/**
 * Wire drawing and management module.
 *
 * Design decisions:
 * 1. No auto-corner - every corner requires a click.
 * 2. Pin snap lines - off-grid pins project invisible snap lines so wires stay
 *    orthogonal even if the pin is not on the grid.
 * 3. Approach / depart alignment - when near a pin the cursor snaps to the pin
 *    axis so the final segment is always horizontal or vertical. On departure
 *    from a pin, the first segment is axis-locked to the pin direction.
 * 4. Midpoint anchors (+ in circle) - handled by the Wire shape class, same as
 *    Line and Polygon.
 * 5. Join / unjoin / junctions - finishing a wire on another wire segment
 *    splits the target and creates a junction dot.
 * 6. Sticky wires - when a component moves, connected wire endpoints follow.
 * 7. Crossings - wires that cross without sharing a vertex do NOT join.
 * 8. Combine - two wires joined end-to-end merge into one.
 * 9. Split - inserting a point on a wire via midpoint anchor.
 * 10. Off-grid snap lines for editing - when dragging an anchor, the other
 *     end of each connected segment provides an invisible snap line so wires
 *     stay orthogonal even off-grid.
 */

import { Wire } from '../../shapes/index.js';
import { BatchCommand, AddShapeCommand, ModifyShapeCommand, DeleteShapesCommand } from '../../core/CommandHistory.js';

// --- Pin helpers ---

/**
 * Find the nearest component pin within tolerance.
 * Returns { component, pin, pinKey, distance, worldPos } or null.
 */
export function findNearbyPin(components, worldPos, tolerance = 0.5) {
    let nearest = null;
    let minDist = tolerance;

    for (const component of components) {
        if (!component.symbol || !component.symbol.pins) continue;
        for (const pin of component.symbol.pins) {
            const pinWorld = component.getPinPosition
                ? component.getPinPosition(pin.number)
                : { x: component.x + pin.x, y: component.y + pin.y };
            if (!pinWorld) continue;
            const dist = Math.hypot(worldPos.x - pinWorld.x, worldPos.y - pinWorld.y);
            if (dist < minDist) {
                const pinKey = pin._key || pin._id || pin.number || `${pin.x},${pin.y}`;
                minDist = dist;
                nearest = { component, pin, pinKey, distance: dist, worldPos: { x: pinWorld.x, y: pinWorld.y } };
            }
        }
    }
    return nearest;
}

export function isSamePin(pin1, pin2) {
    if (pin1?.component?.id !== pin2?.component?.id) return false;
    const key1 = pin1?.pinKey || pin1?.pin?._key || pin1?.pin?._id || pin1?.pin?.number;
    const key2 = pin2?.pinKey || pin2?.pin?._key || pin2?.pin?._id || pin2?.pin?.number;
    if (key1 && key2) return key1 === key2;
    return pin1?.pin?.number === pin2?.pin?.number;
}

export function pointsMatch(a, b, epsilon = 1e-6) {
    return a && b && Math.abs(a.x - b.x) < epsilon && Math.abs(a.y - b.y) < epsilon;
}

/**
 * Determine the axis direction a pin points into the schematic.
 * The wire departs along the pin stub direction.
 * Returns 'horizontal' or 'vertical'.
 */
function pinDepartAxis(pin) {
    const orient = pin?.pin?.orientation || 'right';
    return (orient === 'up' || orient === 'down') ? 'vertical' : 'horizontal';
}

// --- Snap helpers ---

/**
 * Resolve a world position to the best snap target for wire operations.
 * This is the single source of truth for snap priority:
 *   pin > wire endpoint (exact) > wire segment (constrained+grid) > grid snap.
 *
 * Used by pre-draw hover, wire start click, and internally by
 * getDrawingSnappedPosition (which layers drawing-specific constraints on
 * top of the result).
 *
 * @param {object} app
 * @param {object} worldPos - Raw (unsnapped) cursor world position
 * @param {object} [options]
 * @param {object} [options.excludePin] - Pin snap to exclude (e.g. start pin)
 * @param {object} [options.excludeWire] - Wire to exclude from wire snap
 * @param {number} [options.pinTolerance=PIN_SNAP_TOL] - Pin detection radius
 * @param {number} [options.wireTolerance=WIRE_SNAP_TOL] - Wire detection radius
 * @returns {{ x, y, snapPin, snapType: 'pin'|'endpoint'|'segment'|'grid', wireDir? }}
 */
export function resolveWireSnapPosition(app, worldPos, options = {}) {
    const {
        excludePin = null,
        excludeWire = null,
        pinTolerance = PIN_SNAP_TOL,
        wireTolerance = WIRE_SNAP_TOL
    } = options;

    // 1. Pin snap (highest priority)
    const nearPin = findNearbyPin(app.components, worldPos, pinTolerance);
    if (nearPin && !(excludePin && isSamePin(excludePin, nearPin))) {
        return {
            x: nearPin.worldPos.x,
            y: nearPin.worldPos.y,
            snapPin: nearPin,
            snapType: 'pin',
        };
    }

    // 2. Wire snap (endpoint > segment — handled inside findNearbyWirePoint)
    const nearWire = findNearbyWirePoint(app, worldPos, wireTolerance, excludeWire);
    if (nearWire) {
        if (nearWire.type === 'endpoint') {
            return {
                x: nearWire.x,
                y: nearWire.y,
                snapPin: null,
                snapType: 'endpoint',
            };
        } else {
            // Segment T-junction: constrain wire's axis, grid-snap the free axis
            const gridSnapped = app.viewport.getSnappedPosition(nearWire);
            if (nearWire.wireDir === 'horizontal') {
                return { x: gridSnapped.x, y: nearWire.y, snapPin: null, snapType: 'segment', wireDir: 'horizontal' };
            } else {
                return { x: nearWire.x, y: gridSnapped.y, snapPin: null, snapType: 'segment', wireDir: 'vertical' };
            }
        }
    }

    // 3. Grid snap (fallback)
    const gridSnapped = app.viewport.getSnappedPosition(worldPos);
    return { ...gridSnapped, snapPin: null, snapType: 'grid' };
}

/**
 * Snap a position considering grid, nearby pins, and orthogonal constraints
 * during active wire drawing. Layers drawing-specific behaviour (axis
 * choice zone, adjustLast, auto-corner) on top of resolveWireSnapPosition.
 *
 * When drawing:
 *  - The segment from lastPoint to cursor is constrained to be strictly
 *    horizontal or vertical (whichever axis the cursor has moved further in).
 *  - If a pin is nearby, its position acts as a snap line on the appropriate
 *    axis so the wire aligns to it even when it is off-grid.
 *  - When departing a pin (first segment), the axis is locked to the pin
 *    orientation axis.
 */
export function getDrawingSnappedPosition(app, worldPos) {
    // No points yet — use unified resolver (pin tol 1.0, no wires to snap to)
    if (app.wirePoints.length === 0) {
        const snap = resolveWireSnapPosition(app, worldPos, { pinTolerance: 1.0 });
        return { x: snap.x, y: snap.y, snapPin: snap.snapPin, snapType: snap.snapType };
    }

    const lastPoint = app.wirePoints[app.wirePoints.length - 1];
    const rawDx = Math.abs(worldPos.x - lastPoint.x);
    const rawDy = Math.abs(worldPos.y - lastPoint.y);

    // --- Axis choice zone ---
    // A small zone around the segment start lets the user pick H/V direction.
    // Once the cursor exits, the axis is locked until the cursor returns.
    // Radius is at least 2× effective stroke width, but no smaller than 20 screen pixels.
    const choiceRadius = Math.max(app._getEffectiveStrokeWidth(0.2) * 2, 20 / app.viewport.scale);
    const inChoiceZone = rawDx < choiceRadius && rawDy < choiceRadius;

    let axis;
    if (inChoiceZone) {
        // Inside the zone: unlock axis so user can re-pick direction
        app._wireAxisLock = null;
        axis = rawDx >= rawDy ? 'horizontal' : 'vertical';
    } else if (app._wireAxisLock) {
        // Outside the zone with a lock: keep the locked axis
        axis = app._wireAxisLock;
    } else {
        // Exiting the zone for the first time: lock direction
        axis = rawDx >= rawDy ? 'horizontal' : 'vertical';
        app._wireAxisLock = axis;
    }

    // If departing a pin (first segment), prefer the pin axis when the
    // cursor direction is ambiguous. Once the user clearly moves in the
    // perpendicular direction (ratio > 2:1), respect that choice.
    if (app.wirePoints.length === 1 && lastPoint.pin) {
        const pinAxis = pinDepartAxis(lastPoint);
        const dominant = Math.max(rawDx, rawDy);
        const minor = Math.min(rawDx, rawDy);
        if (dominant < minor * 2) {
            axis = pinAxis;
        }
    }

    // Use the unified resolver for snap target detection.
    // Exclude the start pin so we don't snap back to our own origin.
    const excludePin = lastPoint.pin ? { component: lastPoint.pin.component, pin: lastPoint.pin.pin } : null;
    const snap = resolveWireSnapPosition(app, worldPos, {
        excludePin,
        pinTolerance: PIN_SNAP_TOL,
        wireTolerance: WIRE_SNAP_TOL,
    });

    // --- Apply drawing-specific adjustments based on snap type ---

    if (snap.snapType === 'pin') {
        // Approaching a pin: snap the free axis to the pin, and shift the
        // constrained axis of *both* the endpoint AND the previous waypoint
        // so the segment remains perfectly horizontal / vertical.
        if (axis === 'horizontal') {
            return { x: snap.x, y: snap.y, snapPin: snap.snapPin, snapType: 'pin', adjustLastY: snap.y };
        } else {
            return { x: snap.x, y: snap.y, snapPin: snap.snapPin, snapType: 'pin', adjustLastX: snap.x };
        }
    }

    if (snap.snapType === 'endpoint') {
        // Snap to exact endpoint (like a pin) with adjustLast
        if (axis === 'horizontal') {
            return { x: snap.x, y: snap.y, snapPin: null, snapType: 'endpoint', adjustLastY: snap.y };
        } else {
            return { x: snap.x, y: snap.y, snapPin: null, snapType: 'endpoint', adjustLastX: snap.x };
        }
    }

    if (snap.snapType === 'segment') {
        // Segment T-junction: endpoint position comes from resolveWireSnapPosition
        // (free axis grid-snapped, constrained axis on wire). Add auto-corner
        // so lastPoint stays put and we get an L-shaped path.
        const corner = { x: snap.x, y: lastPoint.y };
        return { x: snap.x, y: snap.y, snapPin: null, snapType: 'segment', corner };
    }

    // Normal orthogonal constraint — but prefer a nearby pin's coordinate
    // as a snap line on the free axis so off-grid pins are reachable.
    const gridSnapped = app.viewport.getSnappedPosition(worldPos);
    const gridSize = app.viewport.gridSize || 1.0;
    const halfGrid = gridSize * 0.5;
    const pinSnap = findNearbyPin(app.components, worldPos, PIN_SNAP_TOL);

    if (axis === 'horizontal') {
        let freeX = gridSnapped.x;
        if (pinSnap && Math.abs(worldPos.x - pinSnap.worldPos.x) <= halfGrid) {
            freeX = pinSnap.worldPos.x;
        }
        return { x: freeX, y: lastPoint.y, snapPin: null, snapType: 'grid' };
    } else {
        let freeY = gridSnapped.y;
        if (pinSnap && Math.abs(worldPos.y - pinSnap.worldPos.y) <= halfGrid) {
            freeY = pinSnap.worldPos.y;
        }
        return { x: lastPoint.x, y: freeY, snapPin: null, snapType: 'grid' };
    }
}

// --- Drawing lifecycle ---

export function startWireDrawing(app, snappedData) {
    const snapPin = snappedData.snapPin || null;
    const startPoint = { x: snappedData.x, y: snappedData.y };
    if (snapPin) startPoint.pin = snapPin;

    app.wirePoints = [startPoint];
    app.wireSnapPin = snapPin;
    app.wireStartPin = snapPin;
    app._wireAxisLock = null;
    app.isDrawing = true;
    app._createPreview();
    app._showCrosshair();
    app._updateCrosshair(snappedData);
    app._setToolCursor(app.currentTool, app.viewport.svg);
}

export function updateWireDrawing(app, worldPos) {
    if (!app.isDrawing || app.wirePoints.length === 0) return;

    // Calculate snapped target (includes snap detection via resolveWireSnapPosition)
    const target = getDrawingSnappedPosition(app, worldPos);

    // Highlight uses snapType from the unified resolver — no duplicate detection
    if (target.snapType === 'pin' && target.snapPin) {
        updateSnapHighlight(app, target.snapPin);
    } else if (target.snapType === 'endpoint' || target.snapType === 'segment') {
        updateSnapHighlight(app, { x: target.x, y: target.y, type: target.snapType });
    } else {
        updateSnapHighlight(app, null);
    }

    app.drawCurrent = { x: target.x, y: target.y };
    app.drawCorner = target.corner || null;
    app.lastSnappedData = { x: target.x, y: target.y, snapPin: target.snapPin };

    // When approaching an off-grid pin, shift the last waypoint's
    // constrained coordinate so the segment stays perfectly orthogonal.
    const lastPt = app.wirePoints[app.wirePoints.length - 1];
    if (target.adjustLastY !== undefined) {
        lastPt._savedY = lastPt._savedY ?? lastPt.y;
        lastPt.y = target.adjustLastY;
    } else if (target.adjustLastX !== undefined) {
        lastPt._savedX = lastPt._savedX ?? lastPt.x;
        lastPt.x = target.adjustLastX;
    } else {
        // Restore if we moved away from the pin
        if (lastPt._savedY !== undefined) { lastPt.y = lastPt._savedY; delete lastPt._savedY; }
        if (lastPt._savedX !== undefined) { lastPt.x = lastPt._savedX; delete lastPt._savedX; }
    }

    updateWirePreview(app);
}

export function addWireWaypoint(app, waypointData) {
    if (app.wirePoints.length === 0) return;

    const point = { x: waypointData.x, y: waypointData.y };
    if (waypointData.snapPin) point.pin = waypointData.snapPin;

    // Don't add duplicate point
    const last = app.wirePoints[app.wirePoints.length - 1];
    if (pointsMatch(last, point)) return;

    // Lock in any pin-adjusted coordinate on the previous waypoint
    delete last._savedX;
    delete last._savedY;

    app.wirePoints.push(point);
    app._wireAxisLock = null;   // Reset axis lock for new segment

    // Remove redundant collinear midpoint: if the last 3 points are on a
    // straight line, the middle one is unnecessary.
    const n = app.wirePoints.length;
    if (n >= 3) {
        const a = app.wirePoints[n - 3];
        const b = app.wirePoints[n - 2];
        const c = app.wirePoints[n - 1];
        if (segmentsCollinear({ a, b }, { a: b, b: c })) {
            app.wirePoints.splice(n - 2, 1);
        }
    }

    updateWirePreview(app);
}

export function finishWireDrawing(app, worldPos) {
    // Add final point if different from last waypoint
    if (app.drawCurrent) {
        const last = app.wirePoints[app.wirePoints.length - 1];
        if (!pointsMatch(last, app.drawCurrent)) {
            addWireWaypoint(app, {
                x: app.drawCurrent.x,
                y: app.drawCurrent.y,
                snapPin: app.lastSnappedData?.snapPin || null
            });
        }
    }

    if (app.wirePoints.length < 2) {
        cancelWireDrawing(app);
        return;
    }

    updateSnapHighlight(app, null);

    const firstPt = app.wirePoints[0];
    const lastPt = app.wirePoints[app.wirePoints.length - 1];

    const wire = new Wire({
        points: app.wirePoints.map(p => ({ x: p.x, y: p.y })),
        color: WIRE_COLOR,
        lineWidth: WIRE_WIDTH,
        connections: {
            start: firstPt.pin ? { componentId: firstPt.pin.component.id, pinNumber: firstPt.pin.pin.number } : null,
            end: lastPt.pin ? { componentId: lastPt.pin.component.id, pinNumber: lastPt.pin.pin.number } : null
        }
    });

    // Capture before-states of all existing wires so that mutations from
    // processWireJoins / processWireMerges can be undone as a single batch.
    const existingWires = app.shapes.filter(s => s.type === 'wire');
    const beforeStates = new Map();
    for (const w of existingWires) beforeStates.set(w, w.captureState());

    // If every segment of the new wire is already covered by existing
    // wiring, the wire is redundant — discard it before mutating anything.
    if (isWireRedundant(app, wire)) {
        cancelWireDrawing(app);
        return;
    }

    // Add wire without creating a standalone undo entry — it will be
    // part of the batch command below.
    app._addShapeInternal(wire);

    // Post-placement: check for joins onto other wires (may split/mutate)
    processWireJoins(app, wire);

    // Check for end-to-end merges (may remove wires)
    processWireMerges(app, wire);

    // Update pin connections after merge may have changed endpoints
    refreshWireConnections(app, wire);

    // Absorb existing wires now fully covered by the new/merged wire.
    // The before-state diff below will capture these removals automatically.
    if (app.shapes.includes(wire)) {
        for (const other of [...app.shapes]) {
            if (other === wire || other.type !== 'wire') continue;
            if (isWireRedundant(app, other)) {
                app._removeShapeInternal(other);
            }
        }
    }

    // Build a single BatchCommand that captures everything:
    //   - the new wire addition
    //   - any existing wires that were modified (split / junction added)
    //   - any existing wires that were removed (merged into newWire)
    //   - any new wires created by collinear split in processWireJoins
    const batch = new BatchCommand('Draw wire');

    // Collect after-states and identify changes
    const removedWires = [];      // { wire, before }
    const modifiedWires = [];     // { wire, before, after }
    const addedWires = [];        // wires created by collinear split

    for (const [w, before] of beforeStates) {
        if (!app.shapes.includes(w)) {
            removedWires.push({ wire: w, before });
        } else {
            const after = w.captureState();
            if (JSON.stringify(before) !== JSON.stringify(after)) {
                modifiedWires.push({ wire: w, before, after });
            }
        }
    }
    for (const s of app.shapes) {
        if (s.type !== 'wire' || s === wire) continue;
        if (!beforeStates.has(s)) {
            addedWires.push(s);
        }
    }

    // Revert everything to pre-mutation state so batch.execute() can replay
    for (const { wire: w, before } of modifiedWires) {
        w.applyState(before);
        w.invalidate();
    }
    for (const { wire: w, before } of removedWires) {
        w.applyState(before);
        app._addShapeInternal(w);
    }
    for (const s of addedWires) {
        app._removeShapeInternal(s);
    }
    app._removeShapeInternal(wire);

    // Build batch: deletes first, then modifications, then adds
    for (const { wire: w } of removedWires) {
        batch.add(new DeleteShapesCommand(app, [w]));
    }
    for (const { wire: w, before, after } of modifiedWires) {
        batch.add(new ModifyShapeCommand(app, w, before, after));
    }
    for (const s of addedWires) {
        batch.add(new AddShapeCommand(app, s));
    }
    batch.add(new AddShapeCommand(app, wire));

    // Execute the batch — replays all commands, reaching the final state
    app.history.execute(batch);

    cancelWireDrawing(app);

    // Re-render after merge/join may have mutated points or removed shapes
    app.renderShapes(true);
}

export function cancelWireDrawing(app) {
    app.wirePoints = [];
    app._wireAxisLock = null;
    updateSnapHighlight(app, null);
    app.wireSnapPin = null;
    app.wireStartPin = null;
    app.isDrawing = false;

    if (app.previewElement) {
        app.previewElement.remove();
        app.previewElement = null;
    }
    app._hideCrosshair();
    app._setToolCursor(app.currentTool, app.viewport.svg);
}

// --- Wire preview ---

export function updateWirePreview(app) {
    if (!app.previewElement) return;

    const strokeWidth = app._getEffectiveStrokeWidth(0.2);
    let svg = '';
    const pts = app.wirePoints;

    // Draw committed segments
    for (let i = 0; i < pts.length - 1; i++) {
        svg += `<line x1="${pts[i].x}" y1="${pts[i].y}" x2="${pts[i + 1].x}" y2="${pts[i + 1].y}" 
                stroke="${WIRE_COLOR}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
    }

    // Draw waypoint dots
    for (const p of pts) {
        svg += `<circle cx="${p.x}" cy="${p.y}" r="${2 / app.viewport.scale}" fill="${WIRE_COLOR}"/>`;    
    }

    // Draw live segment from last waypoint to cursor (with optional corner)
    if (app.drawCurrent && pts.length > 0) {
        const last = pts[pts.length - 1];
        if (app.drawCorner) {
            const c = app.drawCorner;
            svg += `<line x1="${last.x}" y1="${last.y}" x2="${c.x}" y2="${c.y}" 
                    stroke="${WIRE_COLOR}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-opacity="0.6"/>`;
            svg += `<line x1="${c.x}" y1="${c.y}" x2="${app.drawCurrent.x}" y2="${app.drawCurrent.y}" 
                    stroke="${WIRE_COLOR}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-opacity="0.6"/>`;    
        } else {
            svg += `<line x1="${last.x}" y1="${last.y}" x2="${app.drawCurrent.x}" y2="${app.drawCurrent.y}" 
                    stroke="${WIRE_COLOR}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-opacity="0.6"/>`;    
        }
    }

    app.previewElement.innerHTML = svg;
}

// --- Snap highlight (unified pin + wire junction) ---

/**
 * Low-level: show yellow dot on a component pin.
 */
function _showPinDot(app, snapPin) {
    const pinKey = snapPin.pinKey || snapPin.pin._key || snapPin.pin._id || snapPin.pin.number;
    const pinGroup = snapPin.component.pinElements?.get(pinKey);
    if (pinGroup) {
        const dot = pinGroup.querySelector('circle');
        if (dot) {
            if (!dot.dataset.originalFill) dot.dataset.originalFill = dot.getAttribute('fill');
            dot.setAttribute('fill', '#ffff00');
            dot.setAttribute('display', '');
        }
    }
}

/**
 * Low-level: restore a previously highlighted pin dot.
 */
function _hidePinDot(app) {
    if (!app.wireSnapPin?.pin) return;
    const pinKey = app.wireSnapPin.pinKey || app.wireSnapPin.pin._key || app.wireSnapPin.pin._id || app.wireSnapPin.pin.number;
    const pinGroup = app.wireSnapPin.component.pinElements?.get(pinKey);
    if (pinGroup) {
        const dot = pinGroup.querySelector('circle');
        if (dot) {
            dot.setAttribute('fill', dot.dataset.originalFill || 'var(--sch-pin, #aa0000)');
            if (!app.wireSnapPin.component.selected) {
                dot.setAttribute('display', 'none');
            }
        }
    }
}

/**
 * Low-level: show a temporary yellow SVG circle at a wire junction point.
 */
function _showWireJunctionDot(app, pos) {
    _hideWireJunctionDot(app);
    app._wireJunctionData = { x: pos.x, y: pos.y, type: pos.type };
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', pos.x);
    dot.setAttribute('cy', pos.y);
    dot.setAttribute('r', Math.max(0.4, 3 / app.viewport.scale));
    dot.setAttribute('fill', '#ffff00');
    dot.setAttribute('stroke', 'none');
    dot.setAttribute('pointer-events', 'none');
    dot.classList.add('wire-junction-highlight');
    app.viewport.contentLayer.appendChild(dot);
    app._wireJunctionDot = dot;
}

/**
 * Low-level: remove the temporary wire junction dot.
 */
function _hideWireJunctionDot(app) {
    if (app._wireJunctionDot) {
        app._wireJunctionDot.remove();
        app._wireJunctionDot = null;
    }
    app._wireJunctionData = null;
}

/**
 * Unified snap highlight: show a yellow dot for a pin or wire junction,
 * automatically cleaning up any previous highlight of either type.
 *
 * @param {object} app
 * @param {object|null} target - A pin snap object (has .pin), a wire
 *        junction {x, y} (no .pin), or null to clear all highlights.
 */
export function updateSnapHighlight(app, target) {
    const isPin = target?.pin != null;
    const isWireJunction = target && !isPin;
    const prevPin = app.wireSnapPin;
    const sameTarget = isPin && target === prevPin;

    // Nothing changed
    if (sameTarget) return;

    // Clear previous highlights
    if (prevPin) {
        _hidePinDot(app);
        app.wireSnapPin = null;
    }
    _hideWireJunctionDot(app);

    // Show new highlight
    if (isPin) {
        app.wireSnapPin = target;
        _showPinDot(app, target);
    } else if (isWireJunction) {
        _showWireJunctionDot(app, target);
    }
}

// --- Wire junction detection ---

/**
 * Find the nearest point on another wire (endpoint or segment interior)
 * that is within tolerance of worldPos.  Returns { x, y, type } or null.
 * type is 'endpoint' (merge) or 'segment' (T-junction).
 */
export function findNearbyWirePoint(app, worldPos, tolerance, excludeWires = null) {
    // Normalize exclusion to a Set for uniform handling
    const excludeSet = !excludeWires ? new Set() :
        excludeWires instanceof Set ? excludeWires : new Set([excludeWires]);

    // Pass 1: find closest endpoint (preferred — endpoint snaps are exact)
    let bestEp = null;
    let bestEpDist = tolerance;

    // Pass 1b: find closest interior vertex (corner junction)
    let bestCorner = null;
    let bestCornerDist = tolerance;

    // Pass 2: find closest segment (T-junction, only used if no endpoint)
    let bestSeg = null;
    let bestSegDist = tolerance;

    for (const shape of app.shapes) {
        if (shape.type !== 'wire' || shape.points.length < 2) continue;
        if (excludeSet.has(shape)) continue;

        // Check endpoints
        const first = shape.points[0];
        const last = shape.points[shape.points.length - 1];
        for (const ep of [first, last]) {
            const d = Math.hypot(worldPos.x - ep.x, worldPos.y - ep.y);
            if (d < bestEpDist) {
                bestEpDist = d;
                bestEp = { x: ep.x, y: ep.y, type: 'endpoint' };
            }
        }

        // Check interior vertices (corners)
        for (let i = 1; i < shape.points.length - 1; i++) {
            const p = shape.points[i];
            const d = Math.hypot(worldPos.x - p.x, worldPos.y - p.y);
            if (d < bestCornerDist) {
                bestCornerDist = d;
                bestCorner = { x: p.x, y: p.y, type: 'endpoint' };
            }
        }

        // Check segments (T-junction)
        const seg = shape.closestSegment(worldPos);
        if (seg && seg.distance < bestSegDist) {
            // Only count as T-junction if not at an existing vertex
            let atVertex = false;
            for (const p of shape.points) {
                if (Math.hypot(seg.point.x - p.x, seg.point.y - p.y) < VERTEX_EPSILON) {
                    atVertex = true;
                    break;
                }
            }
            if (!atVertex) {
                bestSegDist = seg.distance;
                const segA = shape.points[seg.segIndex];
                const segB = shape.points[seg.segIndex + 1];
                const segDx = Math.abs(segB.x - segA.x);
                const segDy = Math.abs(segB.y - segA.y);
                // Wire direction: 'horizontal' if dx>dy, 'vertical' otherwise
                const wireDir = segDx >= segDy ? 'horizontal' : 'vertical';
                bestSeg = { x: seg.point.x, y: seg.point.y, type: 'segment', wireDir };
            }
        }
    }

    // Endpoints always win, then interior vertices, then segments
    return bestEp || bestCorner || bestSeg;
}

// --- Constants ---

/** Snap threshold in screen pixels (divided by viewport.scale for world units). */
export const SNAP_SCREEN_PX = 5;

/** Epsilon for detecting collinear H/V segments (world units). */
export const COLLINEAR_EPSILON = 0.01;

/** Angle tolerance for general collinearity check (sin of max angle). */
export const ANGLE_TOL = 0.05;

/** Tolerance for vertex coincidence checks (world units). */
export const VERTEX_EPSILON = 0.15;

/** Tolerance for pin snap detection during drawing (world units). */
export const PIN_SNAP_TOL = 1.5;

/** Tolerance for wire-to-wire snap detection (world units). */
export const WIRE_SNAP_TOL = 0.5;

/** Default wire stroke color. */
export const WIRE_COLOR = '#00cc66';

/** Default wire stroke width (world units). */
export const WIRE_WIDTH = 0.25;

// --- Wire point cleanup ---

/**
 * Splice a point out of a wire and shift junction indices accordingly.
 */
export function spliceWirePoint(wire, idx) {
    wire.points.splice(idx, 1);
    const shifted = new Set();
    for (const j of wire.junctions) {
        if (j === idx) continue;
        shifted.add(j > idx ? j - 1 : j);
    }
    wire.junctions = shifted;
}

/**
 * Remove zero-length segments and collinear midpoints from a wire,
 * keeping T-junction vertices where another wire connects.
 * Uses parametric projection to handle drag-past-endpoint correctly.
 */
export function collapseRedundantWirePoints(app, wire) {
    // Remove adjacent duplicate points (zero-length segments)
    for (let i = wire.points.length - 1; i > 0; i--) {
        const a = wire.points[i], b = wire.points[i - 1];
        if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) {
            spliceWirePoint(wire, i);
        }
    }
    // Remove collinear midpoints, but keep T-junction vertices.
    // Uses parametric projection to find which of three collinear
    // points is geometrically interior (handles drag-past-endpoint).
    for (let i = wire.points.length - 2; i >= 1; i--) {
        const a = wire.points[i - 1], b = wire.points[i], c = wire.points[i + 1];
        if (!pointsCollinear(a, b, c)) continue;

        const dxAC = c.x - a.x, dyAC = c.y - a.y;
        const lenSqAC = dxAC * dxAC + dyAC * dyAC;
        let removeIdx;
        if (lenSqAC < 1e-12) {
            removeIdx = i;
        } else {
            const t = ((b.x - a.x) * dxAC + (b.y - a.y) * dyAC) / lenSqAC;
            if (t < 0) removeIdx = i - 1;
            else if (t > 1) removeIdx = i + 1;
            else removeIdx = i;
        }

        const rp = wire.points[removeIdx];
        if (isTJunctionPoint(app, rp, wire)) continue;
        spliceWirePoint(wire, removeIdx);
    }
    wire.invalidate();
}

// --- Collinearity helper ---

/**
 * Check if three consecutive points are collinear (the angle at b
 * deviates less than ANGLE_TOL from 180°).  Handles degenerate
 * zero-length spans gracefully.
 */
export function pointsCollinear(a, b, c) {
    const dx1 = b.x - a.x, dy1 = b.y - a.y;
    const dx2 = c.x - b.x, dy2 = c.y - b.y;
    const len1 = Math.hypot(dx1, dy1), len2 = Math.hypot(dx2, dy2);
    if (len1 < 1e-9 || len2 < 1e-9) return true;
    return Math.abs(dx1 * dy2 - dy1 * dx2) / (len1 * len2) < ANGLE_TOL;
}

/**
 * Check if a wire is entirely redundant — every segment is collinear with
 * and fully contained by an existing wire's segment.  Used to absorb
 * duplicate wires drawn or dropped on top of existing wiring.
 *
 * "Contained" means both endpoints of the wire's segment project within
 * [0, 1] on the covering segment (parametrically), not just the midpoint.
 * This ensures a long wire is never incorrectly flagged as redundant when
 * only its midpoint happens to land on a shorter collinear wire.
 */
export function isWireRedundant(app, wire) {
    if (wire.points.length < 2) return true;
    for (let i = 0; i < wire.points.length - 1; i++) {
        const a = wire.points[i], b = wire.points[i + 1];
        if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) continue; // zero-length
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        let covered = false;
        for (const other of app.shapes) {
            if (other === wire || other.type !== 'wire') continue;
            // Check if segment midpoint lies on a collinear segment of `other`
            const hit = other.closestSegment(mid);
            if (!hit || hit.distance > VERTEX_EPSILON) continue;
            const tA = other.points[hit.segIndex], tB = other.points[hit.segIndex + 1];
            if (!segmentsCollinear({ a, b }, { a: tA, b: tB })) continue;
            // Verify containment: both endpoints of the wire's segment must
            // project within the covering segment's parametric range [0, 1].
            const tdx = tB.x - tA.x, tdy = tB.y - tA.y;
            const tLenSq = tdx * tdx + tdy * tdy;
            if (tLenSq < 1e-18) continue;
            const projA = ((a.x - tA.x) * tdx + (a.y - tA.y) * tdy) / tLenSq;
            const projB = ((b.x - tA.x) * tdx + (b.y - tA.y) * tdy) / tLenSq;
            const eps = VERTEX_EPSILON / Math.sqrt(tLenSq);
            if (projA >= -eps && projA <= 1 + eps && projB >= -eps && projB <= 1 + eps) {
                covered = true;
                break;
            }
        }
        if (!covered) return false;
    }
    return true;
}

/**
 * Check if two segments are collinear (parallel and overlapping direction).
 * seg1/seg2 are { a: {x,y}, b: {x,y} }.
 */
export function segmentsCollinear(seg1, seg2, angleTol = ANGLE_TOL) {
    const dx1 = seg1.b.x - seg1.a.x, dy1 = seg1.b.y - seg1.a.y;
    const dx2 = seg2.b.x - seg2.a.x, dy2 = seg2.b.y - seg2.a.y;
    const len1 = Math.hypot(dx1, dy1), len2 = Math.hypot(dx2, dy2);
    if (len1 < 1e-9 || len2 < 1e-9) return true; // degenerate
    const cross = Math.abs(dx1 * dy2 - dy1 * dx2) / (len1 * len2);
    return cross < angleTol;
}

/**
 * Get the terminal segment direction of a wire at the given endpoint.
 * end: 'start' or 'end'
 */
function terminalSegment(wire, end) {
    if (wire.points.length < 2) return null;
    if (end === 'start') return { a: wire.points[0], b: wire.points[1] };
    return { a: wire.points[wire.points.length - 1], b: wire.points[wire.points.length - 2] };
}

// --- Join / unjoin / junctions (requirement 5) ---

/**
 * Process a single wire endpoint against a target wire for T-junction,
 * corner junction, or collinear overshoot.  Shared by processWireJoins
 * (drawing), processWireAnchorMerge (editing), and segment drag commit.
 *
 * @param {object} app
 * @param {Wire}   wire       - the wire whose endpoint is being tested
 * @param {{x,y}}  pt         - the endpoint position
 * @param {string} end        - 'start' or 'end'
 * @param {Wire}   other      - the target wire to test against
 * @param {Map}    [stateMap] - if provided, capture before-state of other
 *                              before mutating (for undo tracking)
 * @returns {boolean} true if the other wire was modified
 */
export function processEndpointJoin(app, wire, pt, end, other, stateMap) {
    // Interior vertex (corner) — just mark as junction, no split needed
    const cornerIdx = other.interiorVertexAt(pt, VERTEX_EPSILON);
    if (cornerIdx >= 0) {
        if (stateMap && !stateMap.has(other)) {
            stateMap.set(other, app._captureShapeState(other));
        }
        other.junctions.add(cornerIdx);
        other.invalidate();
        return true;
    }

    // Point on segment — T-junction or collinear overshoot
    const onSeg = other.pointOnSegment(pt, VERTEX_EPSILON);
    if (!onSeg) return false;

    const incoming = terminalSegment(wire, end);
    const target = { a: other.points[onSeg.segIndex], b: other.points[onSeg.segIndex + 1] };

    if (incoming && segmentsCollinear(incoming, target)) {
        // Collinear containment: the wire's endpoint sits inside a collinear
        // segment of another wire.  pointOnSegment already excludes hits
        // near existing vertices, so this only fires for genuine containment
        // (endpoint deep inside the segment), never for near-endpoint
        // overshoot.  Skip it — the redundancy check (isWireRedundant) will
        // absorb the shorter wire if it is fully covered.
        return false;
    }

    // Non-collinear: real T-junction — split and add junction dot
    if (stateMap && !stateMap.has(other)) {
        stateMap.set(other, app._captureShapeState(other));
    }
    const insertIdx = other.splitAt(pt);
    other.junctions.add(insertIdx);
    other.invalidate();
    return true;
}

/**
 * After a new wire is placed, check if its endpoints land on another wire
 * segment (T-junction) or corner vertex.  Delegates to processEndpointJoin.
 */
export function processWireJoins(app, newWire) {
    const endpoints = [
        { pt: newWire.points[0], end: 'start' },
        { pt: newWire.points[newWire.points.length - 1], end: 'end' }
    ];
    for (const { pt, end } of endpoints) {
        for (const shape of app.shapes) {
            if (shape === newWire || shape.type !== 'wire') continue;
            processEndpointJoin(app, newWire, pt, end, shape);
        }
    }
}

/**
 * Check whether any other wire has a point at the given location,
 * indicating a T-junction that must not be optimised away.
 * @param {object} app
 * @param {{x:number,y:number}} pt  - point to test
 * @param {...object} excludeWires  - wires to skip (the ones being merged/edited)
 */
export function isTJunctionPoint(app, pt, ...excludeWires) {
    if (!app) return false;
    for (const s of app.shapes) {
        if (s.type !== 'wire') continue;
        if (excludeWires.includes(s)) continue;
        for (const p of s.points) {
            if (Math.abs(p.x - pt.x) < VERTEX_EPSILON && Math.abs(p.y - pt.y) < VERTEX_EPSILON) return true;
        }
    }
    return false;
}

/**
 * Clean up orphaned T-junction vertices on surviving wires after wire deletion.
 * Scans surviving wires for collinear midpoints at the given orphaned points
 * and removes them if no third wire still connects there.
 *
 * @param {object}   app           - the app instance
 * @param {Array<{x:number,y:number}>} orphanedPts - points being removed from the wire graph
 * @param {Array}    excludeWires  - wires being deleted (excluded from the scan)
 * @returns {Array<{wire, beforeState, afterState}>}  wires that were modified
 */
export function cleanupOrphanedTJunctions(app, orphanedPts, excludeWires) {
    const excludeSet = new Set(excludeWires);
    const tjCleanup = new Map(); // surviving wire -> Set of midpoint indices to remove

    for (const pt of orphanedPts) {
        for (const other of app.shapes) {
            if (excludeSet.has(other) || other.type !== 'wire') continue;
            for (let i = 1; i < other.points.length - 1; i++) {
                const op = other.points[i];
                if (Math.abs(op.x - pt.x) >= VERTEX_EPSILON || Math.abs(op.y - pt.y) >= VERTEX_EPSILON) continue;
                // Only remove collinear midpoints (junction-inserted)
                const a = other.points[i - 1], c = other.points[i + 1];
                if (!pointsCollinear(a, op, c)) continue;
                // Keep if a third wire still connects here
                if (isTJunctionPoint(app, pt, ...excludeWires, other)) continue;
                if (!tjCleanup.has(other)) tjCleanup.set(other, new Set());
                tjCleanup.get(other).add(i);
            }
        }
    }

    const results = [];
    for (const [other, idxSet] of tjCleanup) {
        const beforeState = other.captureState();
        const sorted = [...idxSet].sort((a, b) => b - a);
        for (const i of sorted) other.points.splice(i, 1);
        const newJunctions = new Set();
        for (const j of other.junctions) {
            if (idxSet.has(j)) continue;
            let adj = j;
            for (const ri of sorted) { if (ri < j) adj--; }
            newJunctions.add(adj);
        }
        other.junctions = newJunctions;
        other.invalidate();
        const afterState = other.captureState();
        other.applyState(beforeState);
        results.push({ wire: other, beforeState, afterState });
    }
    return results;
}

/**
 * Merge two point arrays at a shared seam, dropping the seam point if
 * collinear with its neighbors (no redundant anchor on a straight wire).
 * front ends at the shared point; back starts after it.
 */
function mergeWirePoints(app, front, back, wireA, wireB) {
    if (front.length >= 2 && back.length >= 1) {
        const a = front[front.length - 2];
        const b = front[front.length - 1]; // seam point
        const c = back[0];
        if (segmentsCollinear({ a, b }, { a: b, b: c })) {
            if (!isTJunctionPoint(app, b, wireA, wireB)) {
                return [...front.slice(0, -1), ...back];
            }
        }
    }
    return [...front, ...back];
}

/**
 * Attempt to merge wire with other at a shared endpoint pt.
 * Returns true (and removes other) if the merge was performed.
 */
function tryEndpointMerge(app, wire, pt, end, other) {
    const otherEnd = other.endpointAt(pt);
    if (!otherEnd) return false;
    if (isTJunctionPoint(app, pt, wire, other)) return false;

    // If both wires also share the opposite endpoint, the other wire is
    // fully overlapping — just absorb it without concatenating points
    // (concatenation would produce a degenerate back-and-forth path).
    const oppositeEnd = end === 'start' ? 'end' : 'start';
    const oppPt = oppositeEnd === 'start' ? wire.points[0] : wire.points[wire.points.length - 1];
    if (other.endpointAt(oppPt)) {
        app._removeShapeInternal(other);
        return true;
    }

    const otherPts = other.points.map(p => ({ ...p }));
    if (end === otherEnd) otherPts.reverse();
    if (end === 'start') {
        wire.points = mergeWirePoints(app, otherPts, wire.points.slice(1), wire, other);
    } else {
        wire.points = mergeWirePoints(app, wire.points, otherPts.slice(1), wire, other);
    }
    wire.junctions = new Set();
    wire.invalidate();
    app._removeShapeInternal(other);
    return true;
}

/**
 * After a new wire is placed, check if it shares an endpoint with exactly
 * one other wire. If so, merge them into one wire.
 */
export function processWireMerges(app, newWire) {
    if (!app.shapes.includes(newWire)) return;

    const tryMerge = (myEnd) => {
        const myPt = myEnd === 'start' ? newWire.points[0] : newWire.points[newWire.points.length - 1];
        for (const shape of [...app.shapes]) {
            if (shape === newWire || shape.type !== 'wire') continue;
            if (!app.shapes.includes(shape)) continue;
            if (tryEndpointMerge(app, newWire, myPt, myEnd, shape)) return true;
        }
        return false;
    };

    let merged = true;
    while (merged) {
        merged = tryMerge('start') || tryMerge('end');
    }
}

// --- Sticky wires (requirement 6) ---

/**
 * Refresh a wire's connection info by checking whether its first/last
 * points coincide with a component pin.  Call after anchor or segment
 * drags so that dragged endpoints "stick" to the pin they land on (or
 * detach from a pin they were dragged away from).
 */
export function refreshWireConnections(app, wire) {
    if (!wire || wire.type !== 'wire' || wire.points.length < 2) return;
    const tolerance = 0.1;

    // Check start point
    const startPt = wire.points[0];
    const startPin = findNearbyPin(app.components, startPt, tolerance);
    wire.connections.start = startPin
        ? { componentId: startPin.component.id, pinNumber: startPin.pin.number }
        : null;

    // Check end point
    const endPt = wire.points[wire.points.length - 1];
    const endPin = findNearbyPin(app.components, endPt, tolerance);
    wire.connections.end = endPin
        ? { componentId: endPin.component.id, pinNumber: endPin.pin.number }
        : null;
}

/**
 * Call this after moving components. For every wire whose endpoint is
 * connected to a pin, update that endpoint to the pin current world
 * position.
 */
export function updateStickyWires(app) {
    for (const shape of app.shapes) {
        if (shape.type !== 'wire') continue;
        const conn = shape.connections;
        if (conn.start) {
            const comp = app.components.find(c => c.id === conn.start.componentId);
            if (comp) {
                const pos = comp.getPinPosition(conn.start.pinNumber);
                if (pos) {
                    shape.points[0].x = pos.x;
                    shape.points[0].y = pos.y;
                    shape.invalidate();
                }
            }
        }
        if (conn.end) {
            const comp = app.components.find(c => c.id === conn.end.componentId);
            if (comp) {
                const pos = comp.getPinPosition(conn.end.pinNumber);
                if (pos) {
                    const last = shape.points[shape.points.length - 1];
                    last.x = pos.x;
                    last.y = pos.y;
                    shape.invalidate();
                }
            }
        }
    }
}

// --- Anchor merge after drag (same-wire collapse + cross-wire merge) ---

/**
 * After an anchor drag on a wire, collapse duplicate adjacent points and
 * merge / join with other wires whose endpoints now coincide.
 * Returns true if the wire was modified or merged.
 */
export function processWireAnchorMerge(app, wire) {
    if (!wire || wire.type !== 'wire') return false;
    let changed = false;

    // 1 & 2. Collapse zero-length segments and redundant collinear midpoints.
    const ptsBefore = wire.points.length;
    collapseRedundantWirePoints(app, wire);
    if (wire.points.length !== ptsBefore) changed = true;
    if (wire.points.length < 2) return changed;

    // Early redundancy check: if the wire is already fully covered by
    // existing wires, remove it before the merge loop can destructively
    // absorb the covering wire's points.
    if (isWireRedundant(app, wire)) {
        app._removeShapeInternal(wire);
        return true;
    }

    // 3. Check endpoints against other wires for merge / T-join.
    //    Loop until no more merges occur (a merge changes wire.points,
    //    so we need to re-check both endpoints).
    let merging = true;
    while (merging) {
        merging = false;
        const endpoints = [
            { pt: wire.points[0], end: 'start' },
            { pt: wire.points[wire.points.length - 1], end: 'end' }
        ];

        for (const { pt, end } of endpoints) {
            let merged = false;
            for (const other of [...app.shapes]) {
                if (other === wire || other.type !== 'wire') continue;
                if (!app.shapes.includes(other)) continue;

                // Endpoint-to-endpoint merge
                if (tryEndpointMerge(app, wire, pt, end, other)) {
                    changed = true;
                    merged = true;
                    break; // restart — points changed
                }

                // T-junction, corner junction, or collinear overshoot
                if (processEndpointJoin(app, wire, pt, end, other)) {
                    changed = true;
                    // processEndpointJoin may have snapped our endpoint —
                    // retry endpoint merge with the same wire
                    const snappedPt = end === 'start' ? wire.points[0] : wire.points[wire.points.length - 1];
                    if (tryEndpointMerge(app, wire, snappedPt, end, other)) {
                        merged = true;
                    }
                    if (merged) break;
                }
            }
            if (merged) { merging = true; break; } // restart both endpoints
        }
    }

    // After all merging, check if the wire is now fully redundant
    // (every segment covered by another wire). If so, remove it.
    if (wire.points.length >= 2 && app.shapes.includes(wire) && isWireRedundant(app, wire)) {
        app._removeShapeInternal(wire);
        return true;
    }

    return changed;
}

// --- Guide line rendering ---

/**
 * Render an array of guide line segments as blue highlight overlays.
 * Manages a pool of SVG line elements in app._collinearGuides.
 *
 * @param {object} app
 * @param {Array<[{x,y},{x,y}]>} guides - Array of [pointA, pointB] pairs
 */
export function renderGuideLines(app, guides) {
    if (!app._collinearGuides) app._collinearGuides = [];
    const wireStroke = app._getEffectiveStrokeWidth(0.25);
    for (let gi = 0; gi < guides.length; gi++) {
        const [gA, gB] = guides[gi];
        if (!app._collinearGuides[gi]) {
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('pointer-events', 'none');
            app.viewport.svg.appendChild(line);
            app._collinearGuides[gi] = line;
        }
        const line = app._collinearGuides[gi];
        line.setAttribute('x1', gA.x);
        line.setAttribute('y1', gA.y);
        line.setAttribute('x2', gB.x);
        line.setAttribute('y2', gB.y);
        line.setAttribute('stroke', '#4488ff');
        line.setAttribute('stroke-width', String(wireStroke * 3));
        line.setAttribute('stroke-opacity', '0.22');
        line.setAttribute('stroke-dasharray', 'none');
        line.setAttribute('display', '');
    }
    for (let gi = guides.length; gi < app._collinearGuides.length; gi++) {
        app._collinearGuides[gi].setAttribute('display', 'none');
    }
}

// --- Collinear / H-V snap for moving wire segments ---

/**
 * Check if three points are collinear within a world-unit threshold.
 * If so, returns the projection of `mid` onto the line through
 * `outer` and `far`. Otherwise returns null.
 */
function collinearSnap(outer, mid, far, threshold) {
    const dx1 = mid.x - outer.x, dy1 = mid.y - outer.y;
    const len1 = Math.hypot(dx1, dy1);
    if (len1 < 1e-9) return null;
    const ldx = far.x - outer.x, ldy = far.y - outer.y;
    const lenSq = ldx * ldx + ldy * ldy;
    if (lenSq < 1e-9) return null;
    const cross = Math.abs(dx1 * ldy - dy1 * ldx) / Math.sqrt(lenSq);
    if (cross < threshold) {
        const t = (dx1 * ldx + dy1 * ldy) / lenSq;
        return { x: outer.x + t * ldx, y: outer.y + t * ldy };
    }
    return null;
}

/**
 * Override a grid-snapped position with off-grid neighbor coordinates
 * when the raw (un-snapped) position is within half a grid cell of a
 * neighbor's X or Y.  This creates invisible snap lines at every
 * neighbor coordinate so off-grid alignment is preserved.
 *
 * Mutates `snapped` in place.
 *
 * @param {{ x: number, y: number }} raw      - un-snapped world position
 * @param {{ x: number, y: number }} snapped  - grid-snapped position (mutated)
 * @param {Array<{ x: number, y: number }>} neighbors - points to snap to
 * @param {number} gridSize - current grid size in world units
 */
export function applyOffGridNeighborSnap(raw, snapped, neighbors, gridSize) {
    const halfGrid = gridSize * 0.5;
    for (const nb of neighbors) {
        if (Math.abs(raw.x - nb.x) <= halfGrid) snapped.x = nb.x;
        if (Math.abs(raw.y - nb.y) <= halfGrid) snapped.y = nb.y;
    }
}

/**
 * Unified H/V and collinear snap for moving wire segments.
 *
 * Each edge describes a segment where `moving` is the endpoint being
 * displaced and `fixed` is the stationary neighbor.  If `beyond` is
 * supplied, a collinear check is also performed against the line through
 * `fixed` and `beyond`.
 *
 * Works regardless of snap-to-grid — the threshold is screen-pixel-based.
 *
 * @param {number} threshold - snap distance in world units
 * @param {Array<{ moving: {x,y}, fixed: {x,y}, beyond?: {x,y} }>} edges
 * @param {string} [axisLock] - 'horizontal'|'vertical' drag-axis constraint
 * @returns {{ adjustX: number, adjustY: number, guides: Array<[{x,y},{x,y}]> }}
 */
export function computeMovingSegmentSnaps(threshold, edges, axisLock) {
    let adjustX = 0, adjustY = 0;

    // ── Collinear snap (first match adjusts position) ──
    let collinearSnapped = false;
    for (const { moving, fixed, beyond } of edges) {
        if (!beyond) continue;
        const mx = moving.x + adjustX, my = moving.y + adjustY;
        const snap = collinearSnap(fixed, { x: mx, y: my }, beyond, threshold);
        if (!snap) continue;
        let offX = snap.x - mx, offY = snap.y - my;
        if (axisLock === 'vertical') offX = 0;
        else if (axisLock === 'horizontal') offY = 0;
        adjustX += offX;
        adjustY += offY;
        collinearSnapped = true;
        break;
    }

    // ── H/V snap (skipped if collinear already adjusted) ──
    if (!collinearSnapped) {
        let bestAbsX = Infinity, bestAbsY = Infinity;
        let bestAdjX = 0, bestAdjY = 0;
        for (const { moving, fixed } of edges) {
            const mx = moving.x + adjustX, my = moving.y + adjustY;
            const diffY = Math.abs(my - fixed.y);
            const diffX = Math.abs(mx - fixed.x);
            if (axisLock !== 'horizontal' && diffY < threshold && diffY < bestAbsY) {
                bestAdjY = fixed.y - my;
                bestAbsY = diffY;
            }
            if (axisLock !== 'vertical' && diffX < threshold && diffX < bestAbsX) {
                bestAdjX = fixed.x - mx;
                bestAbsX = diffX;
            }
        }
        adjustX += bestAdjX;
        adjustY += bestAdjY;
    }

    // ── Guides: one per unique fixed point, collinear preferred over H/V ──
    const covered = new Set();
    const guides = [];
    // Collinear guides first (skip if fixed already covered by a prior guide
    // to avoid overlapping highlights on straight multi-segment wires)
    for (const { moving, fixed, beyond } of edges) {
        if (!beyond) continue;
        if (covered.has(fixed)) continue;
        const mx = moving.x + adjustX, my = moving.y + adjustY;
        if (!collinearSnap(fixed, { x: mx, y: my }, beyond, threshold)) continue;
        covered.add(fixed);
        covered.add(beyond);
        const pts = [{ x: mx, y: my }, fixed, beyond];
        const rx = Math.abs(beyond.x - fixed.x);
        const ry = Math.abs(beyond.y - fixed.y);
        pts.sort((a, b) => rx >= ry ? a.x - b.x : a.y - b.y);
        guides.push([pts[0], pts[2]]);
    }
    // H/V guides (skip fixed points already covered by collinear,
    // and skip alignments that are trivially preserved by the axis lock)
    for (const { moving, fixed } of edges) {
        if (covered.has(fixed)) continue;
        const mx = moving.x + adjustX, my = moving.y + adjustY;
        const yAligned = axisLock !== 'horizontal' && Math.abs(my - fixed.y) < threshold;
        const xAligned = axisLock !== 'vertical' && Math.abs(mx - fixed.x) < threshold;
        if (yAligned || xAligned) {
            guides.push([{ x: mx, y: my }, fixed]);
            covered.add(fixed);
        }
    }

    return { adjustX, adjustY, guides };
}

/**
 * Compute collinear/H-V snap and guide lines for a wire anchor drag.
 * Delegates to computeMovingSegmentSnaps.
 */
export function computeAnchorCollinearSnap(app, wire, anchorId, anchorPos) {
    const match = anchorId.match(/^p(\d+)$/);
    if (!match) return { anchorPos, guides: [] };

    const idx = parseInt(match[1]);
    const pts = wire.points;
    const threshold = SNAP_SCREEN_PX / app.viewport.scale;
    const edges = [];

    // Interior point: collinear across the bend (prev ↔ next)
    if (idx > 0 && idx < pts.length - 1) {
        edges.push({ moving: anchorPos, fixed: pts[idx - 1], beyond: pts[idx + 1] });
        // Extended: collinear with segment beyond each neighbor
        // (only for interior points — endpoint cases already cover this)
        if (idx + 2 < pts.length) {
            edges.push({ moving: anchorPos, fixed: pts[idx + 1], beyond: pts[idx + 2] });
        }
        if (idx - 2 >= 0) {
            edges.push({ moving: anchorPos, fixed: pts[idx - 1], beyond: pts[idx - 2] });
        }
    }
    // Endpoint 0: collinear with first two neighbors
    if (idx === 0 && pts.length >= 3) {
        edges.push({ moving: anchorPos, fixed: pts[1], beyond: pts[2] });
    }
    // Last endpoint: collinear with last two neighbors
    if (idx === pts.length - 1 && pts.length >= 3) {
        edges.push({ moving: anchorPos, fixed: pts[pts.length - 2], beyond: pts[pts.length - 3] });
    }
    // H/V with immediate neighbors
    if (idx > 0) edges.push({ moving: anchorPos, fixed: pts[idx - 1] });
    if (idx < pts.length - 1) edges.push({ moving: anchorPos, fixed: pts[idx + 1] });

    const result = computeMovingSegmentSnaps(threshold, edges);
    return {
        anchorPos: { x: anchorPos.x + result.adjustX, y: anchorPos.y + result.adjustY },
        guides: result.guides
    };
}

/**
 * Compute snap position, pin/wire highlight, and guide lines for a wire
 * segment drag.  Collinear and H/V logic delegates to
 * computeMovingSegmentSnaps.
 */
export function computeSegmentDragSnap(app, wire, segIdx, origState, target, dragSegAxis, excludeWires = null) {
    const snappedTarget = app.viewport.getSnappedPosition(target);
    const gridSize = app.viewport.gridSize || 1.0;
    const origPtA = origState.points[segIdx];
    const origPtB = origState.points[segIdx + 1];
    const segOffX = origPtB.x - origPtA.x;
    const segOffY = origPtB.y - origPtA.y;

    // Off-grid neighbor snap lines
    const neighbors = [];
    if (segIdx > 0) neighbors.push(origState.points[segIdx - 1]);
    if (segIdx + 2 < origState.points.length) neighbors.push(origState.points[segIdx + 2]);
    applyOffGridNeighborSnap(target, snappedTarget, neighbors, gridSize);

    // Pin snap — check both endpoints, pick closest
    const rawA = target;
    const rawB = { x: target.x + segOffX, y: target.y + segOffY };
    let highlight = null;

    const pinA = findNearbyPin(app.components, rawA, PIN_SNAP_TOL);
    const pinB = findNearbyPin(app.components, rawB, PIN_SNAP_TOL);
    let bestPin = null, bestRaw = null;
    if (pinA && pinB) {
        bestPin = pinA.distance <= pinB.distance ? pinA : pinB;
        bestRaw = pinA.distance <= pinB.distance ? rawA : rawB;
    } else if (pinA) { bestPin = pinA; bestRaw = rawA; }
    else if (pinB) { bestPin = pinB; bestRaw = rawB; }

    if (bestPin) {
        let offX = bestPin.worldPos.x - bestRaw.x;
        let offY = bestPin.worldPos.y - bestRaw.y;
        if (dragSegAxis === 'vertical') offX = 0;
        else if (dragSegAxis === 'horizontal') offY = 0;
        snappedTarget.x = target.x + offX;
        snappedTarget.y = target.y + offY;
        highlight = bestPin;
    } else {
        // Wire junction highlight (exclude T-junction-linked wires that move
        // along with the drag — they are not new connections)
        const wireExclude = excludeWires ? new Set([wire, ...excludeWires]) : new Set([wire]);
        const futureA = { x: snappedTarget.x, y: snappedTarget.y };
        const futureB = { x: snappedTarget.x + segOffX, y: snappedTarget.y + segOffY };
        for (const ep of [futureA, futureB]) {
            const nw = findNearbyWirePoint(app, ep, WIRE_SNAP_TOL, wireExclude);
            if (nw) { highlight = nw; break; }
        }
    }

    // Collinear and H/V via unified function
    const futureA = { x: snappedTarget.x, y: snappedTarget.y };
    const futureB = { x: snappedTarget.x + segOffX, y: snappedTarget.y + segOffY };
    const snapEdges = [];
    if (segIdx > 0) {
        snapEdges.push({ moving: futureA, fixed: wire.points[segIdx - 1], beyond: futureB });
    }
    if (segIdx + 2 < wire.points.length) {
        snapEdges.push({ moving: futureB, fixed: wire.points[segIdx + 2], beyond: futureA });
    }
    const threshold = SNAP_SCREEN_PX / app.viewport.scale;
    const snapResult = computeMovingSegmentSnaps(threshold, snapEdges, dragSegAxis);
    snappedTarget.x += snapResult.adjustX;
    snappedTarget.y += snapResult.adjustY;

    return { snappedTarget, guides: snapResult.guides, highlight };
}

/**
 * Compute H/V snap adjustment and guide lines for sticky wire segments
 * connected to moving components.  Combines the nudge and guide logic
 * into a single call via computeMovingSegmentSnaps.
 *
 * @param {object} app
 * @param {Set<string>} movingCompIds
 * @param {number} proposedDx - grid-snapped dx about to be applied
 * @param {number} proposedDy - grid-snapped dy about to be applied
 * @returns {{ adjustX: number, adjustY: number, guides: Array<[{x,y},{x,y}]> }}
 */
export function computeStickyWireSnaps(app, movingCompIds, proposedDx, proposedDy) {
    // Threshold must be at least half-grid so the nudge can bridge the gap
    // between a grid-snapped component position and off-grid pin alignment.
    const screenThreshold = SNAP_SCREEN_PX / app.viewport.scale;
    const halfGrid = (app.viewport.gridSize || 1.0) * 0.5;
    const threshold = Math.max(screenThreshold, halfGrid);
    const edges = [];

    for (const shape of app.shapes) {
        if (shape.type !== 'wire') continue;
        const conn = shape.connections;
        if (!conn.start && !conn.end) continue;
        const startComp = conn.start && movingCompIds.has(conn.start.componentId);
        const endComp = conn.end && movingCompIds.has(conn.end.componentId);
        if (!startComp && !endComp) continue;

        if (startComp && shape.points.length >= 2) {
            edges.push({
                moving: { x: shape.points[0].x + proposedDx, y: shape.points[0].y + proposedDy },
                fixed: shape.points[1]
            });
        }
        if (endComp && shape.points.length >= 2) {
            edges.push({
                moving: { x: shape.points[shape.points.length - 1].x + proposedDx,
                           y: shape.points[shape.points.length - 1].y + proposedDy },
                fixed: shape.points[shape.points.length - 2]
            });
        }
    }

    return computeMovingSegmentSnaps(threshold, edges);
}


