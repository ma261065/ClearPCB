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
 * @param {number} [options.pinTolerance=1.5] - Pin detection radius
 * @param {number} [options.wireTolerance=0.5] - Wire detection radius
 * @returns {{ x, y, snapPin, snapType: 'pin'|'endpoint'|'segment'|'grid', wireDir? }}
 */
export function resolveWireSnapPosition(app, worldPos, options = {}) {
    const {
        excludePin = null,
        excludeWire = null,
        pinTolerance = 1.5,
        wireTolerance = 0.5
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
        pinTolerance: 1.5,
        wireTolerance: 0.5,
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
    const pinSnap = findNearbyPin(app.components, worldPos, 1.5);

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
 * Snap for wire anchor editing (requirement 10).
 * The other end of each connected segment provides an invisible snap line
 * so wires stay orthogonal even off-grid. Grid still applies in the
 * perpendicular direction.
 */
export function getWireAnchorSnappedPosition(app, wireShape, anchorId, worldPos) {
    const snapped = app.viewport.getSnappedPosition(worldPos);
    const match = anchorId?.match(/^p(\d+)$/);
    if (!match || !wireShape?.points) return snapped;

    const idx = parseInt(match[1]);
    if (idx < 0 || idx >= wireShape.points.length) return snapped;

    const gridSize = app.viewport.gridSize || 1.0;
    const halfGrid = gridSize * 0.5;

    // Collect snap lines from neighboring vertices
    const neighbors = [];
    if (idx > 0) neighbors.push(wireShape.points[idx - 1]);
    if (idx < wireShape.points.length - 1) neighbors.push(wireShape.points[idx + 1]);

    // Also check pin snap lines
    const pinSnap = findNearbyPin(app.components, worldPos, 1.5);

    let snapX = snapped.x;
    let snapY = snapped.y;

    for (const n of neighbors) {
        if (Math.abs(worldPos.x - n.x) <= halfGrid) snapX = n.x;
        if (Math.abs(worldPos.y - n.y) <= halfGrid) snapY = n.y;
    }

    if (pinSnap) {
        if (Math.abs(worldPos.x - pinSnap.worldPos.x) <= halfGrid) snapX = pinSnap.worldPos.x;
        if (Math.abs(worldPos.y - pinSnap.worldPos.y) <= halfGrid) snapY = pinSnap.worldPos.y;
    }

    // Also check nearby wire endpoints/segments for off-grid snap
    const nearWire = findNearbyWirePoint(app, worldPos, halfGrid, wireShape);
    if (nearWire) {
        if (Math.abs(worldPos.x - nearWire.x) <= halfGrid) snapX = nearWire.x;
        if (Math.abs(worldPos.y - nearWire.y) <= halfGrid) snapY = nearWire.y;
    }

    return { x: snapX, y: snapY };
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
        color: '#00cc66',
        lineWidth: 0.25,
        connections: {
            start: firstPt.pin ? { componentId: firstPt.pin.component.id, pinNumber: firstPt.pin.pin.number } : null,
            end: lastPt.pin ? { componentId: lastPt.pin.component.id, pinNumber: lastPt.pin.pin.number } : null
        }
    });

    app.addShape(wire);

    // Post-placement: check for joins onto other wires
    processWireJoins(app, wire);

    // Check for end-to-end merges
    processWireMerges(app, wire);

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
                stroke="#00cc66" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
    }

    // Draw waypoint dots
    for (const p of pts) {
        svg += `<circle cx="${p.x}" cy="${p.y}" r="${2 / app.viewport.scale}" fill="#00cc66"/>`;
    }

    // Debug: draw choice zone circle around last waypoint (original position)
    if (pts.length > 0) {
        const last = pts[pts.length - 1];
        const cx = last._savedX !== undefined ? last._savedX : last.x;
        const cy = last._savedY !== undefined ? last._savedY : last.y;
        const zoneRadius = Math.max(strokeWidth * 2, 20 / app.viewport.scale);
        svg += `<circle cx="${cx}" cy="${cy}" r="${zoneRadius}" 
                fill="none" stroke="#ffff00" stroke-width="${1 / app.viewport.scale}" stroke-opacity="0.5" stroke-dasharray="${3 / app.viewport.scale}"/>`;
    }

    // Draw live segment from last waypoint to cursor (with optional corner)
    if (app.drawCurrent && pts.length > 0) {
        const last = pts[pts.length - 1];
        if (app.drawCorner) {
            const c = app.drawCorner;
            svg += `<line x1="${last.x}" y1="${last.y}" x2="${c.x}" y2="${c.y}" 
                    stroke="#00cc66" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-opacity="0.6"/>`;
            svg += `<line x1="${c.x}" y1="${c.y}" x2="${app.drawCurrent.x}" y2="${app.drawCurrent.y}" 
                    stroke="#00cc66" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-opacity="0.6"/>`;
        } else {
            svg += `<line x1="${last.x}" y1="${last.y}" x2="${app.drawCurrent.x}" y2="${app.drawCurrent.y}" 
                    stroke="#00cc66" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-opacity="0.6"/>`;
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

// Keep named exports for backward compatibility (SchematicApp delegates)
export function highlightPin(app, snapPin) { _showPinDot(app, snapPin); }
export function unhighlightPin(app) {
    _hidePinDot(app);
    app.wireSnapPin = null;
}

// --- Wire junction detection ---

/**
 * Find the nearest point on another wire (endpoint or segment interior)
 * that is within tolerance of worldPos.  Returns { x, y, type } or null.
 * type is 'endpoint' (merge) or 'segment' (T-junction).
 */
export function findNearbyWirePoint(app, worldPos, tolerance, excludeWire = null) {
    // Pass 1: find closest endpoint (preferred — endpoint snaps are exact)
    let bestEp = null;
    let bestEpDist = tolerance;

    // Pass 2: find closest segment (T-junction, only used if no endpoint)
    let bestSeg = null;
    let bestSegDist = tolerance;

    for (const shape of app.shapes) {
        if (shape.type !== 'wire' || shape.points.length < 2) continue;
        if (shape === excludeWire) continue;

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

        // Check segments (T-junction)
        const seg = shape.closestSegment(worldPos);
        if (seg && seg.distance < bestSegDist) {
            // Only count as T-junction if not at an existing vertex
            let atVertex = false;
            for (const p of shape.points) {
                if (Math.hypot(seg.point.x - p.x, seg.point.y - p.y) < 0.15) {
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

    // Endpoints always win over segments when within tolerance
    return bestEp || bestSeg;
}

// --- Collinearity helper ---

/**
 * Check if two segments are collinear (parallel and overlapping direction).
 * seg1/seg2 are { a: {x,y}, b: {x,y} }.
 */
function segmentsCollinear(seg1, seg2, angleTol = 0.05) {
    const dx1 = seg1.b.x - seg1.a.x, dy1 = seg1.b.y - seg1.a.y;
    const dx2 = seg2.b.x - seg2.a.x, dy2 = seg2.b.y - seg2.a.y;
    const len1 = Math.hypot(dx1, dy1), len2 = Math.hypot(dx2, dy2);
    if (len1 < 1e-9 || len2 < 1e-9) return true; // degenerate
    // Cross product / (len1*len2) gives sin(angle)
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
 * After a new wire is placed, check if its endpoints land on another wire
 * segment (T-junction). If so, insert a vertex in the target wire and mark
 * it as a junction — but only if the incoming segment is NOT collinear with
 * the target segment (collinear means end-on overshoot, which should merge
 * instead of junction).
 */
export function processWireJoins(app, newWire) {
    const endpoints = [
        { pt: newWire.points[0], end: 'start' },
        { pt: newWire.points[newWire.points.length - 1], end: 'end' }
    ];

    for (const { pt, end } of endpoints) {
        for (const shape of app.shapes) {
            if (shape === newWire || shape.type !== 'wire') continue;
            const onSeg = shape.pointOnSegment(pt, 0.15);
            if (onSeg) {
                // Get the incoming segment of the new wire and the target segment
                const incoming = terminalSegment(newWire, end);
                const target = { a: shape.points[onSeg.segIndex], b: shape.points[onSeg.segIndex + 1] };

                if (incoming && segmentsCollinear(incoming, target)) {
                    // Collinear overshoot: snap new wire endpoint to nearest
                    // vertex of the target segment so processWireMerges can
                    // do an endpoint-to-endpoint merge.
                    const segA = shape.points[onSeg.segIndex];
                    const segB = shape.points[onSeg.segIndex + 1];
                    const dA = Math.hypot(pt.x - segA.x, pt.y - segA.y);
                    const dB = Math.hypot(pt.x - segB.x, pt.y - segB.y);
                    const nearIdx = dA < dB ? onSeg.segIndex : onSeg.segIndex + 1;
                    const snapPt = shape.points[nearIdx];

                    // Move new wire endpoint to snap point
                    if (end === 'start') {
                        newWire.points[0] = { x: snapPt.x, y: snapPt.y };
                    } else {
                        newWire.points[newWire.points.length - 1] = { x: snapPt.x, y: snapPt.y };
                    }
                    newWire.invalidate();

                    // If snap point is interior, split target into two wires
                    // so one of them has this point as an endpoint.
                    if (nearIdx > 0 && nearIdx < shape.points.length - 1) {
                        const secondPts = shape.points.slice(nearIdx).map(p => ({ x: p.x, y: p.y }));
                        shape.points = shape.points.slice(0, nearIdx + 1);
                        shape.junctions = new Set();
                        shape.invalidate();
                        const secondWire = new Wire({
                            points: secondPts,
                            color: '#00cc66',
                            lineWidth: 0.25,
                        });
                        app.addShape(secondWire);
                    }
                    // processWireMerges will handle the endpoint-to-endpoint merge
                    continue;
                }

                // Non-collinear: real T-junction
                const insertIdx = shape.splitAt(pt);
                shape.junctions.add(insertIdx);
                shape.invalidate();
                const epIdx = pointsMatch(pt, newWire.points[0]) ? 0 : newWire.points.length - 1;
                newWire.junctions.add(epIdx);
                newWire.invalidate();
            }
        }
    }
}

/**
 * Merge two point arrays at a shared seam, dropping the seam point if
 * collinear with its neighbors (no redundant anchor on a straight wire).
 * front ends at the shared point; back starts after it.
 */
function mergeWirePoints(front, back) {
    if (front.length >= 2 && back.length >= 1) {
        const a = front[front.length - 2];
        const b = front[front.length - 1]; // seam point
        const c = back[0];
        if (segmentsCollinear({ a, b }, { a: b, b: c })) {
            return [...front.slice(0, -1), ...back];
        }
    }
    return [...front, ...back];
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

            const otherEnd = shape.endpointAt(myPt);
            if (!otherEnd) continue;

            // Both wires share this endpoint - merge
            const otherPts = shape.points.map(p => ({ ...p }));
            // Reverse when both shared-ends match (start-start or end-end)
            // so the other wire's points flow in the correct direction
            if (myEnd === otherEnd) otherPts.reverse();

            if (myEnd === 'start') {
                newWire.points = mergeWirePoints(otherPts, newWire.points.slice(1));
            } else {
                newWire.points = mergeWirePoints(newWire.points, otherPts.slice(1));
            }

            newWire.junctions = new Set();
            newWire.invalidate();
            app._removeShapeInternal(shape);
            return true;
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

    // 1. Collapse zero-length segments: remove adjacent duplicate points
    for (let i = wire.points.length - 1; i > 0; i--) {
        if (pointsMatch(wire.points[i], wire.points[i - 1])) {
            wire.points.splice(i, 1);
            // Shift junction indices
            const shifted = new Set();
            for (const j of wire.junctions) {
                if (j === i) continue;
                shifted.add(j > i ? j - 1 : j);
            }
            wire.junctions = shifted;
            changed = true;
        }
    }
    if (wire.points.length < 2) return changed;

    // 2. Remove redundant collinear midpoints (e.g. middle anchor dragged
    //    onto the same line as its neighbours → straight line with extra point).
    for (let i = wire.points.length - 2; i >= 1; i--) {
        const a = wire.points[i - 1], b = wire.points[i], c = wire.points[i + 1];
        if (segmentsCollinear({ a, b }, { a: b, b: c })) {
            wire.points.splice(i, 1);
            // Shift junction indices
            const shifted = new Set();
            for (const j of wire.junctions) {
                if (j === i) continue;
                shifted.add(j > i ? j - 1 : j);
            }
            wire.junctions = shifted;
            changed = true;
        }
    }
    if (wire.points.length < 2) return changed;

    wire.invalidate();

    // 3. Check endpoints against other wires for merge / T-join
    const endpoints = [
        { pt: wire.points[0], end: 'start' },
        { pt: wire.points[wire.points.length - 1], end: 'end' }
    ];

    for (const { pt, end } of endpoints) {
        for (const other of [...app.shapes]) {
            if (other === wire || other.type !== 'wire') continue;
            if (!app.shapes.includes(other)) continue;

            // Endpoint-to-endpoint merge
            const otherEnd = other.endpointAt(pt);
            if (otherEnd) {
                const otherPts = other.points.map(p => ({ ...p }));
                if (end === otherEnd) otherPts.reverse();
                if (end === 'start') {
                    wire.points = mergeWirePoints(otherPts, wire.points.slice(1));
                } else {
                    wire.points = mergeWirePoints(wire.points, otherPts.slice(1));
                }
                wire.junctions = new Set();
                wire.invalidate();
                app._removeShapeInternal(other);
                changed = true;
                break; // restart outer since points changed
            }

            // Endpoint onto segment (T-junction) — only if not collinear
            const onSeg = other.pointOnSegment(pt, 0.15);
            if (onSeg) {
                const incoming = terminalSegment(wire, end);
                const target = { a: other.points[onSeg.segIndex], b: other.points[onSeg.segIndex + 1] };

                if (incoming && segmentsCollinear(incoming, target)) {
                    // Collinear overshoot: snap endpoint to nearest vertex of
                    // the target segment, then do endpoint-to-endpoint merge.
                    const segA = other.points[onSeg.segIndex];
                    const segB = other.points[onSeg.segIndex + 1];
                    const dA = Math.hypot(pt.x - segA.x, pt.y - segA.y);
                    const dB = Math.hypot(pt.x - segB.x, pt.y - segB.y);
                    const nearIdx = dA < dB ? onSeg.segIndex : onSeg.segIndex + 1;
                    const snapPt = other.points[nearIdx];

                    // Snap wire endpoint
                    if (end === 'start') {
                        wire.points[0] = { x: snapPt.x, y: snapPt.y };
                    } else {
                        wire.points[wire.points.length - 1] = { x: snapPt.x, y: snapPt.y };
                    }
                    wire.invalidate();

                    // If interior, split target so one half has this endpoint
                    if (nearIdx > 0 && nearIdx < other.points.length - 1) {
                        const secondPts = other.points.slice(nearIdx).map(p => ({ x: p.x, y: p.y }));
                        other.points = other.points.slice(0, nearIdx + 1);
                        other.junctions = new Set();
                        other.invalidate();
                        const secondWire = new Wire({
                            points: secondPts,
                            color: '#00cc66',
                            lineWidth: 0.25,
                        });
                        app.addShape(secondWire);
                    }

                    // Now try endpoint merge
                    const otherEnd2 = other.endpointAt(snapPt);
                    if (otherEnd2) {
                        const otherPts2 = other.points.map(p => ({ ...p }));
                        if (end === otherEnd2) otherPts2.reverse();
                        if (end === 'start') {
                            wire.points = mergeWirePoints(otherPts2, wire.points.slice(1));
                        } else {
                            wire.points = mergeWirePoints(wire.points, otherPts2.slice(1));
                        }
                        wire.junctions = new Set();
                        wire.invalidate();
                        app._removeShapeInternal(other);
                    }
                    changed = true;
                    break;
                }

                const insertIdx = other.splitAt(pt);
                other.junctions.add(insertIdx);
                other.invalidate();
                const epIdx = end === 'start' ? 0 : wire.points.length - 1;
                wire.junctions.add(epIdx);
                wire.invalidate();
                changed = true;
            }
        }
    }

    return changed;
}

// --- Legacy shims ---

/** @deprecated No longer used - auto-corner removed. */
export function checkAutoCornerTriggers() {
    return { triggered: false };
}

/** @deprecated Use getDrawingSnappedPosition instead. */
export function getWireSnappedPosition(app, worldPos) {
    return getDrawingSnappedPosition(app, worldPos);
}
