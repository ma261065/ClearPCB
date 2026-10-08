/**
 * Dragging a track's nodes and segments.
 *
 * A press on a node moves that node; a press on a segment drags the whole segment (both
 * ends move by the same delta, KiCad-style) while the neighbouring segments stretch; a
 * press on a segment's midpoint handle inserts a node there and drags it. A moved node
 * snaps to pads, track nodes and the grid (track-snap.js); a dragged segment keeps its
 * shape. A via under a dragged node stays behind; a via at the end of a dragged segment
 * stays put and a bridge segment grows from it. Release commits one undoable command
 * (track-drop.js decides what the dropped copper joins); Escape restores the track.
 *
 * Hit tests and structural edits (split, delete, collapse) are track-edits.js; dragging
 * vias and pads is terminal-drag.js.
 */
import { beginDragSession, copperNets, refreshDragRatlines, releaseDragSession } from './drag-session.js';
import { renderTrack, removeTrackElements } from './track-render.js';
import { resolveTrackSnap, showTrackSnapMarker, clearTrackSnapMarker, applyAxisConstraint, COLLINEAR_SNAP_SCREEN_PX, COLLINEAR_GLOW_ANGLE_TOL } from './track-snap.js';
import { reconcileRatsnest, updateNetGuideLine, clearNetGuideLine } from './ratsnest.js';
import { renderTrackAxisGlow, renderTrackAxisGlowTop, clearTrackAxisGlow, _axisAlignment } from './track-draw.js';
import { snapNodeToAxis, snapNodeToCollinear } from '../../shapes/path-snap.js';
import { bondedExclusion } from './track-connections.js';
import { clearTrackEdit, createTrackSelectionAdapter, getTrackEdit } from './track-select.js';
import { refreshTrackSelectionHalo } from './copper-halos.js';
import { CompoundCommand, canonicalTrack, getPlacementPreviewTracks } from './track-commands.js';
import { pointsCollinear, collinearSnap } from '../../core/geometry.js';
import { Track } from '../../shapes/track.js';
import { isLayerLocked, isLayerVisible } from './layers.js';
import { bulgeRatio } from '../../core/geometry.js';
import { formatNumberInputValue } from '../../core/number-inputs.js';
import { arcFromBulge } from '../../shapes/arc-edge.js';
import { trackRectangleOrder } from '../../shapes/track-geometry.js';
import { resizeRectanglePoints } from '../../shapes/path-operations.js';
import { getPcbSelection, syncPcbSelection } from './selection-registry.js';
import { snapPathTranslation, snapPathPoint, beginPathSplit } from './path-edit.js';
import { commitPropertyEditors } from './property-editors.js';
import { areDragOverlaysDeferred, isBoardViewRefreshSuspended, refreshBoardView } from './refresh-state.js';
import { isEditorActive } from './pcb-editor-api.js';
import { refreshTrackClearance } from './clearance-overlay.js';
import { getPcbInteraction, setPcbInteraction } from './pcb-interactions.js';
import { getSelectionInteraction, setSelectionInteraction } from './selection-interaction.js';
import { refreshSelectedDrcMarker } from './drc-state.js';
import { finishViaDrag, getViaDrag } from './terminal-drag.js';
import { findNearbyVia, hitTestTrackEdge, hitTestTrackMidpoint, hitTestTrackNode, viaAtPoint } from './track-edits.js';
import { lockedJoinTarget, trackPointerCommands } from './track-drop.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {{x: number, y: number}} Point */
/** The node, segment, move or bulge drag in progress (see beginTrackPointer). @typedef {any} VertexDrag */

/** @type {WeakMap<PcbEditor, {downScreen: Point|null, segmentEdgeId: string|null}>} */
const vertexClickState = new WeakMap();

/** @param {PcbEditor} app */
function clickState(app) {
    let state = vertexClickState.get(app);
    if (!state) vertexClickState.set(app, state = { downScreen: null, segmentEdgeId: null });
    return state;
}

/** @param {PcbEditor} app @param {Point|null|undefined} point */
export function setVertexDragDownScreen(app, point) {
    clickState(app).downScreen = point ? { x: point.x, y: point.y } : null;
}

/** @param {PcbEditor} app */
export function getVertexDragDownScreen(app) {
    return clickState(app).downScreen;
}

/** @param {PcbEditor} app @param {string|null|undefined} edgeId */
export function setSegmentClickEdgeId(app, edgeId) {
    clickState(app).segmentEdgeId = edgeId || null;
}

/** @param {PcbEditor} app */
export function getSegmentClickEdgeId(app) {
    return clickState(app).segmentEdgeId;
}

/** @param {PcbEditor} app @param {VertexDrag} drag */
function _endVertexDragOverlayDeferral(app, drag) {
    releaseDragSession(app, drag.session);
    if (!areDragOverlaysDeferred(app)) app.refreshClearanceHalos?.();
    else if (drag.preview) refreshTrackClearance(app, drag.original);
}

/** @param {PcbEditor} app @param {Track|null} track */
function prepareTrackPointer(app, track) {
    track = track ? canonicalTrack(app, track) : null;
    if (!track) return null;
    commitPropertyEditors(app, ['track', 'via', 'pad', 'fill']);
    if (getViaDrag(app)) finishViaDrag(app);
    if (getVertexDrag(app) || getPlacementPreviewTracks(app)) return null;
    return track;
}

/** @param {PcbEditor} app @param {Track} track @param {any} details */
function beginTrackPointer(app, track, details) {
    const nodes = new Set(/** @type {any[]} */ (details.nodes).map(node => node.nodeId));
    const layers = new Set([...track.edges].filter(([id, edge]) => details.mode === 'move'
        || (details.mode === 'bulge' ? id === details.edgeId : nodes.has(edge.from) || nodes.has(edge.to)))
        .map(([id]) => track.getEdgeLayer(id)));
    if (!isEditorActive(app) || [...layers].some(layer => isLayerLocked(layer) || !isLayerVisible(layer))) return null;
    const drag = { ...details, original: track, track, layers, lastDx: 0, lastDy: 0,
        // The 2D/3D board view rebuilds once on the drop, not from in-flight node positions.
        session: beginDragSession(app, { nets: copperNets([track]), suspendBoardView: true }) };
    setPcbInteraction(app, '_vertexDrag', drag);
    return drag;
}

/** @param {PcbEditor} app @param {VertexDrag} drag */
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

/**
 * The active track vertex/segment drag, or null.
 * @param {PcbEditor} app
 */
export function getVertexDrag(app) {
    return getPcbInteraction(app, '_vertexDrag');
}

/**
 * The track a node/bulge drag is moving: `original` is the authored track and `preview`
 * the copy shown while dragging. Null when no track drag is active.
 * @param {PcbEditor} app
 * @returns {{original: any, preview: any}|null}
 */
export function draggedTrack(app) {
    const drag = getVertexDrag(app);
    return drag ? { original: drag.original, preview: drag.track } : null;
}

/**
 * Whether a node/bulge drag is moving this authored track.
 * @param {PcbEditor} app
 * @param {Track|null|undefined} track
 */
export function isDraggingTrack(app, track) {
    return !!track && getVertexDrag(app)?.original === track;
}

/**
 * Cancel a node/bulge drag of this track, e.g. before a command replaces the track.
 * @param {PcbEditor} app
 * @param {Track|null|undefined} track
 */
export function cancelTrackDragOf(app, track) {
    if (isDraggingTrack(app, track)) cancelVertexDrag(app);
}

/** @param {PcbEditor} app @param {string} layerId */
export function trackPointerTouchesLayer(app, layerId) {
    return getVertexDrag(app)?.layers?.has(layerId) || false;
}

/** @param {PcbEditor} app @param {Track|null} track @param {string} edgeId */
export function startTrackBulgeDrag(app, track, edgeId) {
    track = /** @type {Track} */ (prepareTrackPointer(app, track));
    if (!track?.edges.has(edgeId)) return false;
    const edge = track.edges.get(edgeId), a = track.nodes.get(edge.from), b = track.nodes.get(edge.to);
    return !!beginTrackPointer(app, /** @type {Track} */ (track), { mode: 'bulge', edgeId, nodes: [], initialBulge: edge.bulge || 0,
        bulgeOrigin: arcFromBulge(a, b, edge.bulge)?.bulgePoint || { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } });
}

/** @param {PcbEditor} app @param {Track} [track] */
export function trackEditRenderOptions(app, track = getVertexDrag(app)?.track) {
    return {
        viaDiameter: app.getRoutingParams?.()?.viaDiameter,
        viaDrill: app.getRoutingParams?.()?.viaDrill,
        hideNetLabel: !!track && (track === getPcbSelection(app, 'track')[0] || track === getVertexDrag(app)?.track),
    };
}

/**
 * Split a degree-2 Track node into two coincident nodes (detaching one
 * incident edge to the new node) and immediately float the new node
 * under the cursor, mirroring the schematic "Split" action. The floating
 * node drops on the next left-click through the selection controller.
 * Returns true if the split started.
 *
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {string} nodeId
 * @returns {boolean}
 */
export function splitTrackNodeAndDrag(app, track, nodeId) {
    track = /** @type {Track} */ (prepareTrackPointer(app, track));
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
    renderTrack(copy, id => app.getLayerGroup(id), trackEditRenderOptions(app));

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
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {string} edgeId
 * @returns {boolean} true if an insertion drag was started.
 */
export function startMidpointInsertDrag(app, track, edgeId) {
    track = /** @type {Track} */ (prepareTrackPointer(app, track));
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
    renderTrack(copy, (id) => app.getLayerGroup(id), trackEditRenderOptions(app));
    refreshTrackSelectionHalo(app);
    reconcileRatsnest(app);
    return true;
}

/**
 * Begin a drag on the selected track. Returns true if a drag was
 * started, false if the click missed.
 *
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {Point} worldPos
 * @param {{allowMidpointInsert?:boolean, nodeId?:string, edgeId?:string, whole?:boolean}} [opts] - When `allowMidpointInsert`
 *   is false, a click on a midpoint "+" handle is ignored (it won't start a
 *   split). Used on the click that first selects a track so the plus requires
 *   a separate, deliberate second click. `nodeId` / `edgeId` name an already
 *   hit node or edge (skipping the hit test); `whole` drags the entire track.
 */
export function startVertexDrag(app, track, worldPos, opts = {}) {
    const activeDrag = getVertexDrag(app);
    if (activeDrag?.preparingSplit
        && canonicalTrack(app, track) === activeDrag.original
        && opts.nodeId === activeDrag.splitNodeId) return true;
    track = /** @type {Track} */ (prepareTrackPointer(app, track));
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
        // A rectangular loop resizes like a board rectangle: the opposite corner
        // stays put and the sides stay axis-aligned. Loops tied to pads keep
        // free node dragging so their connections are not dragged along.
        const rectangle = track.padConnections.size ? null : trackRectangleOrder(track);
        if (rectangle) {
            const drag = beginTrackPointer(app, track, {
                mode: 'rectangle', handle: rectangle.indexOf(nodeId), grabX: worldPos.x, grabY: worldPos.y,
                nodes: rectangle.map(id => ({ nodeId: id, startX: track.nodes.get(id).x,
                    startY: track.nodes.get(id).y, padLink: null })),
            });
            if (!drag) return false;
            app.viewport?.setCrosshair({ x: n.x, y: n.y });
            return true;
        }
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
        if (!viaAtPoint(app, n.x, n.y)) continue;
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
    app.viewport?.setCrosshair({ x: a.x, y: a.y });
    return true;
}

/**
 * Update the dragged node(s) from the current mouse world pos.
 * @param {PcbEditor} app
 * @param {Point} worldPos
 */
export function updateVertexDrag(app, worldPos) {
    const drag = getVertexDrag(app);
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
        renderTrack(copy, layer => app.getLayerGroup(layer), trackEditRenderOptions(app));
        refreshTrackClearance(app, copy);
        refreshSelectedDrcMarker(app);
        refreshTrackSelectionHalo(app);
        const input = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropTrackBulge'));
        if (input) input.value = formatNumberInputValue(bulge);
        return;
    }

    if (drag.mode === 'rectangle') {
        const snap = snapPathPoint(app, worldPos, [], true);
        const nodes = /** @type {any[]} */ (drag.nodes);
        const corners = nodes.map(node => ({ x: node.startX, y: node.startY }));
        const opposite = corners[(drag.handle + 2) % 4];
        // A zero-width rectangle has no side axis left to resize along.
        if (Math.abs(snap.x - opposite.x) < 1e-6 || Math.abs(snap.y - opposite.y) < 1e-6) return;
        const points = resizeRectanglePoints(corners, drag.handle, snap);
        if (nodes.every((node, index) => {
            const current = drag.track.nodes.get(node.nodeId);
            return current.x === points[index].x && current.y === points[index].y;
        })) return;
        beginTrackPointerPreview(app, drag);
        nodes.forEach((node, index) => Object.assign(drag.track.nodes.get(node.nodeId), points[index]));
        drag.track.invalidate();
        app.viewport?.setCrosshair(points[drag.handle]);
        renderTrack(drag.track, (id) => app.getLayerGroup(id), trackEditRenderOptions(app));
        refreshTrackClearance(app, drag.track);
        refreshTrackSelectionHalo(app);
        refreshDragRatlines(app, drag.session);
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
            const nodes = /** @type {any[]} */ (drag.nodes);
            drag.translationPoints = nodes.map(node => ({ x: node.startX, y: node.startY }));
            const movedIds = new Set(nodes.map(node => node.nodeId));
            drag.constraints = drag.mode === 'segment' ? nodes.map((node, index) => ({
                index,
                neighbours: [
                    .../** @type {any[]} */ (drag.track.incidentEdges(node.nodeId)).filter(edge => !movedIds.has(edge.otherNode))
                        .map(edge => drag.track.nodes.get(edge.otherNode)),
                    ...(/** @type {any[]} */ (drag.bridges).some(bridge => bridge.nodeId === node.nodeId)
                        ? [{ x: node.startX, y: node.startY }] : []),
                ],
            })) : [];
        }
        const delta = snapPathTranslation(app, drag.translationPoints,
            { x: rawDx, y: rawDy }, drag.mode === 'move' ? [drag.translationPoints[0]] : [], drag.constraints, true);
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
        renderTrackAxisGlow(app, incidentSegments(drag.track, drag.nodes));
        renderTrack(drag.track, (id) => app.getLayerGroup(id), trackEditRenderOptions(app));
        refreshTrackClearance(app, drag.track);
        renderTrackAxisGlowTop(app);
        refreshTrackSelectionHalo(app);
        refreshDragRatlines(app, drag.session);
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
    const neighborIds = drag.neighborIds ||= new Set(/** @type {any[]} */ (drag.track.incidentEdges(draggedId)).map(edge => edge.otherNode));
    const snap = resolveTrackSnap(app, worldPos, {
        layer: drag.track.getEdgeLayer(drag.track.incidentEdges(draggedId)[0]?.edgeId) || drag.track.layer,
        excludeNode: (track, nid) =>
            canonicalTrack(app, track) === drag.original && (nid === draggedId || neighborIds.has(nid)),
    });
    const current = drag.track.nodes.get(nd.nodeId);
    if (!current) return;
    const snapVia = app.viewport?.shiftHeld
        || snap.snapType === 'pad' || snap.snapType === 'track-node'
        ? null : findNearbyVia(app, worldPos);
    const n = { x: snapVia ? snapVia.x : snap.x, y: snapVia ? snapVia.y : snap.y };
    const previousTarget = drag.snapTargetNode, previousVia = drag.snapTargetVia;
    drag.snapTargetVia = snapVia || snap.pad?.standalonePad || null;
    drag.snapTargetKind = snap.pad?.standalonePad ? 'pad' : 'via';

    // Remember the exact node the cursor snapped onto, so the drop merges
    // into THAT node even though the smaller node-snap band means the
    // released position may not re-detect by coincidence alone.
    drag.snapTargetNode = snap.snapType === 'track-node' && snap.trackNode
        && !lockedJoinTarget(app, snap.trackNode.track)
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
        if (!snapped) snapped = snapNodeAcrossNeighbour(drag.track, nd.nodeId, rawPos, threshold);
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
    renderTrackAxisGlow(app, incidentSegments(drag.track, drag.nodes));
    renderTrack(drag.track, (id) => app.getLayerGroup(id), trackEditRenderOptions(app));
    refreshTrackClearance(app, drag.track);
    renderTrackAxisGlowTop(app);
    // Keep the selection halo glued to the new geometry.
    refreshTrackSelectionHalo(app);
    refreshDragRatlines(app, drag.session);

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
    /** @param {number} dx @param {number} dy */
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
export function incidentSegments(track, nodes) {
    const draggedSet = new Set(nodes.map((n) => n.nodeId));
    const segMap = new Map(); // edgeId → segment record (deduped)
    /** @param {string} edgeId */
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
export function snapNodeAcrossNeighbour(track, nodeId, pos, threshold) {
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
 * @param {PcbEditor} app
 */
export function finishVertexDrag(app) {
    const drag = getVertexDrag(app);
    if (!drag) return;
    let committed = false;
    try {
        clearTrackPointerGuides(app, drag);
        if (!isEditorActive(app) || drag.original.locked
            || [...drag.layers].some(layer => isLayerLocked(layer) || !isLayerVisible(layer))) return;
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
        const commands = trackPointerCommands(app, /** @type {PcbEditor} */ (/** @type {unknown} */ (view)), drag);
        setPcbInteraction(app, '_vertexDrag', null);
        removeTrackElements(drag.track);
        if (commands.length) {
            app.history.execute(commands.length === 1 ? commands[0] : new CompoundCommand(commands));
            committed = true;
        }
    } finally {
        endTrackPointer(app, drag, committed);
    }
}

/**
 * Discard the in-progress drag and restore canonical artwork.
 * @param {PcbEditor} app
 */
export function cancelVertexDrag(app) {
    const drag = getVertexDrag(app);
    if (!drag) return;
    endTrackPointer(app, drag, false);
}

/** @param {PcbEditor} app @param {VertexDrag} drag */
function clearTrackPointerGuides(app, drag) {
    if (drag.mode !== 'bulge') app.viewport?.hideCrosshair();
    clearTrackAxisGlow(app);
    clearTrackSnapMarker(app);
    clearNetGuideLine(app);
}

/** @param {PcbEditor} app @param {VertexDrag} drag @param {boolean} committed */
function endTrackPointer(app, drag, committed) {
    const interaction = getSelectionInteraction(app);
    if (interaction?.adapter?.kind === 'track'
        || (interaction?.mode === 'move-adapter' && interaction.entry.kind === 'track')) {
        setSelectionInteraction(app, null);
    }
    setPcbInteraction(app, '_vertexDrag', null);
    try {
        clearTrackPointerGuides(app, drag);
        const present = (app.pcbDocument?.tracks || app.tracks).includes(drag.original);
        if (!present) {
            removeTrackElements(drag.original);
            if (getTrackEdit(app)?.track === drag.original) clearTrackEdit(app);
            syncPcbSelection(app);
            app.clearProperties?.();
        }
        if (drag.preview) {
            removeTrackElements(drag.track);
            if (!committed && present) {
                renderTrack(drag.original, id => app.getLayerGroup(id), trackEditRenderOptions(app, drag.original));
            }
            refreshTrackSelectionHalo(app);
        }
    } finally {
        _endVertexDragOverlayDeferral(app, drag);
        if (drag.preview) reconcileRatsnest(app, { skipFillRefresh: !committed });
        if (!isBoardViewRefreshSuspended(app) && drag.preview) refreshBoardView(app);
    }
}
