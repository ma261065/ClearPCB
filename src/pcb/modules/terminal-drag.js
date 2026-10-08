/**
 * Dragging a via or a standalone pad (a terminal). The track nodes attached to it move
 * with it; release commits the move and what it now connects to, and Escape restores it.
 * The drag is the _viaDrag interaction slot, which this module owns.
 */
import { beginDragSession, copperNets, refreshDragRatlines, releaseDragSession } from './drag-session.js';
import { renderTrack, removeTrackElements, removeViaElements } from './track-render.js';
import { renderVia } from './track-render.js';
import { resolveTrackSnap, showTrackSnapMarker, clearTrackSnapMarker, COLLINEAR_SNAP_SCREEN_PX } from './track-snap.js';
import { reconcileRatsnest } from './ratsnest.js';
import { renderTrackAxisGlow, renderTrackAxisGlowTop, clearTrackAxisGlow } from './track-draw.js';
import { snapNodeToAxis, snapNodeToCollinear } from '../../shapes/path-snap.js';
import { refreshTrackSelectionHalo } from './copper-halos.js';
import { MoveVertexCommand, MoveViaCommand, CompoundCommand, ModifyTrackGraphCommand, canonicalTrack } from './track-commands.js';
import { Via, viaHitTest } from '../../shapes/via.js';
import { Track } from '../../shapes/track.js';
import { Pad } from '../../shapes/pad.js';
import { padLayers } from '../../shapes/pad-geometry.js';
import { renderPad, removePadElements } from './pad.js';
import { MovePadCommand } from './pad-commands.js';
import { getPropertyEditor } from './property-editors.js';
import { areDragOverlaysDeferred } from './refresh-state.js';
import { refreshTrackClearance, refreshViaClearance } from './clearance-overlay.js';
import { getPcbInteraction, setPcbInteraction } from './pcb-interactions.js';
import { finishVertexDrag, getVertexDrag, incidentSegments, snapNodeAcrossNeighbour, trackEditRenderOptions } from './track-drag.js';
import { findSplittableTrackEdge, showTrackViaNetConflict } from './track-edits.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {{x: number, y: number}} Point */
/**
 * @typedef {import('./drag-session.js').DragSession} DragSession
 * @typedef {{track: Track, nodeId: string, startX: number, startY: number, originalTrack?: Track}} TerminalAttachedNode
 * @typedef {{tracks: Track[], copies: Map<Track, Track>, originals: Map<Track, Track>, pads?: Pad[], vias?: Via[]}} TerminalDragPreview
 * @typedef {{track: Track, nodeId?: string, edgeId?: string, px: number, py: number}} TerminalTrackTarget
 * @typedef {{layers: string[], startX: number, startY: number, grabX: number, grabY: number, attached: TerminalAttachedNode[], session: DragSession, preview?: TerminalDragPreview, snapTargetTrack?: TerminalTrackTarget|null}} TerminalDragCommon
 * @typedef {TerminalDragCommon & {via: Via, original: Via, kind: 'via', render: (item: Via, layerGroup: (id: string) => any) => void, remove: (item: Via) => void}} ViaDrag
 * @typedef {TerminalDragCommon & {via: Pad, original: Pad, kind: 'pad', render: (item: Pad, layerGroup: (id: string) => any) => void, remove: (item: Pad) => void}} PadDrag
 * @typedef {ViaDrag|PadDrag} TerminalDrag
 */

/** @param {PcbEditor} app */
export function getViaDrag(app) {
    return /** @type {TerminalDrag|null} */ (getPcbInteraction(app, '_viaDrag'));
}

/**
 * The via or pad a terminal drag is moving (authored `original`, displayed `preview`),
 * plus the attached tracks it carries (`tracks.originals` / `tracks.copies`), or null.
 * @param {PcbEditor} app
 * @returns {{kind: 'via', original: Via, preview: Via, tracks: TerminalDragPreview|null}|{kind: 'pad', original: Pad, preview: Pad, tracks: TerminalDragPreview|null}|null}
 */
export function draggedVia(app) {
    const drag = getViaDrag(app);
    if (!drag) return null;
    return drag.kind === 'via'
        ? { kind: 'via', original: drag.original, preview: drag.via, tracks: drag.preview || null }
        : { kind: 'pad', original: drag.original, preview: drag.via, tracks: drag.preview || null };
}

/* ──────────────────────────── via drag ──────────────────────────── */

/** Screen-px hit tolerance for picking up a Via to drag. */
const VIA_HIT_PX = 6;

/**
 * Hit-test a Via against the world position. Returns true if the
 * cursor is within the via's annular-ring radius (plus pixel tolerance).
 * @param {PcbEditor} app
 * @param {Via} via
 * @param {Point} worldPos
 * @param {number} [pxTol]
 */
function _hitVia(app, via, worldPos, pxTol = VIA_HIT_PX) {
    const scale = app.viewport?.scale || 1;
    return viaHitTest(via, worldPos, pxTol / scale);
}

/**
 * Begin a drag on the given (already-selected) Via if the click landed
 * on it. Captures any Track nodes colocated with the via so they drag
 * along — the via acts as a hinge that connected wires follow.
 * @param {PcbEditor} app
 * @param {Via} via
 * @param {Point} worldPos
 */
export function startViaDrag(app, via, worldPos) {
    if (!via || !_hitVia(app, via, worldPos)) return false;
    return startTerminalDrag(app, via, worldPos, 'via');
}

/**
 * Pads and vias share attached-node movement, snapping and atomic history.
 * @param {PcbEditor} app
 * @param {Pad} pad
 * @param {Point} worldPos
 */
export function startPadDrag(app, pad, worldPos) {
    return startTerminalDrag(app, pad, worldPos, 'pad');
}

/** @param {PcbEditor} app @param {Via|Pad} via @param {Point} worldPos @param {'via'|'pad'} kind */
function startTerminalDrag(app, via, worldPos, kind) {
    if (getVertexDrag(app)) finishVertexDrag(app);
    getPropertyEditor(app, 'track')?.commit();
    const layers = kind === 'pad' ? padLayers(/** @type {Pad} */ (via)) : ['top-copper', 'bottom-copper'];
    // Find every Track node at the via's current (x, y). Track endpoints
    // and layer-change nodes commonly sit exactly on a via.
    const EPS = 1e-4;
    const attached = []; // [{track, nodeId, startX, startY}]
    for (const t of app.tracks || []) {
        for (const [nid, n] of t.nodes) {
            if (Math.abs(n.x - via.x) < EPS && Math.abs(n.y - via.y) < EPS) {
                if (!/** @type {any[]} */ (t.incidentEdges(nid)).some((edge) => layers.includes(t.getEdgeLayer(edge.edgeId)))) continue;
                attached.push({ track: t, nodeId: nid, startX: n.x, startY: n.y });
            }
        }
    }
    setPcbInteraction(app, '_viaDrag', {
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
        session: beginDragSession(app, { nets: copperNets([via, ...attached.map((/** @param {any} item */ item) => item.track)]) }),
    });
    app.viewport?.setCrosshair({ x: via.x, y: via.y });
    return true;
}

/** @param {PcbEditor} app @param {TerminalDrag} drag */
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
        tracks: app.pcbDocument.tracks.map((/** @param {Track} track */ track) => copies.get(track) || track),
        [collection]: app.pcbDocument[collection].map((/** @param {any} item */ item) => item === drag.original ? copy : item),
        copies, originals,
    };
    drag.attached = /** @type {any[]} */ (drag.attached).map((item) => ({
        ...item, originalTrack: item.track, track: copies.get(item.track),
    }));
    drag.preview = preview;
    drag.via = copy;
    if (drag.kind === 'pad') drag.remove(drag.original);
    else drag.remove(drag.original);
    for (const track of copies.keys()) removeTrackElements(track);
}

/** @param {TerminalDrag} drag */
function removeTerminalPreviewArtwork(drag) {
    if (drag.kind === 'pad') drag.remove(drag.via);
    else drag.remove(drag.via);
    for (const copy of /** @type {TerminalDragPreview} */ (drag.preview).copies.values()) removeTrackElements(copy);
}

/** @param {PcbEditor} app @param {TerminalDrag} drag @param {boolean} committed */
function restoreTerminalArtwork(app, drag, committed) {
    if (!drag.preview) return;
    removeTerminalPreviewArtwork(drag);
    if (!committed) {
        /** @param {string} id */
        const layerGroup = (id) => app.getLayerGroup(id);
        if (drag.kind === 'pad') {
            if (app.pcbDocument.pads.includes(drag.original)) drag.render(drag.original, layerGroup);
        } else if (app.pcbDocument.vias.includes(drag.original)) {
            drag.render(drag.original, layerGroup);
        }
        for (const track of drag.preview.copies.keys()) {
            if (app.pcbDocument.tracks.includes(track)) {
                renderTrack(track, layerGroup, trackEditRenderOptions(app, track));
            }
        }
        refreshTrackSelectionHalo(app);
        reconcileRatsnest(app, { skipFillRefresh: true });
    }
    if (!areDragOverlaysDeferred(app)) {
        if (!committed) app.refreshClearanceHalos();
    } else {
        if (drag.kind === 'via') refreshViaClearance(app, drag.original);
        for (const track of drag.preview.copies.keys()) refreshTrackClearance(app, track);
    }
}

/**
 * Update a dragged Via or standalone Pad and its layer-compatible Track nodes.
 * @param {PcbEditor} app
 * @param {Point} worldPos
 */
export function updateViaDrag(app, worldPos) {
    const drag = getViaDrag(app);
    if (!drag) return;
    const targetPos = {
        x: drag.startX + worldPos.x - drag.grabX,
        y: drag.startY + worldPos.y - drag.grabY,
    };
    // Skip the via's own attached nodes when snapping — they ride along with
    // the via, so letting the snap catch them (within the coarse track-node
    // tolerance) would override the finer grid snap and feel sticky.
    /** @param {Track} track @param {string} nodeId */
    const excludeNode = (track, nodeId) =>
        /** @type {any[]} */ (drag.attached).some((a) => a.track === track && a.nodeId === nodeId)
        || !track.incidentEdges(nodeId).some((/** @param {any} edge */ edge) => drag.layers.includes(track.getEdgeLayer(edge.edgeId)));
    const snap = resolveTrackSnap(app, targetPos, {
        excludeNode,
        excludePad: drag.kind === 'pad' ? drag.via : null,
        layer: drag.kind === 'pad' ? drag.via.layers : 'both',
    });
    if (drag.kind === 'pad' && snap.snapType !== 'pad' && snap.snapType !== 'track-node') {
        Object.assign(snap, app.viewport?.getSnappedPosition?.(targetPos) || targetPos);
    }
    let pos = { x: snap.x, y: snap.y };
    const attachedTracks = new Set(/** @type {any[]} */ (drag.attached).map(item => item.track));
    const trackTarget = app.viewport?.shiftHeld || snap.snapType === 'pad'
        ? null
        : snap.snapType === 'track-node'
            ? { track: snap.trackNode.track, nodeId: snap.trackNode.nodeId, edgeId: undefined,
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
        /** @param {Track} track @param {string} nid */
        const isAttached = (track, nid) =>
            /** @type {any[]} */ (drag.attached).some(a => a.track === track && a.nodeId === nid);
        /** @param {any} a */
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
            snapped = snapNodeAcrossNeighbour(a.track, a.nodeId, rawPos, threshold);
            if (snapped) break;
        }
        // 2. Fall back to H/V/45° against any attached node's neighbour.
        if (!snapped) {
            const allNeighbours = [];
            for (const a of /** @type {any[]} */ (drag.attached)) allNeighbours.push(...neighboursOf(a));
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
    for (const a of /** @type {any[]} */ (drag.attached)) {
        const n = a.track.nodes.get(a.nodeId);
        if (!n) continue;
        n.x = pos.x;
        n.y = pos.y;
        touched.add(a.track);
    }
    for (const track of /** @type {Set<Track>} */ (touched)) track.invalidate();
    // Build the axis glow from every attached track's incident segments, then
    // render: glow halos UNDER the copper, centerlines ON TOP (two-pass).
    const byTrack = new Map();
    for (const a of /** @type {any[]} */ (drag.attached)) {
        if (!byTrack.has(a.track)) byTrack.set(a.track, []);
        byTrack.get(a.track).push({ nodeId: a.nodeId });
    }
    const glowSegs = [];
    for (const [track, nodes] of /** @type {Map<Track, any[]>} */ (byTrack)) glowSegs.push(...incidentSegments(track, nodes));
    renderTrackAxisGlow(app, glowSegs);
    /** @param {string} id */
    const layerGroup = (id) => app.getLayerGroup(id);
    for (const t of /** @type {Set<Track>} */ (touched)) {
        renderTrack(t, layerGroup, trackEditRenderOptions(app, t));
        refreshTrackClearance(app, t);
    }
    if (drag.kind === 'pad') drag.render(drag.via, layerGroup);
    else drag.render(drag.via, layerGroup);
    if (drag.kind === 'via') refreshViaClearance(app, drag.via);
    renderTrackAxisGlowTop(app);
    refreshTrackSelectionHalo(app);
    refreshDragRatlines(app, drag.session);
}

/**
 * Commit the in-progress terminal drag. Wraps the Pad/Via move plus every
 * attached track-node move as a single compound history entry.
 * @param {PcbEditor} app
 */
export function finishViaDrag(app) {
    const drag = getViaDrag(app);
    if (!drag) return;
    setPcbInteraction(app, '_viaDrag', null);
    releaseDragSession(app, drag.session);
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
                showTrackViaNetConflict(app, trackNet, viaNet, drag.kind);
                return;
            }
        }
        const terminalExists = drag.kind === 'pad'
            ? app.pcbDocument.pads.includes(drag.original)
            : app.pcbDocument.vias.includes(drag.original);
        if (!terminalExists) {
            throw new Error(`Cannot move a missing ${drag.kind}.`);
        }
        for (const { originalTrack, nodeId } of /** @type {any[]} */ (drag.attached)) {
            if (!app.pcbDocument.tracks.includes(originalTrack) || !originalTrack.nodes.has(nodeId)) {
                throw new Error('Cannot move a missing attached track node.');
            }
        }
        const toX = drag.via.x, toY = drag.via.y;
        /** @type {any[]} */
        const cmds = [];
        if (drag.kind === 'pad') cmds.push(new MovePadCommand(app, drag.original, { x: drag.startX, y: drag.startY }, { x: toX, y: toY }));
        else cmds.push(new MoveViaCommand(app, drag.original, drag.startX, drag.startY, toX, toY));
        for (const a of /** @type {any[]} */ (drag.attached)) {
            cmds.push(new MoveVertexCommand(app, a.originalTrack, a.nodeId, a.startX, a.startY, toX, toY));
        }
        if (drag.snapTargetTrack) {
            const { track, edgeId, nodeId } = drag.snapTargetTrack;
            if (!app.pcbDocument.tracks.includes(track)
                || (edgeId ? !track.edges.has(edgeId) : nodeId == null || !track.nodes.has(nodeId))) {
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

/**
 * Abort the in-progress Pad/Via drag and restore the terminal and Track nodes.
 * @param {PcbEditor} app
 */
export function cancelViaDrag(app) {
    const drag = getViaDrag(app);
    if (!drag) return;
    setPcbInteraction(app, '_viaDrag', null);
    releaseDragSession(app, drag.session);
    app.viewport?.hideCrosshair();
    clearTrackAxisGlow(app);
    clearTrackSnapMarker(app);
    restoreTerminalArtwork(app, drag, false);
}
