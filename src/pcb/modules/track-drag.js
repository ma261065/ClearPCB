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
    renderTrackAxisGlowTop,
    clearTrackAxisGlow,
    snapNodeToAxis,
    snapNodeToCollinear,
    applyAxisConstraint,
    _axisAlignment,
    COLLINEAR_SNAP_SCREEN_PX,
    COLLINEAR_GLOW_ANGLE_TOL,
} from './track-draw.js';
import { refreshTrackSelectionHalo } from './track-select.js';
import { MoveVertexCommand, MoveViaCommand, CompoundCommand, ModifyTrackGraphCommand, RemoveTrackCommand, AddViaCommand } from './track-commands.js';
import { pointsCollinear, collinearSnap } from '../../core/geometry.js';
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

function _opts(app, track = app._vertexDrag?.track) {
    return {
        viaDiameter: app._getRoutingParams?.()?.viaDiameter,
        viaDrill: app._getRoutingParams?.()?.viaDrill,
        hideNetLabel: !!track && (track === app._selectedTrack || track === app._vertexDrag?.track),
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
 *
 * @param {object} app
 * @param {object} track
 * @param {{x:number,y:number}} worldPos
 * @param {{allowMidpointInsert?:boolean}} [opts] - When `allowMidpointInsert`
 *   is false, a click on a midpoint "+" handle is ignored (it won't start a
 *   split). Used on the click that first selects a track so the plus requires
 *   a separate, deliberate second click.
 */
export function startVertexDrag(app, track, worldPos, opts = {}) {
    const allowMidpointInsert = opts.allowMidpointInsert !== false;
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
    // Skipped on the selecting click (allowMidpointInsert === false) so a
    // freshly selected track doesn't split just because the cursor happened
    // to land on a "+".
    if (allowMidpointInsert) {
        const midEdge = hitTestTrackMidpoint(app, track, worldPos);
        if (midEdge && startMidpointInsertDrag(app, track, midEdge)) {
            return true;
        }
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
        edgeId: hit.edgeId,
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
        // Translate both endpoints by the cursor delta. The dragged segment
        // itself can't change orientation, but its connected (non-dragged)
        // neighbours can — so snap the delta when one of those neighbours
        // lands on an H/V/45° axis or becomes collinear with its far edge.
        const rawDx = worldPos.x - drag.grabX;
        const rawDy = worldPos.y - drag.grabY;
        const threshold = COLLINEAR_SNAP_SCREEN_PX / (app.viewport?.scale || 1);
        const { dx, dy } = _snapSegmentDrag(drag.track, drag.nodes, rawDx, rawDy, threshold);
        for (const nd of drag.nodes) {
            const n = drag.track.nodes.get(nd.nodeId);
            if (!n) continue;
            n.x = nd.startX + dx;
            n.y = nd.startY + dy;
            if (nd.padLink) drag.track.padConnections.delete(nd.nodeId);
        }
        renderTrackAxisGlow(app, _incidentSegments(drag.track, drag.nodes));
        renderTrack(drag.track, (id) => app._getLayerGroup(id), _opts(app));
        renderTrackAxisGlowTop(app);
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
        // Measure alignment from the RAW cursor, not the grid-snapped point:
        // grid quantisation would otherwise shrink the effective pull band
        // (and, on an off-grid track, let one axis "use up" the snap so the
        // second axis never catches). Axes that DON'T align fall back to the
        // grid-snapped coordinate so grid snapping still applies there.
        const rawPos = { x: worldPos.x, y: worldPos.y };
        const gridPos = { x: snap.x, y: snap.y };
        const threshold = COLLINEAR_SNAP_SCREEN_PX / (app.viewport?.scale || 1);
        // 1. Dragged node is itself a degree-2 waypoint between its two
        //    neighbours: project onto the line through them so both incident
        //    segments become one straight run.
        let snapped = snapNodeToCollinear(rawPos, neighbours, threshold);
        // 2. Otherwise, when dragging an endpoint whose neighbour is a
        //    degree-2 corner, project onto the extension of that corner's
        //    far segment so the dragged segment lines up straight through
        //    the corner (the across-the-node collinear case). Subtle pull,
        //    same band as the green collinear glow.
        if (!snapped) snapped = _snapNodeAcrossNeighbour(drag.track, nd.nodeId, rawPos, threshold);
        // 3. Fall back to the per-segment H/V/45° axis snap (same pull band).
        //    Both incident axes are tested independently against the raw
        //    cursor, so an L-pivot can lock H and V at once; unaligned axes
        //    keep the grid-snapped coordinate.
        if (!snapped) snapped = snapNodeToAxis(rawPos, neighbours, threshold, gridPos);
        n.x = snapped.x;
        n.y = snapped.y;
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
    renderTrackAxisGlowTop(app);
    // Keep the selection halo glued to the new geometry.
    refreshTrackSelectionHalo(app);
    reconcileRatsnest(app);
}

/**
 * Snap the translation delta of a segment drag so a connected (non-dragged)
 * neighbour segment locks onto an H/V/45° axis or becomes collinear with its
 * far edge. Both dragged endpoints move by the same delta, so we look for a
 * nearby delta that satisfies a constraint on any dragged endpoint's edge to
 * a fixed neighbour. Independent H/V snaps combine per-axis; 45°/collinear
 * are coupled candidates and win when they fit at least as tightly.
 *
 * @param {Track} track
 * @param {Array<{nodeId:string, startX:number, startY:number}>} nodes
 * @param {number} rawDx raw cursor delta x (world mm)
 * @param {number} rawDy raw cursor delta y (world mm)
 * @param {number} threshold perpendicular pull distance (world mm)
 * @returns {{dx:number, dy:number}}
 */
function _snapSegmentDrag(track, nodes, rawDx, rawDy, threshold) {
    const draggedSet = new Set(nodes.map((n) => n.nodeId));
    // Start positions of the dragged nodes (they all translate by the same
    // delta, so the dragged segment's direction is constant during the drag).
    const startMap = new Map(nodes.map((n) => [n.nodeId, { x: n.startX, y: n.startY }]));
    // Coupled 45°/collinear candidates: full delta, smallest nudge wins.
    let coupled = null;
    const considerCoupled = (dx, dy) => {
        const nudge = Math.hypot(dx - rawDx, dy - rawDy);
        if (nudge <= threshold && (!coupled || nudge < coupled.nudge)) {
            coupled = { dx, dy, nudge };
        }
    };
    // Independent per-axis H/V snaps.
    let snapX = rawDx, snapY = rawDy;
    let bestXNudge = threshold, bestYNudge = threshold;
    let snappedX = false, snappedY = false;

    for (const nd of nodes) {
        const sx = nd.startX, sy = nd.startY;
        const newPos = { x: sx + rawDx, y: sy + rawDy };
        const inc = track.incidentEdges(nd.nodeId);

        // Scenario A — collinear at the DRAGGED node: when this endpoint has
        // exactly one frozen (dragged) segment and one fixed neighbour on the
        // same layer, the neighbour can line up straight with the dragged
        // segment (they fuse on release). The dragged segment's direction is
        // fixed, so project the moved endpoint onto the line through the fixed
        // neighbour parallel to that direction.
        if (inc.length === 2) {
            const draggedEdge = inc.find((e) => draggedSet.has(e.otherNode));
            const fixedEdge = inc.find((e) => !draggedSet.has(e.otherNode));
            if (draggedEdge && fixedEdge) {
                const l1 = track.edgeLayers.get(draggedEdge.edgeId) || track.layer;
                const l2 = track.edgeLayers.get(fixedEdge.edgeId) || track.layer;
                const P = startMap.get(draggedEdge.otherNode);   // dragged partner (start)
                const F = track.nodes.get(fixedEdge.otherNode);  // fixed neighbour
                if (l1 === l2 && P && F) {
                    const segDx = P.x - sx, segDy = P.y - sy;    // frozen direction
                    const far = { x: F.x + segDx, y: F.y + segDy };
                    const proj = collinearSnap(F, newPos, far, threshold);
                    if (proj) considerCoupled(proj.x - sx, proj.y - sy);
                }
            }
        }

        for (const { edgeId, otherNode } of inc) {
            if (draggedSet.has(otherNode)) continue;     // skip the frozen dragged segment
            const F = track.nodes.get(otherNode);
            if (!F) continue;
            // Vertical: snap delta.x so F→D is vertical.
            const cx = F.x - sx, nx = Math.abs(rawDx - cx);
            if (nx < bestXNudge) { bestXNudge = nx; snapX = cx; snappedX = true; }
            // Horizontal: snap delta.y so F→D is horizontal.
            const cy = F.y - sy, ny = Math.abs(rawDy - cy);
            if (ny < bestYNudge) { bestYNudge = ny; snapY = cy; snappedY = true; }
            // 45°: project the moved endpoint onto the nearest diagonal from F.
            const d45 = applyAxisConstraint(F, newPos, 'd');
            considerCoupled(d45.x - sx, d45.y - sy);
            // Scenario B — collinear at a FIXED corner: when F is a degree-2
            // corner, project the moved endpoint onto the line through F and
            // its far neighbour so the dragged-to-F segment lines up straight
            // with that far edge.
            const fInc = track.incidentEdges(otherNode);
            if (fInc.length === 2) {
                const other = fInc.find((e) => e.otherNode !== nd.nodeId);
                const l1 = track.edgeLayers.get(edgeId) || track.layer;
                const l2 = other ? (track.edgeLayers.get(other.edgeId) || track.layer) : null;
                if (other && l1 === l2) {
                    const G = track.nodes.get(other.otherNode);
                    if (G) {
                        const proj = collinearSnap(F, newPos, G, threshold);
                        if (proj) considerCoupled(proj.x - sx, proj.y - sy);
                    }
                }
            }
        }
    }

    // Only count an axis nudge when a snap actually fired on that axis;
    // otherwise the raw delta is unconstrained there and must not pin the
    // coupled 45°/collinear candidate out of contention.
    const axisNudge = (snappedX || snappedY)
        ? Math.hypot(snappedX ? rawDx - snapX : 0, snappedY ? rawDy - snapY : 0)
        : Infinity;
    if (coupled && coupled.nudge <= axisNudge) return { dx: coupled.dx, dy: coupled.dy };
    return { dx: snapX, dy: snapY };
}

/**
 * Collect the edges incident to the dragged node(s) as live segments for
 * the axis-alignment glow, and flag those that participate in a collinear
 * "would-merge-on-release" relationship.
 *
 * Each returned segment runs between two nodes and carries that edge's
 * copper layer. The `collinear` flag is set when the segment is one of the
 * two edges of a degree-2 node whose edges are collinear (same layer) —
 * exactly the condition `collapseCollinearTrackNodes` fuses on release. The
 * pivot may be the dragged node itself OR a degree-2 corner that an
 * endpoint drag rotates a segment toward (that corner is not a dragged
 * node, so its far "second-ring" edge is pulled in too so it glows).
 *
 * @param {Track} track
 * @param {Array<{nodeId:string}>} nodes
 * @returns {Array<{a:{x:number,y:number}, b:{x:number,y:number}, layerId:string, width:number, collinear:boolean}>}
 */
function _incidentSegments(track, nodes) {
    const draggedSet = new Set(nodes.map((n) => n.nodeId));
    const segMap = new Map(); // edgeId → segment record (deduped)
    const addEdge = (edgeId) => {
        if (segMap.has(edgeId)) return segMap.get(edgeId);
        const e = track.edges.get(edgeId);
        if (!e) return null;
        const a = track.nodes.get(e.from);
        const b = track.nodes.get(e.to);
        if (!a || !b) return null;
        const rec = {
            a: { x: a.x, y: a.y },
            b: { x: b.x, y: b.y },
            layerId: track.edgeLayers.get(edgeId) || track.layer || 'top-copper',
            width: track.width,
            collinear: false,
            // Axis classification of the (post-snap) geometry. This is the
            // SINGLE place the glow's H/V/45 kind is decided: the glow reads
            // `axisKind` and never re-derives it, so the glow lights a
            // segment exactly when the snap pinned it onto an axis.
            axisKind: _axisAlignment(a, b),
            // "Frozen": both endpoints move together (the segment being
            // translated in a segment drag), so its orientation can't change.
            // Don't give it an H/V/45 glow on its own — only light it when a
            // collinear relationship pulls it in (handled in step 2).
            frozen: draggedSet.has(e.from) && draggedSet.has(e.to),
        };
        segMap.set(edgeId, rec);
        return rec;
    };

    // 1. Directly incident edges to the dragged node(s) — these change
    //    orientation during the drag and always get a glow if axis-aligned.
    const incidentEids = new Set();
    for (const { nodeId } of nodes) {
        for (const { edgeId } of track.incidentEdges(nodeId)) {
            incidentEids.add(edgeId);
            addEdge(edgeId);
        }
    }

    // 2. Collinear-merge detection at every degree-2 node touched by an
    //    incident segment (the dragged node, and the far corners its
    //    segments rotate toward). When such a pivot's two edges line up
    //    (same layer, within the merge angle tolerance), flag BOTH green —
    //    pulling in the partner edge even when it isn't directly incident.
    const pivots = new Set();
    for (const eid of incidentEids) {
        const e = track.edges.get(eid);
        if (!e) continue;
        pivots.add(e.from);
        pivots.add(e.to);
    }
    for (const pid of pivots) {
        const inc = track.incidentEdges(pid);
        if (inc.length !== 2) continue;
        const l1 = track.edgeLayers.get(inc[0].edgeId) || track.layer;
        const l2 = track.edgeLayers.get(inc[1].edgeId) || track.layer;
        if (l1 !== l2) continue;
        const p = track.nodes.get(pid);
        const f1 = track.nodes.get(inc[0].otherNode);
        const f2 = track.nodes.get(inc[1].otherNode);
        if (!p || !f1 || !f2) continue;
        if (!pointsCollinear(f1, p, f2, COLLINEAR_GLOW_ANGLE_TOL)) continue;
        const r1 = addEdge(inc[0].edgeId);
        const r2 = addEdge(inc[1].edgeId);
        if (r1) r1.collinear = true;
        if (r2) r2.collinear = true;
    }

    return [...segMap.values()];
}

/**
 * Straight-line snap across a degree-2 neighbour. When the dragged node
 * `nodeId` has a neighbour that is a degree-2 corner (one edge back to the
 * dragged node, one edge on to a far node), project `pos` onto the line
 * through that corner and its far node — so the dragged segment becomes
 * collinear with the corner's other segment (they would fuse on release).
 * Only same-layer corners qualify. When several corners are in range the
 * one needing the smallest nudge wins. Returns the projected position, or
 * null if no corner is within `threshold`.
 *
 * @param {Track} track
 * @param {string} nodeId dragged node
 * @param {{x:number,y:number}} pos current dragged-node position
 * @param {number} threshold perpendicular pull distance (world mm)
 * @returns {{x:number,y:number}|null}
 */
function _snapNodeAcrossNeighbour(track, nodeId, pos, threshold) {
    let best = null;
    let bestDist = Infinity;
    for (const { edgeId, otherNode } of track.incidentEdges(nodeId)) {
        const inc = track.incidentEdges(otherNode);
        if (inc.length !== 2) continue;               // neighbour must be a corner
        const other = inc.find((e) => e.otherNode !== nodeId);
        if (!other) continue;
        const l1 = track.edgeLayers.get(edgeId) || track.layer;
        const l2 = track.edgeLayers.get(other.edgeId) || track.layer;
        if (l1 !== l2) continue;                      // only same-layer runs merge
        const corner = track.nodes.get(otherNode);
        const far = track.nodes.get(other.otherNode);
        if (!corner || !far) continue;
        const proj = collinearSnap(corner, pos, far, threshold);
        if (!proj) continue;
        const d = Math.hypot(proj.x - pos.x, proj.y - pos.y);
        if (d < bestDist) {
            bestDist = d;
            best = proj;
        }
    }
    return best;
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
            renderTrack(drag.track, (id) => app._getLayerGroup(id), _opts(app, drag.track));
            refreshTrackSelectionHalo(app);
            reconcileRatsnest(app);
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
        renderTrack(drag.track, (id) => app._getLayerGroup(id), _opts(app, drag.track));
        refreshTrackSelectionHalo(app);
        reconcileRatsnest(app);
        return;
    }
    for (const nd of (drag.nodes || [])) {
        const n = drag.track.nodes.get(nd.nodeId);
        if (n) {
            n.x = nd.startX;
            n.y = nd.startY;
        }
    }
    renderTrack(drag.track, (id) => app._getLayerGroup(id), _opts(app, drag.track));
    refreshTrackSelectionHalo(app);
    reconcileRatsnest(app);
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
    let pos = { x: snap.x, y: snap.y };

    // Axis / collinear snap — match single-node drag so the via aligns onto
    // H/V/45° axes and straight runs (and lights the same glow). Skip when
    // the grid snap already locked a hard pad / track-node target. The via's
    // attached nodes all move with it, so they're excluded as neighbours.
    if (snap.snapType !== 'pad' && snap.snapType !== 'track-node') {
        const threshold = COLLINEAR_SNAP_SCREEN_PX / (app.viewport?.scale || 1);
        const isAttached = (track, nid) =>
            drag.attached.some(a => a.track === track && a.nodeId === nid);
        const neighboursOf = (a) => {
            const nbs = [];
            for (const { otherNode } of a.track.incidentEdges(a.nodeId)) {
                if (isAttached(a.track, otherNode)) continue;
                const nb = a.track.nodes.get(otherNode);
                if (nb) nbs.push({ x: nb.x, y: nb.y });
            }
            return nbs;
        };
        // Measure alignment from the RAW cursor (not the grid-snapped point)
        // so grid quantisation can't shrink the pull band; unaligned axes
        // fall back to the grid-snapped position.
        const rawPos = { x: worldPos.x, y: worldPos.y };
        const gridPos = { x: snap.x, y: snap.y };
        // 1. Collinear straight-run (degree-2) or across-the-corner, per node.
        let snapped = null;
        for (const a of drag.attached) {
            snapped = snapNodeToCollinear(rawPos, neighboursOf(a), threshold);
            if (snapped) break;
            snapped = _snapNodeAcrossNeighbour(a.track, a.nodeId, rawPos, threshold);
            if (snapped) break;
        }
        // 2. Fall back to H/V/45° against any attached node's neighbour.
        if (!snapped) {
            const allNeighbours = [];
            for (const a of drag.attached) allNeighbours.push(...neighboursOf(a));
            snapped = snapNodeToAxis(rawPos, allNeighbours, threshold, gridPos);
        }
        if (snapped) pos = { x: snapped.x, y: snapped.y };
    }

    drag.via.x = pos.x;
    drag.via.y = pos.y;
    // Drag attached track nodes in lock-step.
    const touched = new Set();
    for (const a of drag.attached) {
        const n = a.track.nodes.get(a.nodeId);
        if (!n) continue;
        n.x = pos.x;
        n.y = pos.y;
        touched.add(a.track);
    }
    // Build the axis glow from every attached track's incident segments, then
    // render: glow halos UNDER the copper, centerlines ON TOP (two-pass).
    const byTrack = new Map();
    for (const a of drag.attached) {
        if (!byTrack.has(a.track)) byTrack.set(a.track, []);
        byTrack.get(a.track).push({ nodeId: a.nodeId });
    }
    const glowSegs = [];
    for (const [track, nodes] of byTrack) glowSegs.push(..._incidentSegments(track, nodes));
    renderTrackAxisGlow(app, glowSegs);
    for (const t of touched) {
        renderTrack(t, (id) => app._getLayerGroup(id), _opts(app, t));
    }
    renderVia(drag.via, (id) => app._getLayerGroup(id));
    renderTrackAxisGlowTop(app);
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
    clearTrackAxisGlow(app);
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
    clearTrackAxisGlow(app);
    drag.via.x = drag.startX;
    drag.via.y = drag.startY;
    renderVia(drag.via, (id) => app._getLayerGroup(id));
    const touched = new Set();
    for (const a of drag.attached) {
        const n = a.track.nodes.get(a.nodeId);
        if (n) { n.x = a.startX; n.y = a.startY; touched.add(a.track); }
    }
    for (const t of touched) {
        renderTrack(t, (id) => app._getLayerGroup(id), _opts(app, t));
    }
    refreshTrackSelectionHalo(app);
}
