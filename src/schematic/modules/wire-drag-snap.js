/**
 * The snaps wires take while their segments, anchors or attached components are being
 * dragged: collinear chains, pin bridges, off-grid neighbours and sticky wires.
 */
import { distanceToSegment, pointsCollinear, collinearSnap } from '../../core/geometry.js';
import { PIN_SNAP_TOL, SNAP_SCREEN_PX, WIRE_SNAP_TOL, findNearbyPin, findNearbyWirePoint } from './wire-snap.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/**
 * @typedef {{x: number, y: number}} Point
 * @typedef {import('../../core/SchematicDocument.js').SchematicShape} Wire
 * @typedef {{from: string, to: string, [key: string]: any}} GraphEdge
 * @typedef {{nodes: Record<string, Point>, edges: Record<string, GraphEdge>}} WireGraphState
 * @typedef {{moving: Point, fixed: Point, beyond?: Point}} SnapEdge
 * @typedef {{a: Point, b: Point, collinear?: boolean, axisKind?: string}} SnapGuide
 * @typedef {import('./wire-snap.js').PinSnapInfo} PinSnap
 * @typedef {Point & {type?: string}} WirePointSnap
 */

// --- Collinear / H-V snap for moving wire segments ---

/**
 * Build the set of nodes that move together with a dragged segment.
 *
 * Starting from the two endpoints of the dragged edge, walk outward along
 * adjacent edges whose direction is collinear with the dragged edge.  This
 * captures chains of aligned segments (e.g. several horizontal tines of an
 * E-shape) so they all move as a unit.
 *
 * Pin-connected nodes are never absorbed — they stay fixed because the
 * bridge insertion at drag-start keeps them anchored to the pin.
 *
 * Uses an iterative fixed-point loop: keeps expanding until no new nodes
 * are found.  Positions are looked up from `origState` (the snapshot taken
 * at drag start) so that in-progress movement doesn't skew the collinearity
 * check.
 *
 * @param {Wire} wire - the live wire graph
 * @param {string} dragEdgeId - the edge being dragged
 * @param {WireGraphState} origState  - captured state snapshot {nodes, edges, …}
 * @returns {Set<string>} IDs of all nodes that should move with the drag
 */
export function buildCollinearChain(wire, dragEdgeId, origState) {
    const origEdge = origState.edges[dragEdgeId];
    const origA = origState.nodes[origEdge.from];
    const origB = origState.nodes[origEdge.to];
    const movingNodes = new Set([origEdge.from, origEdge.to]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const nodeId of [...movingNodes]) {
            for (const inc of wire.incidentEdges(nodeId)) {
                if (inc.edgeId === dragEdgeId || movingNodes.has(inc.otherNode)) continue;
                if (wire.pinConnections.has(inc.otherNode)) continue;
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
    return movingNodes;
}

/**
 * Insert bridge nodes at pin-connected endpoints reachable through a
 * collinear chain.  For each chain-boundary node whose neighbor is
 * pin-connected and collinear, a bridge is inserted so the pin stays
 * fixed while the chain (including the bridge) can move.
 *
 * @param {Wire} wire       The wire to modify
 * @param {Set<string>}  chain      The collinear moving-node set (from buildCollinearChain).
 *                          Bridge node IDs are added to this set so they move with the chain.
 */
export function bridgeCollinearPinEndpoints(wire, chain) {
    for (const nid of [...chain]) {
        for (const { edge: e, otherNode } of wire.incidentEdges(nid)) {
            if (chain.has(otherNode)) continue;
            if (!wire.pinConnections.has(otherNode)) continue;
            // Skip if pin already has a bridge (non-pin neighbor at same position)
            const pinPos = wire.nodes.get(otherNode);
            let alreadyBridged = false;
            for (const { otherNode: adj } of wire.incidentEdges(otherNode)) {
                if (adj === nid) continue;
                if (wire.pinConnections.has(adj)) continue;
                const adjPos = wire.nodes.get(adj);
                if (adjPos && Math.abs(adjPos.x - pinPos.x) < 0.01 && Math.abs(adjPos.y - pinPos.y) < 0.01) {
                    alreadyBridged = true;
                    break;
                }
            }
            if (alreadyBridged) continue;
            const bridgeId = wire.addNode(pinPos.x, pinPos.y);
            if (e.from === otherNode) e.from = bridgeId;
            else e.to = bridgeId;
            wire.addEdge(otherNode, bridgeId);
            chain.add(bridgeId);
            wire.invalidate();
        }
    }
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
 * @param {SnapEdge[]} edges
 * @param {string} [axisLock] - 'horizontal'|'vertical' drag-axis constraint
 * @param {{ diagonal?: boolean }} [options] - `diagonal` also snaps and guides 45° segments
 *   (when no collinear or H/V snap applies)
 * @returns {{ adjustX: number, adjustY: number, guides: SnapGuide[] }}
 */
export function computeMovingSegmentSnaps(threshold, edges, axisLock, { diagonal = false } = {}) {
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
    let axisSnapped = false;
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
        axisSnapped = bestAbsX < Infinity || bestAbsY < Infinity;
    }

    // ── 45° snap (only when nothing else snapped): nearest diagonal through a fixed point ──
    if (diagonal && !collinearSnapped && !axisSnapped) {
        let best = null;
        for (const { moving, fixed } of edges) {
            const mx = moving.x + adjustX, my = moving.y + adjustY;
            const dx = mx - fixed.x, dy = my - fixed.y;
            const alongX = { x: mx, y: fixed.y + (Math.sign(dy) || 1) * Math.abs(dx) };
            const alongY = { x: fixed.x + (Math.sign(dx) || 1) * Math.abs(dy), y: my };
            const target = axisLock === 'vertical' ? alongX
                : axisLock === 'horizontal' ? alongY
                    : Math.abs(dx) >= Math.abs(dy) ? alongX : alongY;
            if (target.x === fixed.x && target.y === fixed.y) continue;
            const distance = Math.hypot(target.x - mx, target.y - my);
            if (distance < threshold && (!best || distance < best.distance)) {
                best = { distance, offX: target.x - mx, offY: target.y - my };
            }
        }
        if (best) {
            adjustX += best.offX;
            adjustY += best.offY;
        }
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
        guides.push({ a: pts[0], b: pts[2], collinear: true });
    }
    // H/V guides (skip fixed points already covered by collinear,
    // and skip alignments that are trivially preserved by the axis lock)
    for (const { moving, fixed } of edges) {
        if (covered.has(fixed)) continue;
        const mx = moving.x + adjustX, my = moving.y + adjustY;
        const yAligned = axisLock !== 'horizontal' && Math.abs(my - fixed.y) < threshold;
        const xAligned = axisLock !== 'vertical' && Math.abs(mx - fixed.x) < threshold;
        if (yAligned || xAligned) {
            guides.push({ a: { x: mx, y: my }, b: fixed, axisKind: yAligned ? 'h' : 'v' });
            covered.add(fixed);
        }
    }
    // 45° guides for segments that now sit exactly on a diagonal.
    if (diagonal) {
        for (const { moving, fixed } of edges) {
            if (covered.has(fixed)) continue;
            const mx = moving.x + adjustX, my = moving.y + adjustY;
            const adx = Math.abs(mx - fixed.x), ady = Math.abs(my - fixed.y);
            if (adx > 1e-9 && Math.abs(adx - ady) < 1e-6) {
                guides.push({ a: { x: mx, y: my }, b: fixed, axisKind: 'd' });
                covered.add(fixed);
            }
        }
    }

    return { adjustX, adjustY, guides };
}

/**
 * Compute collinear/H-V snap and guide lines for a wire anchor drag.
 * Delegates to computeMovingSegmentSnaps.
 * @param {SchematicEditor} app
 * @param {Wire} wire
 * @param {string} anchorId
 * @param {Point} anchorPos
 */
export function computeAnchorCollinearSnap(app, wire, anchorId, anchorPos) {
    if (!wire.nodes.has(anchorId)) return { anchorPos, guides: [] };

    const threshold = SNAP_SCREEN_PX / app.viewport.scale;
    /** @type {SnapEdge[]} */
    const edges = [];
    const neighbors = wire.incidentEdges(anchorId);

    // For each incident edge, add an H/V snap edge (moving ↔ neighbor)
    // plus walk collinear chains to find the farthest aligned node beyond
    for (const { otherNode } of neighbors) {
        const npos = wire.nodes.get(otherNode);
        if (!npos) continue;
        edges.push({ moving: anchorPos, fixed: npos });

        // Walk collinear chain from neighbor outward to find the endpoint
        /** @type {Point|null} */
        let farthest = null;
        /** @type {Set<string>} */
        const visited = new Set([anchorId, otherNode]);
        const queue = [{ nodeId: otherNode, prevPos: anchorPos }];
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item) break;
            const { nodeId: current, prevPos } = item;
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

    const result = computeMovingSegmentSnaps(threshold, edges, undefined, { diagonal: true });
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
 * @param {SchematicEditor} app
 * @param {Wire}   wire         - the wire being dragged
 * @param {string} dragEdgeId   - the edge being dragged
 * @param {WireGraphState} origState    - captured state before drag {nodes, edges, …}
 * @param {Point}  target       - raw cursor world position
 * @param {'horizontal'|'vertical'|null} dragSegAxis  - drag-axis constraint
 * @param {Set<Wire>|null} excludeWires - wires to exclude from snap detection
 */
export function computeSegmentDragSnap(app, wire, dragEdgeId, origState, target, dragSegAxis, excludeWires = null) {
    const snappedTarget = app.viewport.getSnappedPosition(target);
    const gridSize = app.viewport.gridSize || 1.0;
    const origEdge = origState.edges[dragEdgeId];
    const origA = origState.nodes[origEdge.from];
    const origB = origState.nodes[origEdge.to];
    const segOffX = origB.x - origA.x;
    const segOffY = origB.y - origA.y;

    // Build the collinear chain: all nodes that move with the dragged segment.
    const movingNodes = buildCollinearChain(wire, dragEdgeId, origState);

    // Collect fixed neighbors at the chain boundary (for off-grid snap + guides).
    // Track which moving node each fixed neighbor is adjacent to, so we use the
    // correct endpoint (futureA vs futureB) for guide line computation.
    /** @type {{pos: Point, movingNodeId: string}[]} */
    const fixedNeighbors = [];
    for (const nodeId of movingNodes) {
        for (const { otherNode } of wire.incidentEdges(nodeId)) {
            if (movingNodes.has(otherNode)) continue;
            const p = wire.nodes.get(otherNode);
            if (p) fixedNeighbors.push({ pos: p, movingNodeId: nodeId });
        }
    }

    // Off-grid neighbor snap for both segment endpoints.
    // target is the raw position of the 'from' node; the 'to' node is at
    // target + segOff.  A fixed neighbor (e.g. a pin node) may be adjacent
    // to either endpoint, so we check both.
    //
    // This is a dual-endpoint variant of applyOffGridNeighborSnap: each
    // neighbor is tested against BOTH endpoints with a segment offset, and
    // the 'from' endpoint takes precedence (the `else if`). That A-over-B
    // precedence doesn't fit the single-position scalar primitive, so the
    // loop is kept inline intentionally.
    {
        const halfGrid = gridSize * 0.5;
        const rawBx = target.x + segOffX, rawBy = target.y + segOffY;
        for (const { pos: nb } of fixedNeighbors) {
            if (Math.abs(target.x - nb.x) <= halfGrid) snappedTarget.x = nb.x;
            else if (Math.abs(rawBx - nb.x) <= halfGrid) snappedTarget.x = nb.x - segOffX;
            if (Math.abs(target.y - nb.y) <= halfGrid) snappedTarget.y = nb.y;
            else if (Math.abs(rawBy - nb.y) <= halfGrid) snappedTarget.y = nb.y - segOffY;
        }
    }

    // Pin snap — check both endpoints, pick closest
    const rawA = target;
    const rawB = { x: target.x + segOffX, y: target.y + segOffY };
    /** @type {PinSnap|WirePointSnap|null} */
    let highlight = null;

    const pinA = findNearbyPin(app.components, rawA, PIN_SNAP_TOL);
    const pinB = findNearbyPin(app.components, rawB, PIN_SNAP_TOL);
    /** @type {PinSnap|null} */
    let bestPin = null;
    /** @type {Point|null} */
    let bestRaw = null;
    if (pinA && pinB) {
        bestPin = pinA.distance <= pinB.distance ? pinA : pinB;
        bestRaw = pinA.distance <= pinB.distance ? rawA : rawB;
    } else if (pinA) { bestPin = pinA; bestRaw = rawA; }
    else if (pinB) { bestPin = pinB; bestRaw = rawB; }

    if (bestPin) {
        // Don't snap to a pin the wire is already connected to — the bridge
        // maintains the connection and pin snap would fight the drag.
        const pin = bestPin;
        const alreadyConnected = [...wire.pinConnections.values()].some(
            conn => conn.componentId === pin.component.id &&
                    String(conn.pinNumber) === String(pin.pin.number)
        );
        if (alreadyConnected) bestPin = null;
    }

    if (bestPin && bestRaw) {
        let offX = bestPin.worldPos.x - bestRaw.x;
        let offY = bestPin.worldPos.y - bestRaw.y;
        if (dragSegAxis === 'vertical') offX = 0;
        else if (dragSegAxis === 'horizontal') offY = 0;
        snappedTarget.x = target.x + offX;
        snappedTarget.y = target.y + offY;
        highlight = bestPin;
    } else {
        // Wire junction highlight — check endpoint proximity first
        /** @type {Set<Wire>} */
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
    /** @type {SnapEdge[]} */
    const snapEdges = [];
    // Use fixed chain-boundary neighbors as snap/guide targets.
    // Each fixed neighbor knows which moving node it connects to, so we
    // use the correct future position (A or B) as the moving point.
    for (const { pos: p, movingNodeId } of fixedNeighbors) {
        const movingPt = (movingNodeId === origEdge.from) ? futureA : futureB;
        const beyondPt = (movingNodeId === origEdge.from) ? futureB : futureA;
        snapEdges.push({ moving: movingPt, fixed: p, beyond: beyondPt });
    }
    const threshold = SNAP_SCREEN_PX / app.viewport.scale;
    const snapResult = computeMovingSegmentSnaps(threshold, snapEdges, dragSegAxis || undefined, { diagonal: true });
    snappedTarget.x += snapResult.adjustX;
    snappedTarget.y += snapResult.adjustY;

    return { snappedTarget, guides: snapResult.guides, highlight };
}

/**
 * Compute H/V snap adjustment and guide lines for sticky wire nodes
 * connected to moving components.
 *
 * @param {SchematicEditor} app
 * @param {Set<string>} movingCompIds
 * @param {number} proposedDx - grid-snapped dx about to be applied
 * @param {number} proposedDy - grid-snapped dy about to be applied
 * @returns {{ adjustX: number, adjustY: number, guides: Array<{a:{x:number,y:number}, b:{x:number,y:number}, collinear?:boolean, axisKind?:string}> }}
 */
export function computeStickyWireSnaps(app, movingCompIds, proposedDx, proposedDy) {
    const screenThreshold = SNAP_SCREEN_PX / app.viewport.scale;
    const halfGrid = (app.viewport.gridSize || 1.0) * 0.5;
    const threshold = Math.max(screenThreshold, halfGrid);
    /** @type {SnapEdge[]} */
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
