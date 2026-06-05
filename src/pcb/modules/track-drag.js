/**
 * Vertex/segment drag editing for a selected Track.
 *
 * Drag rules (chosen to match the schematic Wire conventions):
 *   - Mousedown on a Track node moves that single node.
 *   - Mousedown on a Track segment drags the whole segment (both
 *     endpoints translate by the same delta, KiCad-style); the
 *     adjacent segments stretch to stay connected.
 *   - Single-node move snaps to grid; pad / track-node snap targets
 *     supersede grid when the cursor is within tolerance. Segment drag
 *     is unsnapped (raw delta) so the segment keeps its shape.
 *   - A via colocated with a dragged NODE is left behind: moving a node
 *     disconnects it from the via. A via on an endpoint of a dragged
 *     SEGMENT instead stays anchored while a new bridge segment grows
 *     from the via to the moving endpoint, keeping the trace connected.
 *     Only dragging the via itself carries its attached track nodes
 *     along (see startViaDrag).
 *   - Mouseup commits a MoveVertexCommand (or a CompoundCommand for a
 *     segment drag) to the history stack.
 *   - Escape cancels and restores the original position(s).
 */

import { renderTrack } from './track-render.js';
import { renderVia } from './track-render.js';
import {
    resolveTrackSnap,
    reconcileRatsnest,
    renderTrackAxisGlow,
    clearTrackAxisGlow,
    snapNodeToAxis,
    snapNodeToCollinear,
    COLLINEAR_SNAP_SCREEN_PX,
} from './track-draw.js';
import { refreshTrackSelectionHalo } from './track-select.js';
import { MoveVertexCommand, MoveViaCommand, CompoundCommand, ModifyTrackGraphCommand, RemoveTrackCommand, AddViaCommand } from './track-commands.js';
import { showAlert } from '../../ui/modules/modal.js';
import { Via } from '../../shapes/via.js';

/** Screen-px hit tolerance for selecting a Track node to drag. */
const NODE_HIT_PX = 8;

/** World-space tolerance for treating a Via as "on" a Track node. */
const VIA_NODE_EPS = 1e-4;

/** World-space tolerance for treating two dropped nodes as coincident. */
const NODE_MERGE_EPS = 1e-3;

/** True if any standalone Via sits on `(x, y)`. */
function _viaAtPoint(app, x, y) {
    for (const via of (app.vias || [])) {
        if (Math.abs(via.x - x) < VIA_NODE_EPS && Math.abs(via.y - y) < VIA_NODE_EPS) return true;
    }
    return false;
}

function _opts(app) {
    return {
        viaDiameter: app._getRoutingParams?.()?.viaDiameter,
        viaDrill: app._getRoutingParams?.()?.viaDrill,
    };
}

/**
 * Hit-test a Track's nodes against the world position. Returns the
 * nodeId of the closest node within tolerance, else null.
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
 */
export function hitTestTrackMidpoint(app, track, worldPos, pxTol = NODE_HIT_PX) {
    const scale = app.viewport?.scale || 1;
    const tol = pxTol / scale;
    let best = null;
    let bestD = tol;
    for (const [eid, e] of track.edges) {
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
 */
export function hitTestTrackEdge(app, track, worldPos, pxTol = 6) {
    const scale = app.viewport?.scale || 1;
    const half = (track.width || 0.2) / 2 + pxTol / scale;
    let best = null;
    let bestD = half;
    for (const [eid, e] of track.edges) {
        const a = track.nodes.get(e.from);
        const b = track.nodes.get(e.to);
        if (!a || !b) continue;
        const vx = b.x - a.x, vy = b.y - a.y;
        const len2 = vx * vx + vy * vy;
        if (len2 < 1e-12) continue;
        let t = ((worldPos.x - a.x) * vx + (worldPos.y - a.y) * vy) / len2;
        if (t < 0 || t > 1) continue;
        const d = Math.hypot(worldPos.x - (a.x + t * vx), worldPos.y - (a.y + t * vy));
        if (d < bestD) { bestD = d; best = { edgeId: eid, edge: e, t }; }
    }
    return best;
}

/** World-space margin from an edge endpoint below which a projection is
 *  treated as "on the node" (attach) rather than mid-segment (split). */
const SPLIT_ENDPOINT_EPS = 0.05;

/**
 * Scan every Track for an edge whose interior passes under `worldPos`
 * (within the trace half-width + pixel tolerance). Returns the closest
 * match with the perpendicular projection point on that edge, or null.
 * Projections that land on (or very near) an endpoint node are rejected
 * so that mid-segment drops split while end drops attach.
 *
 * @returns {{track:object, edgeId:string, edge:object, px:number, py:number}|null}
 */
export function findSplittableTrackEdge(app, worldPos, pxTol = 6) {
    const scale = app.viewport?.scale || 1;
    let best = null;
    let bestD = Infinity;
    for (const t of (app.tracks || [])) {
        const half = (t.width || 0.2) / 2 + pxTol / scale;
        for (const [eid, e] of t.edges) {
            const a = t.nodes.get(e.from);
            const b = t.nodes.get(e.to);
            if (!a || !b) continue;
            const vx = b.x - a.x, vy = b.y - a.y;
            const len2 = vx * vx + vy * vy;
            if (len2 < 1e-9) continue;
            const tt = ((worldPos.x - a.x) * vx + (worldPos.y - a.y) * vy) / len2;
            if (tt <= 0 || tt >= 1) continue;
            const px = a.x + tt * vx, py = a.y + tt * vy;
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
 * @returns {Array<object>|null} new Track objects, or null on failure.
 */
export function splitTrackObjectAtPoint(track, edgeId, splitPoint) {
    const clone = track.clone();
    const origLayer = clone.edgeLayers.get(edgeId) || clone.layer;
    const split = clone.splitEdge(edgeId, splitPoint);
    if (!split) return null;
    // splitEdge issues fresh edge IDs without layer entries — carry over.
    clone.edgeLayers.set(split.edge1Id, origLayer);
    clone.edgeLayers.set(split.edge2Id, origLayer);

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
 * @returns {Array<object>} replacement Track objects (possibly empty).
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
 * @param {object} app
 * @param {object} track
 * @param {string} nodeId
 * @returns {boolean}
 */
export function deleteTrackNode(app, track, nodeId) {
    if (!track?.nodes?.has(nodeId) || track.edges.size <= 1) return false;
    const before = track.captureState();
    // Remember the incident-edge layers (degree-2 case) so the bridging
    // edge created by deleteAnchor inherits the right copper layer.
    const inc = track.incidentEdges(nodeId);
    const neighborA = inc[0]?.otherNode;
    const neighborB = inc[1]?.otherNode;
    const bridgeLayer = inc.length === 2
        ? (track.edgeLayers.get(inc[0].edgeId) || track.layer)
        : null;
    const edgesBefore = new Set(track.edges.keys());
    if (!track.deleteAnchor(nodeId)) return false;
    if (bridgeLayer && neighborA != null && neighborB != null) {
        for (const [eid, e] of track.edges) {
            if (edgesBefore.has(eid)) continue;
            if ((e.from === neighborA && e.to === neighborB) ||
                (e.from === neighborB && e.to === neighborA)) {
                track.edgeLayers.set(eid, bridgeLayer);
            }
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
 * Dissolve redundant collinear waypoints from a track: any degree-2 node
 * whose two incident edges share a copper layer and whose neighbours are
 * collinear through it is removed, joining the neighbours with a single
 * edge of that layer. Nodes anchored to a pad, or sitting on a via (a
 * layer transition / stitch point), are preserved. Mutates `track` in
 * place and returns whether anything was removed — callers fold the
 * result into their own undo snapshot.
 *
 * @param {object} app
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
            if (_viaAtPoint(app, pos.x, pos.y)) continue;  // via / layer change
            const inc = track.incidentEdges(nid);
            if (inc.length !== 2) continue;
            const l1 = track.edgeLayers.get(inc[0].edgeId) || track.layer;
            const l2 = track.edgeLayers.get(inc[1].edgeId) || track.layer;
            if (l1 !== l2) continue;                        // layer change → keep
            const p1 = track.nodes.get(inc[0].otherNode);
            const p2 = track.nodes.get(inc[1].otherNode);
            if (!p1 || !p2) continue;
            if (!track._areCollinear(p1, pos, p2)) continue;
            // Drop the node and its two edges, then bridge the neighbours.
            track.removeEdge(inc[0].edgeId);
            track.removeEdge(inc[1].edgeId);
            track.removeNode(nid);
            if (!track.hasEdgeBetween(inc[0].otherNode, inc[1].otherNode)) {
                const ne = track.addEdge(inc[0].otherNode, inc[1].otherNode);
                if (ne) track.edgeLayers.set(ne, l1);
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
 * @param {object} app
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

/**
 * Split a degree-2 Track node into two coincident nodes (detaching one
 * incident edge to the new node) and immediately float the new node
 * under the cursor, mirroring the schematic "Split" action. The floating
 * node drops on the next left-click (handled in PCBApp's mousedown via
 * the `floating` flag). Returns true if the split started.
 *
 * @param {object} app
 * @param {object} track
 * @param {string} nodeId
 * @returns {boolean}
 */
export function splitTrackNodeAndDrag(app, track, nodeId) {
    if (!track?.nodes?.has(nodeId) || track.degree(nodeId) !== 2) return false;
    const pos = track.nodes.get(nodeId);
    if (!pos) return false;

    const before = track.captureState();
    const inc = track.incidentEdges(nodeId);
    if (inc.length < 2) return false;
    const newNodeId = track.splitNode(nodeId, [inc[0].edgeId]);
    if (!newNodeId) return false;

    // Float the freshly-detached node under the cursor. The whole split
    // (topology + move) commits atomically via the graphBefore branch in
    // finishVertexDrag; dropping it in place discards the split.
    app._vertexDrag = {
        track,
        mode: 'node',
        floating: true,
        graphBefore: before,
        grabX: pos.x,
        grabY: pos.y,
        nodes: [{ nodeId: newNodeId, startX: pos.x, startY: pos.y, padLink: null }],
    };
    renderTrack(track, (id) => app._getLayerGroup(id), _opts(app));
    refreshTrackSelectionHalo(app);
    reconcileRatsnest(app);
    return true;
}

/**
 * Insert a new vertex at the midpoint of `edgeId` and immediately begin
 * dragging it — the schematic Wire "+ in circle" midpoint-anchor model.
 * The edge is split (both halves inherit its copper layer) and the new
 * node is set up as a normal press-drag; the topology change + move
 * commit atomically through finishVertexDrag's `graphBefore` branch.
 * Dropping in place leaves the node collinear, so finishVertexDrag's
 * collapse pass removes it again (net no-op).
 *
 * @param {object} app
 * @param {object} track
 * @param {string} edgeId
 * @returns {boolean} true if an insertion drag was started.
 */
export function startMidpointInsertDrag(app, track, edgeId) {
    if (!track?.edges?.has(edgeId)) return false;
    const e = track.edges.get(edgeId);
    const a = track.nodes.get(e.from);
    const b = track.nodes.get(e.to);
    if (!a || !b) return false;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const layer = track.edgeLayers.get(edgeId) || track.layer;

    const before = track.captureState();
    const res = track.splitEdge(edgeId, mid);
    if (!res) return false;
    // splitEdge deletes the old edge directly (bypassing edgeLayers
    // cleanup); drop the stale entry and tag the two new edges.
    track.edgeLayers.delete(edgeId);
    track.edgeLayers.set(res.edge1Id, layer);
    track.edgeLayers.set(res.edge2Id, layer);

    app._vertexDrag = {
        track,
        mode: 'node',
        graphBefore: before,
        grabX: mid.x,
        grabY: mid.y,
        nodes: [{ nodeId: res.newNodeId, startX: mid.x, startY: mid.y, padLink: null }],
    };
    renderTrack(track, (id) => app._getLayerGroup(id), _opts(app));
    refreshTrackSelectionHalo(app);
    reconcileRatsnest(app);
    return true;
}

/**
 * Find a node (on any track) coincident with `(x, y)`, other than the
 * dragged node itself. Returns `{track, nodeId}` or null.
 */
function _findCoincidentNode(app, dragTrack, dragNodeId, x, y) {
    for (const t of (app.tracks || [])) {
        for (const [nid, p] of t.nodes) {
            if (t === dragTrack && nid === dragNodeId) continue;
            if (Math.abs(p.x - x) < NODE_MERGE_EPS && Math.abs(p.y - y) < NODE_MERGE_EPS) {
                return { track: t, nodeId: nid };
            }
        }
    }
    return null;
}

/** Set of copper layers of the edges incident to `nodeId` on `track`. */
function _incidentLayers(track, nodeId) {
    const layers = new Set();
    for (const [eid, e] of track.edges) {
        if (e.from === nodeId || e.to === nodeId) {
            layers.add(track.edgeLayers.get(eid) || track.layer);
        }
    }
    return layers;
}

/** True if a standalone Via already sits at `(x, y)`. */
function _hasViaAt(app, x, y) {
    return (app.vias || []).some(
        (v) => Math.abs(v.x - x) < NODE_MERGE_EPS && Math.abs(v.y - y) < NODE_MERGE_EPS);
}

/** Build a standalone Via at `(x, y)` on `net` using the app's routing params. */
function _makeViaAt(app, x, y, net) {
    const p = app._getRoutingParams?.() || {};
    const diameter = Number.isFinite(p.viaDiameter) && p.viaDiameter > 0 ? p.viaDiameter : 0.6;
    const drill = Number.isFinite(p.viaDrill) && p.viaDrill > 0 ? p.viaDrill : 0.3;
    return new Via({ x, y, diameter, drill, net: net || '' });
}

/**
 * If the just-dropped single node landed on top of another node, merge
 * the two into one (like schematic wires). Tracks on conflicting nets
 * (two different non-empty net names) are not merged — an error dialog
 * is shown and the node snaps back.
 *
 * MODEL INVARIANT: a graph node belongs to exactly one copper layer and
 * never carries edges of more than one layer. A same-layer drop fuses the
 * two nodes into one continuous trace. A CROSS-layer drop instead keeps
 * the two single-layer nodes DISTINCT but coincident and bonds them with
 * a via — mirroring the split-path representation (a layer transition is
 * always two coincident single-layer nodes + a Via). This avoids
 * overloading one node with both layers, which previously made
 * layer-aware segment dragging move the wrong copper.
 *
 * Returns true if the drop was handled here (merged or rejected), false
 * to fall through to a normal move.
 */
function _tryMergeDroppedNode(app, drag) {
    const nd = drag.nodes[0];
    const track = drag.track;
    const n = track.nodes.get(nd.nodeId);
    if (!n) return false;
    const dropX = n.x, dropY = n.y;
    const target = _findCoincidentNode(app, track, nd.nodeId, dropX, dropY);
    if (!target) return false;

    const netA = track.net || '';
    const netB = target.track.net || '';
    if (netA && netB && netA !== netB) {
        // Net conflict: revert the node and warn.
        n.x = nd.startX;
        n.y = nd.startY;
        renderTrack(track, (id) => app._getLayerGroup(id), _opts(app));
        refreshTrackSelectionHalo(app);
        reconcileRatsnest(app);
        showAlert(
            `Cannot merge nodes on different nets: "${netA}" and "${netB}".`,
            { title: 'Net Conflict' }
        );
        return true;
    }

    // Does the merge span copper layers? The dragged node and target node
    // each carry the layer(s) of their incident edges; if they share none,
    // this is a layer transition (→ keep nodes distinct + bond with a via).
    const dragLayers = _incidentLayers(track, nd.nodeId);
    const targetLayers = _incidentLayers(target.track, target.nodeId);
    let shareLayer = false;
    for (const l of dragLayers) if (targetLayers.has(l)) { shareLayer = true; break; }
    const crossLayer = dragLayers.size > 0 && targetLayers.size > 0 && !shareLayer;
    const needsVia = crossLayer && !_hasViaAt(app, dropX, dropY);
    const mergedNet = netA || netB;

    // Snapshot the dragged track in its pre-drop state for undo.
    n.x = nd.startX;
    n.y = nd.startY;
    const before = track.captureState();

    const cmds = [];
    if (crossLayer) {
        // CROSS-LAYER: do NOT fuse the nodes. Place the dragged node exactly
        // on the target coordinate so the two single-layer nodes are
        // coincident, then bond them with a via. Each node keeps only its
        // own layer's edges, so a later segment drag moves only that layer.
        const dn = track.nodes.get(nd.nodeId);
        if (dn) { dn.x = dropX; dn.y = dropY; }
        if (!track.net && netB) track.net = netB;
        const after = track.captureState();
        track.applyState(before);
        cmds.push(new ModifyTrackGraphCommand(app, track, before, after));
        if (needsVia) {
            cmds.push(new AddViaCommand(app, _makeViaAt(app, dropX, dropY, mergedNet)));
        }
    } else if (target.track === track) {
        // Same track, same layer: collapse the two nodes (keep the target).
        track.mergeNodes(target.nodeId, nd.nodeId);
        const after = track.captureState();
        track.applyState(before);
        cmds.push(new ModifyTrackGraphCommand(app, track, before, after));
    } else {
        // Cross-track, same layer: pull the other track's graph in, fuse the
        // shared node into one continuous trace, inherit its net if we had
        // none, then drop the now-empty other track.
        const remap = track.absorb(target.track);
        const absorbedNid = remap.get(target.nodeId);
        const dn = track.nodes.get(nd.nodeId);
        if (dn) { dn.x = dropX; dn.y = dropY; }
        if (absorbedNid) track.mergeNodes(nd.nodeId, absorbedNid);
        if (!track.net && netB) track.net = netB;
        const after = track.captureState();
        track.applyState(before);
        cmds.push(new RemoveTrackCommand(app, target.track));
        cmds.push(new ModifyTrackGraphCommand(app, track, before, after));
    }
    app.history.execute(cmds.length === 1 ? cmds[0] : new CompoundCommand(cmds));
    refreshTrackSelectionHalo(app);
    reconcileRatsnest(app);
    return true;
}

/**
 * Begin a drag on the selected track. Returns true if a drag was
 * started, false if the click missed.
 */
export function startVertexDrag(app, track, worldPos) {
    const nodeId = hitTestTrackNode(app, track, worldPos);

    // Grabbing a node: drag that single node (snaps to grid/pad/node).
    if (nodeId) {
        const n = track.nodes.get(nodeId);
        app._vertexDrag = {
            track,
            mode: 'node',
            grabX: worldPos.x,
            grabY: worldPos.y,
            nodes: [{
                nodeId,
                startX: n.x,
                startY: n.y,
                // Was this node attached to a pad? Hold onto the link; we'll
                // drop it if the user drags away from the original pad.
                padLink: track.padConnections.get(nodeId) || null,
            }],
        };
        return true;
    }

    // Grabbing a midpoint "+" handle: insert a new vertex there and drag
    // it (schematic Wire midpoint-anchor model). Checked before the
    // segment grab so the handle wins over a parallel-segment drag.
    const midEdge = hitTestTrackMidpoint(app, track, worldPos);
    if (midEdge && startMidpointInsertDrag(app, track, midEdge)) {
        return true;
    }

    // Grabbing a segment: KiCad-style parallel drag — translate both of
    // the edge's endpoints by the same delta so the segment keeps its
    // orientation, while the adjacent segments stretch to stay connected
    // (they share the endpoint nodes, so they follow automatically).
    const hit = hitTestTrackEdge(app, track, worldPos);
    if (!hit) return false;
    const e = hit.edge;
    const a = track.nodes.get(e.from);
    const b = track.nodes.get(e.to);
    if (!a || !b) return false;

    // If an endpoint of the dragged segment sits on a via, keep the via
    // anchored where it is and grow a new "bridge" segment from the via
    // to the moving endpoint, so the trace stays connected through the
    // via instead of tearing away from it. This is a topology change, so
    // snapshot the graph up-front for an atomic undo.
    const segLayer = track.edgeLayers.get(hit.edgeId) || track.layer;
    let graphBefore = null;
    for (const epId of [e.from, e.to]) {
        const n = track.nodes.get(epId);
        if (!_viaAtPoint(app, n.x, n.y)) continue;
        if (!graphBefore) graphBefore = track.captureState();
        const bridgeId = track.addNode(n.x, n.y);
        const bridgeEdge = track.addEdge(bridgeId, epId);
        if (bridgeEdge) track.edgeLayers.set(bridgeEdge, segLayer);
        // NOTE: the other layer's copper at this via lives on a SEPARATE
        // coincident node (model invariant: one node per layer at a via),
        // so it is not an endpoint of the dragged segment and stays pinned
        // to the via automatically — no edge re-pointing needed here.
    }

    app._vertexDrag = {
        track,
        mode: 'segment',
        grabX: worldPos.x,
        grabY: worldPos.y,
        graphBefore,
        nodes: [
            { nodeId: e.from, startX: a.x, startY: a.y, padLink: track.padConnections.get(e.from) || null },
            { nodeId: e.to, startX: b.x, startY: b.y, padLink: track.padConnections.get(e.to) || null },
        ],
    };
    if (graphBefore) renderTrack(track, (id) => app._getLayerGroup(id), _opts(app));
    return true;
}

/** Update the dragged node(s) from the current mouse world pos. */
export function updateVertexDrag(app, worldPos) {
    const drag = app._vertexDrag;
    if (!drag) return;

    if (drag.mode === 'segment') {
        // Translate both endpoints by the raw cursor delta. Pad/grid
        // snapping is intentionally skipped here (snapping each endpoint
        // independently would distort the segment); a bonded endpoint
        // that moves drops its pad link.
        const dx = worldPos.x - drag.grabX;
        const dy = worldPos.y - drag.grabY;
        for (const nd of drag.nodes) {
            const n = drag.track.nodes.get(nd.nodeId);
            if (!n) continue;
            n.x = nd.startX + dx;
            n.y = nd.startY + dy;
            if (nd.padLink) drag.track.padConnections.delete(nd.nodeId);
        }
        renderTrackAxisGlow(app, _incidentSegments(drag.track, drag.nodes));
        renderTrack(drag.track, (id) => app._getLayerGroup(id), _opts(app));
        refreshTrackSelectionHalo(app);
        reconcileRatsnest(app);
        return;
    }

    // Single-node drag: snaps to grid / pad / track-node targets.
    const nd = drag.nodes[0];
    const snap = resolveTrackSnap(app, worldPos, { excludeTrack: drag.track });
    const n = drag.track.nodes.get(nd.nodeId);
    if (!n) return;
    n.x = snap.x;
    n.y = snap.y;

    // Axis snap: when an incident segment falls within the alignment-glow
    // band, lock the node exactly onto that H/V/45° axis so a drop matches
    // the glow (no hysteresis gap). Pad / track-node snaps are hard
    // targets and take priority over axis alignment.
    if (snap.snapType !== 'pad' && snap.snapType !== 'track-node') {
        const neighbours = [];
        for (const { otherNode } of drag.track.incidentEdges(nd.nodeId)) {
            const nb = drag.track.nodes.get(otherNode);
            if (nb) neighbours.push({ x: nb.x, y: nb.y });
        }
        // Prefer the straight-line (collinear) snap when this is a degree-2
        // waypoint near the line through both neighbours — projecting onto
        // that line makes the two incident segments collinear at any angle
        // (and lights the collinear glow). Otherwise fall back to the
        // per-segment H/V/45° axis snap.
        const threshold = COLLINEAR_SNAP_SCREEN_PX / (app.viewport?.scale || 1);
        const collinear = snapNodeToCollinear({ x: n.x, y: n.y }, neighbours, threshold);
        if (collinear) {
            n.x = collinear.x;
            n.y = collinear.y;
        } else {
            const snapped = snapNodeToAxis({ x: n.x, y: n.y }, neighbours);
            n.x = snapped.x;
            n.y = snapped.y;
        }
    }

    // If the user landed on a pad, record/replace the pad connection.
    if (snap.snapType === 'pad' && snap.pad) {
        drag.track.padConnections.set(nd.nodeId, {
            componentId: snap.pad.componentId,
            pinNumber: snap.pad.pinNumber,
        });
    } else {
        drag.track.padConnections.delete(nd.nodeId);
    }

    renderTrackAxisGlow(app, _incidentSegments(drag.track, drag.nodes));
    renderTrack(drag.track, (id) => app._getLayerGroup(id), _opts(app));
    // Keep the selection halo glued to the new geometry.
    refreshTrackSelectionHalo(app);
    reconcileRatsnest(app);
}

/**
 * Collect the edges incident to the dragged node(s) as live segments for
 * the axis-alignment glow. Each segment runs from a dragged node to its
 * neighbour and carries that edge's copper layer. Edges are de-duplicated
 * (a segment shared by two dragged nodes is emitted once).
 *
 * @param {Track} track
 * @param {Array<{nodeId:string}>} nodes
 * @returns {Array<{a:{x:number,y:number}, b:{x:number,y:number}, layerId:string, width:number}>}
 */
function _incidentSegments(track, nodes) {
    const segs = [];
    const seen = new Set();
    for (const { nodeId } of nodes) {
        const a = track.nodes.get(nodeId);
        if (!a) continue;
        for (const { edgeId, otherNode } of track.incidentEdges(nodeId)) {
            if (seen.has(edgeId)) continue;
            seen.add(edgeId);
            const b = track.nodes.get(otherNode);
            if (!b) continue;
            const layerId = track.edgeLayers.get(edgeId) || track.layer || 'top-copper';
            segs.push({
                a: { x: a.x, y: a.y },
                b: { x: b.x, y: b.y },
                layerId,
                width: track.width,
            });
        }
    }
    return segs;
}

/**
 * Commit the in-progress drag as a MoveVertexCommand (or a
 * CompoundCommand for a multi-node segment drag), or revert if no net
 * movement.
 */
export function finishVertexDrag(app) {
    const drag = app._vertexDrag;
    if (!drag) return;
    app._vertexDrag = null;
    clearTrackAxisGlow(app);

    // Did any dragged node actually move?
    let moved = false;
    for (const nd of drag.nodes) {
        const n = drag.track.nodes.get(nd.nodeId);
        if (n && (Math.abs(n.x - nd.startX) > 1e-6 || Math.abs(n.y - nd.startY) > 1e-6)) {
            moved = true;
            break;
        }
    }

    // Segment drag that pinned a via grew bridge geometry on start —
    // commit the whole graph change (topology + positions) atomically.
    if (drag.graphBefore) {
        if (!moved) {
            // No real move: discard the bridge geometry added on start.
            drag.track.applyState(drag.graphBefore);
            renderTrack(drag.track, (id) => app._getLayerGroup(id), _opts(app));
            refreshTrackSelectionHalo(app);
            return;
        }
        // Dissolve any waypoints the drag made redundant before snapshotting.
        collapseCollinearTrackNodes(app, drag.track);
        const after = drag.track.captureState();
        drag.track.applyState(drag.graphBefore);
        app.history.execute(new ModifyTrackGraphCommand(app, drag.track, drag.graphBefore, after));
        reconcileRatsnest(app);
        return;
    }

    // Single-node drop onto another node → merge into one (schematic-style).
    // A net conflict (two different non-empty nets) is rejected with a dialog.
    if (drag.mode === 'node' && drag.nodes.length === 1 && moved) {
        if (_tryMergeDroppedNode(app, drag)) return;
    }

    // Collect the moved nodes and snap the model back so each command's
    // execute() re-applies the move from the original position.
    const moves = [];
    for (const nd of drag.nodes) {
        const n = drag.track.nodes.get(nd.nodeId);
        if (!n) continue;
        if (Math.abs(n.x - nd.startX) > 1e-6 || Math.abs(n.y - nd.startY) > 1e-6) {
            moves.push({ nodeId: nd.nodeId, fromX: nd.startX, fromY: nd.startY, toX: n.x, toY: n.y });
        }
        n.x = nd.startX;
        n.y = nd.startY;
    }
    if (!moves.length) return;

    // Build a 'before' snapshot at the original positions, re-apply the
    // move, then dissolve any waypoints the move made redundant (collinear
    // with their neighbours). If a node was dissolved the topology changed,
    // so commit move + cleanup together as one atomic snapshot; otherwise
    // fall back to lightweight per-node MoveVertexCommands.
    const before = drag.track.captureState();
    for (const m of moves) {
        const n = drag.track.nodes.get(m.nodeId);
        if (n) { n.x = m.toX; n.y = m.toY; }
    }
    const collapsed = collapseCollinearTrackNodes(app, drag.track);
    if (collapsed) {
        const after = drag.track.captureState();
        drag.track.applyState(before);
        app.history.execute(new ModifyTrackGraphCommand(app, drag.track, before, after));
        reconcileRatsnest(app);
        return;
    }
    drag.track.applyState(before);

    const cmds = moves.map((m) =>
        new MoveVertexCommand(app, drag.track, m.nodeId, m.fromX, m.fromY, m.toX, m.toY));
    const cmd = cmds.length === 1 ? cmds[0] : new CompoundCommand(cmds);
    app.history.execute(cmd);
    reconcileRatsnest(app);
}

/** Abort the in-progress drag and restore the original node position(s). */
export function cancelVertexDrag(app) {
    const drag = app._vertexDrag;
    if (!drag) return;
    app._vertexDrag = null;
    clearTrackAxisGlow(app);
    if (drag.graphBefore) {
        // Roll back any bridge geometry plus the node moves in one step.
        drag.track.applyState(drag.graphBefore);
        renderTrack(drag.track, (id) => app._getLayerGroup(id), _opts(app));
        refreshTrackSelectionHalo(app);
        return;
    }
    for (const nd of (drag.nodes || [])) {
        const n = drag.track.nodes.get(nd.nodeId);
        if (n) {
            n.x = nd.startX;
            n.y = nd.startY;
        }
    }
    renderTrack(drag.track, (id) => app._getLayerGroup(id), _opts(app));
}

/* ──────────────────────────── via drag ──────────────────────────── */

/** Screen-px hit tolerance for picking up a Via to drag. */
const VIA_HIT_PX = 6;

/**
 * Hit-test a Via against the world position. Returns true if the
 * cursor is within the via's annular-ring radius (plus pixel tolerance).
 */
function _hitVia(app, via, worldPos, pxTol = VIA_HIT_PX) {
    const scale = app.viewport?.scale || 1;
    const r = (via.diameter || 0.6) / 2 + pxTol / scale;
    return Math.hypot(via.x - worldPos.x, via.y - worldPos.y) <= r;
}

/**
 * Begin a drag on the given (already-selected) Via if the click landed
 * on it. Captures any Track nodes colocated with the via so they drag
 * along — the via acts as a hinge that connected wires follow.
 */
export function startViaDrag(app, via, worldPos) {
    if (!via || !_hitVia(app, via, worldPos)) return false;
    // Find every Track node at the via's current (x, y). Track endpoints
    // and layer-change nodes commonly sit exactly on a via.
    const EPS = 1e-4;
    const attached = []; // [{track, nodeId, startX, startY}]
    for (const t of app.tracks) {
        for (const [nid, n] of t.nodes) {
            if (Math.abs(n.x - via.x) < EPS && Math.abs(n.y - via.y) < EPS) {
                attached.push({ track: t, nodeId: nid, startX: n.x, startY: n.y });
            }
        }
    }
    app._viaDrag = {
        via,
        startX: via.x,
        startY: via.y,
        attached,
    };
    return true;
}

/** Update the dragged via's position from the current mouse world pos. */
export function updateViaDrag(app, worldPos) {
    const drag = app._viaDrag;
    if (!drag) return;
    // Skip the via's own attached nodes when snapping — they ride along with
    // the via, so letting the snap catch them (within the coarse track-node
    // tolerance) would override the finer grid snap and feel sticky.
    const excludeNode = drag.attached.length
        ? (track, nodeId) => drag.attached.some(a => a.track === track && a.nodeId === nodeId)
        : null;
    const snap = resolveTrackSnap(app, worldPos, excludeNode ? { excludeNode } : {});
    drag.via.x = snap.x;
    drag.via.y = snap.y;
    renderVia(drag.via, (id) => app._getLayerGroup(id));
    // Drag attached track nodes in lock-step.
    const touched = new Set();
    for (const a of drag.attached) {
        const n = a.track.nodes.get(a.nodeId);
        if (!n) continue;
        n.x = snap.x;
        n.y = snap.y;
        touched.add(a.track);
    }
    for (const t of touched) {
        renderTrack(t, (id) => app._getLayerGroup(id), _opts(app));
    }
    refreshTrackSelectionHalo(app);
    reconcileRatsnest(app);
}

/**
 * Commit the in-progress via drag. Wraps the via move plus every
 * attached track-node move as a single compound history entry.
 */
export function finishViaDrag(app) {
    const drag = app._viaDrag;
    if (!drag) return;
    app._viaDrag = null;
    const moved = Math.abs(drag.via.x - drag.startX) > 1e-6
        || Math.abs(drag.via.y - drag.startY) > 1e-6;
    if (!moved) {
        // Restore any incidental sub-tolerance drift on track nodes.
        for (const a of drag.attached) {
            const n = a.track.nodes.get(a.nodeId);
            if (n) { n.x = a.startX; n.y = a.startY; }
        }
        return;
    }
    const toX = drag.via.x, toY = drag.via.y;
    // Snap-back the model so commands' execute() re-apply.
    drag.via.x = drag.startX;
    drag.via.y = drag.startY;
    for (const a of drag.attached) {
        const n = a.track.nodes.get(a.nodeId);
        if (n) { n.x = a.startX; n.y = a.startY; }
    }
    const cmds = [new MoveViaCommand(app, drag.via, drag.startX, drag.startY, toX, toY)];
    for (const a of drag.attached) {
        cmds.push(new MoveVertexCommand(app, a.track, a.nodeId, a.startX, a.startY, toX, toY));
    }
    app.history.execute(new CompoundCommand(cmds));
    reconcileRatsnest(app);
}

/** Abort the in-progress via drag and restore the original position. */
export function cancelViaDrag(app) {
    const drag = app._viaDrag;
    if (!drag) return;
    app._viaDrag = null;
    drag.via.x = drag.startX;
    drag.via.y = drag.startY;
    renderVia(drag.via, (id) => app._getLayerGroup(id));
    const touched = new Set();
    for (const a of drag.attached) {
        const n = a.track.nodes.get(a.nodeId);
        if (n) { n.x = a.startX; n.y = a.startY; touched.add(a.track); }
    }
    for (const t of touched) {
        renderTrack(t, (id) => app._getLayerGroup(id), _opts(app));
    }
    refreshTrackSelectionHalo(app);
}
