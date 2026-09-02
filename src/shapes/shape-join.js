/**
 * Shape joining — fuse two drawing shapes into a single Polyline by snapping
 * an endpoint of one onto an endpoint of the other.
 *
 * This is the data-model half of the "drag a node onto another node to join"
 * interaction. It is pure (no DOM, no app/editor state) so it is shared by the
 * schematic editor today and reusable by the PCB editor's drawing tools later.
 *
 * The merged result is always a single {@link Polyline} whose edges may carry a
 * per-edge `bulge` (arc) attribute. An {@link Arc} therefore becomes one curved
 * edge; a polygon stays a chain of straight (and/or curved) edges. This is the
 * "merged-path" model — one shape, mixed straight/curved segments — rather than
 * keeping the originals linked.
 */

import { Polyline } from './polyline.js';
import { bulgeRatio } from '../core/geometry.js';

/** Endpoints within this world distance are treated as coincident. */
export const JOIN_COINCIDENT_EPS = 1e-3;

/** Shape types that can take part in a join. */
const JOINABLE_TYPES = new Set(['polyline', 'arc']);

/**
 * @param {any} shape
 * @returns {boolean} Whether the shape can participate in a join.
 */
export function isJoinable(shape) {
    return !!shape && JOINABLE_TYPES.has(shape.type) && !shape.locked;
}

/**
 * The endpoint anchors of a shape that may be joined (chain ends only — not
 * midpoint "add point" handles, and not an arc's curvature control point).
 * @param {any} shape
 * @returns {Array<{id:string,x:number,y:number}>}
 */
export function joinableAnchors(shape) {
    if (!isJoinable(shape)) return [];
    if (shape.type === 'arc') {
        const s = shape.getStartPoint(), e = shape.getEndPoint();
        return [
            { id: 'start', x: s.x, y: s.y },
            { id: 'end', x: e.x, y: e.y },
        ];
    }
    // Polyline: real graph nodes only (skip the 'copy'/midpoint handles).
    return shape.getAnchors()
        .filter(a => !a.midpoint && shape.degree(a.id) === 1)
        .map(a => ({ id: a.id, x: a.x, y: a.y }));
}

/**
 * Find the nearest joinable endpoint to `worldPos`, including the opposite
 * endpoint of the dragged open polyline. Used to drive snap and merge on drop.
 * Pure (takes the shapes array directly) so it is reusable by any editor.
 * @param {Array<any>} shapes All shapes to consider.
 * @param {{x:number,y:number}} worldPos Probe position (the dragged anchor).
 * @param {number} tolerance Max snap distance in world units.
 * @param {any} dragShape The shape being dragged.
 * @param {string|null} dragAnchorId The dragged endpoint, for self-join exclusion.
 * @returns {{shape:any, anchorId:string, x:number, y:number, dist:number}|null}
 */
export function findJoinTarget(shapes, worldPos, tolerance, dragShape, dragAnchorId = null) {
    let best = null;
    for (const shape of shapes) {
        if (!isJoinable(shape)) continue;
        const selfJoin = shape === dragShape;
        if (selfJoin && (shape.type !== 'polyline'
            || !dragAnchorId || shape.degree(dragAnchorId) !== 1)) continue;
        for (const a of joinableAnchors(shape)) {
            if (selfJoin && a.id === dragAnchorId) continue;
            const d = Math.hypot(a.x - worldPos.x, a.y - worldPos.y);
            if (d <= tolerance && (!best || d < best.dist)) {
                best = { shape, anchorId: a.id, x: a.x, y: a.y, dist: d };
            }
        }
    }
    return best;
}

/**
 * Convert a joinable shape into Polyline graph form for merging.
 * @param {any} shape
 * @returns {{poly: Polyline, anchorNode: Object<string,string>}|null}
 *   `poly` is a fresh Polyline; `anchorNode` maps the shape's join anchor IDs
 *   to node IDs within `poly`.
 */
function toJoinablePolyline(shape) {
    if (!isJoinable(shape)) return null;

    if (shape.type === 'polyline') {
        const poly = shape.clone();
        const anchorNode = {};
        for (const nid of poly.nodes.keys()) anchorNode[nid] = nid;
        return { poly, anchorNode };
    }

    if (shape.type === 'arc') {
        const s = shape.getStartPoint(), e = shape.getEndPoint();
        const bulge = bulgeRatio(s, e, shape.bulgePoint);
        const poly = new Polyline({
            color: shape.color, lineWidth: shape.lineWidth, layer: shape.layer,
            visible: shape.visible, locked: false,
            fill: shape.fill, fillColor: shape.fillColor, fillAlpha: shape.fillAlpha,
        });
        const ns = poly.addNode(s.x, s.y);
        const ne = poly.addNode(e.x, e.y);
        poly.addEdge(ns, ne, { bulge });
        return { poly, anchorNode: { start: ns, end: ne } };
    }

    return null;
}

/**
 * If the merged graph is a single cycle (every node degree 2, no dangling
 * ends), mark it closed so fill auto-closes correctly.
 * @param {Polyline} poly
 */
function detectAndMarkClosed(poly) {
    if (poly.nodes.size < 3) return;
    if (poly.nodes.size !== poly.edges.size) return; // a simple cycle has n nodes, n edges
    for (const nid of poly.nodes.keys()) {
        if (poly.degree(nid) !== 2) return;
    }
    poly.closed = true;
    if (typeof poly.isAxisAlignedRect === 'function' && poly.isAxisAlignedRect()) {
        poly.isRect = true;
    }
}

/**
 * Fuse any pair of open (degree-1) endpoints that are coincident within
 * {@link JOIN_COINCIDENT_EPS}. This lets a single drop that brings the last
 * two open ends of a near-complete outline together close the loop, and keeps
 * the graph free of duplicate stacked endpoints after a merge.
 * @param {Polyline} poly
 */
function fuseCoincidentEndpoints(poly) {
    let fused = true;
    while (fused) {
        fused = false;
        const ends = [...poly.nodes.keys()].filter(nid => poly.degree(nid) === 1);
        outer:
        for (let i = 0; i < ends.length; i++) {
            const a = poly.nodes.get(ends[i]);
            for (let j = i + 1; j < ends.length; j++) {
                const b = poly.nodes.get(ends[j]);
                if (a && b
                    && Math.abs(a.x - b.x) <= JOIN_COINCIDENT_EPS
                    && Math.abs(a.y - b.y) <= JOIN_COINCIDENT_EPS) {
                    poly.mergeNodes(ends[i], ends[j]);
                    fused = true;
                    break outer;
                }
            }
        }
    }
}

/**
 * Join two shapes by fusing the endpoint `anchorIdA` of `shapeA` onto the
 * endpoint `anchorIdB` of `shapeB`. Returns a new merged {@link Polyline}
 * (the originals are not modified). Returns null if either shape is not
 * joinable or the anchors are unknown.
 *
 * The merged node takes `shapeA`'s anchor position. The caller is responsible
 * for removing the two originals and inserting the result (e.g. via an
 * undoable command) and for transferring selection.
 *
 * @param {any} shapeA
 * @param {string} anchorIdA
 * @param {any} shapeB
 * @param {string} anchorIdB
 * @returns {Polyline|null}
 */
export function joinShapes(shapeA, anchorIdA, shapeB, anchorIdB) {
    // Self-join: fusing two endpoints of the same shape (e.g. closing a loop).
    if (shapeA === shapeB) return joinShapeEndpoints(shapeA, anchorIdA, anchorIdB);

    const A = toJoinablePolyline(shapeA);
    const B = toJoinablePolyline(shapeB);
    if (!A || !B) return null;

    const nodeA = A.anchorNode[anchorIdA];
    const origNodeB = B.anchorNode[anchorIdB];
    if (nodeA == null || origNodeB == null) return null;

    // Bring B's graph into A (bulge and other edge attrs are carried verbatim).
    const remap = A.poly.absorb(B.poly);
    const nodeB = remap.get(origNodeB);
    if (nodeB == null) return null;

    // Fuse the two coincident endpoints into one shared node, then fuse any
    // further coincident open ends (closes a loop when the last gap is bridged).
    A.poly.mergeNodes(nodeA, nodeB);
    fuseCoincidentEndpoints(A.poly);

    detectAndMarkClosed(A.poly);
    A.poly.invalidate();
    return A.poly;
}

/**
 * Fuse two endpoints of a *single* shape (e.g. dragging one end of an open
 * polyline onto another of its own nodes to close a loop). Returns a new
 * merged {@link Polyline}; the original is not modified. Only Polylines can
 * be self-joined.
 * @param {any} shape
 * @param {string} keepAnchorId Anchor whose position the fused node keeps.
 * @param {string} dropAnchorId Anchor merged into `keepAnchorId`.
 * @returns {Polyline|null}
 */
export function joinShapeEndpoints(shape, keepAnchorId, dropAnchorId) {
    if (!isJoinable(shape) || shape.type !== 'polyline') return null;
    if (keepAnchorId === dropAnchorId) return null;
    const poly = shape.clone();
    if (!poly.nodes.has(keepAnchorId) || !poly.nodes.has(dropAnchorId)) return null;
    poly.mergeNodes(keepAnchorId, dropAnchorId);
    fuseCoincidentEndpoints(poly);
    detectAndMarkClosed(poly);
    poly.invalidate();
    return poly;
}
