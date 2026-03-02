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

import { Wire, COLLINEAR_EPSILON as _SHAPE_COLLINEAR_EPSILON } from '../../shapes/index.js';
import { BatchCommand, AddShapeCommand, ModifyShapeCommand, DeleteShapesCommand } from '../../core/CommandHistory.js';
import { distanceToSegment, pointsMatch, pointsCollinear, segmentsCollinear, collinearSnap } from '../../core/geometry.js';

// --- Constants ---

/** Snap threshold in screen pixels (divided by viewport.scale for world units). */
export const SNAP_SCREEN_PX = 5;

/** Epsilon for detecting collinear H/V segments (world units). Re-exported from Wire shape. */
export const COLLINEAR_EPSILON = _SHAPE_COLLINEAR_EPSILON;

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

/** Maximum iterations for pairwise merge loop. */
const MAX_MERGE_ITERATIONS = 50;

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

/**
 * Resolve the unique key for a pin-snap object.
 * Handles the multiple fallback fields in component pin data.
 */
function _getPinKey(snapInfo) {
    return snapInfo?.pinKey || snapInfo?.pin?._key || snapInfo?.pin?._id || snapInfo?.pin?.number;
}

/**
 * Compare two pin-snap objects for identity (same component + same pin).
 * @param {object} pin1 - Pin snap info
 * @param {object} pin2 - Pin snap info
 * @returns {boolean}
 */
export function isSamePin(pin1, pin2) {
    if (pin1?.component?.id !== pin2?.component?.id) return false;
    const key1 = _getPinKey(pin1), key2 = _getPinKey(pin2);
    if (key1 && key2) return key1 === key2;
    return pin1?.pin?.number === pin2?.pin?.number;
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
 * @param {object} [options.excludeWire] - Wire to exclude entirely from wire snap
 * @param {{wire,nodeId}} [options.excludeNode] - Skip one node + its incident edges (partial exclusion)
 * @param {Array<{a:{x,y},b:{x,y}}>} [options.extraSegments] - Additional segments to check (e.g. in-progress wirePoints)
 * @param {number} [options.pinTolerance=PIN_SNAP_TOL] - Pin detection radius
 * @param {number} [options.wireTolerance=WIRE_SNAP_TOL] - Wire detection radius
 * @returns {{ x, y, snapPin, snapType: 'pin'|'endpoint'|'segment'|'grid', wireDir? }}
 */
export function resolveWireSnapPosition(app, worldPos, options = {}) {
    const {
        excludePin = null,
        excludeWire = null,
        excludeNode = null,
        extraSegments = null,
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
    const nearWire = findNearbyWirePoint(app, worldPos, wireTolerance, excludeWire, { excludeNode, extraSegments });
    if (nearWire) {
        if (nearWire.type === 'endpoint') {
            return {
                x: nearWire.x,
                y: nearWire.y,
                snapPin: null,
                snapType: 'endpoint',
            };
        } else {
            // Segment T-junction snap.
            // For axis-aligned (H/V) segments, constrain the wire's axis
            // and grid-snap the free axis.  For angled segments, snap to
            // the nearest point along the segment direction so we stay
            // exactly on the line.
            if (nearWire.wireDir === 'horizontal') {
                const gridSnapped = app.viewport.getSnappedPosition(nearWire);
                return { x: gridSnapped.x, y: nearWire.y, snapPin: null, snapType: 'segment', wireDir: 'horizontal' };
            } else if (nearWire.wireDir === 'vertical') {
                const gridSnapped = app.viewport.getSnappedPosition(nearWire);
                return { x: nearWire.x, y: gridSnapped.y, snapPin: null, snapType: 'segment', wireDir: 'vertical' };
            } else {
                // Angled segment: use the on-segment point directly
                return { x: nearWire.x, y: nearWire.y, snapPin: null, snapType: 'segment', wireDir: nearWire.wireDir };
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
    // Pass earlier wirePoints as extra segments so loop-back self-join
    // snapping works — these segments aren't in app.shapes yet.
    const excludePin = lastPoint.pin ? { component: lastPoint.pin.component, pin: lastPoint.pin.pin } : null;
    const extraSegments = _buildDrawingExtraSegments(app.wirePoints);
    const snap = resolveWireSnapPosition(app, worldPos, {
        excludePin,
        extraSegments,
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
        //
        // Guard: only accept the segment snap if the axis-constrained drawing
        // position is itself near the snap point.  Without this, the raw cursor
        // wandering toward a parallel wire above/below triggers an unwanted
        // auto-corner even though the constrained wire is far from the target.
        const constrainedPos = axis === 'horizontal'
            ? { x: worldPos.x, y: lastPoint.y }
            : { x: lastPoint.x, y: worldPos.y };
        const distFromConstrained = Math.hypot(constrainedPos.x - snap.x, constrainedPos.y - snap.y);
        if (distFromConstrained <= WIRE_SNAP_TOL) {
            const corner = { x: snap.x, y: lastPoint.y };
            return { x: snap.x, y: snap.y, snapPin: null, snapType: 'segment', corner };
        }
        // Segment too far from constrained position — fall through to grid snap
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

/**
 * Build the extra-segments array from in-progress wirePoints for
 * self-join detection.  Skips the last segment (it leads into the
 * current cursor position) and needs ≥ 3 points (≥ 2 segments).
 *
 * @param {Array<{x:number,y:number}>} pts - app.wirePoints
 * @returns {Array<{a:{x,y},b:{x,y}}>|null}
 */
function _buildDrawingExtraSegments(pts) {
    if (!pts || pts.length < 3) return null;
    const segs = [];
    for (let i = 0, end = pts.length - 2; i < end; i++) {
        segs.push({ a: pts[i], b: pts[i + 1] });
    }
    return segs;
}

// --- Drawing lifecycle ---

/**
 * Begin drawing a new wire from a snapped start position.
 * Sets up app.wirePoints, axis lock, and shows the crosshair.
 * @param {object} app - SchematicApp instance
 * @param {{x: number, y: number, snapPin?: object}} snappedData - Start position
 */
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

/**
 * Update the wire-drawing preview as the cursor moves.
 * Calculates snap target and updates the preview SVG.
 * @param {object} app - SchematicApp instance
 * @param {{x: number, y: number}} worldPos - Raw cursor position in world coords
 */
export function updateWireDrawing(app, worldPos) {
    if (!app.isDrawing || app.wirePoints.length === 0) return;

    // Calculate snapped target (includes snap detection via resolveWireSnapPosition)
    const target = getDrawingSnappedPosition(app, worldPos);

    updateSnapHighlight(app, target);

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

/**
 * Add a waypoint (corner) to the wire being drawn.
 * Collinear points are collapsed automatically.
 * @param {object} app - SchematicApp instance
 * @param {{x: number, y: number, snapPin?: object}} waypointData
 */
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

/**
 * Finish the current wire drawing: create a Wire shape from the
 * accumulated waypoints, run reconciliation (merge, overlap,
 * junctions), and push an undo batch.
 * @param {object} app - SchematicApp instance
 * @param {{x: number, y: number, snapPin?: object}} worldPos - Final endpoint
 */
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

    // Build graph nodes/edges from the drawn points
    const graphNodes = {}, graphEdges = {}, pinConns = {};
    let nc = 0, ec = 0;
    const pts = app.wirePoints;
    let prevId = null;
    for (const pt of pts) {
        const nid = `n${nc++}`;
        graphNodes[nid] = { x: pt.x, y: pt.y };
        if (prevId !== null) {
            const eid = `e${ec++}`;
            graphEdges[eid] = { from: prevId, to: nid };
        }
        prevId = nid;
    }
    const firstPt = pts[0], lastPt = pts[pts.length - 1];
    if (firstPt.pin)
        pinConns['n0'] = { componentId: firstPt.pin.component.id, pinNumber: firstPt.pin.pin.number };
    if (lastPt.pin)
        pinConns[`n${nc - 1}`] = { componentId: lastPt.pin.component.id, pinNumber: lastPt.pin.pin.number };

    const wire = new Wire({
        graphNodes, graphEdges, pinConnections: pinConns,
        color: WIRE_COLOR, lineWidth: WIRE_WIDTH,
    });

    // Snapshot all existing wires before any mutations
    const existingWires = app.shapes.filter(s => s.type === 'wire');
    const beforeStates = new Map();
    for (const w of existingWires) beforeStates.set(w, w.captureState());

    // Add wire without creating a standalone undo entry
    app._addShapeInternal(wire);

    // Unified reconciliation: overlap trim, merge, collapse, junctions
    reconcileWires(app, [wire]);

    // Update pin connections
    if (app.shapes.includes(wire)) refreshWireConnections(app, wire);

    // If the wire was fully absorbed (e.g. redundant), revert and cancel
    if (!app.shapes.includes(wire) && wire.edges.size === 0) {
        for (const [w, before] of beforeStates) {
            if (!app.shapes.includes(w)) {
                w.applyState(before);
                app._addShapeInternal(w);
            } else {
                w.applyState(before);
            }
        }
        cancelWireDrawing(app);
        return;
    }

    // Build undo batch (drawn wire is an extra add since it's new)
    const batch = buildWireDiffBatch(app, beforeStates, 'Draw wire', [wire]);
    if (batch) app.history.execute(batch);
    cancelWireDrawing(app);
    app.renderShapes(true);
}

/**
 * Cancel the current wire drawing, cleaning up preview and state.
 * @param {object} app - SchematicApp instance
 */
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

/**
 * Redraw the wire-drawing preview SVG from app.wirePoints
 * plus the current cursor position (app.drawCurrent).
 * @param {object} app - SchematicApp instance
 */
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
    const pinGroup = snapPin.component.pinElements?.get(_getPinKey(snapPin));
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
    const pinGroup = app.wireSnapPin.component.pinElements?.get(_getPinKey(app.wireSnapPin));
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
 * Accepts three input forms:
 *   - A snap result (has .snapType): automatically converted
 *   - A pin snap object (has .pin): show pin dot
 *   - A wire junction {x, y, type} (no .pin): show junction dot
 *   - null: clear all highlights
 */
export function updateSnapHighlight(app, target) {
    // Accept snap resolver results directly — convert to highlight format
    if (target?.snapType) {
        if (target.snapType === 'pin' && target.snapPin) {
            target = target.snapPin;
        } else if (target.snapType === 'endpoint' || target.snapType === 'segment') {
            target = { x: target.x, y: target.y, type: target.snapType };
        } else {
            target = null;
        }
    }

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
 * Classify a segment direction as horizontal, vertical, or angled.
 * H/V threshold: the minor axis must be < 5% of the major axis.
 */
function _classifyDir(dx, dy) {
    const ax = Math.abs(dx), ay = Math.abs(dy);
    const ratio = Math.min(ax, ay) / Math.max(ax, ay);
    if (ratio < 0.05) return ax >= ay ? 'horizontal' : 'vertical';
    return 'angled';
}

/**
 * Find the nearest point on another wire (node or edge interior)
 * that is within tolerance of worldPos.  Returns { x, y, type } or null.
 * type is 'endpoint' (snap to node) or 'segment' (T-junction on edge).
 */
export function findNearbyWirePoint(app, worldPos, tolerance, excludeWires = null, options = {}) {
    const excludeSet = !excludeWires ? new Set() :
        excludeWires instanceof Set ? excludeWires : new Set([excludeWires]);

    // Node-level exclusion: skip a specific node and its incident edges
    // on a wire, while still considering the wire's other nodes/edges.
    const { excludeNode = null, extraSegments = null } = options;
    let excNodeEdgeIds = null;
    if (excludeNode) {
        excNodeEdgeIds = new Set(
            excludeNode.wire.incidentEdges(excludeNode.nodeId).map(e => e.edgeId)
        );
    }

    let bestNode = null, bestNodeDist = tolerance;
    let bestEdge = null, bestEdgeDist = tolerance;

    for (const shape of app.shapes) {
        if (shape.type !== 'wire' || shape.edges.size === 0) continue;
        // Full-wire exclusion (skip entire shape)
        if (excludeSet.has(shape)) continue;

        const isPartiallyExcluded = excludeNode && shape === excludeNode.wire;

        // Check all nodes (endpoints, junctions, corners)
        for (const [nid, pos] of shape.nodes) {
            if (isPartiallyExcluded && nid === excludeNode.nodeId) continue;
            const d = Math.hypot(worldPos.x - pos.x, worldPos.y - pos.y);
            if (d < bestNodeDist) {
                bestNodeDist = d;
                bestNode = { x: pos.x, y: pos.y, type: 'endpoint' };
            }
        }

        // Check edges (T-junction)
        for (const [eid, e] of shape.edges) {
            if (isPartiallyExcluded && excNodeEdgeIds.has(eid)) continue;
            const a = shape.nodes.get(e.from), b = shape.nodes.get(e.to);
            if (!a || !b) continue;
            const dx = b.x - a.x, dy = b.y - a.y;
            const lenSq = dx * dx + dy * dy;
            if (lenSq === 0) continue;
            let t = ((worldPos.x - a.x) * dx + (worldPos.y - a.y) * dy) / lenSq;
            t = Math.max(0, Math.min(1, t));
            const px = a.x + t * dx, py = a.y + t * dy;
            const d = Math.hypot(worldPos.x - px, worldPos.y - py);
            if (d < bestEdgeDist) {
                // Only count if not at an existing node (but ignore the
                // excluded node — it may have been moved here by a prior frame)
                const hitNode = shape.nodeAt({ x: px, y: py }, VERTEX_EPSILON);
                if (!hitNode || (isPartiallyExcluded && hitNode === excludeNode.nodeId)) {
                    bestEdgeDist = d;
                    bestEdge = {
                        x: px, y: py,
                        type: 'segment',
                        wireDir: _classifyDir(dx, dy)
                    };
                }
            }
        }
    }

    // Extra segments: in-progress wirePoints not yet in app.shapes
    if (extraSegments) {
        for (const { a, b } of extraSegments) {
            const dx = b.x - a.x, dy = b.y - a.y;
            const lenSq = dx * dx + dy * dy;
            if (lenSq === 0) continue;
            let t = ((worldPos.x - a.x) * dx + (worldPos.y - a.y) * dy) / lenSq;
            t = Math.max(0, Math.min(1, t));
            const px = a.x + t * dx, py = a.y + t * dy;
            const d = Math.hypot(worldPos.x - px, worldPos.y - py);
            if (d < bestEdgeDist) {
                bestEdgeDist = d;
                bestEdge = {
                    x: px, y: py,
                    type: 'segment',
                    wireDir: _classifyDir(dx, dy)
                };
            }
        }
    }

    // Nodes always win over edges
    return bestNode || bestEdge;
}

// --- Wire point cleanup (graph model — handled by Wire.cleanGraph()) ---

/**
 * Collapse redundant collinear points in a wire.
 * Delegates to Wire.cleanGraph() in the graph model.
 */
export function collapseRedundantWirePoints(app, wire) {
    if (wire && wire.cleanGraph) wire.cleanGraph();
}

// --- Junctions (graph model — junctions are degree ≥ 3 nodes, automatic) ---

/**
 * Check whether a point coincides with a node on any non-excluded wire.
 */
export function isTJunctionPoint(app, pt, ...excludeWires) {
    if (!app) return false;
    for (const s of app.shapes) {
        if (s.type !== 'wire') continue;
        if (excludeWires.includes(s)) continue;
        if (s.nodeAt(pt, VERTEX_EPSILON)) return true;
    }
    return false;
}

// --- Sticky wires (requirement 6) ---

/**
 * Refresh a wire's pin connections by checking which nodes coincide
 * with component pins.  Call after anchor or segment drags.
 */
export function refreshWireConnections(app, wire) {
    if (!wire || wire.type !== 'wire' || wire.edges.size === 0) return;
    const tolerance = 0.1;
    wire.pinConnections.clear();
    for (const [nodeId, pos] of wire.nodes) {
        const nearPin = findNearbyPin(app.components, pos, tolerance);
        if (nearPin) {
            wire.pinConnections.set(nodeId, {
                componentId: nearPin.component.id,
                pinNumber: nearPin.pin.number
            });
        }
    }
}

/**
 * Call this after moving components. For every wire node that has a pin
 * connection, update that node to the pin's current world position.
 * NOTE: Also duplicated inline in MoveShapesCommand (core/CommandHistory.js)
 * to avoid circular imports — keep both in sync.
 */
export function updateStickyWires(app) {
    for (const shape of app.shapes) {
        if (shape.type !== 'wire') continue;
        for (const [nodeId, conn] of shape.pinConnections) {
            const comp = app.components.find(c => c.id === conn.componentId);
            if (!comp) continue;
            const pos = comp.getPinPosition(conn.pinNumber);
            if (!pos) continue;
            const node = shape.nodes.get(nodeId);
            if (node) {
                node.x = pos.x;
                node.y = pos.y;
                shape.invalidate();
            }
        }
    }
}

// --- Unified wire reconciliation (graph model) ---

/**
 * Try to merge two wire graphs.  Checks if any node of wireA is near
 * a node or on an edge of wireB (and vice-versa).  If found, absorbs
 * wireB into wireA, merges coincident nodes, and removes wireB from
 * app.shapes.  Returns true if a merge occurred.
 */
function _tryMergeGraphs(app, wireA, wireB, affected, changed) {
    // Forward: A's nodes → B's nodes/edges
    for (const [nodeId, pos] of wireA.nodes) {
        const match = wireB.nodeAt(pos, VERTEX_EPSILON);
        if (match) {
            const remap = wireA.absorb(wireB);
            wireA.mergeNodes(nodeId, remap.get(match));
            _removeMerged(app, wireB, affected, changed, wireA);
            return true;
        }
        const onEdge = wireB.closestEdge(pos);
        if (onEdge && onEdge.distance < VERTEX_EPSILON) {
            const split = wireB.splitEdge(onEdge.edgeId, pos);
            const remap = wireA.absorb(wireB);
            wireA.mergeNodes(nodeId, remap.get(split.newNodeId));
            _removeMerged(app, wireB, affected, changed, wireA);
            return true;
        }
    }
    // Reverse: B's nodes → A's edges
    for (const [nodeId, pos] of wireB.nodes) {
        if (wireA.nodeAt(pos, VERTEX_EPSILON)) continue;   // handled above
        const onEdge = wireA.closestEdge(pos);
        if (onEdge && onEdge.distance < VERTEX_EPSILON) {
            const split = wireA.splitEdge(onEdge.edgeId, pos);
            const remap = wireA.absorb(wireB);
            wireA.mergeNodes(split.newNodeId, remap.get(nodeId));
            _removeMerged(app, wireB, affected, changed, wireA);
            return true;
        }
    }
    return false;
}

function _removeMerged(app, removed, affected, changed, keeper) {
    app._removeShapeInternal(removed);
    affected.delete(removed);
    changed.delete(removed);
    if (!changed.has(keeper)) changed.add(keeper);
}

/**
 * Unified wire reconciliation (graph model).
 *
 * Given one or more wires that just changed (drawn, moved, dragged),
 * performs 3 sequential passes:
 *
 *   1. Graph merge — absorb touching wires into one graph
 *   2. Clean graph — deduplicate edges, remove collinear degree-2 nodes
 *   3. Split disconnected components into separate Wire objects
 *
 * Discovers affected partner wires automatically by geometric proximity.
 * Modifies wires in place (nodes, edges).  May remove wires from app.shapes.
 *
 * @param {object} app
 * @param {Wire[]} changedWires - the wires that just changed
 * @param {Set<Wire>} [skipSet] - wires to skip pairwise checks against
 */
export function reconcileWires(app, changedWires, skipSet = null) {
    const changed = new Set(changedWires.filter(w => app.shapes.includes(w)));
    if (changed.size === 0) return;

    // Discover affected wires (any wire whose nodes/edges are near a changed wire)
    const affected = new Set(changed);
    for (const cw of changed) {
        for (const other of app.shapes) {
            if (other.type !== 'wire' || affected.has(other)) continue;
            if (skipSet && skipSet.has(other)) continue;
            // Forward: changed wire's nodes near other wire's edges
            let found = false;
            for (const pos of cw.nodes.values()) {
                if (other.distanceTo(pos) < VERTEX_EPSILON * 2) {
                    found = true; break;
                }
            }
            // Reverse: other wire's nodes near changed wire's edges
            if (!found) {
                for (const pos of other.nodes.values()) {
                    if (cw.distanceTo(pos) < VERTEX_EPSILON * 2) {
                        found = true; break;
                    }
                }
            }
            if (found) affected.add(other);
        }
    }

    // ── Pass 1: Merge touching graphs ──
    let stable = false;
    let iterations = 0;
    while (!stable && iterations < MAX_MERGE_ITERATIONS) {
        stable = true;
        iterations++;
        for (const wireA of [...affected]) {
            if (!app.shapes.includes(wireA)) continue;
            for (const wireB of [...affected]) {
                if (wireB === wireA || !app.shapes.includes(wireB)) continue;
                if (_tryMergeGraphs(app, wireA, wireB, affected, changed)) {
                    stable = false;
                    break;
                }
            }
            if (!stable) break;
        }
    }

    // ── Pass 2: Clean graphs ──
    for (const w of affected) {
        if (!app.shapes.includes(w)) continue;
        w.cleanGraph();
        if (w.edges.size === 0) app._removeShapeInternal(w);
    }

    // ── Pass 3: Split disconnected components ──
    for (const w of [...affected]) {
        if (!app.shapes.includes(w)) continue;
        const comps = w.connectedComponents();
        if (comps.length <= 1) continue;
        // Keep the largest component in the original wire
        comps.sort((a, b) => b.size - a.size);
        const keepSet = comps[0];
        for (let i = 1; i < comps.length; i++) {
            const sub = w.extractSubgraph(comps[i]);
            if (sub.edges.size > 0) {
                app._addShapeInternal(sub);
                changed.add(sub);
            }
        }
        // Trim original to keep only the largest component
        for (const nid of [...w.nodes.keys()]) {
            if (!keepSet.has(nid)) w.removeNode(nid);
        }
        w.invalidate();
        if (w.edges.size === 0) app._removeShapeInternal(w);
    }
}

/**
 * Diff wire states before/after mutation and build an undo batch.
 * Reverts all wires to their before-state so batch.execute() replays correctly.
 *
 * @param {object} app
 * @param {Map<Wire, object>} beforeStates - captured states before mutation
 * @param {string} label - undo command label
 * @param {Wire[]} [extraAdds] - additional new wires to include as AddShapeCommand
 * @returns {BatchCommand|null} - batch or null if nothing changed
 */
export function buildWireDiffBatch(app, beforeStates, label, extraAdds = []) {
    const batch = new BatchCommand(label);
    let anyChanges = false;

    for (const [w, before] of beforeStates) {
        if (!app.shapes.includes(w)) {
            w.applyState(before);
            if (!app.shapes.includes(w)) app.shapes.push(w);
            batch.add(new DeleteShapesCommand(app, [w]));
            anyChanges = true;
        } else {
            const after = w.captureState();
            if (JSON.stringify(before) !== JSON.stringify(after)) {
                w.applyState(before);
                batch.add(new ModifyShapeCommand(app, w, before, after));
                anyChanges = true;
            }
        }
    }
    // New wires (from splits) — exclude extraAdds so they aren't double-counted
    const extraSet = new Set(extraAdds);
    for (const s of [...app.shapes]) {
        if (s.type === 'wire' && !beforeStates.has(s) && !extraSet.has(s)) {
            app._removeShapeInternal(s);
            batch.add(new AddShapeCommand(app, s));
            anyChanges = true;
        }
    }
    // Additional new wires (e.g. the drawn wire in finishWireDrawing)
    for (const w of extraAdds) {
        if (app.shapes.includes(w)) app._removeShapeInternal(w);
        batch.add(new AddShapeCommand(app, w));
        anyChanges = true;
    }

    return anyChanges ? batch : null;
}

/**
 * Build undo commands for wire reconciliation.  Snapshots all wire state
 * before reconciliation, runs it, then diffs to create the undo batch.
 *
 * @param {object} app
 * @param {Wire[]} changedWires
 * @param {Set<Wire>} [skipSet]
 * @returns {BatchCommand|null} - batch command or null if nothing changed
 */
export function reconcileWiresWithUndo(app, changedWires, skipSet = null) {
    // Snapshot all wires BEFORE
    const allWires = app.shapes.filter(s => s.type === 'wire');
    const beforeStates = new Map(allWires.map(w => [w, w.captureState()]));

    // Run reconciliation
    reconcileWires(app, changedWires, skipSet);

    // Refresh pin connections for all surviving changed wires
    for (const cw of changedWires) {
        if (app.shapes.includes(cw)) refreshWireConnections(app, cw);
    }

    // Diff and build undo batch
    const batch = buildWireDiffBatch(app, beforeStates, 'Wire reconciliation');
    if (!batch) return null;

    batch.execute();
    return batch;
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
    if (!wire.nodes.has(anchorId)) return { anchorPos, guides: [] };

    const threshold = SNAP_SCREEN_PX / app.viewport.scale;
    const edges = [];
    const neighbors = wire.incidentEdges(anchorId);

    // For each incident edge, add an H/V snap edge (moving ↔ neighbor)
    // plus walk collinear chains to find the farthest aligned node beyond
    for (const { otherNode } of neighbors) {
        const npos = wire.nodes.get(otherNode);
        if (!npos) continue;
        edges.push({ moving: anchorPos, fixed: npos });

        // Walk collinear chain from neighbor outward to find the endpoint
        let farthest = null;
        const visited = new Set([anchorId, otherNode]);
        const queue = [{ nodeId: otherNode, prevPos: anchorPos }];
        while (queue.length > 0) {
            const { nodeId: current, prevPos } = queue.shift();
            const currentPos = wire.nodes.get(current);
            if (!currentPos) continue;
            for (const { otherNode: beyond } of wire.incidentEdges(current)) {
                if (visited.has(beyond)) continue;
                visited.add(beyond);
                const bpos = wire.nodes.get(beyond);
                if (!bpos) continue;
                // Continue walking if this node continues the chain direction
                if (pointsCollinear(prevPos, currentPos, bpos)) {
                    farthest = bpos;
                    queue.push({ nodeId: beyond, prevPos: currentPos });
                }
            }
        }
        if (farthest) {
            edges.push({ moving: anchorPos, fixed: npos, beyond: farthest });
        }
    }

    // Collinear across the node (if degree 2, check through both neighbors)
    if (neighbors.length === 2) {
        const p1 = wire.nodes.get(neighbors[0].otherNode);
        const p2 = wire.nodes.get(neighbors[1].otherNode);
        if (p1 && p2) {
            edges.push({ moving: anchorPos, fixed: p1, beyond: p2 });
        }
    }

    const result = computeMovingSegmentSnaps(threshold, edges);
    return {
        anchorPos: { x: anchorPos.x + result.adjustX, y: anchorPos.y + result.adjustY },
        guides: result.guides
    };
}

/**
 * Compute snap position, pin/wire highlight, and guide lines for a wire
 * segment (edge) drag.  Collinear and H/V logic delegates to
 * computeMovingSegmentSnaps.
 *
 * @param {object} app
 * @param {Wire}   wire         - the wire being dragged
 * @param {string} dragEdgeId   - the edge being dragged
 * @param {object} origState    - captured state before drag {nodes, edges, …}
 * @param {{x,y}}  target       - raw cursor world position
 * @param {string} dragSegAxis  - 'horizontal'|'vertical'|null axis lock
 * @param {Set|null} excludeWires - wires to exclude from snap detection
 */
export function computeSegmentDragSnap(app, wire, dragEdgeId, origState, target, dragSegAxis, excludeWires = null) {
    const snappedTarget = app.viewport.getSnappedPosition(target);
    const gridSize = app.viewport.gridSize || 1.0;
    const origEdge = origState.edges[dragEdgeId];
    const origA = origState.nodes[origEdge.from];
    const origB = origState.nodes[origEdge.to];
    const segOffX = origB.x - origA.x;
    const segOffY = origB.y - origA.y;

    // Build the collinear chain: all nodes that move with the dragged segment
    const movingNodes = new Set([origEdge.from, origEdge.to]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const nodeId of [...movingNodes]) {
            for (const inc of wire.incidentEdges(nodeId)) {
                if (inc.edgeId === dragEdgeId || movingNodes.has(inc.otherNode)) continue;
                const a = origState.nodes[inc.otherNode];
                const b = origState.nodes[nodeId];
                if (!a || !b || !origA || !origB) continue;
                if (pointsCollinear(a, b, origA) && pointsCollinear(a, b, origB)) {
                    movingNodes.add(inc.otherNode);
                    grew = true;
                }
            }
        }
    }

    // Collect fixed neighbors at the chain boundary (for off-grid snap + guides)
    const fixedNeighbors = [];
    for (const nodeId of movingNodes) {
        for (const { otherNode } of wire.incidentEdges(nodeId)) {
            if (movingNodes.has(otherNode)) continue;
            const p = wire.nodes.get(otherNode);
            if (p) fixedNeighbors.push(p);
        }
    }

    // Off-grid neighbor snap (use fixed chain-boundary neighbors)
    applyOffGridNeighborSnap(target, snappedTarget, fixedNeighbors, gridSize);

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
        // Wire junction highlight — check endpoint proximity first
        const wireExclude = excludeWires ? new Set([wire, ...excludeWires]) : new Set([wire]);
        const futureA = { x: snappedTarget.x, y: snappedTarget.y };
        const futureB = { x: snappedTarget.x + segOffX, y: snappedTarget.y + segOffY };
        for (const ep of [futureA, futureB]) {
            const nw = findNearbyWirePoint(app, ep, WIRE_SNAP_TOL, wireExclude);
            if (nw) { highlight = nw; break; }
        }
        // Also check if any other wire's node falls on the dragged edge body
        if (!highlight) {
            for (const other of app.shapes) {
                if (other.type !== 'wire' || wireExclude.has(other)) continue;
                for (const [, npos] of other.nodes) {
                    const d = distanceToSegment(npos, futureA, futureB);
                    if (d < WIRE_SNAP_TOL) {
                        highlight = { x: npos.x, y: npos.y, type: 'endpoint' };
                        break;
                    }
                }
                if (highlight) break;
            }
        }
    }

    // Collinear and H/V via unified function
    const futureA = { x: snappedTarget.x, y: snappedTarget.y };
    const futureB = { x: snappedTarget.x + segOffX, y: snappedTarget.y + segOffY };
    const snapEdges = [];
    // Use fixed chain-boundary neighbors as snap/guide targets
    for (const p of fixedNeighbors) {
        snapEdges.push({ moving: futureA, fixed: p, beyond: futureB });
    }
    const threshold = SNAP_SCREEN_PX / app.viewport.scale;
    const snapResult = computeMovingSegmentSnaps(threshold, snapEdges, dragSegAxis);
    snappedTarget.x += snapResult.adjustX;
    snappedTarget.y += snapResult.adjustY;

    return { snappedTarget, guides: snapResult.guides, highlight };
}

/**
 * Compute H/V snap adjustment and guide lines for sticky wire nodes
 * connected to moving components.
 *
 * @param {object} app
 * @param {Set<string>} movingCompIds
 * @param {number} proposedDx - grid-snapped dx about to be applied
 * @param {number} proposedDy - grid-snapped dy about to be applied
 * @returns {{ adjustX: number, adjustY: number, guides: Array<[{x,y},{x,y}]> }}
 */
export function computeStickyWireSnaps(app, movingCompIds, proposedDx, proposedDy) {
    const screenThreshold = SNAP_SCREEN_PX / app.viewport.scale;
    const halfGrid = (app.viewport.gridSize || 1.0) * 0.5;
    const threshold = Math.max(screenThreshold, halfGrid);
    const edges = [];

    for (const shape of app.shapes) {
        if (shape.type !== 'wire') continue;
        if (shape.pinConnections.size === 0) continue;

        for (const [nodeId, conn] of shape.pinConnections) {
            if (!movingCompIds.has(conn.componentId)) continue;
            const node = shape.nodes.get(nodeId);
            if (!node) continue;
            // Find a non-moving neighbor node for the snap reference
            const neighbors = shape.incidentEdges(nodeId);
            for (const { otherNode } of neighbors) {
                const npos = shape.nodes.get(otherNode);
                if (!npos) continue;
                // Only use non-moving neighbors as fixed reference
                const otherConn = shape.pinConnections.get(otherNode);
                if (otherConn && movingCompIds.has(otherConn.componentId)) continue;
                edges.push({
                    moving: { x: node.x + proposedDx, y: node.y + proposedDy },
                    fixed: npos
                });
            }
        }
    }

    return computeMovingSegmentSnaps(threshold, edges);
}


