/**
 * Editor adapters for PCB model commands.
 *
 * Render/SVG updates and derived refreshes stay here; separated authored
 * changes and undo snapshots belong to the neutral core commands.
 */

import {
    renderTrack,
    renderVia,
    removeTrackElements,
    hasTrackElements,
    removeViaElements,
} from './track-render.js';
import { reconcileRatsnest } from './ratsnest.js';
import { clearTrackSelection } from './track-select.js';
import { refreshTrackSelectionHalo } from './copper-halos.js';
import { getPcbSelection, syncPcbSelection, togglePcbSelection } from './selection-registry.js';
import { showPcbSelectionProperties } from './selection-interaction.js';
import { batchDerivedUpdates, deferDerivedUpdate } from '../../core/DerivedUpdates.js';
import { isPlacementMirrored } from '../../shared/pcb/board-geometry.js';
import { scheduleDrc, setDrcRatlines, storedDrcRatlines } from './drc-state.js';
import { drawBoardOutline, syncBoardOutlineInputs } from './board-outline-resize.js';
export { isPlacementMirrored } from '../../shared/pcb/board-geometry.js';
import {
    updatePlacementPadPositions,
    repositionPadConnectedNodes as repositionPadConnectedNodesData,
    applyPlacementSide as applyPlacementSideData,
    disconnectIncompatiblePadNodes as disconnectIncompatiblePadNodesData,
} from '../../core/pcb-placement-geometry.js';
import { SetBoardOutlineCommand as ModelSetBoardOutlineCommand } from '../../core/pcb-outline-commands.js';
import { Track } from '../../shapes/track.js';
import { Via } from '../../shapes/via.js';
import {
    MovePlacementCommand as ModelMovePlacementCommand,
    RotatePlacementCommand as ModelRotatePlacementCommand,
    FlipPlacementCommand as ModelFlipPlacementCommand,
    SetPlacementSideCommand as ModelSetPlacementSideCommand,
    SetPlacementLockedCommand as ModelSetPlacementLockedCommand,
    SetPlacementRefVisibleCommand as ModelSetPlacementRefVisibleCommand,
} from '../../core/pcb-placement-commands.js';
import {
    AddTrackCommand as ModelAddTrackCommand,
    RemoveTrackCommand as ModelRemoveTrackCommand,
    ModifyTrackCommand as ModelModifyTrackCommand,
    MoveVertexCommand as ModelMoveVertexCommand,
    ModifyTrackGraphCommand as ModelModifyTrackGraphCommand,
    ReplaceRoutesCommand as ModelReplaceRoutesCommand,
} from '../../core/pcb-track-commands.js';
import {
    AddViaCommand as ModelAddViaCommand,
    RemoveViaCommand as ModelRemoveViaCommand,
    ModifyViaCommand as ModelModifyViaCommand,
    ModifyViasCommand as ModelModifyViasCommand,
    MoveViaCommand as ModelMoveViaCommand,
} from '../../core/pcb-via-commands.js';
import { cancelTrackDragOf, draggedTrack } from './track-drag.js';
import { draggedVia } from './terminal-drag.js';
import { getPropertyEditor } from './property-editors.js';
import { areDragOverlaysDeferred, refreshBoardView } from './refresh-state.js';
import { getPadHaloGroup } from './clearance-overlay.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/**
 * @typedef {import('../../core/ProjectDocument.js').ProjectDocument} ProjectDocument
 * @typedef {import('../../core/pcb-placement-geometry.js').Placement} Placement
 * @typedef {import('../../core/pcb-track-commands.js').TrackState} TrackState
 * @typedef {Partial<TrackState> & Record<string, any>} TrackPatch
 * @typedef {import('../../core/pcb-via-commands.js').ViaState} ViaState
 * @typedef {{edgeId?: string|null, nodeId?: string|null}} TrackPropertyScope
 * @typedef {{original: Track, track: Track, before: TrackState, scope: TrackPropertyScope, tracks: Track[]}} TrackPropertyPreview
 * @typedef {import('../../core/pcb-via-commands.js').ViaChange} ViaChange
 * @typedef {{before: Map<Via, ViaState>, copies: Map<Via, Via>, originals: Map<Via, Via>, vias: Via[]}} ViaPropertyPreview
 * @typedef {{tracks: Track[], copies: Track[], originals: Map<Track, Track>, copiesByOriginal: Map<Track, Track>, rendered: Set<Track>, before: Map<string, {x: number, y: number, rotation: number}>, changed: Set<string>}} PlacementPreview
 * @typedef {Partial<import('../../core/PcbPlacementState.js').PlacementOverride> & Record<string, unknown>} PlacementPatch
 * @typedef {{pose: import('../../core/PcbPlacementState.js').PlacementOverride, pads: Map<string|number, import('../../core/pcb-placement-geometry.js').BoardPad>, tracks: Set<Track>}} PlacementPoseResult
 * @typedef {{net: string|number, from: {x: number, y: number}, to: {x: number, y: number}}} FailedConnection
 * @typedef {{failed?: boolean, net: string, x1: number, y1: number, x2: number, y2: number}} RoutedRatline
 * @typedef {import('../../core/pcb-track-commands.js').RouteState} RouteState
 * @typedef {import('../../core/pcb-outline-commands.js').BoardOutlineCommandState} BoardOutlineCommandState
 * @typedef {{execute: () => void, undo: () => void, app?: PcbEditor}} CommandLike
 */

/** @type {WeakMap<PcbEditor, PlacementPreview>} */
const placementPreviews = new WeakMap();
/** @type {WeakMap<PcbEditor, ViaPropertyPreview>} */
const viaPropertyPreviews = new WeakMap();
/** @type {WeakMap<PcbEditor, TrackPropertyPreview>} */
const trackPropertyPreviews = new WeakMap();

/** @param {PcbEditor} app */
export function getTrackPropertyPreview(app) {
    return trackPropertyPreviews.get(app);
}

/**
 * @param {PcbEditor} app
 * @param {Track} track
 */
export function canonicalTrack(app, track) {
    const trackDrag = draggedTrack(app);
    if (trackDrag && trackDrag.preview === track) return trackDrag.original || track;
    const preview = trackPropertyPreviews.get(app);
    if (preview?.track === track) return preview.original;
    return draggedVia(app)?.tracks?.originals.get(track)
        || placementPreviews.get(app)?.originals.get(track) || track;
}

/**
 * @param {PcbEditor} app
 * @param {Track} track
 */
export function displayedTrack(app, track) {
    track = canonicalTrack(app, track);
    const placement = placementPreviews.get(app)?.copiesByOriginal.get(track);
    if (placement) return placement;
    const trackDrag = draggedTrack(app);
    if (trackDrag && trackDrag.original === track) return trackDrag.preview;
    const terminal = draggedVia(app)?.tracks?.copies.get(track);
    if (terminal) return terminal;
    const preview = trackPropertyPreviews.get(app);
    return preview?.original === track ? preview.track : track;
}

/**
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {TrackPropertyScope} scope
 */
function assertTrackPropertyTarget(app, track, { edgeId, nodeId }) {
    if (!app.pcbDocument.tracks.includes(track)
        || (edgeId != null && !track.edges.has(edgeId))
        || (nodeId != null && !track.nodes.has(nodeId))) {
        throw new Error('Cannot edit a missing track, segment or node.');
    }
}

/**
 * Keep one exact graph copy for the active numeric track property field.
 * @param {PcbEditor} app
 * @param {Track} original
 * @param {TrackPropertyScope} scope
 */
export function beginTrackPropertyPreview(app, original, scope) {
    if (trackPropertyPreviews.has(app) || placementPreviews.has(app)
        || draggedVia(app) || draggedTrack(app)) {
        throw new Error('Finish the current track preview before editing track properties.');
    }
    assertTrackPropertyTarget(app, original, scope);
    const before = original.captureState();
    const track = new Track({ id: original.id });
    track.applyState(before);
    const preview = { original, track, before, scope,
        tracks: app.pcbDocument.tracks.map(item => item === original ? track : item) };
    trackPropertyPreviews.set(app, preview);
    removeTrackElements(original);
    return preview;
}

/**
 * Drop display ownership before the existing graph command applies authored state.
 * @param {PcbEditor} app
 * @param {(before: TrackState, after: TrackState) => void} [commit]
 */
export function finishTrackPropertyPreview(app, commit) {
    const preview = trackPropertyPreviews.get(app);
    if (!preview) return;
    trackPropertyPreviews.delete(app);
    removeTrackElements(preview.track);
    let committed = false;
    try {
        const after = preview.track.captureState();
        if (commit && JSON.stringify(after) !== JSON.stringify(preview.before)) {
            assertTrackPropertyTarget(app, preview.original, preview.scope);
            commit(preview.before, after);
            committed = true;
        }
    } finally {
        if (!committed && app.pcbDocument.tracks.includes(preview.original)) {
            renderTrack(preview.original, id => app.getLayerGroup(id), _opts(app, preview.original));
        }
    }
}

/** @param {PcbEditor} app */
export function getViaPropertyPreview(app) {
    return viaPropertyPreviews.get(app);
}

/**
 * @param {PcbEditor} app
 * @param {Via} via
 */
export function canonicalVia(app, via) {
    const viaDrag = draggedVia(app);
    if (viaDrag && viaDrag.preview === via) return viaDrag.original;
    return viaPropertyPreviews.get(app)?.originals.get(via) || via;
}

/**
 * @param {PcbEditor} app
 * @param {Via} via
 */
export function displayedVia(app, via) {
    via = canonicalVia(app, via);
    const viaDrag = draggedVia(app);
    if (viaDrag && viaDrag.original === via) return viaDrag.preview;
    return viaPropertyPreviews.get(app)?.copies.get(via) || via;
}

/**
 * Numeric via fields reuse one fixed-selection projection from first change.
 * @param {PcbEditor} app
 * @param {Via[]} vias
 */
export function beginViaPropertyPreview(app, vias) {
    if (viaPropertyPreviews.has(app) || draggedVia(app)) {
        throw new Error('Finish the current via preview before editing via properties.');
    }
    const available = new Set(app.pcbDocument.vias);
    if (vias.some(via => !available.has(via))) throw new Error('Cannot edit a missing via.');
    const before = new Map(vias.map(via => [via, via.captureState()]));
    const copies = new Map(vias.map(via => [via, Object.assign(new Via({ id: via.id }), before.get(via))]));
    const preview = {
        before, copies, originals: new Map([...copies].map(([via, copy]) => [copy, via])),
        vias: app.pcbDocument.vias.map(via => copies.get(via) || via),
    };
    viaPropertyPreviews.set(app, preview);
    for (const via of vias) removeViaElements(via);
    return preview;
}

/**
 * Model commands receive canonical targets only, after all preview SVG is removed.
 * @param {PcbEditor} app
 * @param {(changes: ViaChange[]) => void} [commit]
 */
export function finishViaPropertyPreview(app, commit) {
    const preview = viaPropertyPreviews.get(app);
    if (!preview) return;
    viaPropertyPreviews.delete(app);
    const changes = [];
    for (const [via, copy] of preview.copies) {
        removeViaElements(copy);
        /** @type {Partial<ViaState>} */
        const before = {};
        /** @type {Partial<ViaState>} */
        const after = {};
        const snapshot = preview.before.get(via);
        if (!snapshot) continue;
        for (const key of /** @type {const} */ (['diameter', 'drill'])) {
            if (snapshot[key] === copy[key]) continue;
            before[key] = snapshot[key];
            after[key] = copy[key];
        }
        if (Object.keys(after).length) changes.push({ via, before, after });
    }
    let committed = false;
    try {
        if (commit && changes.length) {
            const available = new Set(app.pcbDocument.vias);
            if ([...preview.copies.keys()].some(via => !available.has(via))) {
                throw new Error('Cannot edit a missing via.');
            }
            commit(changes);
            committed = true;
        }
    } finally {
        const changed = new Set(committed ? changes.map(change => change.via) : []);
        const available = new Set(app.pcbDocument.vias);
        for (const via of preview.copies.keys()) {
            if (available.has(via) && !changed.has(via)) renderVia(via, id => app.getLayerGroup(id));
        }
    }
}

/**
 * @param {PcbEditor} app
 * @returns {Track[]|undefined}
 */
export function getPlacementPreviewTracks(app) {
    return placementPreviews.get(app)?.tracks;
}

/**
 * Move connected copper in an editor-owned projection, never in the document.
 * @param {PcbEditor} app
 * @param {string} compId
 * @param {Partial<{x:number, y:number, rotation:number}>} pose
 */
export function previewPlacementPose(app, compId, pose) {
    previewPlacementPoses(app, new Map([[compId, pose]]));
}

/**
 * Preview a fixed set of component poses, sharing one copy of each bonded track.
 * @param {PcbEditor} app
 * @param {Map<string, Partial<{x:number, y:number, rotation:number}>>} poses
 * @param {Set<string>} [deferredTrackIds] Tracks rendered after a mixed-group translation.
 */
export function previewPlacementPoses(app, poses, deferredTrackIds) {
    const ids = [...poses.keys()].filter(id => app.placements?.has(id));
    if (!ids.length) return;
    let preview = placementPreviews.get(app);
    if (!preview) {
        const before = new Map(ids.map(id => {
            const pl = app.placements?.get(id);
            if (!pl) throw new Error(`PCB placement is no longer available: ${id}`);
            return [id, { x: pl.x, y: pl.y, rotation: pl.rotation || 0 }];
        }));
        const originals = new Map();
        const tracks = (app.pcbDocument?.tracks || app.tracks || []).map(track => {
            if (![...(track.padConnections?.values() || [])].some(connection => before.has(connection?.componentId))) return track;
            const copy = new Track({ id: track.id });
            copy.applyState(track.captureState());
            originals.set(copy, track);
            return copy;
        });
        preview = { tracks, copies: [...originals.keys()], originals,
            copiesByOriginal: new Map([...originals].map(([copy, original]) => [original, copy])), rendered: new Set(),
            before, changed: new Set() };
        placementPreviews.set(app, preview);
    }
    if (!preview) return;
    if (preview.before.size !== ids.length || ids.some(id => !preview.before.has(id))) {
        throw new Error('Finish the current placement preview before starting another.');
    }
    const touched = new Set();
    for (const id of ids) {
        const pl = app.placements?.get(id);
        const before = preview.before.get(id);
        const pose = poses.get(id);
        if (!pl || !before || !pose) throw new Error(`PCB placement is no longer available: ${id}`);
        Object.assign(pl, pose);
        if (pl.x !== before.x || pl.y !== before.y || pl.rotation !== before.rotation) preview.changed.add(id);
        else preview.changed.delete(id);
        updatePlacementPadPositions(pl);
        renderPlacementPose(app, id);
        for (const track of repositionPadConnectedNodesData(preview.copies, id, pl.pads)) touched.add(track);
    }
    for (const track of touched) {
        if (!preview.rendered.has(track)) removeTrackElements(/** @type {Track} */ (preview.originals.get(track)));
        if (!deferredTrackIds?.has(track.id)) renderTrack(track, id => app.getLayerGroup(id), _opts(app, track));
        preview.rendered.add(track);
    }
    refreshEditedTrackClearance(app);
}

/**
 * End the projection before a command runs; failures restore canonical track artwork.
 * @param {PcbEditor} app
 * @param {() => void} [commit]
 */
export function finishPlacementPreview(app, commit) {
    const preview = placementPreviews.get(app);
    placementPreviews.delete(app);
    let committed = false;
    try {
        if (commit) {
            commit();
            committed = true;
        }
    } finally {
        if (preview && !committed) {
            for (const [id, before] of preview.before) {
                const pl = app.placements?.get(id);
                if (!pl) continue;
                Object.assign(pl, before);
                updatePlacementPadPositions(pl);
                if (preview.changed.has(id)) renderPlacementPose(app, id);
            }
        }
        if (preview) {
            const currentTracks = new Set(app.pcbDocument?.tracks || app.tracks || []);
            for (const track of preview.rendered) {
                removeTrackElements(track);
                const original = preview.originals.get(track);
                if (original && currentTracks.has(original) && (!committed || !hasTrackElements(original))) {
                    renderTrack(original, id => app.getLayerGroup(id), _opts(app, original));
                }
            }
        }
        if (preview && commit && !committed) {
            refreshEditedTrackClearance(app);
            app.updateRatsnest?.();
        }
    }
    return !!preview;
}

/**
 * Discard preview copper and restore clearance after a cancelled pose gesture.
 * @param {PcbEditor} app
 */
export function restorePlacementPosePreview(app) {
    finishPlacementPreview(app);
    refreshEditedTrackClearance(app);
}

/**
 * @param {PcbEditor} app
 * @param {Track} track
 */
function deselectRemovedTrack(app, track) {
    if (!getPcbSelection(app, 'track').includes(track)) return;
    clearTrackSelection(app);
    togglePcbSelection(app, 'track', track);
    refreshTrackSelectionHalo(app);
    app.clearProperties?.();
}

/** @param {PcbEditor} app */
function refreshEditedTrackClearance(app) {
    if (deferDerivedUpdate(app, 'clearance', () => refreshEditedTrackClearance(app))) return;
    if (!areDragOverlaysDeferred(app)) app.refreshClearanceHalos?.();
}

/**
 * @param {PcbEditor} app
 * @param {Track} track
 */
function _opts(app, track) {
    return {
        viaDiameter: app.getRoutingParams?.()?.viaDiameter,
        viaDrill: app.getRoutingParams?.()?.viaDrill,
        hideNetLabel: _shouldHideNetLabel(app, track),
    };
}

/**
 * Net labels are hidden while a track is selected or being dragged.
 * @param {PcbEditor} app
 * @param {Track} track
 */
function _shouldHideNetLabel(app, track) {
    return !!track && (track === getPcbSelection(app, 'track')[0] || track === draggedTrack(app)?.preview);
}

/**
 * Re-glue track endpoints to the pads they are bonded to. For every
 * Track node whose padConnections entry references `compId`, move the
 * node to its pad's current world position and re-render that track.
 * This keeps hand-drawn / routed tracks attached when a component is
 * moved (the schematic Wire "sticky pin" behaviour, applied to pads).
 *
 * Pad world positions are read live from the placement, so the caller
 * must update `pl.pads` (and `pl.x`/`pl.y`) before calling this.
 *
 * @param {PcbEditor} app
 * @param {string} compId - The component whose pads moved
 * @returns {Set<Track>|null} the set of tracks that were repositioned
 */
export function repositionPadConnectedNodes(app, compId) {
    const pl = app.placements?.get(compId);
    if (!pl?.pads) return null;
    const touched = repositionPadConnectedNodesData(app.tracks || [], compId, pl.pads);
    for (const track of touched) {
        renderTrack(track, (id) => app.getLayerGroup(id), _opts(app, track));
    }
    return touched;
}

/**
 * The SVG transform for a placement's current pose (position + rotation + mirror).
 * @param {Placement} pl
 */
export function placementTransform(pl) {
    let t = `translate(${pl.x}, ${pl.y})`;
    if (pl.rotation) t += ` rotate(${pl.rotation})`;
    if (isPlacementMirrored(pl)) t += ' scale(-1, 1)';
    return t;
}

/**
 * Apply a placement's full pose (position + rotation) to its rendered SVG
 * and recompute its pads' world positions. Footprint geometry is authored in
 * local coordinates and oriented purely by the group's `translate … rotate`
 * transform, so pad world positions are the local offsets rotated by the
 * placement angle. Pad-bonded track endpoints are re-glued afterwards.
 *
 * Callers must set `pl.x`, `pl.y` and `pl.rotation` first, then call this; the
 * caller decides whether to also reconcile the ratsnest / record an override.
 * @param {PcbEditor} app
 * @param {string} compId
 */
export function applyPlacementPose(app, compId) {
    const pl = app.placements?.get(compId);
    if (!pl) return;
    updatePlacementPadPositions(pl);
    renderPlacementPose(app, compId);
    repositionPadConnectedNodes(app, compId);
    refreshEditedTrackClearance(app);
}

/**
 * Update existing SVG transforms without changing pads, track bonds or clearance.
 * @param {PcbEditor} app
 * @param {string} compId
 */
export function renderPlacementPose(app, compId) {
    const pl = app.placements?.get(compId);
    if (!pl) return;
    const transform = placementTransform(pl);
    for (const el of (pl.elements || [])) el.setAttribute('transform', transform);
    if (pl.lodEl) pl.lodEl.setAttribute('transform', transform);
    const halo = getPadHaloGroup(app, compId);
    if (halo) halo.setAttribute('transform', transform);
    const mirrored = isPlacementMirrored(pl);
    // Counter-mirror text inside the (possibly mirrored) footprint group:
    //  • Pad numbers stay readable in every orientation → counter the full
    //    visual mirror (`mirrored` = user-flip XOR bottom-side).
    //  • The reference designator's handedness must reflect only the board
    //    SIDE: readable on top (even after an H/V flip), mirrored on the
    //    bottom. The group already applies `mirrored`; countering by the
    //    user-flip flag alone leaves a net mirror of just (side === 'bottom').
    for (const el of (pl.elements || [])) {
        for (const t of el.querySelectorAll('.pcb-mirror-text')) {
            const isRef = t.hasAttribute('data-fp-ref');
            const flip = isRef ? !!pl.mirror : mirrored;
            if (isRef) {
                // The reference designator can be moved/rotated relative to the
                // footprint. Compose (outermost → innermost):
                //   translate(offset) · [counter-mirror] · rotate(refRot,cx,cy)
                const c = parseFloat(t.getAttribute('data-mx-center')) || 0;
                const cy = parseFloat(t.getAttribute('data-ref-cy')) || 0;
                const dx = pl.refDx || 0, dy = pl.refDy || 0, rr = pl.refRot || 0;
                const parts = [];
                if (dx || dy) parts.push(`translate(${dx}, ${dy})`);
                if (flip) parts.push(`translate(${2 * c}, 0) scale(-1, 1)`);
                if (rr) parts.push(`rotate(${rr}, ${c}, ${cy})`);
                if (parts.length) t.setAttribute('transform', parts.join(' '));
                else t.removeAttribute('transform');
            } else if (flip) {
                const c = parseFloat(t.getAttribute('data-mx-center')) || 0;
                t.setAttribute('transform', `translate(${2 * c}, 0) scale(-1, 1)`);
            } else {
                t.removeAttribute('transform');
            }
        }
    }
    getPropertyEditor(app, 'component')?.syncRotationInput(compId);
}

/** Add a freshly-built Track to app.tracks and render it. Optionally
 *  also add associated standalone Vias (e.g. at layer-change nodes)
 *  in the same atomic undo step. */
export class AddTrackCommand extends ModelAddTrackCommand {
    /** @param {PcbEditor} app @param {Track} track @param {Via[]} [vias] */
    constructor(app, track, vias = []) {
        super(app.pcbDocument, track, vias);
        this.app = app;
    }

    execute() {
        super.execute();
        renderTrack(this.track, (id) => this.app.getLayerGroup(id), _opts(this.app, this.track));
        for (const v of this.vias) {
            renderVia(v, (id) => this.app.getLayerGroup(id));
        }
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
    }
    undo() {
        cancelTrackDragOf(this.app, this.track);
        deselectRemovedTrack(this.app, this.track);
        for (const v of this.vias) {
            removeViaElements(v);
        }
        removeTrackElements(this.track);
        super.undo();
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
    }
}

export class ReplaceRoutesCommand extends ModelReplaceRoutesCommand {
    /** @param {PcbEditor} app @param {Track[]} tracks @param {Via[]} vias @param {FailedConnection[]} [failedConnections] */
    constructor(app, tracks, vias, failedConnections = []) {
        super(app.pcbDocument, tracks, vias);
        this.app = app;
        this.description = 'Replace routed copper';
        const currentFailed = /** @type {RoutedRatline[]} */ (storedDrcRatlines(app));
        this.beforeFailed = currentFailed.filter(line => line.failed).map(line => ({ ...line }));
        this.afterFailed = failedConnections.map(fc => ({
            net: String(fc.net), x1: fc.from.x, y1: fc.from.y, x2: fc.to.x, y2: fc.to.y, failed: true,
        }));
    }
    /** @param {RouteState} state */
    _apply(state) {
        clearTrackSelection(this.app);
        for (const track of this.document.tracks) removeTrackElements(track);
        for (const via of this.document.vias) removeViaElements(via);
        super._apply(state);
        renderRoutedCopper(this.app, state === this.after ? this.afterFailed : this.beforeFailed);
    }
}

/**
 * Redraw routed copper after routes are replaced or cleared: tracks and vias, the
 * failed-connection ratlines, selection, DRC and clearance halos.
 * @param {PcbEditor} app
 * @param {Array<{net: string, x1: number, y1: number, x2: number, y2: number}>} [failedRatlines]
 */
export function renderRoutedCopper(app, failedRatlines = []) {
    const params = app.getRoutingParams();
    for (const id of ['top-copper', 'bottom-copper', 'vias']) {
        app.getLayerGroup(id)?.querySelectorAll('.pcb-routed-track, .pcb-routed-via, .pcb-route-anim')
            .forEach(el => el.remove());
    }
    /** @param {string} id */
    const getGroup = (id) => app.getLayerGroup(id);
    for (const t of app.pcbDocument.tracks) renderTrack(t, getGroup, {
        viaDiameter: params.viaDiameter,
        viaDrill: params.viaDrill,
    });
    for (const v of app.pcbDocument.vias) renderVia(v, getGroup);

    // Reconcile final ratsnest: hide all original ratlines, then draw
    // per-connection ratlines for each failed connection.
    const ratLayer = app.getLayerGroup('ratlines');
    ratLayer?.querySelectorAll('.ratsnest-failed').forEach(el => el.remove());
    for (const el of [...(ratLayer?.children || [])]) {
        /** @type {HTMLElement} */ (el).style.display = 'none';
    }

    const NS2 = 'http://www.w3.org/2000/svg';
    if (ratLayer) {
        for (const fc of failedRatlines) {
            const line = document.createElementNS(NS2, 'line');
            line.setAttribute('x1', String(fc.x1));
            line.setAttribute('y1', String(fc.y1));
            line.setAttribute('x2', String(fc.x2));
            line.setAttribute('y2', String(fc.y2));
            line.setAttribute('stroke', '#4488ff');
            line.setAttribute('stroke-width', '1');
            line.setAttribute('vector-effect', 'non-scaling-stroke');
            line.setAttribute('pointer-events', 'none');
            line.setAttribute('class', 'ratsnest-line ratsnest-failed');
            line.dataset.net = fc.net;
            ratLayer.appendChild(line);
        }
    }

    setDrcRatlines(app, failedRatlines.map(line => ({ ...line })));
    reconcileRatsnest(app);
    syncPcbSelection(app);
    app.refreshSelectionHighlights();
    showPcbSelectionProperties(app);
    app.setPcbStatus?.();

    app.refreshClearanceHalos();
    scheduleDrc(app);
}

/** Remove an existing Track from app.tracks and its SVG. */
export class RemoveTrackCommand extends ModelRemoveTrackCommand {
    /** @param {PcbEditor} app @param {Track} track */
    constructor(app, track) {
        super(app.pcbDocument, canonicalTrack(app, track));
        this.app = app;
    }
    execute() {
        cancelTrackDragOf(this.app, this.track);
        if (getPropertyEditor(this.app, 'track')?.track === this.track) getPropertyEditor(this.app, 'track')?.dispose();
        deselectRemovedTrack(this.app, this.track);
        removeTrackElements(this.track);
        super.execute();
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
    }
    undo() {
        super.undo();
        renderTrack(this.track, (id) => this.app.getLayerGroup(id), _opts(this.app, this.track));
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
    }
}

/**
 * Change one or more scalar properties of a Track (e.g. width). Both
 * snapshots are plain {key: value} objects.
 */
export class ModifyTrackCommand extends ModelModifyTrackCommand {
    /** @param {PcbEditor} app @param {Track} track @param {TrackPatch} before @param {TrackPatch} after */
    constructor(app, track, before, after) {
        super(canonicalTrack(app, track), before, after);
        this.app = app;
    }
    /** @param {TrackPatch} state */
    _apply(state) {
        cancelTrackDragOf(this.app, this.track);
        super._apply(state);
        renderTrack(this.track, (id) => this.app.getLayerGroup(id), _opts(this.app, this.track));
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
    }
}

/** Move a single Track node from (fromX, fromY) to (toX, toY). */
export class MoveVertexCommand extends ModelMoveVertexCommand {
    /** @param {PcbEditor} app @param {Track} track @param {string} nodeId @param {number} fromX @param {number} fromY @param {number} toX @param {number} toY */
    constructor(app, track, nodeId, fromX, fromY, toX, toY) {
        super(canonicalTrack(app, track), nodeId, fromX, fromY, toX, toY);
        this.app = app;
    }
    /** @param {{x: number, y: number}} pt */
    _set(pt) {
        cancelTrackDragOf(this.app, this.track);
        super._set(pt);
        renderTrack(this.track, (id) => this.app.getLayerGroup(id), _opts(this.app, this.track));
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
        refreshTrackSelectionHalo(this.app);
    }
}

/**
 * Replace a Track's entire graph (nodes, edges, layers, pad links) with
 * a captured snapshot. Used for edits that change topology — e.g. a
 * segment drag that pins a via and grows a bridging segment. `before`
 * and `after` are `track.captureState()` snapshots.
 */
export class ModifyTrackGraphCommand extends ModelModifyTrackGraphCommand {
    /** @param {PcbEditor} app @param {Track} track @param {TrackState} before @param {TrackState} after */
    constructor(app, track, before, after) {
        super(canonicalTrack(app, track), before, after);
        this.app = app;
    }
    /** @param {TrackState} state */
    _apply(state) {
        cancelTrackDragOf(this.app, this.track);
        super._apply(state);
        renderTrack(this.track, (id) => this.app.getLayerGroup(id), _opts(this.app, this.track));
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
        refreshTrackSelectionHalo(this.app);
    }
}

export class AddViaCommand extends ModelAddViaCommand {
    /** @param {PcbEditor} app @param {Via} via */
    constructor(app, via) { super(app.pcbDocument, via); this.app = app; }
    execute() {
        super.execute();
        renderVia(this.via, (id) => this.app.getLayerGroup(id));
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
    }
    undo() {
        removeViaElements(this.via);
        super.undo();
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
    }
}

export class RemoveViaCommand extends ModelRemoveViaCommand {
    /** @param {PcbEditor} app @param {Via} via */
    constructor(app, via) { super(app.pcbDocument, via); this.app = app; }
    execute() {
        removeViaElements(this.via);
        super.execute();
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
    }
    undo() {
        super.undo();
        renderVia(this.via, (id) => this.app.getLayerGroup(id));
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
    }
}

export class ModifyViaCommand extends ModelModifyViaCommand {
    /** @param {PcbEditor} app @param {Via} via @param {Partial<ViaState>} before @param {Partial<ViaState>} after */
    constructor(app, via, before, after) {
        super(via, before, after);
        this.app = app;
    }
    /** @param {Partial<ViaState>} state */
    _apply(state) {
        super._apply(state);
        renderVia(this.via, (id) => this.app.getLayerGroup(id));
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
        refreshTrackSelectionHalo(this.app);
    }
}

/** Apply the same property edit to several vias with one derived refresh. */
export class ModifyViasCommand extends ModelModifyViasCommand {
    /** @param {PcbEditor} app @param {ViaChange[]} changes */
    constructor(app, changes) {
        super(changes);
        this.app = app;
    }
    /** @param {'before'|'after'} stateKey */
    _apply(stateKey) {
        super._apply(stateKey);
        for (const change of this.changes) {
            renderVia(change.via, (id) => this.app.getLayerGroup(id));
        }
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
        refreshTrackSelectionHalo(this.app);
    }
}

/** Move a standalone Via from (fromX, fromY) to (toX, toY). */
export class MoveViaCommand extends ModelMoveViaCommand {
    /** @param {PcbEditor} app @param {Via} via @param {number} fromX @param {number} fromY @param {number} toX @param {number} toY */
    constructor(app, via, fromX, fromY, toX, toY) {
        super(via, fromX, fromY, toX, toY);
        this.app = app;
    }
    /** @param {{x: number, y: number}} pt */
    _set(pt) {
        super._set(pt);
        renderVia(this.via, (id) => this.app.getLayerGroup(id));
        refreshEditedTrackClearance(this.app);
        refreshTrackSelectionHalo(this.app);
    }
}

/**
 * @param {PcbEditor} app
 * @param {string} compId
 * @param {PlacementPoseResult} result
 */
function presentPlacementPose(app, compId, result) {
    const pl = app.placements?.get(compId);
    if (pl) {
        pl.x = result.pose.x;
        pl.y = result.pose.y;
        pl.rotation = result.pose.rotation;
        pl.mirror = result.pose.mirror;
        pl.side = result.pose.side;
        for (const [id, pad] of result.pads) pl.pads.set(id, pad);
        renderPlacementPose(app, compId);
    }
    for (const track of result.tracks) {
        renderTrack(track, id => app.getLayerGroup(id), _opts(app, track));
    }
    refreshEditedTrackClearance(app);
    app.markDirty?.();
    app.updateRatsnest?.();
    app.refreshFills?.();
    refreshBoardView(app);
    app.refreshSelectionHighlights?.();
}

export class MovePlacementCommand extends ModelMovePlacementCommand {
    /** @param {PcbEditor} app @param {string} compId @param {number} fromX @param {number} fromY @param {number} toX @param {number} toY */
    constructor(app, compId, fromX, fromY, toX, toY) {
        super(/** @type {ProjectDocument} */ (app.project), compId, fromX, fromY, toX, toY, app.placements?.get(compId));
        this.app = app;
    }
    /** @param {{x: number, y: number}} pt */
    _apply(pt) {
        const result = super._apply(pt);
        presentPlacementPose(this.app, this.compId, result);
        return result;
    }
}

/**
 * Rotate a placement about its origin to an absolute angle (degrees).
 * Re-orients the footprint SVG, re-glues pad-bonded tracks, persists the
 * pose override, reconciles the ratsnest and refreshes any open 3D view.
 */
export class RotatePlacementCommand extends ModelRotatePlacementCommand {
    /** @param {PcbEditor} app @param {string} compId @param {number} fromDeg @param {number} toDeg */
    constructor(app, compId, fromDeg, toDeg) {
        super(/** @type {ProjectDocument} */ (app.project), compId, fromDeg, toDeg, app.placements?.get(compId));
        this.app = app;
    }
    /** @param {number} deg */
    _apply(deg) {
        const result = super._apply(deg);
        presentPlacementPose(this.app, this.compId, result);
        return result;
    }
}

/** Toggle whether a PCB placement can be transformed or have its reference edited. */
export class SetPlacementLockedCommand extends ModelSetPlacementLockedCommand {
    /** @param {PcbEditor} app @param {string} compId @param {boolean} locked */
    constructor(app, compId, locked) {
        super(app.placementState, compId, locked, app.placements?.get(compId));
        this.app = app;
    }
    /** @param {boolean} locked */
    _apply(locked) {
        const saved = super._apply(locked);
        const pl = this.app.placements?.get(this.compId);
        if (pl) pl.locked = saved.locked;
        this.app.markDirty?.();
        this.app.refreshSelectionHighlights?.();
        if (getPcbSelection(this.app, 'component').includes(this.compId)) {
            if (this.app.viewport?.svg) {
                this.app.viewport.svg.style.cursor = locked ? 'default' : 'grab';
            }
            this.app.showComponentProperties?.(this.compId);
        }
        if (getPcbSelection(this.app, 'reftext').includes(this.compId)) this.app.showRefProperties?.(this.compId);
        return saved;
    }
}

/**
 * Flip a placement horizontally or vertically. Mirrors the schematic editor's
 * model: a flip toggles the `mirror` flag and adjusts the rotation so the net
 * visual is a pure mirror across the chosen world axis (H = vertical axis,
 * V = horizontal axis), regardless of current orientation.
 */
export class FlipPlacementCommand extends ModelFlipPlacementCommand {
    /** @param {PcbEditor} app @param {string} compId @param {'H'|'V'|string} axis */
    constructor(app, compId, axis) {
        super(/** @type {ProjectDocument} */ (app.project), compId, axis, app.placements?.get(compId));
        this.app = app;
    }
    /** @param {PlacementPatch} state */
    _apply(state) {
        const result = super._apply(state);
        presentPlacementPose(this.app, this.compId, result);
        return result;
    }
}

/**
 * Show or hide a placement's reference designator (the silkscreen label). The
 * reference group is tagged with `data-fp-ref` by {@link renderFootprint}, so
 * it can be toggled per placement without touching the rest of the footprint.
 * @param {PcbEditor} app
 * @param {string} compId
 * @param {boolean} visible
 */
export function applyPlacementRefVisible(app, compId, visible) {
    const pl = app.placements?.get(compId);
    if (!pl) return;
    pl.refVisible = visible !== false;
    for (const el of (pl.elements || [])) {
        const ref = el.querySelector?.('[data-fp-ref]');
        if (ref) ref.style.display = pl.refVisible ? '' : 'none';
    }
}

/** Toggle a placement's reference-designator visibility through history. */
export class SetPlacementRefVisibleCommand extends ModelSetPlacementRefVisibleCommand {
    /** @param {PcbEditor} app @param {string} compId @param {boolean} visible */
    constructor(app, compId, visible) {
        super(app.placementState, compId, visible, app.placements?.get(compId));
        this.app = app;
    }
    /** @param {boolean} v */
    _apply(v) {
        const saved = super._apply(v);
        applyPlacementRefVisible(this.app, this.compId, saved.refVisible);
        this.app.markDirty?.();
        refreshBoardView(this.app);
        return saved;
    }
}

/** @type {Record<string, string>} */
const FP_LAYER_FLIP = {
    'top-copper': 'bottom-copper', 'bottom-copper': 'top-copper',
    'top-pad-numbers': 'bottom-pad-numbers', 'bottom-pad-numbers': 'top-pad-numbers',
    'top-silk': 'bottom-silk', 'bottom-silk': 'top-silk',
    'top-paste': 'bottom-paste', 'bottom-paste': 'top-paste',
    'top-mask': 'bottom-mask', 'bottom-mask': 'top-mask',
    'top-document': 'bottom-document', 'bottom-document': 'top-document',
};

/**
 * Break pad bonds whose copper layer no longer matches the connected track.
 * After a component changes side, its single-sided (SMD) pads move to the
 * opposite copper layer; any track still bonded to such a pad on the old
 * layer is now electrically disconnected, so its `padConnections` entry is
 * dropped and the track left where it lies. Through-hole pads (`both`) reach
 * every copper layer and keep their bonds.
 * @param {PcbEditor} app
 * @param {string} compId
 */
export function disconnectIncompatiblePadNodes(app, compId) {
    const pl = app.placements?.get(compId);
    if (!pl) return;
    const touched = disconnectIncompatiblePadNodesData(app.tracks || [], compId, pl.padOffsets || []);
    for (const track of touched) {
        renderTrack(track, (id) => app.getLayerGroup(id), _opts(app, track));
    }
}

/**
 * Move a placement to the top or bottom copper side: reparent each footprint
 * layer group to its (optionally mirrored) board layer and swap pad/paste
 * layers for the ratsnest, DRC and gerber export. Geometry mirroring itself is
 * handled by {@link applyPlacementPose} via {@link isPlacementMirrored}; the
 * caller must invoke that afterwards. Does not touch history.
 * @param {PcbEditor} app
 * @param {string} compId
 * @param {'top'|'bottom'} side
 */
export function applyPlacementSide(app, compId, side) {
    const pl = app.placements?.get(compId);
    if (!pl) return;
    applyPlacementSideData(pl, side);
    renderPlacementSide(app, compId, side);
    // Drop incompatible bonds before a subsequent pose update can move their endpoints.
    disconnectIncompatiblePadNodes(app, compId);
}

/**
 * Reparent and recolor footprint artwork without changing pads or track bonds.
 * @param {PcbEditor} app
 * @param {string} compId
 * @param {'top'|'bottom'|string} side
 */
export function renderPlacementSide(app, compId, side) {
    const pl = app.placements?.get(compId);
    if (!pl) return;
    const flip = side === 'bottom';
    for (const el of (pl.elements || [])) {
        const base = el.getAttribute('data-fp-layer');
        if (!base) continue;
        const target = flip ? (FP_LAYER_FLIP[base] || base) : base;
        const group = app.getLayerGroup?.(target);
        if (group && el.parentNode !== group) group.appendChild(el);
        // Recolour SMD pads to the copper colour of the side they now sit on
        // (top = red, bottom = blue). Through-hole pads stay gold.
        if (target === 'top-copper' || target === 'bottom-copper') {
            const fill = target === 'bottom-copper' ? '#3498db' : '#e74c3c';
            for (const pg of el.querySelectorAll('.pcb-pad')) {
                if (pg.getAttribute('data-pad-kind') === 'th') continue;
                const shape = pg.querySelector('rect, circle');
                if (shape) shape.setAttribute('fill', fill);
            }
        }
    }
}

/**
 * Place a component on the top or bottom copper side. Reparents its artwork to
 * the matching layers, mirrors the footprint, re-glues pad-bonded tracks,
 * persists the override, reconciles the ratsnest and refreshes any 3D view.
 */
export class SetPlacementSideCommand extends ModelSetPlacementSideCommand {
    /** @param {PcbEditor} app @param {string} compId @param {'top'|'bottom'|string} side */
    constructor(app, compId, side) {
        super(/** @type {ProjectDocument} */ (app.project), compId, side, app.placements?.get(compId));
        this.app = app;
    }
    /** @param {'top'|'bottom'|string} side @param {boolean} [restore] */
    _apply(side, restore = false) {
        const result = super._apply(side, restore);
        const pl = this.app.placements?.get(this.compId);
        if (pl) {
            applyPlacementSideData(pl, result.pose.side);
            renderPlacementSide(this.app, this.compId, result.pose.side);
        }
        presentPlacementPose(this.app, this.compId, result);
        return result;
    }
}

export class SetBoardOutlineCommand extends ModelSetBoardOutlineCommand {
    /** @param {PcbEditor} app @param {BoardOutlineCommandState} before @param {BoardOutlineCommandState} after */
    constructor(app, before, after) {
        super(app.pcbDocument, before, after);
        this.app = app;
    }
    /** @param {BoardOutlineCommandState} s */
    _apply(s) {
        super._apply(s);
        drawBoardOutline(this.app);
        syncBoardOutlineInputs(this.app);
        this.app.refreshFills?.();
    }
}

/**
 * Group N commands into one atomic history entry. execute() runs them
 * in order; undo() runs them in reverse. Useful for compound gestures
 * (e.g. dragging a via that also moves connected track endpoints).
 */
export class CompoundCommand {
    /** @param {CommandLike[]} commands */
    constructor(commands) {
        this.commands = Array.isArray(commands) ? commands.slice() : [];
        this.app = this.commands.find((command) => command.app)?.app;
    }
    execute() {
        batchDerivedUpdates(this.app, () => {
            const applied = [];
            try {
                for (const command of this.commands) {
                    command.execute();
                    applied.push(command);
                }
            } catch (error) {
                for (const command of applied.reverse()) command.undo();
                throw error;
            }
        });
    }
    undo() {
        batchDerivedUpdates(this.app, () => {
            for (let index = this.commands.length - 1; index >= 0; index--) this.commands[index].undo();
        });
    }
}
