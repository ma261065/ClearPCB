/**
 * Finding a track's nodes, midpoints and edges under the pointer, and the structural
 * edits made there: splitting a track at a point, deleting a segment or a node, and
 * collapsing collinear nodes after an edit.
 */
import { resolveTrackSegments } from '../../shared/pcb/board-geometry.js';
import { reconcileRatsnest } from './ratsnest.js';
import { refreshTrackSelectionHalo } from './copper-halos.js';
import { ModifyTrackGraphCommand, RemoveTrackCommand } from './track-commands.js';
import { Via } from '../../shapes/via.js';
import { Track } from '../../shapes/track.js';
import { closestPointOnArcEdge } from '../../shapes/arc-edge.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {import('../../shapes/track.js').TrackEdge} TrackEdge */
/** @typedef {{excludeTracks?: Set<Track>, layers?: string[]}} SplitTrackOptions */

/** Screen-px hit tolerance for selecting a Track node to drag. */
const NODE_HIT_PX = 8;

/** World-space tolerance for treating a Via as "on" a Track node. */
const VIA_NODE_EPS = 1e-4;

/**
 * True if any standalone Via sits on `(x, y)`.
 * @param {Pick<PcbEditor, 'vias'>} app
 * @param {number} x
 * @param {number} y
 */
export function viaAtPoint(app, x, y) {
    for (const via of (app.vias || [])) {
        if (Math.abs(via.x - x) < VIA_NODE_EPS && Math.abs(via.y - y) < VIA_NODE_EPS) return true;
    }
    return false;
}

/**
 * Hit-test a Track's nodes against the world position. Returns the
 * nodeId of the closest node within tolerance, else null.
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {Point} worldPos
 * @param {number} [pxTol]
 */
export function hitTestTrackNode(app, track, worldPos, pxTol = NODE_HIT_PX) {
    const scale = app.viewport?.scale || 1;
    const tol = pxTol / scale;
    let best = null;
    let bestD = tol;
    for (const [nid, n] of track.nodes) {
        const d = Math.hypot(n.x - worldPos.x, n.y - worldPos.y);
        if (d < bestD) { bestD = d; best = nid; }
    }
    return best;
}

/**
 * Hit-test the "+" insertion handles drawn at each segment midpoint.
 * Returns the edgeId of the closest segment whose midpoint is within
 * tolerance of `worldPos`, else null. Mirrors the schematic Wire
 * midpoint-anchor model: grabbing a midpoint inserts a new vertex.
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {Point} worldPos
 * @param {number} [pxTol]
 */
export function hitTestTrackMidpoint(app, track, worldPos, pxTol = NODE_HIT_PX) {
    const scale = app.viewport?.scale || 1;
    const tol = pxTol / scale;
    let best = null;
    let bestD = tol;
    for (const [eid, e] of track.edges) {
        if (e.bulge) continue;
        const a = track.nodes.get(e.from);
        const b = track.nodes.get(e.to);
        if (!a || !b) continue;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const d = Math.hypot(mx - worldPos.x, my - worldPos.y);
        if (d < bestD) { bestD = d; best = eid; }
    }
    return best;
}

/**
 * Find which edge of `track` the world position lies on (closest
 * perpendicular projection within `track.width/2 + tol`). Returns
 * { edgeId, edge, t } or null.
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {Point} worldPos
 * @param {number} [pxTol]
 */
export function hitTestTrackEdge(app, track, worldPos, pxTol = 6) {
    const scale = app.viewport?.scale || 1;
    const tol = pxTol / scale;
    let best = null;
    let bestD = Infinity;
    for (const { edgeId, start: a, end: b, width } of resolveTrackSegments(track)) {
        const half = width / 2 + tol;
        const vx = b.x - a.x, vy = b.y - a.y;
        const len2 = vx * vx + vy * vy;
        if (len2 < 1e-12) continue;
        let t = ((worldPos.x - a.x) * vx + (worldPos.y - a.y) * vy) / len2;
        if (t < 0 || t > 1) continue;
        const d = Math.hypot(worldPos.x - (a.x + t * vx), worldPos.y - (a.y + t * vy));
        if (d <= half && d < bestD) { bestD = d; best = { edgeId, edge: track.edges.get(edgeId), t }; }
    }
    return best;
}

/** World-space margin from an edge endpoint below which a projection is
 *  treated as "on the node" (attach) rather than mid-segment (split). */
const SPLIT_ENDPOINT_EPS = 0.05;

/**
 * Scan every Track for an edge whose interior passes under `worldPos`
 * (within the track half-width + pixel tolerance). Returns the closest
 * match with the perpendicular projection point on that edge, or null.
 * Projections that land on (or very near) an endpoint node are rejected
 * so that mid-segment drops split while end drops attach.
 *
 * @param {PcbEditor} app
 * @param {Point} worldPos
 * @param {number} [pxTol]
 * @param {SplitTrackOptions} [options]
 * @returns {{track:Track, edgeId:string, edge:TrackEdge, px:number, py:number}|null}
 */
export function findSplittableTrackEdge(app, worldPos, pxTol = 6, options = {}) {
    const scale = app.viewport?.scale || 1;
    let best = null;
    let bestD = Infinity;
    for (const t of (app.tracks || [])) {
        if (options.excludeTracks?.has(t)) continue;
        for (const [eid, e] of t.edges) {
            if (options.layers && !options.layers.includes(t.getEdgeLayer(eid))) continue;
            const a = t.nodes.get(e.from);
            const b = t.nodes.get(e.to);
            if (!a || !b) continue;
            const half = (t.getEdgeWidth ? t.getEdgeWidth(eid) : t.width || 0.2) / 2 + pxTol / scale;
            const { x: px, y: py } = closestPointOnArcEdge(worldPos, a, b, e.bulge || 0);
            const d = Math.hypot(worldPos.x - px, worldPos.y - py);
            if (d > half || d >= bestD) continue;
            // Reject projections that sit essentially on an endpoint node.
            if (Math.hypot(px - a.x, py - a.y) < SPLIT_ENDPOINT_EPS) continue;
            if (Math.hypot(px - b.x, py - b.y) < SPLIT_ENDPOINT_EPS) continue;
            bestD = d;
            best = { track: t, edgeId: eid, edge: e, px, py };
        }
    }
    return best;
}

/** @param {PcbEditor} app @param {Point} worldPos @param {Via|null} [excludeVia] */
export function findNearbyVia(app, worldPos, excludeVia = null) {
    const tolerance = 6 / (app.viewport?.scale || 1);
    let best = null;
    let bestDistance = Infinity;
    for (const via of app.vias || []) {
        if (via === excludeVia || via.visible === false) continue;
        const distance = Math.hypot(worldPos.x - via.x, worldPos.y - via.y);
        if (distance <= Math.max(tolerance, (via.diameter || 0.6) / 2)
            && distance < bestDistance) {
            best = via;
            bestDistance = distance;
        }
    }
    return best;
}

/** @param {PcbEditor} app @param {string} trackNet @param {string} viaNet @param {string} [kind] */
export function showTrackViaNetConflict(app, trackNet, viaNet, kind = 'via') {
    const message = `Cannot connect track net "${trackNet}" to ${kind} net "${viaNet}".`;
    app.alert(message, { title: 'Net Conflict' });
}

/**
 * Split a Track into separate Track objects at `splitPoint` on `edgeId`.
 *
 * The point becomes a new node; that node is then duplicated so the two
 * sides of the cut belong to disjoint graphs, which are extracted into
 * independent Tracks (each keeps the original net, width, layer, per-edge
 * layers and any pad connections on its side). Both resulting Tracks have
 * a node exactly at the split point, so a via dropped there sits on a node
 * of each. If the cut does not disconnect the graph (e.g. a loop), a
 * single Track with a node at the point is returned instead.
 *
 * @param {Track} track
 * @param {string} edgeId
 * @param {Point} splitPoint
 * @returns {unknown[]|null} new Track objects, or null on failure.
 */
export function splitTrackObjectAtPoint(track, edgeId, splitPoint) {
    const clone = track.clone();
    const split = clone.splitEdge(edgeId, splitPoint);
    if (!split) return null;
    // splitEdge copies the source edge's per-edge attributes (layer/width)
    // onto both halves, so no manual carry-over is needed here.

    const P = split.newNodeId;
    const p = clone.nodes.get(P);
    // Duplicate the split node and hand one incident edge to the copy so
    // the two halves become separate connected components.
    const P2 = clone.addNode(p.x, p.y);
    const e2 = clone.edges.get(split.edge2Id);
    if (e2.from === P) e2.from = P2; else e2.to = P2;

    const comps = clone.connectedComponents();
    if (comps.length < 2) {
        // Cut did not separate the graph (loop) — keep it as one Track.
        clone.mergeNodes(P, P2);
        return [clone];
    }
    return comps.map((set) => clone.extractSubgraph(set));
}

/**
 * Remove a single edge (segment) from a Track. Returns the Track objects
 * that should replace the original: the graph minus that edge, split into
 * its remaining connected components (each keeps the original net, width,
 * layer, per-edge layers and pad connections). Nodes left with no edges
 * are dropped. Returns an empty array if the track had only that segment.
 *
 * @param {Track} track
 * @param {string} edgeId
 * @returns {unknown[]} replacement Track objects (possibly empty).
 */
export function deleteTrackSegment(track, edgeId) {
    const clone = track.clone();
    if (!clone.edges.has(edgeId)) return [clone];
    clone.removeEdge(edgeId);
    // Keep only components that still contain at least one edge; a lone
    // node is just a dangling point with no copper to render.
    const parts = [];
    for (const set of clone.connectedComponents()) {
        const sub = clone.extractSubgraph(set);
        if (sub.edges.size > 0) parts.push(sub);
    }
    return parts;
}

/**
 * Delete a single Track node, mirroring the schematic "Delete point"
 * action: a degree-1 leaf is removed; a degree-2 node is removed and its
 * two neighbours are reconnected by a bridging edge. Commits a
 * ModifyTrackGraphCommand. Returns true if the node was deleted.
 *
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {string} nodeId
 * @returns {boolean}
 */
export function deleteTrackNode(app, track, nodeId) {
    if (!track?.nodes?.has(nodeId)) return false;
    if (track.edges.size <= 1) {
        app.history.execute(new RemoveTrackCommand(app, track));
        return true;
    }
    const before = track.captureState();
    const incident = track.incidentEdges(nodeId);
    // deleteAnchor reconnects a degree-2 node's neighbours with a bridging
    // edge that inherits the first incident edge's attributes (layer/width),
    // so no manual carry-over is needed here.
    if (!track.deleteAnchor(nodeId)) return false;
    if (incident.length === 2) {
        for (const edge of track.edges.values()) {
            if (incident.some(item => item.otherNode === edge.from) && incident.some(item => item.otherNode === edge.to)) edge.bulge = 0;
        }
    }
    const after = track.captureState();
    track.applyState(before);
    app.history.execute(new ModifyTrackGraphCommand(app, track, before, after));
    refreshTrackSelectionHalo(app);
    reconcileRatsnest(app);
    return true;
}

/**
 * Dissolve redundant collinear waypoints from a track: unknown degree-2 node
 * whose two incident edges share a copper layer and whose neighbours are
 * collinear through it is removed, joining the neighbours with a single
 * edge of that layer. Nodes anchored to a pad, or sitting on a via (a
 * layer transition / stitch point), are preserved. Mutates `track` in
 * place and returns whether anything was removed — callers fold the
 * result into their own undo snapshot.
 *
 * @param {PcbEditor} app
 * @param {Track} track
 * @returns {boolean} true if at least one node was dissolved.
 */
export function collapseCollinearTrackNodes(app, track) {
    if (!track?.nodes) return false;
    let removedAny = false;
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 10000) {
        changed = false;
        for (const [nid, pos] of track.nodes) {
            if (track.degree(nid) !== 2) continue;
            if (track.padConnections.has(nid)) continue;   // pad anchor
            if (viaAtPoint(app, pos.x, pos.y)) continue;  // via / layer change
            const inc = track.incidentEdges(nid);
            if (inc.length !== 2) continue;
            if (inc.some(({ edgeId }) => track.getEdgeAttr(edgeId, 'bulge'))) continue;
            const l1 = track.getEdgeLayer(inc[0].edgeId);
            const l2 = track.getEdgeLayer(inc[1].edgeId);
            if (l1 !== l2) continue;                        // layer change → keep
            const w1 = track.getEdgeWidth(inc[0].edgeId);
            const w2 = track.getEdgeWidth(inc[1].edgeId);
            if (w1 !== w2) continue;                         // width change → keep
            const p1 = track.nodes.get(inc[0].otherNode);
            const p2 = track.nodes.get(inc[1].otherNode);
            if (!p1 || !p2) continue;
            if (!track._areCollinear(p1, pos, p2)) continue;
            // Drop the node and its two edges, then bridge the neighbours,
            // carrying the (shared) layer/width onto the new edge.
            const bridgeAttrs = track._cloneEdge(track.edges.get(inc[0].edgeId));
            track.removeEdge(inc[0].edgeId);
            track.removeEdge(inc[1].edgeId);
            track.removeNode(nid);
            if (!track.hasEdgeBetween(inc[0].otherNode, inc[1].otherNode)) {
                track.addEdge(inc[0].otherNode, inc[1].otherNode, bridgeAttrs);
            }
            removedAny = true;
            changed = true;
            break;
        }
    }
    return removedAny;
}

/**
 * Tidy a track's redundant collinear waypoints as an undoable edit. Used
 * when a track is deselected: a node added by double-click but never moved
 * is, by definition, collinear and gets dissolved here. Captures a graph
 * snapshot, runs {@link collapseCollinearTrackNodes}, and only commits a
 * {@link ModifyTrackGraphCommand} when something actually changed.
 *
 * @param {PcbEditor} app
 * @param {Track} track
 * @returns {boolean} true if a cleanup command was committed.
 */
export function commitCollinearCleanup(app, track) {
    if (!track?.nodes) return false;
    const before = track.captureState();
    if (!collapseCollinearTrackNodes(app, track)) return false;
    const after = track.captureState();
    track.applyState(before);
    app.history.execute(new ModifyTrackGraphCommand(app, track, before, after));
    refreshTrackSelectionHalo(app);
    reconcileRatsnest(app);
    return true;
}
