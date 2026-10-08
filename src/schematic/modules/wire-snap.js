/**
 * Where a wire being drawn lands: on a pin (leaving it along the pin's axis), on another
 * wire's node or segment, or on the grid with axis locks.
 */
import { VERTEX_EPSILON } from './wire-constants.js';
import { getEffectiveStrokeWidth } from './drawing.js';
import { buildDrawingExtraSegments, getWireAxisLock, setWireAxisLock } from './wire.js';
import { applyOffGridNeighborSnap } from './wire-drag-snap.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../components/Component.js').Component} Component */
/** @typedef {import('../../core/SchematicDocument.js').SchematicItem} SchematicItem */
/** @typedef {import('../../shapes/wire.js').Wire} Wire */
/** @typedef {import('../../shapes/net.js').Net} NetShape */
/** @typedef {import('../../core/geometry.js').Point} Point */
/** @typedef {Record<string, any> & {number: string|number}} ComponentPin Dynamic pin records come from component libraries and synthetic snap targets. */
/** @typedef {{id: string, type?: string, net?: string, [key: string]: unknown}} PinComponent */
/** @typedef {{component: Component|SchematicItem|PinComponent, pin: ComponentPin, pinKey?: string|number|null}} PinIdentity */
/** @typedef {PinIdentity & {distance: number, worldPos: Point}} PinSnapInfo */
/** @typedef {{wire: Wire, nodeId: string}} ExcludedWireNode */
/** @typedef {{a: Point, b: Point}} WireSegment */
/** @typedef {{excludePin?: PinIdentity|null, excludeWire?: Wire|Set<Wire>|null, excludeNode?: ExcludedWireNode|null, extraSegments?: WireSegment[]|null, pinTolerance?: number, wireTolerance?: number}} WireSnapOptions */
/** @typedef {{x:number, y:number, snapPin: PinSnapInfo|null, snapType: 'pin'|'endpoint'|'segment'|'grid', wireDir?: 'horizontal'|'vertical'|'angled'}} WireSnapResult */
/** @typedef {{x:number, y:number, type: 'endpoint'|'segment', wire: Wire|null, wireDir?: 'horizontal'|'vertical'|'angled'}} NearbyWirePoint */

// --- Constants ---

// ── Snap tolerances ──
// All distance/angle thresholds that govern how wire endpoints, segments and
// pins "snap" together. Co-located so the snap feel can be tuned in one place.
// World units unless noted otherwise.

/** Snap threshold in screen pixels (divided by viewport.scale for world units). */
export const SNAP_SCREEN_PX = 5;

/** Tolerance for pin snap detection during drawing (world units). */
export const PIN_SNAP_TOL = 1.5;

/** Tolerance for wire-to-wire snap detection (world units). */
export const WIRE_SNAP_TOL = 0.5;

/**
 * Minimum radius of the axis-choice zone around a segment start, in screen
 * pixels. Inside this zone the H/V drawing direction stays unlocked so the
 * user can re-pick it; the world-space radius is at least 2× the effective
 * stroke width but never smaller than this.
 */
export const CHOICE_ZONE_MIN_PX = 20;

/**
 * Dominance ratio for honoring a perpendicular departure from a pin. While the
 * first segment leaves a pin, the pin's own axis is preferred until the cursor
 * moves more than this ratio further along the perpendicular axis.
 */
export const PIN_DEPART_RATIO = 2;

// --- Pin helpers ---

/**
 * Find the nearest component pin (or Net label connection point) within tolerance.
 * Returns { component, pin, pinKey, distance, worldPos } or null.
 * @param {Component[]} components
 * @param {Point} worldPos
 * @param {number} [tolerance]
 * @param {SchematicItem[]|null} [shapes] - extra shapes (e.g. Net labels) to also test
 * @returns {PinSnapInfo|null}
 */
export function findNearbyPin(components, worldPos, tolerance = 0.5, shapes = null) {
    /** @type {PinSnapInfo|null} */
    let nearest = null;
    let minDist = tolerance;

    for (const component of components) {
        if (!component.symbol || !component.symbol.pins) continue;
        // Hoist the component transform out of the per-pin loop. The old code
        // called component.getPinPosition(pin.number) for every pin, which
        // re-scanned the pin list by number (O(pins²)) and allocated a String
        // per call — needless work on every mousemove during placement.
        const cx = component.x, cy = component.y;
        const rad = (component.rotation || 0) * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const mirror = !!component.mirror;
        for (const pin of /** @type {ComponentPin[]} */ (component.symbol.pins)) {
            const lx = mirror ? -pin.x : pin.x;
            const ly = pin.y;
            const wx = lx * cos - ly * sin + cx;
            const wy = lx * sin + ly * cos + cy;
            const dist = Math.hypot(worldPos.x - wx, worldPos.y - wy);
            if (dist < minDist) {
                const pinKey = pin._key || pin._id || pin.number || `${pin.x},${pin.y}`;
                minDist = dist;
                nearest = { component, pin, pinKey, distance: dist, worldPos: { x: wx, y: wy } };
            }
        }
    }
    // Also check Net labels (they expose the same pin interface)
    if (shapes) {
        for (const shape of shapes) {
            if (shape.type !== 'net') continue;
            const netShape = /** @type {NetShape} */ (shape);
            const dist = Math.hypot(worldPos.x - netShape.x, worldPos.y - netShape.y);
            if (dist < minDist) {
                const pin = /** @type {ComponentPin} */ (netShape.symbol.pins[0]);
                minDist = dist;
                nearest = { component: netShape, pin, pinKey: pin.number, distance: dist, worldPos: { x: netShape.x, y: netShape.y } };
            }
        }
    }
    return nearest;
}

/**
 * Resolve the unique key for a pin-snap object.
 * Handles the multiple fallback fields in component pin data.
 * @param {PinIdentity|null|undefined} snapInfo
 * @returns {string|number|undefined}
 */
export function getPinKey(snapInfo) {
    return snapInfo?.pinKey || snapInfo?.pin?._key || snapInfo?.pin?._id || snapInfo?.pin?.number;
}

/**
 * Compare two pin-snap objects for identity (same component + same pin).
 * @param {PinIdentity|null|undefined} pin1 - Pin snap info
 * @param {PinIdentity|null|undefined} pin2 - Pin snap info
 * @returns {boolean}
 */
export function isSamePin(pin1, pin2) {
    if (pin1?.component?.id !== pin2?.component?.id) return false;
    const key1 = getPinKey(pin1), key2 = getPinKey(pin2);
    if (key1 && key2) return key1 === key2;
    return pin1?.pin?.number === pin2?.pin?.number;
}

/**
 * Determine the axis direction a pin points into the schematic.
 * The wire departs along the pin stub direction.
 * Returns 'horizontal' or 'vertical'.
 * @param {PinIdentity|null|undefined} pin
 * @returns {'horizontal'|'vertical'}
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
 * @param {SchematicEditor} app
 * @param {Point} worldPos - Raw (unsnapped) cursor world position
 * @param {WireSnapOptions} [options]
 * @returns {WireSnapResult}
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

    // 1. Pin snap (highest priority) — includes component pins AND Net labels
    const nearPin = findNearbyPin(app.components, worldPos, pinTolerance, app.shapes);
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
 * @param {SchematicEditor} app
 * @param {Point} worldPos
 * @returns {WireSnapResult & {adjustLastX?: number, adjustLastY?: number, corner?: Point}}
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
    // Radius is at least 2× effective stroke width, but no smaller than
    // CHOICE_ZONE_MIN_PX screen pixels.
    const choiceRadius = Math.max(getEffectiveStrokeWidth(app, 0.2) * 2, CHOICE_ZONE_MIN_PX / app.viewport.scale);
    const inChoiceZone = rawDx < choiceRadius && rawDy < choiceRadius;

    /** @type {'horizontal'|'vertical'} */
    let axis;
    if (inChoiceZone) {
        // Inside the zone: unlock axis so user can re-pick direction
        setWireAxisLock(app, null);
        axis = rawDx >= rawDy ? 'horizontal' : 'vertical';
    } else if (getWireAxisLock(app)) {
        // Outside the zone with a lock: keep the locked axis
        axis = getWireAxisLock(app);
    } else {
        // Exiting the zone for the first time: lock direction
        axis = rawDx >= rawDy ? 'horizontal' : 'vertical';
        setWireAxisLock(app, axis);
    }

    // If departing a pin (first segment), prefer the pin axis when the
    // cursor direction is ambiguous. Once the user clearly moves in the
    // perpendicular direction (ratio > PIN_DEPART_RATIO:1), respect that choice.
    if (app.wirePoints.length === 1 && lastPoint.pin) {
        const pinAxis = pinDepartAxis(lastPoint.pin);
        const dominant = Math.max(rawDx, rawDy);
        const minor = Math.min(rawDx, rawDy);
        if (dominant < minor * PIN_DEPART_RATIO) {
            axis = pinAxis;
        }
    }

    // Use the unified resolver for snap target detection.
    // Exclude the start pin so we don't snap back to our own origin.
    // Pass earlier wirePoints as extra segments so loop-back self-join
    // snapping works — these segments aren't in app.shapes yet.
    const excludePin = lastPoint.pin ? { component: lastPoint.pin.component, pin: lastPoint.pin.pin } : null;
    const extraSegments = buildDrawingExtraSegments(app.wirePoints);
    const snap = resolveWireSnapPosition(app, worldPos, {
        excludePin,
        extraSegments: extraSegments ?? undefined,
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
    // Route through the shared off-grid snap-line primitive so the rule
    // "within half a grid cell of a neighbor coordinate → snap to it" lives
    // in exactly one place. Only the free axis is read back; the constrained
    // axis stays pinned to lastPoint.
    const gridSnapped = app.viewport.getSnappedPosition(worldPos);
    const gridSize = app.viewport.gridSize || 1.0;
    const pinSnap = findNearbyPin(app.components, worldPos, PIN_SNAP_TOL);
    applyOffGridNeighborSnap(worldPos, gridSnapped, pinSnap ? [pinSnap.worldPos] : [], gridSize);

    if (axis === 'horizontal') {
        return { x: gridSnapped.x, y: lastPoint.y, snapPin: null, snapType: 'grid' };
    } else {
        return { x: lastPoint.x, y: gridSnapped.y, snapPin: null, snapType: 'grid' };
    }
}

// --- Wire junction detection ---

/**
 * Classify a segment direction as horizontal, vertical, or angled.
 * H/V threshold: the minor axis must be < 5% of the major axis.
 * @param {number} dx
 * @param {number} dy
 * @returns {'horizontal'|'vertical'|'angled'}
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
 * @param {SchematicEditor} app
 * @param {Point} worldPos
 * @param {number} tolerance
 * @param {Wire|Set<Wire>|null} [excludeWires] - a wire, set of wires, or null
 * @param {{excludeNode?: ExcludedWireNode|null, extraSegments?: WireSegment[]|null}} [options]
 * @returns {NearbyWirePoint|null}
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
            excludeNode.wire.incidentEdges(excludeNode.nodeId).map((/** @type {{edgeId: string}} */ e) => e.edgeId)
        );
    }

    /** @type {NearbyWirePoint|null} */
    let bestNode = null;
    let bestNodeDist = tolerance;
    /** @type {NearbyWirePoint|null} */
    let bestEdge = null;
    let bestEdgeDist = tolerance;

    for (const shape of app.shapes) {
        if (shape.type !== 'wire') continue;
        const wireShape = shape;
        if (wireShape.edges.size === 0) continue;
        // Full-wire exclusion (skip entire shape)
        if (excludeSet.has(wireShape)) continue;

        const isPartiallyExcluded = excludeNode && wireShape === excludeNode.wire;

        // Check all nodes (endpoints, junctions, corners)
        for (const [nid, pos] of wireShape.nodes) {
            if (isPartiallyExcluded && nid === excludeNode.nodeId) continue;
            const d = Math.hypot(worldPos.x - pos.x, worldPos.y - pos.y);
            if (d < bestNodeDist) {
                bestNodeDist = d;
                bestNode = { x: pos.x, y: pos.y, type: 'endpoint', wire: wireShape };
            }
        }

        // Check edges (T-junction)
        for (const [eid, e] of wireShape.edges) {
            if (isPartiallyExcluded && excNodeEdgeIds?.has(eid)) continue;
            const a = wireShape.nodes.get(e.from), b = wireShape.nodes.get(e.to);
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
                const hitNode = wireShape.nodeAt({ x: px, y: py }, VERTEX_EPSILON);
                if (!hitNode || (isPartiallyExcluded && hitNode === excludeNode.nodeId)) {
                    bestEdgeDist = d;
                    bestEdge = {
                        x: px, y: py,
                        type: 'segment',
                        wireDir: _classifyDir(dx, dy),
                        wire: wireShape
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
                    wireDir: _classifyDir(dx, dy),
                    wire: null
                };
            }
        }
    }

    // Nodes always win over edges
    return bestNode || bestEdge;
}
