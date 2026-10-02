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
 *     from the via to the moving endpoint, keeping the track connected.
 *     Only dragging the via itself carries its attached track nodes
 *     along (see startViaDrag).
 *   - Mouseup commits a MoveVertexCommand (or a CompoundCommand for a
 *     segment drag) to the history stack.
 *   - Escape cancels and restores the original position(s).
 */

import { renderTrack, removeTrackElements, removeViaElements } from './track-render.js';
import { resolveTrackSegments } from './board-geometry.js';
import { renderVia } from './track-render.js';
import {
    resolveTrackSnap,
    reconcileRatsnest,
    renderTrackAxisGlow,
    renderTrackAxisGlowTop,
    clearTrackAxisGlow,
    showTrackSnapMarker,
    clearTrackSnapMarker,
    updateNetGuideLine,
    clearNetGuideLine,
    bondedExclusion,
    snapNodeToAxis,
    snapNodeToCollinear,
    applyAxisConstraint,
    _axisAlignment,
    COLLINEAR_SNAP_SCREEN_PX,
    COLLINEAR_GLOW_ANGLE_TOL,
    collectNodeConnections,
} from './track-draw.js';
import { refreshTrackSelectionHalo } from './track-select.js';
import { MoveVertexCommand, MoveViaCommand, CompoundCommand, ModifyTrackGraphCommand, RemoveTrackCommand, AddViaCommand, AddTrackCommand, ModifyTrackCommand, ModifyViaCommand, canonicalTrack, getPlacementPreviewTracks } from './track-commands.js';
import { pointsCollinear, collinearSnap } from '../../core/geometry.js';
import { showAlert } from '../../ui/modules/modal.js';
import { Via, viaHitTest } from '../../shapes/via.js';
import { Track } from '../../shapes/track.js';
import { Pad } from '../../shapes/pad.js';
import { isLayerLocked, isLayerVisible } from './layers.js';
import { bulgeRatio } from '../../core/geometry.js';
import { formatNumberInputValue } from '../../core/number-inputs.js';
import { arcFromBulge } from '../../shapes/arc-edge.js';
import { getPcbSelection, syncPcbSelection } from './selection-registry.js';
import { padLayers } from '../../shapes/pad-geometry.js';
import { renderPad, removePadElements } from './pad.js';
import { MovePadCommand, ModifyPadCommand } from './pad-commands.js';
import { captureBoardShapeState } from './board-shapes.js';
import { ModifyBoardShapeCommand } from './shape-commands.js';
import { ModifyFillCommand } from './copper-fill-commands.js';
import { snapPathTranslation, snapPathPoint, beginPathSplit } from './path-edit.js';
import { createTrackSelectionAdapter } from './track-select.js';
import { closestPointOnArcEdge } from '../../shapes/arc-edge.js';

/** Screen-px hit tolerance for selecting a Track node to drag. */
const NODE_HIT_PX = 8;

/** World-space tolerance for treating a Via as "on" a Track node. */
const VIA_NODE_EPS = 1e-4;

/** World-space tolerance for treating two dropped nodes as coincident. */
const NODE_MERGE_EPS = 1e-3;

function _beginVertexDragOverlayDeferral(app) {
    const previous = !!app._deferDragOverlays;
    app._deferDragOverlays = true;
    return previous;
}

function _endVertexDragOverlayDeferral(app, drag) {
    app._deferDragOverlays = drag.previousDeferDragOverlays;
    if (!app._deferDragOverlays) app.refreshClearanceHalos?.();
    else if (drag.preview) app._refreshTrackClearance?.(drag.original);
}

function prepareTrackPointer(app, track) {
    track = canonicalTrack(app, track);
    app._trackPropertyBinding?.commit();
    app._viaPropertyBinding?.commit();
    app._padPropertyBinding?.commit();
    if (app._viaDrag) finishViaDrag(app);
    if (app._vertexDrag || getPlacementPreviewTracks(app)) return null;
    return track;
}

function beginTrackPointer(app, track, details) {
    const nodes = new Set(details.nodes.map(node => node.nodeId));
    const layers = new Set([...track.edges].filter(([id, edge]) => details.mode === 'move'
        || (details.mode === 'bulge' ? id === details.edgeId : nodes.has(edge.from) || nodes.has(edge.to)))
        .map(([id]) => track.getEdgeLayer(id)));
    if (app._active === false || [...layers].some(layer => isLayerLocked(layer) || !isLayerVisible(layer))) return null;
    const drag = { ...details, original: track, track, layers, lastDx: 0, lastDy: 0,
        previousDeferDragOverlays: _beginVertexDragOverlayDeferral(app),
        previousSuspendBoardViewRefresh: !!app._suspendBoardViewRefresh };
    app._vertexDrag = drag;
    app._suspendBoardViewRefresh = true;
    return drag;
}

function beginTrackPointerPreview(app, drag) {
    if (drag.preview) return drag.track;
    const originals = app.pcbDocument?.tracks || app.tracks;
    if (!originals.includes(drag.original)) {
        cancelVertexDrag(app);
        throw new Error('Cannot edit a missing track.');
    }
    drag.before = drag.original.captureState();
    const copy = new Track({ id: drag.original.id });
    copy.applyState(drag.before);
    drag.track = copy;
    drag.preview = { tracks: originals.map(track => track === drag.original ? copy : track) };
    if (drag.snapTargetNode?.track === drag.original) drag.snapTargetNode.track = copy;
    drag.guideExclude?.excludeTracks?.add(copy);
    for (const { nodeId, attrs } of drag.bridges || []) {
        const node = copy.nodes.get(nodeId);
        const bridgeId = copy.addNode(node.x, node.y);
        copy.addEdge(bridgeId, nodeId, attrs);
    }
    removeTrackElements(drag.original);
    return copy;
}

export function trackPointerTouchesLayer(app, layerId) {
    return app._vertexDrag?.layers?.has(layerId) || false;
}

export function startTrackBulgeDrag(app, track, edgeId) {
    track = prepareTrackPointer(app, track);
    if (!track?.edges.has(edgeId)) return false;
    const edge = track.edges.get(edgeId), a = track.nodes.get(edge.from), b = track.nodes.get(edge.to);
    return !!beginTrackPointer(app, track, { mode: 'bulge', edgeId, nodes: [], initialBulge: edge.bulge || 0,
        bulgeOrigin: arcFromBulge(a, b, edge.bulge)?.bulgePoint || { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } });
}

/** True if any standalone Via sits on `(x, y)`. */
function _viaAtPoint(app, x, y) {
    for (const via of (app.vias || [])) {
        if (Math.abs(via.x - x) < VIA_NODE_EPS && Math.abs(via.y - y) < VIA_NODE_EPS) return true;
    }
    return false;
}

function _opts(app, track = app._vertexDrag?.track) {
    return {
        viaDiameter: app.getRoutingParams?.()?.viaDiameter,
        viaDrill: app.getRoutingParams?.()?.viaDrill,
        hideNetLabel: !!track && (track === getPcbSelection(app, 'track')[0] || track === app._vertexDrag?.track),
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
 * @returns {{track:object, edgeId:string, edge:object, px:number, py:number}|null}
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

function _findNearbyVia(app, worldPos, excludeVia = null) {
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

function _showTrackViaNetConflict(app, trackNet, viaNet, kind = 'via') {
    const message = `Cannot connect track net "${trackNet}" to ${kind} net "${viaNet}".`;
    if (app._alert) app._alert(message, { title: 'Net Conflict' });
    else showAlert(message, { title: 'Net Conflict' });
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
 * node drops on the next left-click through the selection controller.
 * Returns true if the split started.
 *
 * @param {object} app
 * @param {object} track
 * @param {string} nodeId
 * @returns {boolean}
 */
export function splitTrackNodeAndDrag(app, track, nodeId) {
    track = prepareTrackPointer(app, track);
    if (!track?.nodes?.has(nodeId) || track.degree(nodeId) < 2) return false;
    const pos = track.nodes.get(nodeId);
    if (!pos) return false;

    const inc = track.incidentEdges(nodeId);
    if (inc.length < 2) return false;
    const drag = beginTrackPointer(app, track, { mode: 'node', topology: true, preparingSplit: true,
        grabX: pos.x, grabY: pos.y, nodes: [{ nodeId, startX: pos.x, startY: pos.y, padLink: null }] });
    if (!drag) return false;
    const copy = beginTrackPointerPreview(app, drag);
    const newNodeId = copy.splitNode(nodeId, [inc[0].edgeId]);
    if (!newNodeId) { cancelVertexDrag(app); return false; }
    copy.setNodeCornerRadius(newNodeId, copy.nodeCornerRadius(nodeId));
    drag.nodes[0].nodeId = newNodeId;
    drag.splitNodeId = newNodeId;
    renderTrack(copy, id => app.getLayerGroup(id), _opts(app));

    // Float the freshly-detached node under the cursor. The whole split
    // (topology + move) commits atomically via the topology branch in
    // finishVertexDrag; dropping it in place discards the split.
    const adapter = createTrackSelectionAdapter(app, track, track.id);
    const started = beginPathSplit(app, adapter, newNodeId, () => {
        drag.preparingSplit = false;
    });
    if (!started) cancelVertexDrag(app);
    return started;
}

/**
 * Insert a new vertex at the midpoint of `edgeId` and immediately begin
 * dragging it — the schematic Wire "+ in circle" midpoint-anchor model.
 * The edge is split (both halves inherit its copper layer) and the new
 * node is set up as a normal press-drag; the topology change + move
 * commit atomically through finishVertexDrag's topology branch.
 * Dropping in place leaves the node collinear, so finishVertexDrag's
 * collapse pass removes it again (net no-op).
 *
 * @param {object} app
 * @param {object} track
 * @param {string} edgeId
 * @returns {boolean} true if an insertion drag was started.
 */
export function startMidpointInsertDrag(app, track, edgeId) {
    track = prepareTrackPointer(app, track);
    if (!track?.edges?.has(edgeId)) return false;
    const e = track.edges.get(edgeId);
    const a = track.nodes.get(e.from);
    const b = track.nodes.get(e.to);
    if (!a || !b) return false;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

    const drag = beginTrackPointer(app, track, { mode: 'node', topology: true,
        grabX: mid.x, grabY: mid.y,
        nodes: [{ nodeId: e.from }, { nodeId: e.to }] });
    if (!drag) return false;
    const copy = beginTrackPointerPreview(app, drag);
    const res = copy.splitEdge(edgeId, mid);
    if (!res) { cancelVertexDrag(app); return false; }
    // splitEdge copies the source edge's attributes (layer/width) onto both
    // halves, so no manual carry-over is needed.

    drag.nodes = [{ nodeId: res.newNodeId, startX: mid.x, startY: mid.y, padLink: null }];
    // Freeze 3D board-view sync for the drag; it rebuilds once on commit
    // rather than live from the in-flight (uncommitted) node positions.
    app._suspendBoardViewRefresh = true;
    renderTrack(copy, (id) => app.getLayerGroup(id), _opts(app));
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
            layers.add(track.getEdgeLayer(eid));
        }
    }
    return layers;
}

/**
 * Find an existing track node coincident with `(x, y)` that the drawn
 * geometry may fuse into: same net (or one side blank) and carrying an
 * edge on `layer`. Tracks in `exclude` (the freshly drawn ones, not yet
 * committed) are skipped.
 *
 * @returns {{track:object, nodeId:string}|null}
 */
function _findExistingMergeNode(app, x, y, net, layer, exclude) {
    const excludeSet = exclude instanceof Set ? exclude : new Set(exclude || []);
    for (const t of (app.tracks || [])) {
        if (excludeSet.has(t)) continue;
        const otherNet = t.net || '';
        if (net && otherNet && net !== otherNet) continue; // net conflict
        for (const [nid, p] of t.nodes) {
            if (Math.abs(p.x - x) >= NODE_MERGE_EPS || Math.abs(p.y - y) >= NODE_MERGE_EPS) continue;
            // Same copper layer required so we don't silently fuse what
            // should be a via transition.
            if (!_incidentLayers(t, nid).has(layer)) continue;
            return { track: t, nodeId: nid };
        }
    }
    return null;
}

function _bondedNets(bonded, shapes = bonded.shapes) {
    return new Set([...bonded.tracks, ...bonded.vias, ...shapes].map(object => object.net || '')
        .concat([...bonded.padNets]).filter(Boolean));
}

function _showBondedNetConflict(app, nets) {
    const message = `Cannot connect different nets: ${[...nets].map(net => `"${net}"`).join(', ')}.`;
    if (app._alert) app._alert(message);
    else showAlert(message, { title: 'Net Conflict' });
}

function _buildCopperNetCommands(app, bonded, net, shapes = bonded.shapes, includeTracks = true) {
    const commands = [];
    if (!net) return commands;
    if (includeTracks) {
        for (const track of bonded.tracks) {
            if (track.net) continue;
            const nodes = bonded.trackNodes.get(track);
            if (nodes.size === track.nodes.size) {
                commands.push(new ModifyTrackCommand(app, track, { net: track.net }, { net }));
            } else {
                const before = track.captureState();
                const after = track.extractSubgraph(nodes).captureState();
                after.net = net;
                commands.push(new ModifyTrackGraphCommand(app, track, before, after));
                for (const component of track.connectedComponents()) {
                    if (![...component].some(node => nodes.has(node))) {
                        commands.push(new AddTrackCommand(app, track.extractSubgraph(component)));
                    }
                }
            }
        }
    }
    for (const via of bonded.vias) {
        if (!via.net) commands.push(new ModifyViaCommand(app, via, { net: via.net }, { net }));
    }
    for (const pad of app.pads || []) {
        if (pad.net || !bonded.padKeys.has(`null|${pad.id}`)) continue;
        const before = pad.captureState();
        commands.push(new ModifyPadCommand(app, pad, before, { ...before, net }));
    }
    for (const shape of shapes) {
        if (shape.net) continue;
        if (shape.type === 'fill') {
            const before = shape.captureState();
            commands.push(new ModifyFillCommand(app, shape, before, { ...before, net }));
        } else {
            const before = captureBoardShapeState(shape);
            commands.push(new ModifyBoardShapeCommand(app, shape, before, { ...before, net }));
        }
    }
    return commands;
}

/** Capture Net edits after the move/merge so snapshots reference the final topology. */
class AdoptDroppedCopperNetCommand {
    constructor(app, bonded, net) {
        this.app = app;
        this.bonded = bonded;
        this.net = net;
        this.command = null;
    }
    execute() {
        if (!this.command) {
            // Rebind validated contacts to final topology, without rediscovering
            // crossings or depending on a dropped node that may have been merged.
            const tracks = new Set();
            const trackNodes = new Map();
            for (const [preview, nodes] of this.bonded.trackNodes) {
                const track = this.app.tracks.find(candidate => candidate.id === preview.id);
                if (!track) continue; // Absorbed tracks are now part of the surviving graph.
                const connected = track.connectedComponents().filter(component =>
                    [...component].some(id => nodes.has(id)));
                if (!connected.length) continue;
                tracks.add(track);
                trackNodes.set(track, new Set(connected.flatMap(component => [...component])));
            }
            const vias = new Set();
            for (const preview of this.bonded.vias) {
                const via = this.app.vias.find(candidate => candidate.id === preview.id)
                    || this.app.vias.find(candidate => candidate.x === preview.x && candidate.y === preview.y);
                if (!via) throw new Error('Validated node-drop Via is missing after the geometry command.');
                vias.add(via);
            }
            const bonded = { ...this.bonded, tracks, trackNodes, vias };
            this.command = new CompoundCommand(_buildCopperNetCommands(this.app, bonded, this.net));
        }
        this.command.execute();
    }
    undo() { this.command.undo(); }
}

/**
 * Build the history command(s) that commit freshly drawn tracks/vias,
 * fusing any drawn endpoint that lands on an existing track's node (same
 * net, same copper layer) into that existing track. Joined tracks become
 * one continuous polyline instead of two coincident Track objects (which
 * render with a doubled round end-cap at the join).
 *
 * Cross-layer coincidences are deliberately NOT fused here — those remain
 * distinct single-layer nodes bonded by a via (the via/transition model).
 *
 * @param {object} app
 * @param {object|object[]} newTracks freshly built (uncommitted) tracks
 * @param {object[]} [newVias] standalone vias produced alongside the draw
 * @param {object[]} [destinationShapes] Explicit destination copper contacts.
 * @returns {object|null|false} A command, null when empty, or false on a Net conflict.
 */
export function buildDrawnTrackCommands(app, newTracks, newVias = [], destinationShapes = []) {
    const drawn = Array.isArray(newTracks) ? newTracks.slice() : [newTracks];
    const vias = newVias || [];
    const drawnSet = new Set(drawn);
    const bonded = collectNodeConnections({
        ...app, tracks: [...(app.tracks || []), ...drawn], vias: [...(app.vias || []), ...vias],
        pads: app.pads, boardShapes: app.boardShapes,
    }, new Map(drawn.map(track => [track, new Set(track.nodes.keys())])));
    const shapes = new Set([...bonded.shapes, ...destinationShapes]);
    const nets = _bondedNets(bonded, shapes);
    if (nets.size > 1) {
        _showBondedNetConflict(app, nets);
        return false;
    }
    const net = [...nets][0] || '';

    const beforeStates = new Map();      // existing track -> pre-merge snapshot
    const removedExisting = new Set();   // existing tracks emptied by absorb
    const independentAdds = [];          // drawn tracks with no existing join
    const ensureBefore = (t) => { if (!beforeStates.has(t)) beforeStates.set(t, t.captureState()); };
    if (net) {
        for (const track of bonded.tracks) {
            if (track.net || drawnSet.has(track)) continue;
            ensureBefore(track);
            const nodes = bonded.trackNodes.get(track);
            if (nodes.size < track.nodes.size) {
                for (const component of track.connectedComponents()) {
                    if (![...component].some(node => nodes.has(node))) independentAdds.push(track.extractSubgraph(component));
                }
                track.applyState(track.extractSubgraph(nodes).captureState());
            }
            track.net = net;
        }
        for (const track of drawn) track.net = net;
        for (const via of vias) via.net = net;
    }

    for (const nt of drawn) {
        // Endpoints (degree-1 nodes) of the drawn track, with their layer.
        const conns = [];
        for (const [nid] of nt.nodes) {
            const inc = nt.incidentEdges(nid);
            if (inc.length !== 1) continue;
            const layer = nt.getEdgeLayer(inc[0].edgeId) || nt.layer;
            const p = nt.nodes.get(nid);
            const target = _findExistingMergeNode(app, p.x, p.y, nt.net, layer, drawnSet);
            if (target) conns.push({ nodeId: nid, target });
        }
        if (conns.length === 0) { independentAdds.push(nt); continue; }

        // Fuse the drawn track into the first existing track it touches.
        const primary = conns[0].target.track;
        ensureBefore(primary);
        const remapNt = primary.absorb(nt);
        if (!primary.net && nt.net) primary.net = nt.net;

        for (const { nodeId, target } of conns) {
            let targetNodeId = target.nodeId;
            if (target.track !== primary) {
                // Drawn track bridges two existing tracks: pull the second
                // one into primary as well, then drop it.
                ensureBefore(target.track);
                const remapEx = primary.absorb(target.track);
                if (!primary.net && target.track.net) primary.net = target.track.net;
                removedExisting.add(target.track);
                drawnSet.add(target.track);
                targetNodeId = remapEx.get(target.nodeId) ?? targetNodeId;
            }
            const drawnNodeId = remapNt.get(nodeId);
            if (drawnNodeId && targetNodeId) primary.mergeNodes(targetNodeId, drawnNodeId);
        }
        // Dissolve any now-redundant collinear waypoint at the join.
        collapseCollinearTrackNodes(app, primary);
    }

    const cmds = [];
    for (const [existing, before] of beforeStates) {
        const after = existing.captureState();
        existing.applyState(before);
        if (removedExisting.has(existing)) {
            cmds.push(new RemoveTrackCommand(app, existing));
        } else {
            cmds.push(new ModifyTrackGraphCommand(app, existing, before, after));
        }
    }
    for (const nt of independentAdds) cmds.push(new AddTrackCommand(app, nt));
    for (const v of vias) cmds.push(new AddViaCommand(app, v));
    cmds.push(..._buildCopperNetCommands(app, bonded, net, shapes, false));

    if (cmds.length === 0) return null;
    return cmds.length === 1 ? cmds[0] : new CompoundCommand(cmds);
}


/** True if a standalone Via already sits at `(x, y)`. */
function _hasViaAt(app, x, y) {
    return (app.vias || []).some(
        (v) => Math.abs(v.x - x) < NODE_MERGE_EPS && Math.abs(v.y - y) < NODE_MERGE_EPS);
}

/** Build a standalone Via at `(x, y)` on `net` using the app's routing params. */
function _makeViaAt(app, x, y, net) {
    const p = app.getRoutingParams?.() || {};
    const diameter = Number.isFinite(p.viaDiameter) && p.viaDiameter > 0 ? p.viaDiameter : 0.6;
    const drill = Number.isFinite(p.viaDrill) && p.viaDrill > 0 ? p.viaDrill : 0.3;
    return new Via({ x, y, diameter, drill, net: net || '' });
}

/**
 * Re-normalise the whole copper region physically bonded to `seedTrack`
 * into the canonical model and return the minimal command payload to get
 * there. Handles BOTH directions of an edit:
 *
 *  - SPLIT: an edge now jumps layer → the region splits into one
 *    single-layer Track per maximal same-layer connected run, with a
 *    standalone Via added at every position where ≥2 layers now meet.
 *  - MERGE: an edge moved back so a former transition is gone → the two
 *    formerly-separate single-layer Tracks fuse into one and the now
 *    superfluous Via is removed.
 *
 * The region is the set of Tracks reachable from `seedTrack` through
 * coincident node positions (positional bonding — the same premise the
 * ratsnest uses), plus every standalone Via sitting on one of those
 * positions. The region is rebuilt from a single position-keyed multigraph
 * of all its edges: per layer → connected components → one Track each; a
 * via is needed iff a position carries edges of ≥2 distinct layers. Region
 * vias at a still-needed position are KEPT (preserving their diameter/drill);
 * all other region vias are removed as superfluous.
 *
 * A via is required at EVERY layer boundary regardless of copper-ness, so a
 * TOP → SILK → BOTTOM run keeps a via at each boundary.
 *
 * The caller must apply the edge's layer change to `seedTrack` BEFORE calling
 * this (the mutated graph is read here), then restore it to its pre-change
 * state so the returned RemoveTrackCommand captures clean undo.
 *
 * @param {object} app
 * @param {import('../../shapes/track.js').Track} seedTrack
 * @returns {{removeTracks: object[], addTracks: object[], removeVias: object[], addVias: object[]}}
 */
export function reconcileCopperRegion(app, seedTrack) {
    const EPS = NODE_MERGE_EPS;
    const key = (x, y) => `${Math.round(x / EPS)}|${Math.round(y / EPS)}`;

    // Index every track node by rounded position for fast coincidence lookup.
    const nodeIndex = new Map();   // posKey → [{ track }]
    for (const t of (app.tracks || [])) {
        for (const [, p] of t.nodes) {
            const k = key(p.x, p.y);
            if (!nodeIndex.has(k)) nodeIndex.set(k, []);
            nodeIndex.get(k).push(t);
        }
    }

    // BFS the region of tracks connected through shared positions.
    const regionTracks = new Set([seedTrack]);
    const stack = [seedTrack];
    while (stack.length) {
        const t = stack.pop();
        if (!t) continue;
        for (const [, p] of t.nodes) {
            for (const other of nodeIndex.get(key(p.x, p.y)) || []) {
                if (!regionTracks.has(other)) {
                    regionTracks.add(other);
                    stack.push(other);
                }
            }
        }
    }

    // Positions occupied by region copper, and the region's standalone vias.
    const regionPosSet = new Set();
    for (const t of regionTracks)
        for (const [, p] of t.nodes) regionPosSet.add(key(p.x, p.y));
    const regionVias = (app.vias || []).filter((v) => regionPosSet.has(key(v.x, v.y)));

    // Net for rebuilt copper: first non-empty among region tracks, then vias.
    let net = '';
    for (const t of regionTracks) if (t.net) { net = t.net; break; }
    if (!net) for (const v of regionVias) if (v.net) { net = v.net; break; }

    // Unified position-keyed multigraph of all region edges.
    const uNodes = new Map();      // posKey → { x, y }
    const uEdges = [];             // { a, b, layer, width }
    const padAt = new Map();       // posKey → padConnection
    const radiusAt = new Map();
    for (const t of regionTracks) {
        for (const [nodeId, point] of t.nodes) {
            const position = key(point.x, point.y);
            if (!radiusAt.has(position)) radiusAt.set(position, t.nodeCornerRadius(nodeId));
        }
        for (const [eid, e] of t.edges) {
            const pa = t.nodes.get(e.from), pb = t.nodes.get(e.to);
            const ka = key(pa.x, pa.y), kb = key(pb.x, pb.y);
            if (!uNodes.has(ka)) uNodes.set(ka, { x: pa.x, y: pa.y });
            if (!uNodes.has(kb)) uNodes.set(kb, { x: pb.x, y: pb.y });
            uEdges.push({ a: ka, b: kb, layer: t.getEdgeLayer(eid), width: t.getEdgeWidth(eid), bulge: e.bulge || 0 });
        }
        for (const [nid, conn] of t.padConnections) {
            const p = t.nodes.get(nid);
            if (p) padAt.set(key(p.x, p.y), { ...conn });
        }
    }

    // Per-layer connected components → one fresh single-layer Track each.
    const addTracks = [];
    const layers = new Set(uEdges.map((e) => e.layer));
    for (const layer of layers) {
        const layerEdges = uEdges.filter((e) => e.layer === layer);
        const adj = new Map();     // posKey → [posKey]
        for (const e of layerEdges) {
            if (!adj.has(e.a)) adj.set(e.a, []);
            if (!adj.has(e.b)) adj.set(e.b, []);
            adj.get(e.a).push(e.b);
            adj.get(e.b).push(e.a);
        }
        const seen = new Set();
        for (const startK of adj.keys()) {
            if (seen.has(startK)) continue;
            const compKeys = new Set();
            const st = [startK];
            while (st.length) {
                const k = st.pop();
                if (compKeys.has(k)) continue;
                compKeys.add(k);
                seen.add(k);
                for (const o of adj.get(k) || []) if (!compKeys.has(o)) st.push(o);
            }
            const compWidth = layerEdges.find((e) => compKeys.has(e.a))?.width || seedTrack.width;
            const sub = new Track({ net, width: compWidth, layer, cornerRadius: seedTrack.cornerRadius });
            const kToNid = new Map();
            for (const k of compKeys) {
                const p = uNodes.get(k);
                const nn = sub.addNode(p.x, p.y);
                kToNid.set(k, nn);
                sub.setNodeCornerRadius(nn, radiusAt.get(k) || 0);
                if (padAt.has(k)) sub.padConnections.set(nn, { ...padAt.get(k) });
            }
            for (const e of layerEdges) {
                if (!compKeys.has(e.a)) continue;
                // Carry the per-edge layer and width onto the rebuilt edge so
                // a component with mixed-width segments keeps each width.
                sub.addEdge(kToNid.get(e.a), kToNid.get(e.b), { layer, width: e.width, bulge: e.bulge });
            }
            addTracks.push(sub);
        }
    }

    // Positions where ≥2 distinct layers meet require a via.
    const layersAt = new Map();    // posKey → Set(layer)
    for (const e of uEdges) {
        if (!layersAt.has(e.a)) layersAt.set(e.a, new Set());
        if (!layersAt.has(e.b)) layersAt.set(e.b, new Set());
        layersAt.get(e.a).add(e.layer);
        layersAt.get(e.b).add(e.layer);
    }
    const neededViaKeys = new Set();
    for (const [k, ls] of layersAt) if (ls.size >= 2) neededViaKeys.add(k);

    // Keep region vias still at a needed boundary; remove the rest as
    // superfluous; add vias at needed boundaries not already covered.
    const keptKeys = new Set();
    const removeVias = [];
    for (const v of regionVias) {
        const k = key(v.x, v.y);
        if (neededViaKeys.has(k) && !keptKeys.has(k)) keptKeys.add(k);
        else removeVias.push(v);
    }
    const addVias = [];
    for (const k of neededViaKeys) {
        if (keptKeys.has(k)) continue;
        const p = uNodes.get(k);
        addVias.push(_makeViaAt(app, p.x, p.y, net));
    }

    return { removeTracks: [...regionTracks], addTracks, removeVias, addVias };
}

function _droppedNodeTarget(app, drag) {
    const nd = drag.nodes[0];
    const track = drag.track;
    const n = track.nodes.get(nd.nodeId);
    if (!n) return null;
    // Prefer the node the cursor actually snapped onto during the drag (the
    // yellow target). Coincidence re-detection is a fallback: with the
    // screen-pixel node-snap band, a drop can land visually-on but not
    // bit-exactly on the target, so coincidence alone would miss the merge.
    if (drag.snapTargetNode
        && !(drag.snapTargetNode.track === track && drag.snapTargetNode.nodeId === nd.nodeId)
        && app.tracks?.includes(drag.snapTargetNode.track)
        && drag.snapTargetNode.track.nodes?.has(drag.snapTargetNode.nodeId)) {
        return drag.snapTargetNode;
    }
    return _findCoincidentNode(app, track, nd.nodeId, n.x, n.y);
}

/**
 * Same-layer drops fuse nodes; cross-layer drops keep distinct coincident
 * nodes joined by a Via, preserving the single-layer graph-node invariant.
 * Builds canonical commands from the detached graph, or null for a plain move.
 */
function droppedNodeCommands(app, view, drag) {
    const nd = drag.nodes[0];
    const track = drag.track;
    const n = track.nodes.get(nd.nodeId);
    if (!n) return null;
    let dropX = n.x, dropY = n.y;
    const target = _droppedNodeTarget(view, drag);
    if (!target) return null;
    // Pull the dragged node exactly onto the target so the fused geometry is
    // bit-coincident regardless of the release position.
    const tp = target.track.nodes.get(target.nodeId);
    if (tp) { dropX = tp.x; dropY = tp.y; n.x = tp.x; n.y = tp.y; }

    const netA = track.net || '';
    const netB = target.track.net || '';
    if (netA && netB && netA !== netB) {
        showAlert(
            `Cannot merge nodes on different nets: "${netA}" and "${netB}".`,
            { title: 'Net Conflict' }
        );
        return [];
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
        cmds.push(new ModifyTrackGraphCommand(app, drag.original, drag.before, after));
        if (needsVia) {
            cmds.push(new AddViaCommand(app, _makeViaAt(app, dropX, dropY, mergedNet)));
        }
    } else if (target.track === track) {
        // Same track, same layer: collapse the two nodes (keep the target).
        track.mergeNodes(target.nodeId, nd.nodeId);
        const after = track.captureState();
        cmds.push(new ModifyTrackGraphCommand(app, drag.original, drag.before, after));
    } else {
        // Cross-track, same layer: pull the other track's graph in, fuse the
        // shared node into one continuous track, inherit its net if we had
        // none, then drop the now-empty other track.
        const remap = track.absorb(target.track);
        const absorbedNid = remap.get(target.nodeId);
        const dn = track.nodes.get(nd.nodeId);
        if (dn) { dn.x = dropX; dn.y = dropY; }
        if (absorbedNid) track.mergeNodes(nd.nodeId, absorbedNid);
        if (!track.net && netB) track.net = netB;
        const after = track.captureState();
        cmds.push(new RemoveTrackCommand(app, canonicalTrack(app, target.track)));
        cmds.push(new ModifyTrackGraphCommand(app, drag.original, drag.before, after));
    }
    return cmds;
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
    if (app._vertexDrag?.preparingSplit
        && canonicalTrack(app, track) === app._vertexDrag.original
        && opts.nodeId === app._vertexDrag.splitNodeId) return true;
    track = prepareTrackPointer(app, track);
    if (!track) return false;
    if (opts.whole) {
        return !!beginTrackPointer(app, track, { mode: 'move', topology: true,
            grabX: worldPos.x, grabY: worldPos.y,
            nodes: [...track.nodes].map(([nodeId, point]) => ({ nodeId, startX: point.x, startY: point.y,
                padLink: track.padConnections.get(nodeId) || null })) });
    }
    const allowMidpointInsert = opts.allowMidpointInsert !== false;
    const nodeId = opts.edgeId ? null : opts.nodeId ?? hitTestTrackNode(app, track, worldPos);

    // Grabbing a node: drag that single node (snaps to grid/pad/node).
    if (nodeId) {
        const n = track.nodes.get(nodeId);
        if (!n) return false;
        const drag = beginTrackPointer(app, track, {
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
            // Copper this track is already bonded to (computed at rest, before
            // the drag moves anything), so the live net-guide line never
            // points back at copper the dragged end already connects to.
            guideExclude: track.net ? bondedExclusion(app, track) : null,
        });
        if (!drag) return false;
        // Freeze 3D board-view sync for the drag; it rebuilds once on commit
        // rather than live from the in-flight (uncommitted) node positions.
        app._suspendBoardViewRefresh = true;
        app.viewport?.setCrosshair({ x: n.x, y: n.y });
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
    const hit = opts.edgeId ? { edgeId: opts.edgeId, edge: track.edges.get(opts.edgeId) } : hitTestTrackEdge(app, track, worldPos);
    if (!hit?.edge) return false;
    const e = hit.edge;
    const a = track.nodes.get(e.from);
    const b = track.nodes.get(e.to);
    if (!a || !b) return false;

    // If an endpoint of the dragged segment sits on a via, keep the via
    // anchored where it is and grow a new "bridge" segment from the via
    // to the moving endpoint, so the track stays connected through the
    // via instead of tearing away from it. Remember the pins now; the first
    // changed preview stages the bridge geometry for an atomic undo.
    const segAttrs = track._cloneEdge(track.edges.get(hit.edgeId));
    const bridges = [];
    for (const epId of [e.from, e.to]) {
        const n = track.nodes.get(epId);
        if (!_viaAtPoint(app, n.x, n.y)) continue;
        bridges.push({ nodeId: epId, attrs: segAttrs });
        // NOTE: the other layer's copper at this via lives on a SEPARATE
        // coincident node (model invariant: one node per layer at a via),
        // so it is not an endpoint of the dragged segment and stays pinned
        // to the via automatically — no edge re-pointing needed here.
    }

    const drag = beginTrackPointer(app, track, {
        mode: 'segment',
        grabX: worldPos.x,
        grabY: worldPos.y,
        bridges, topology: bridges.length > 0,
        edgeId: hit.edgeId,
        nodes: [
            { nodeId: e.from, startX: a.x, startY: a.y, padLink: track.padConnections.get(e.from) || null },
            { nodeId: e.to, startX: b.x, startY: b.y, padLink: track.padConnections.get(e.to) || null },
        ],
    });
    if (!drag) return false;
    // Freeze 3D board-view sync for the drag; it rebuilds once on commit
    // rather than live from the in-flight (uncommitted) node positions.
    app._suspendBoardViewRefresh = true;
    app.viewport?.setCrosshair({ x: a.x, y: a.y });
    return true;
}

/** Update the dragged node(s) from the current mouse world pos. */
export function updateVertexDrag(app, worldPos) {
    const drag = app._vertexDrag;
    if (!drag) return;
    if (!Number.isFinite(worldPos?.x) || !Number.isFinite(worldPos?.y)) {
        cancelVertexDrag(app);
        throw new Error('Track drag requires a finite position.');
    }
    if ([...drag.layers].some(layer => isLayerLocked(layer) || !isLayerVisible(layer))) {
        cancelVertexDrag(app);
        return;
    }
    if (drag.mode === 'bulge') {
        const edge = drag.track.edges.get(drag.edgeId);
        const snap = snapPathPoint(app, worldPos, [], true);
        const bulge = snap.x === drag.bulgeOrigin.x && snap.y === drag.bulgeOrigin.y ? drag.initialBulge
            : Math.max(-1, Math.min(1, bulgeRatio(drag.track.nodes.get(edge.from), drag.track.nodes.get(edge.to), snap)));
        if ((edge.bulge || 0) === bulge) return;
        const copy = beginTrackPointerPreview(app, drag);
        copy.setEdgeAttr(drag.edgeId, 'bulge', bulge);
        renderTrack(copy, layer => app.getLayerGroup(layer), _opts(app));
        app._refreshTrackClearance?.(copy);
        app.refreshSelectedDRCMarker?.();
        refreshTrackSelectionHalo(app);
        const input = document.getElementById('pcbPropTrackBulge');
        if (input) input.value = formatNumberInputValue(bulge);
        return;
    }

    if (drag.mode === 'segment' || drag.mode === 'move') {
        // Translate both endpoints by the cursor delta. The dragged segment
        // itself can't change orientation, but its connected (non-dragged)
        // neighbours can — so snap the delta when one of those neighbours
        // lands on an H/V/45° axis or becomes collinear with its far edge.
        const rawDx = worldPos.x - drag.grabX;
        const rawDy = worldPos.y - drag.grabY;
        if (!drag.translationPoints) {
            drag.translationPoints = drag.nodes.map(node => ({ x: node.startX, y: node.startY }));
            const movedIds = new Set(drag.nodes.map(node => node.nodeId));
            drag.constraints = drag.mode === 'segment' ? drag.nodes.map((node, index) => ({
                index,
                neighbours: [
                    ...drag.track.incidentEdges(node.nodeId).filter(edge => !movedIds.has(edge.otherNode))
                        .map(edge => drag.track.nodes.get(edge.otherNode)),
                    ...(drag.bridges.some(bridge => bridge.nodeId === node.nodeId)
                        ? [{ x: node.startX, y: node.startY }] : []),
                ],
            })) : [];
        }
        const delta = snapPathTranslation(app, drag.translationPoints,
            { x: rawDx, y: rawDy }, drag.mode === 'move' ? [drag.translationPoints[0]] : [], drag.constraints);
        const { x: dx, y: dy } = delta;
        if (dx === drag.lastDx && dy === drag.lastDy) return;
        beginTrackPointerPreview(app, drag);
        drag.lastDx = dx;
        drag.lastDy = dy;
        for (const nd of drag.nodes) {
            const n = drag.track.nodes.get(nd.nodeId);
            if (!n) continue;
            n.x = nd.startX + dx;
            n.y = nd.startY + dy;
            if (nd.padLink) {
                if (dx === 0 && dy === 0) drag.track.padConnections.set(nd.nodeId, { ...nd.padLink });
                else drag.track.padConnections.delete(nd.nodeId);
            }
        }
        const anchor = drag.track.nodes.get(drag.nodes[0]?.nodeId);
        drag.track.invalidate();
        if (anchor) app.viewport?.setCrosshair({ x: anchor.x, y: anchor.y });
        renderTrackAxisGlow(app, _incidentSegments(drag.track, drag.nodes));
        renderTrack(drag.track, (id) => app.getLayerGroup(id), _opts(app));
        app._refreshTrackClearance?.(drag.track);
        renderTrackAxisGlowTop(app);
        refreshTrackSelectionHalo(app);
        reconcileRatsnest(app);
        clearNetGuideLine(app);
        return;
    }

    // Single-node drag: snaps to grid / pad / track-node targets.
    const nd = drag.nodes[0];
    // Don't exclude the whole dragged track — that would prevent snapping a
    // loose end onto ANOTHER node of the SAME track (e.g. closing a loop, or
    // merging the two remaining ends after a prior cross-track merge fused
    // both tracks into one). Instead exclude just the dragged node itself and
    // its directly-connected neighbours (snapping onto an adjacent node would
    // collapse that edge to zero length).
    const draggedId = nd.nodeId;
    const neighborIds = drag.neighborIds ||= new Set(drag.track.incidentEdges(draggedId).map(edge => edge.otherNode));
    const snap = resolveTrackSnap(app, worldPos, {
        layer: drag.track.getEdgeLayer(drag.track.incidentEdges(draggedId)[0]?.edgeId) || drag.track.layer,
        excludeNode: (track, nid) =>
            canonicalTrack(app, track) === drag.original && (nid === draggedId || neighborIds.has(nid)),
    });
    const current = drag.track.nodes.get(nd.nodeId);
    if (!current) return;
    const snapVia = app.viewport?.shiftHeld
        || snap.snapType === 'pad' || snap.snapType === 'track-node'
        ? null : _findNearbyVia(app, worldPos);
    const n = { x: snapVia ? snapVia.x : snap.x, y: snapVia ? snapVia.y : snap.y };
    const previousTarget = drag.snapTargetNode, previousVia = drag.snapTargetVia;
    drag.snapTargetVia = snapVia || snap.pad?.standalonePad || null;
    drag.snapTargetKind = snap.pad?.standalonePad ? 'pad' : 'via';

    // Remember the exact node the cursor snapped onto, so the drop merges
    // into THAT node even though the smaller node-snap band means the
    // released position may not re-detect by coincidence alone.
    drag.snapTargetNode = snap.snapType === 'track-node' && snap.trackNode
        ? { track: snap.trackNode.track, nodeId: snap.trackNode.nodeId }
        : null;

    // Axis snap: when an incident segment falls within the alignment-glow
    // band, lock the node exactly onto that H/V/45° axis so a drop matches
    // the glow (no hysteresis gap). Pad / track-node snaps are hard
    // targets and take priority over axis alignment.
    if (!app.viewport?.shiftHeld && snap.snapType !== 'pad'
        && snap.snapType !== 'track-node' && !snapVia) {
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

    const connection = snap.snapType === 'pad' && snap.pad?.componentId
        ? { componentId: snap.pad.componentId, pinNumber: snap.pad.pinNumber }
        : n.x === nd.startX && n.y === nd.startY ? nd.padLink : null;
    const currentConnection = drag.track.padConnections.get(nd.nodeId);
    const changed = n.x !== current.x || n.y !== current.y
        || currentConnection?.componentId !== connection?.componentId
        || currentConnection?.pinNumber !== connection?.pinNumber;
    const targetChanged = previousTarget?.track !== drag.snapTargetNode?.track
        || previousTarget?.nodeId !== drag.snapTargetNode?.nodeId || previousVia !== drag.snapTargetVia;
    if (!changed && !targetChanged) return;
    if (snap.snapType === 'pad' || snap.snapType === 'track-node' || snapVia) showTrackSnapMarker(app, n);
    else clearTrackSnapMarker(app);
    app.viewport?.setCrosshair(n);
    if (!changed) return;
    beginTrackPointerPreview(app, drag);
    Object.assign(drag.track.nodes.get(nd.nodeId), n);

    // If the user landed on a pad, record/replace the pad connection.
    if (connection) {
        drag.track.padConnections.set(nd.nodeId, { ...connection });
    } else {
        drag.track.padConnections.delete(nd.nodeId);
    }

    drag.track.invalidate();
    renderTrackAxisGlow(app, _incidentSegments(drag.track, drag.nodes));
    renderTrack(drag.track, (id) => app.getLayerGroup(id), _opts(app));
    app._refreshTrackClearance?.(drag.track);
    renderTrackAxisGlowTop(app);
    // Keep the selection halo glued to the new geometry.
    refreshTrackSelectionHalo(app);
    reconcileRatsnest(app);

    updateNetGuideLine(app, drag.track.net, { x: n.x, y: n.y }, drag.guideExclude?.ratlinePointKeys);
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
    /** @type {{dx:number, dy:number, nudge:number}|null} */
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
                const l1 = track.getEdgeLayer(draggedEdge.edgeId);
                const l2 = track.getEdgeLayer(fixedEdge.edgeId);
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
                const l1 = track.getEdgeLayer(edgeId);
                const l2 = other ? track.getEdgeLayer(other.edgeId) : null;
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
    // `coupled` is only assigned inside considerCoupled(); TS control-flow
    // narrows it back to its `null` initializer here, so re-assert the type.
    const c = /** @type {{dx:number, dy:number, nudge:number}|null} */ (coupled);
    if (c && c.nudge <= axisNudge) return { dx: c.dx, dy: c.dy };
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
            layerId: track.getEdgeLayer(edgeId) || 'top-copper',
            width: track.getEdgeWidth(edgeId),
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
        const l1 = track.getEdgeLayer(inc[0].edgeId);
        const l2 = track.getEdgeLayer(inc[1].edgeId);
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
        const l1 = track.getEdgeLayer(edgeId);
        const l2 = track.getEdgeLayer(other.edgeId);
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
    let committed = false;
    try {
        clearTrackPointerGuides(app, drag);
        if (app._active === false || [...drag.layers].some(layer => isLayerLocked(layer) || !isLayerVisible(layer))) return;
        if (!drag.preview && drag.snapTargetNode) beginTrackPointerPreview(app, drag);
        if (!drag.preview) return;
        const tracks = app.pcbDocument?.tracks || app.tracks;
        if (!tracks.includes(drag.original)
            || Object.keys(drag.before.nodes).some(id => !drag.original.nodes.has(id))
            || Object.keys(drag.before.edges).some(id => !drag.original.edges.has(id))) {
            throw new Error('Cannot finish a drag of a missing track, node or segment.');
        }
        const target = drag.snapTargetNode;
        const originalTarget = target && canonicalTrack(app, target.track);
        if (target && (!tracks.includes(originalTarget) || !originalTarget.nodes.has(target.nodeId))) {
            throw new Error('Cannot finish a drag onto a missing track node.');
        }
        if (drag.snapTargetVia && !(drag.snapTargetKind === 'pad' ? app.pads : app.vias)?.includes(drag.snapTargetVia)) {
            throw new Error('Cannot finish a drag onto a missing terminal.');
        }
        const view = { ...app, tracks: tracks.map(track => track === drag.original ? drag.track : track),
            vias: app.vias, pads: app.pads, boardShapes: app.boardShapes, texts: app.texts };
        const commands = trackPointerCommands(app, view, drag);
        app._vertexDrag = null;
        removeTrackElements(drag.track);
        if (commands.length) {
            app.history.execute(commands.length === 1 ? commands[0] : new CompoundCommand(commands));
            committed = true;
        }
    } finally {
        endTrackPointer(app, drag, committed);
    }
}

function trackPointerCommands(app, view, drag) {
    if (drag.mode === 'bulge') {
        const edge = drag.track.edges.get(drag.edgeId);
        if (Number(formatNumberInputValue(edge.bulge)) === 0) edge.bulge = 0;
        const after = drag.track.captureState();
        return JSON.stringify(after) === JSON.stringify(drag.before) ? []
            : [new ModifyTrackGraphCommand(app, drag.original, drag.before, after)];
    }
    const moved = drag.nodes.some(nd => {
        const n = drag.track.nodes.get(nd.nodeId);
        return n && (Math.abs(n.x - nd.startX) > 1e-6 || Math.abs(n.y - nd.startY) > 1e-6);
    });
    if (!moved && (drag.topology || !drag.snapTargetNode)) return [];
    let netCommand = null;
    if (drag.mode === 'node' && drag.nodes.length === 1 && (moved || drag.snapTargetNode)) {
        const nodeId = drag.nodes[0].nodeId;
        const target = _droppedNodeTarget(view, drag);
        let prospectiveApp = view;
        if (target && !drag.topology) {
            const fromLayers = _incidentLayers(drag.track, nodeId);
            const toLayers = _incidentLayers(target.track, target.nodeId);
            const point = target.track.nodes.get(target.nodeId);
            if (fromLayers.size && toLayers.size && ![...fromLayers].some(layer => toLayers.has(layer))
                && !_hasViaAt(app, point.x, point.y)) {
                // Validate the connection the merge will create across layers,
                // including the transition Via that is not on the board yet.
                prospectiveApp = { ...view,
                    vias: [...(app.vias || []), _makeViaAt(app, point.x, point.y, '')] };
            }
        }
        const bonded = collectNodeConnections(prospectiveApp,
            new Map([[drag.track, new Set([nodeId])]]));
        const nets = _bondedNets(bonded);
        if (nets.size > 1) {
            const terminalNet = drag.snapTargetVia?.net;
            if (drag.track.net && terminalNet && drag.track.net !== terminalNet) {
                _showTrackViaNetConflict(app, drag.track.net, terminalNet, drag.snapTargetKind);
            } else _showBondedNetConflict(app, nets);
            return [];
        }
        const net = [...nets][0];
        if (net) netCommand = new AdoptDroppedCopperNetCommand(app, bonded, net);
    }
    const withNet = commands => netCommand && commands.length ? [...commands, netCommand] : commands;
    if (drag.topology) {
        if (drag.mode !== 'move') collapseCollinearTrackNodes(app, drag.track);
        if (drag.splitNodeId) {
            const components = drag.track.connectedComponents();
            if (components.length > 1) {
                const movingNodes = components.find(nodes => nodes.has(drag.splitNodeId));
                const movingPart = drag.track.extractSubgraph(movingNodes);
                movingPart.sourceBoardShape = drag.track.sourceBoardShape;
                const remainder = components.filter(nodes => nodes !== movingNodes)
                    .map(nodes => drag.track.extractSubgraph(nodes));
                const after = movingPart.captureState();
                return withNet([
                    new ModifyTrackGraphCommand(app, drag.original, drag.before, after),
                    ...remainder.map(track => new AddTrackCommand(app, track)),
                ]);
            }
        }
        const after = drag.track.captureState();
        return withNet([new ModifyTrackGraphCommand(app, drag.original, drag.before, after)]);
    }

    // Single-node drop onto another node → merge into one (schematic-style).
    // A net conflict (two different non-empty nets) is rejected with a dialog.
    // The merge also fires when the node didn't net-move but snapped onto
    // another track's node during the drag (`snapTargetNode`): two endpoints
    // that are already coincident (the visible "join") produce zero net
    // displacement when one is dragged onto the other, so a `moved`-only gate
    // would never fuse them.
    if (drag.mode === 'node' && drag.nodes.length === 1 && (moved || drag.snapTargetNode)) {
        const merged = droppedNodeCommands(app, view, drag);
        if (merged) return withNet(merged);
    }

    const moves = [];
    for (const nd of drag.nodes) {
        const n = drag.track.nodes.get(nd.nodeId);
        if (!n) continue;
        if (Math.abs(n.x - nd.startX) > 1e-6 || Math.abs(n.y - nd.startY) > 1e-6) {
            moves.push({ nodeId: nd.nodeId, fromX: nd.startX, fromY: nd.startY, toX: n.x, toY: n.y });
        }
    }
    if (!moves.length) return [];
    const collapsed = collapseCollinearTrackNodes(app, drag.track);
    const after = drag.track.captureState();
    if (collapsed || JSON.stringify(after.padConnections) !== JSON.stringify(drag.before.padConnections)) {
        return withNet([new ModifyTrackGraphCommand(app, drag.original, drag.before, after)]);
    }
    const moveCmds = moves.map((m) =>
        new MoveVertexCommand(app, drag.original, m.nodeId, m.fromX, m.fromY, m.toX, m.toY));
    return withNet(moveCmds);
}

/** Discard the in-progress drag and restore canonical artwork. */
export function cancelVertexDrag(app) {
    const drag = app._vertexDrag;
    if (!drag) return;
    endTrackPointer(app, drag, false);
}

function clearTrackPointerGuides(app, drag) {
    if (drag.mode !== 'bulge') app.viewport?.hideCrosshair();
    clearTrackAxisGlow(app);
    clearTrackSnapMarker(app);
    clearNetGuideLine(app);
}

function endTrackPointer(app, drag, committed) {
    const interaction = app._pcbSelectionInteraction;
    if (interaction?.adapter?.kind === 'track'
        || (interaction?.mode === 'move-adapter' && interaction.entry.kind === 'track')) {
        app._pcbSelectionInteraction = null;
    }
    app._vertexDrag = null;
    try {
        clearTrackPointerGuides(app, drag);
        const present = (app.pcbDocument?.tracks || app.tracks).includes(drag.original);
        if (!present) {
            removeTrackElements(drag.original);
            if (app._trackEdit?.track === drag.original) app._trackEdit = null;
            syncPcbSelection(app);
            app.clearProperties?.();
        }
        if (drag.preview) {
            removeTrackElements(drag.track);
            if (!committed && present) {
                renderTrack(drag.original, id => app.getLayerGroup(id), _opts(app, drag.original));
            }
            refreshTrackSelectionHalo(app);
        }
    } finally {
        app._suspendBoardViewRefresh = drag.previousSuspendBoardViewRefresh;
        _endVertexDragOverlayDeferral(app, drag);
        if (drag.preview) reconcileRatsnest(app, { skipFillRefresh: !committed });
        if (!app._suspendBoardViewRefresh && drag.preview) app._board3d?.refresh?.();
    }
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
    return viaHitTest(via, worldPos, pxTol / scale);
}

/**
 * Begin a drag on the given (already-selected) Via if the click landed
 * on it. Captures any Track nodes colocated with the via so they drag
 * along — the via acts as a hinge that connected wires follow.
 */
export function startViaDrag(app, via, worldPos) {
    if (!via || !_hitVia(app, via, worldPos)) return false;
    return startTerminalDrag(app, via, worldPos, 'via');
}

/** Pads and vias share attached-node movement, snapping and atomic history. */
export function startPadDrag(app, pad, worldPos) {
    return startTerminalDrag(app, pad, worldPos, 'pad');
}

function startTerminalDrag(app, via, worldPos, kind) {
    if (app._vertexDrag) finishVertexDrag(app);
    app._trackPropertyBinding?.commit();
    const layers = kind === 'pad' ? padLayers(via) : ['top-copper', 'bottom-copper'];
    // Find every Track node at the via's current (x, y). Track endpoints
    // and layer-change nodes commonly sit exactly on a via.
    const EPS = 1e-4;
    const attached = []; // [{track, nodeId, startX, startY}]
    for (const t of app.tracks || []) {
        for (const [nid, n] of t.nodes) {
            if (Math.abs(n.x - via.x) < EPS && Math.abs(n.y - via.y) < EPS) {
                if (!t.incidentEdges(nid).some(edge => layers.includes(t.getEdgeLayer(edge.edgeId)))) continue;
                attached.push({ track: t, nodeId: nid, startX: n.x, startY: n.y });
            }
        }
    }
    app._viaDrag = {
        via,
        original: via,
        kind,
        layers,
        render: kind === 'pad' ? renderPad : renderVia,
        remove: kind === 'pad' ? removePadElements : removeViaElements,
        startX: via.x,
        startY: via.y,
        grabX: worldPos.x,
        grabY: worldPos.y,
        attached,
        previousDeferDragOverlays: !!app._deferDragOverlays,
    };
    app._deferDragOverlays = true;
    app.viewport?.setCrosshair({ x: via.x, y: via.y });
    return true;
}

function beginTerminalPreview(app, drag) {
    if (drag.preview) return;
    const copy = drag.kind === 'pad' ? new Pad({ id: drag.original.id }) : new Via({ id: drag.original.id });
    copy.applyState(drag.original.captureState());
    const copies = new Map();
    const originals = new Map();
    for (const { track } of drag.attached) {
        if (copies.has(track)) continue;
        const copy = new Track({ id: track.id });
        copy.applyState(track.captureState());
        copies.set(track, copy);
        originals.set(copy, track);
    }
    const collection = drag.kind === 'pad' ? 'pads' : 'vias';
    const preview = {
        tracks: app.pcbDocument.tracks.map(track => copies.get(track) || track),
        [collection]: app.pcbDocument[collection].map(item => item === drag.original ? copy : item),
        copies, originals,
    };
    drag.attached = drag.attached.map(item => ({
        ...item, originalTrack: item.track, track: copies.get(item.track),
    }));
    drag.preview = preview;
    drag.via = copy;
    drag.remove(drag.original);
    for (const track of copies.keys()) removeTrackElements(track);
}

function removeTerminalPreviewArtwork(drag) {
    drag.remove(drag.via);
    for (const copy of drag.preview.copies.values()) removeTrackElements(copy);
}

function restoreTerminalArtwork(app, drag, committed) {
    if (!drag.preview) return;
    removeTerminalPreviewArtwork(drag);
    if (!committed) {
        const collection = drag.kind === 'pad' ? 'pads' : 'vias';
        if (app.pcbDocument[collection].includes(drag.original)) {
            drag.render(drag.original, id => app.getLayerGroup(id));
        }
        for (const track of drag.preview.copies.keys()) {
            if (app.pcbDocument.tracks.includes(track)) {
                renderTrack(track, id => app.getLayerGroup(id), _opts(app, track));
            }
        }
        refreshTrackSelectionHalo(app);
        reconcileRatsnest(app, { skipFillRefresh: true });
    }
    if (!app._deferDragOverlays) {
        if (!committed) app.refreshClearanceHalos?.();
    } else {
        if (drag.kind === 'via') app._refreshViaClearance?.(drag.original);
        for (const track of drag.preview.copies.keys()) app._refreshTrackClearance?.(track);
    }
}

/** Update a dragged Via or standalone Pad and its layer-compatible Track nodes. */
export function updateViaDrag(app, worldPos) {
    const drag = app._viaDrag;
    if (!drag) return;
    const targetPos = {
        x: drag.startX + worldPos.x - drag.grabX,
        y: drag.startY + worldPos.y - drag.grabY,
    };
    // Skip the via's own attached nodes when snapping — they ride along with
    // the via, so letting the snap catch them (within the coarse track-node
    // tolerance) would override the finer grid snap and feel sticky.
    const excludeNode = (track, nodeId) =>
        drag.attached.some(a => a.track === track && a.nodeId === nodeId)
        || !track.incidentEdges(nodeId).some(edge => drag.layers.includes(track.getEdgeLayer(edge.edgeId)));
    const snap = resolveTrackSnap(app, targetPos, {
        excludeNode,
        excludePad: drag.kind === 'pad' ? drag.via : null,
        layer: drag.kind === 'pad' ? drag.via.layers : 'both',
    });
    if (drag.kind === 'pad' && snap.snapType !== 'pad' && snap.snapType !== 'track-node') {
        Object.assign(snap, app.viewport?.getSnappedPosition?.(targetPos) || targetPos);
    }
    let pos = { x: snap.x, y: snap.y };
    const attachedTracks = new Set(drag.attached.map(item => item.track));
    const trackTarget = app.viewport?.shiftHeld || snap.snapType === 'pad'
        ? null
        : snap.snapType === 'track-node'
            ? { track: snap.trackNode.track, nodeId: snap.trackNode.nodeId,
                px: snap.trackNode.x, py: snap.trackNode.y }
            : findSplittableTrackEdge(app, targetPos, 6, { excludeTracks: attachedTracks, layers: drag.layers });
    if (trackTarget) pos = { x: trackTarget.px, y: trackTarget.py };
    drag.snapTargetTrack = trackTarget
        ? { ...trackTarget, track: canonicalTrack(app, trackTarget.track) }
        : null;

    // Yellow target circle when locked onto a hard copper target.
    if (snap.snapType === 'pad' || snap.snapType === 'track-node' || trackTarget) {
        showTrackSnapMarker(app, pos);
    } else {
        clearTrackSnapMarker(app);
    }

    // Axis / collinear snap — match single-node drag so the via aligns onto
    // H/V/45° axes and straight runs (and lights the same glow). Skip when
    // the grid snap already locked a hard pad / track-node target. The via's
    // attached nodes all move with it, so they're excluded as neighbours.
    if (!app.viewport?.shiftHeld && snap.snapType !== 'pad' && snap.snapType !== 'track-node' && !trackTarget) {
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
        const rawPos = targetPos;
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

    app.viewport?.setCrosshair(pos);
    if (drag.via.x === pos.x && drag.via.y === pos.y) return;
    beginTerminalPreview(app, drag);
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
    for (const track of touched) track.invalidate();
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
        renderTrack(t, (id) => app.getLayerGroup(id), _opts(app, t));
        app._refreshTrackClearance?.(t);
    }
    drag.render(drag.via, (id) => app.getLayerGroup(id));
    if (drag.kind === 'via') app._refreshViaClearance?.(drag.via);
    renderTrackAxisGlowTop(app);
    refreshTrackSelectionHalo(app);
    reconcileRatsnest(app);
}

/**
 * Commit the in-progress terminal drag. Wraps the Pad/Via move plus every
 * attached track-node move as a single compound history entry.
 */
export function finishViaDrag(app) {
    const drag = app._viaDrag;
    if (!drag) return;
    app._viaDrag = null;
    app._deferDragOverlays = drag.previousDeferDragOverlays;
    app.viewport?.hideCrosshair();
    clearTrackAxisGlow(app);
    clearTrackSnapMarker(app);
    const moved = Math.abs(drag.via.x - drag.startX) > 1e-6
        || Math.abs(drag.via.y - drag.startY) > 1e-6;
    let committed = false;
    try {
        if (!moved) return;
        if (drag.snapTargetTrack) {
            const viaNet = drag.via.net || '';
            const trackNet = drag.snapTargetTrack.track.net || '';
            if (viaNet && trackNet && viaNet !== trackNet) {
                _showTrackViaNetConflict(app, trackNet, viaNet, drag.kind);
                return;
            }
        }
        const collection = drag.kind === 'pad' ? 'pads' : 'vias';
        if (!app.pcbDocument[collection].includes(drag.original)) {
            throw new Error(`Cannot move a missing ${drag.kind}.`);
        }
        for (const { originalTrack, nodeId } of drag.attached) {
            if (!app.pcbDocument.tracks.includes(originalTrack) || !originalTrack.nodes.has(nodeId)) {
                throw new Error('Cannot move a missing attached track node.');
            }
        }
        const toX = drag.via.x, toY = drag.via.y;
        const cmds = [drag.kind === 'pad'
            ? new MovePadCommand(app, drag.original, { x: drag.startX, y: drag.startY }, { x: toX, y: toY })
            : new MoveViaCommand(app, drag.original, drag.startX, drag.startY, toX, toY)];
        for (const a of drag.attached) {
            cmds.push(new MoveVertexCommand(app, a.originalTrack, a.nodeId, a.startX, a.startY, toX, toY));
        }
        if (drag.snapTargetTrack) {
            const { track, edgeId, nodeId } = drag.snapTargetTrack;
            if (!app.pcbDocument.tracks.includes(track)
                || (edgeId ? !track.edges.has(edgeId) : !track.nodes.has(nodeId))) {
                throw new Error('Cannot connect to a missing track target.');
            }
            if (edgeId) {
                const before = track.captureState();
                const copy = new Track({ id: track.id });
                copy.applyState(before);
                copy.splitEdge(edgeId, { x: toX, y: toY });
                cmds.push(new ModifyTrackGraphCommand(app, track, before, copy.captureState()));
            }
        }
        // Command refreshes must not see both preview and committed track artwork.
        removeTerminalPreviewArtwork(drag);
        app.history.execute(new CompoundCommand(cmds));
        committed = true;
    } finally {
        restoreTerminalArtwork(app, drag, committed);
    }
    reconcileRatsnest(app);
}

/** Abort the in-progress Pad/Via drag and restore the terminal and Track nodes. */
export function cancelViaDrag(app) {
    const drag = app._viaDrag;
    if (!drag) return;
    app._viaDrag = null;
    app._deferDragOverlays = drag.previousDeferDragOverlays;
    app.viewport?.hideCrosshair();
    clearTrackAxisGlow(app);
    clearTrackSnapMarker(app);
    restoreTerminalArtwork(app, drag, false);
}
