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
import { reconcileRatsnest } from './track-draw.js';
import { clearTrackSelection, refreshTrackSelectionHalo } from './track-select.js';
import { getPcbSelection, togglePcbSelection } from './selection-registry.js';
import { batchDerivedUpdates, deferDerivedUpdate } from '../../core/DerivedUpdates.js';
import { isPlacementMirrored } from './board-geometry.js';
export { isPlacementMirrored } from './board-geometry.js';
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
    MoveRefTextCommand as ModelMoveRefTextCommand,
    RotateRefTextCommand as ModelRotateRefTextCommand,
    SetRefStyleCommand as ModelSetRefStyleCommand,
} from '../../core/pcb-placement-commands.js';
import {
    AddTrackCommand as ModelAddTrackCommand,
    RemoveTrackCommand as ModelRemoveTrackCommand,
    ModifyTrackCommand as ModelModifyTrackCommand,
    MoveVertexCommand as ModelMoveVertexCommand,
    ModifyTrackGraphCommand as ModelModifyTrackGraphCommand,
} from '../../core/pcb-track-commands.js';
import {
    AddViaCommand as ModelAddViaCommand,
    RemoveViaCommand as ModelRemoveViaCommand,
    ModifyViaCommand as ModelModifyViaCommand,
    ModifyViasCommand as ModelModifyViasCommand,
    MoveViaCommand as ModelMoveViaCommand,
} from '../../core/pcb-via-commands.js';
import { cancelVertexDrag } from './track-drag.js';

const placementPreviews = new WeakMap();
const viaPropertyPreviews = new WeakMap();
const trackPropertyPreviews = new WeakMap();

export function getTrackPropertyPreview(app) {
    return trackPropertyPreviews.get(app);
}

export function canonicalTrack(app, track) {
    if (app._vertexDrag?.track === track) return app._vertexDrag.original || track;
    const preview = trackPropertyPreviews.get(app);
    if (preview?.track === track) return preview.original;
    return app._viaDrag?.preview?.originals.get(track)
        || placementPreviews.get(app)?.originals.get(track) || track;
}

export function displayedTrack(app, track) {
    track = canonicalTrack(app, track);
    const placement = placementPreviews.get(app)?.copiesByOriginal.get(track);
    if (placement) return placement;
    if (app._vertexDrag?.original === track) return app._vertexDrag.track;
    const terminal = app._viaDrag?.preview?.copies.get(track);
    if (terminal) return terminal;
    const preview = trackPropertyPreviews.get(app);
    return preview?.original === track ? preview.track : track;
}

function assertTrackPropertyTarget(app, track, { edgeId, nodeId }) {
    if (!app.pcbDocument.tracks.includes(track)
        || (edgeId != null && !track.edges.has(edgeId))
        || (nodeId != null && !track.nodes.has(nodeId))) {
        throw new Error('Cannot edit a missing track, segment or node.');
    }
}

/** Keep one exact graph copy for the active numeric track property field. */
export function beginTrackPropertyPreview(app, original, scope) {
    if (trackPropertyPreviews.has(app) || placementPreviews.has(app) || app._viaDrag || app._vertexDrag) {
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

/** Drop display ownership before the existing graph command applies authored state. */
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
            renderTrack(preview.original, id => app._getLayerGroup(id), _opts(app, preview.original));
        }
    }
}

export function getViaPropertyPreview(app) {
    return viaPropertyPreviews.get(app);
}

export function canonicalVia(app, via) {
    if (app._viaDrag?.via === via) return app._viaDrag.original;
    return viaPropertyPreviews.get(app)?.originals.get(via) || via;
}

export function displayedVia(app, via) {
    via = canonicalVia(app, via);
    if (app._viaDrag?.original === via) return app._viaDrag.via;
    return viaPropertyPreviews.get(app)?.copies.get(via) || via;
}

/** Numeric via fields reuse one fixed-selection projection from first change. */
export function beginViaPropertyPreview(app, vias) {
    if (viaPropertyPreviews.has(app) || app._viaDrag) {
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

/** Model commands receive canonical targets only, after all preview SVG is removed. */
export function finishViaPropertyPreview(app, commit) {
    const preview = viaPropertyPreviews.get(app);
    if (!preview) return;
    viaPropertyPreviews.delete(app);
    const changes = [];
    for (const [via, copy] of preview.copies) {
        removeViaElements(copy);
        const before = {}, after = {};
        for (const key of ['diameter', 'drill']) {
            if (preview.before.get(via)[key] === copy[key]) continue;
            before[key] = preview.before.get(via)[key];
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
            if (available.has(via) && !changed.has(via)) renderVia(via, id => app._getLayerGroup(id));
        }
    }
}

/** @returns {Track[]|undefined} */
export function getPlacementPreviewTracks(app) {
    return placementPreviews.get(app)?.tracks;
}

/**
 * Move connected copper in an editor-owned projection, never in the document.
 * @param {any} app
 * @param {string} compId
 * @param {Partial<{x:number, y:number, rotation:number}>} pose
 */
export function previewPlacementPose(app, compId, pose) {
    previewPlacementPoses(app, new Map([[compId, pose]]));
}

/**
 * Preview a fixed set of component poses, sharing one copy of each bonded track.
 * @param {any} app
 * @param {Map<string, Partial<{x:number, y:number, rotation:number}>>} poses
 */
export function previewPlacementPoses(app, poses) {
    const ids = [...poses.keys()].filter(id => app.placements?.has(id));
    if (!ids.length) return;
    let preview = placementPreviews.get(app);
    if (!preview) {
        const before = new Map(ids.map(id => {
            const pl = app.placements.get(id);
            return [id, { x: pl.x, y: pl.y, rotation: pl.rotation }];
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
    if (preview.before.size !== ids.length || ids.some(id => !preview.before.has(id))) {
        throw new Error('Finish the current placement preview before starting another.');
    }
    const touched = new Set();
    for (const id of ids) {
        const pl = app.placements.get(id), before = preview.before.get(id);
        Object.assign(pl, poses.get(id));
        if (pl.x !== before.x || pl.y !== before.y || pl.rotation !== before.rotation) preview.changed.add(id);
        else preview.changed.delete(id);
        updatePlacementPadPositions(pl);
        renderPlacementPose(app, id);
        for (const track of repositionPadConnectedNodesData(preview.copies, id, pl.pads)) touched.add(track);
    }
    for (const track of touched) {
        if (!preview.rendered.has(track)) removeTrackElements(preview.originals.get(track));
        renderTrack(track, id => app._getLayerGroup(id), _opts(app, track));
        preview.rendered.add(track);
    }
    refreshEditedTrackClearance(app);
}

/**
 * End the projection before a command runs; failures restore canonical track artwork.
 * @param {any} app
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
        for (const track of preview?.rendered || []) {
            removeTrackElements(track);
            const original = preview.originals.get(track);
            if (!committed || !hasTrackElements(original)) {
                renderTrack(original, id => app._getLayerGroup(id), _opts(app, original));
            }
        }
        if (preview && commit && !committed) {
            refreshEditedTrackClearance(app);
            app._updateRatsnest?.();
        }
    }
    return !!preview;
}

/** Discard preview copper and restore clearance after a cancelled pose gesture. */
export function restorePlacementPosePreview(app) {
    finishPlacementPreview(app);
    refreshEditedTrackClearance(app);
}

function deselectRemovedTrack(app, track) {
    if (!getPcbSelection(app, 'track').includes(track)) return;
    clearTrackSelection(app);
    togglePcbSelection(app, 'track', track);
    refreshTrackSelectionHalo(app);
    app._clearProperties?.();
}

function refreshEditedTrackClearance(app) {
    if (deferDerivedUpdate(app, 'clearance', () => refreshEditedTrackClearance(app))) return;
    if (!app._deferDragOverlays) app._refreshClearanceHalos?.();
}

function _opts(app, track) {
    return {
        viaDiameter: app._getRoutingParams?.()?.viaDiameter,
        viaDrill: app._getRoutingParams?.()?.viaDrill,
        hideNetLabel: _shouldHideNetLabel(app, track),
    };
}

/** Net labels are hidden while a track is selected or being dragged. */
function _shouldHideNetLabel(app, track) {
    return !!track && (track === getPcbSelection(app, 'track')[0] || track === app._vertexDrag?.track);
}

/**
 * Re-glue track endpoints to the pads they are bonded to. For every
 * Track node whose padConnections entry references `compId`, move the
 * node to its pad's current world position and re-render that track.
 * This keeps hand-drawn / routed traces attached when a component is
 * moved (the schematic Wire "sticky pin" behaviour, applied to pads).
 *
 * Pad world positions are read live from the placement, so the caller
 * must update `pl.pads` (and `pl.x`/`pl.y`) before calling this.
 *
 * @param {object} app - PCBApp
 * @param {string} compId - The component whose pads moved
 * @returns {Set<object>|null} the set of tracks that were repositioned
 */
export function repositionPadConnectedNodes(app, compId) {
    const pl = app.placements?.get(compId);
    if (!pl?.pads) return null;
    const touched = repositionPadConnectedNodesData(app.tracks || [], compId, pl.pads);
    for (const track of touched) {
        renderTrack(track, (id) => app._getLayerGroup(id), _opts(app, track));
    }
    return touched;
}

/** The SVG transform for a placement's current pose (position + rotation + mirror). */
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
 * @param {object} app - PCBApp
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

/** Update existing SVG transforms without changing pads, track bonds or clearance. */
export function renderPlacementPose(app, compId) {
    const pl = app.placements?.get(compId);
    if (!pl) return;
    const transform = placementTransform(pl);
    for (const el of (pl.elements || [])) el.setAttribute('transform', transform);
    if (pl.lodEl) pl.lodEl.setAttribute('transform', transform);
    const halo = app._padHaloGroups?.get(compId);
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
    app._syncComponentRotationInput?.(compId);
}

/** Add a freshly-built Track to app.tracks and render it. Optionally
 *  also add associated standalone Vias (e.g. at layer-change nodes)
 *  in the same atomic undo step. */
export class AddTrackCommand extends ModelAddTrackCommand {
    constructor(app, track, vias = []) {
        super(app.pcbDocument, track, vias);
        this.app = app;
    }
    execute() {
        super.execute();
        renderTrack(this.track, (id) => this.app._getLayerGroup(id), _opts(this.app, this.track));
        for (const v of this.vias) {
            renderVia(v, (id) => this.app._getLayerGroup(id));
        }
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
    }
    undo() {
        if (this.app._vertexDrag?.original === this.track) cancelVertexDrag(this.app);
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

/** Remove an existing Track from app.tracks and its SVG. */
export class RemoveTrackCommand extends ModelRemoveTrackCommand {
    constructor(app, track) {
        super(app.pcbDocument, canonicalTrack(app, track));
        this.app = app;
    }
    execute() {
        if (this.app._vertexDrag?.original === this.track) cancelVertexDrag(this.app);
        if (this.app._trackPropertyBinding?.track === this.track) this.app._trackPropertyBinding.dispose();
        deselectRemovedTrack(this.app, this.track);
        removeTrackElements(this.track);
        super.execute();
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
    }
    undo() {
        super.undo();
        renderTrack(this.track, (id) => this.app._getLayerGroup(id), _opts(this.app, this.track));
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
    }
}

/**
 * Change one or more scalar properties of a Track (e.g. width). Both
 * snapshots are plain {key: value} objects.
 */
export class ModifyTrackCommand extends ModelModifyTrackCommand {
    constructor(app, track, before, after) {
        super(canonicalTrack(app, track), before, after);
        this.app = app;
    }
    _apply(state) {
        if (this.app._vertexDrag?.original === this.track) cancelVertexDrag(this.app);
        super._apply(state);
        renderTrack(this.track, (id) => this.app._getLayerGroup(id), _opts(this.app, this.track));
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
    }
}

/** Move a single Track node from (fromX, fromY) to (toX, toY). */
export class MoveVertexCommand extends ModelMoveVertexCommand {
    constructor(app, track, nodeId, fromX, fromY, toX, toY) {
        super(canonicalTrack(app, track), nodeId, fromX, fromY, toX, toY);
        this.app = app;
    }
    _set(pt) {
        if (this.app._vertexDrag?.original === this.track) cancelVertexDrag(this.app);
        super._set(pt);
        renderTrack(this.track, (id) => this.app._getLayerGroup(id), _opts(this.app, this.track));
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
    constructor(app, track, before, after) {
        super(canonicalTrack(app, track), before, after);
        this.app = app;
    }
    _apply(state) {
        if (this.app._vertexDrag?.original === this.track) cancelVertexDrag(this.app);
        super._apply(state);
        renderTrack(this.track, (id) => this.app._getLayerGroup(id), _opts(this.app, this.track));
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
        refreshTrackSelectionHalo(this.app);
    }
}

export class AddViaCommand extends ModelAddViaCommand {
    constructor(app, via) { super(app.pcbDocument, via); this.app = app; }
    execute() {
        super.execute();
        renderVia(this.via, (id) => this.app._getLayerGroup(id));
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
    constructor(app, via) { super(app.pcbDocument, via); this.app = app; }
    execute() {
        removeViaElements(this.via);
        super.execute();
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
    }
    undo() {
        super.undo();
        renderVia(this.via, (id) => this.app._getLayerGroup(id));
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
    }
}

export class ModifyViaCommand extends ModelModifyViaCommand {
    constructor(app, via, before, after) {
        super(via, before, after);
        this.app = app;
    }
    _apply(state) {
        super._apply(state);
        renderVia(this.via, (id) => this.app._getLayerGroup(id));
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
        refreshTrackSelectionHalo(this.app);
    }
}

/** Apply the same property edit to several vias with one derived refresh. */
export class ModifyViasCommand extends ModelModifyViasCommand {
    constructor(app, changes) {
        super(changes);
        this.app = app;
    }
    _apply(stateKey) {
        super._apply(stateKey);
        for (const change of this.changes) {
            renderVia(change.via, (id) => this.app._getLayerGroup(id));
        }
        refreshEditedTrackClearance(this.app);
        reconcileRatsnest(this.app);
        refreshTrackSelectionHalo(this.app);
    }
}

/** Move a standalone Via from (fromX, fromY) to (toX, toY). */
export class MoveViaCommand extends ModelMoveViaCommand {
    constructor(app, via, fromX, fromY, toX, toY) {
        super(via, fromX, fromY, toX, toY);
        this.app = app;
    }
    _set(pt) {
        super._set(pt);
        renderVia(this.via, (id) => this.app._getLayerGroup(id));
        refreshEditedTrackClearance(this.app);
        refreshTrackSelectionHalo(this.app);
    }
}

function presentPlacementPose(app, compId, result) {
    const pl = app.placements?.get(compId);
    if (pl) {
        for (const key of ['x', 'y', 'rotation', 'mirror', 'side']) pl[key] = result.pose[key];
        for (const [id, pad] of result.pads) pl.pads.set(id, pad);
        renderPlacementPose(app, compId);
    }
    for (const track of result.tracks) {
        renderTrack(track, id => app._getLayerGroup(id), _opts(app, track));
    }
    refreshEditedTrackClearance(app);
    app._markDirty?.();
    app._updateRatsnest?.();
    app._refreshFills?.();
    app._board3d?.refresh?.();
    app._refreshPcbSelectionHighlights?.();
}

export class MovePlacementCommand extends ModelMovePlacementCommand {
    constructor(app, compId, fromX, fromY, toX, toY) {
        super(app.project, compId, fromX, fromY, toX, toY, app.placements?.get(compId));
        this.app = app;
    }
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
    constructor(app, compId, fromDeg, toDeg) {
        super(app.project, compId, fromDeg, toDeg, app.placements?.get(compId));
        this.app = app;
    }
    _apply(deg) {
        const result = super._apply(deg);
        presentPlacementPose(this.app, this.compId, result);
        return result;
    }
}

/** Toggle whether a PCB placement can be transformed or have its reference edited. */
export class SetPlacementLockedCommand extends ModelSetPlacementLockedCommand {
    constructor(app, compId, locked) {
        super(app.placementState, compId, locked, app.placements?.get(compId));
        this.app = app;
    }
    _apply(locked) {
        const saved = super._apply(locked);
        const pl = this.app.placements?.get(this.compId);
        if (pl) pl.locked = saved.locked;
        this.app._markDirty?.();
        this.app._refreshPcbSelectionHighlights?.();
        if (getPcbSelection(this.app, 'component').includes(this.compId)) {
            if (this.app.viewport?.svg) {
                this.app.viewport.svg.style.cursor = locked ? 'default' : 'grab';
            }
            this.app._showComponentProperties?.(this.compId);
        }
        if (getPcbSelection(this.app, 'reftext').includes(this.compId)) {
            this.app._showRefProperties?.(this.compId);
        }
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
    constructor(app, compId, axis) {
        super(app.project, compId, axis, app.placements?.get(compId));
        this.app = app;
    }
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
 * @param {object} app - PCBApp
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
    constructor(app, compId, visible) {
        super(app.placementState, compId, visible, app.placements?.get(compId));
        this.app = app;
    }
    _apply(v) {
        const saved = super._apply(v);
        applyPlacementRefVisible(this.app, this.compId, saved.refVisible);
        this.app._markDirty?.();
        this.app._board3d?.refresh?.();
        return saved;
    }
}

/**
 * Move a placement's reference designator relative to its footprint. The
 * offset (`refDx`, `refDy`) is stored in the footprint's authored-local frame
 * — the same frame as the pad offsets — so it survives rotation, mirroring and
 * side changes of the parent placement.
 */
export class MoveRefTextCommand extends ModelMoveRefTextCommand {
    constructor(app, compId, fromDx, fromDy, toDx, toDy) {
        super(app.placementState, compId, fromDx, fromDy, toDx, toDy, app.placements?.get(compId));
        this.app = app;
    }
    _apply(s) {
        const saved = super._apply(s);
        const pl = this.app.placements?.get(this.compId);
        if (pl) { pl.refDx = saved.refDx; pl.refDy = saved.refDy; }
        renderPlacementPose(this.app, this.compId);
        this.app._markDirty?.();
        this.app._drawRefOverlay?.(this.compId, false);
        this.app._board3d?.refresh?.();
        return saved;
    }
}

/**
 * Rotate a placement's reference designator about its own centre to an
 * absolute angle (degrees), independent of the footprint's rotation.
 */
export class RotateRefTextCommand extends ModelRotateRefTextCommand {
    constructor(app, compId, fromDeg, toDeg) {
        super(app.placementState, compId, fromDeg, toDeg, app.placements?.get(compId));
        this.app = app;
    }
    _apply(deg) {
        const saved = super._apply(deg);
        const pl = this.app.placements?.get(this.compId);
        if (pl) pl.refRot = saved.refRot;
        renderPlacementPose(this.app, this.compId);
        this.app._markDirty?.();
        this.app._drawRefOverlay?.(this.compId, false);
        this.app._board3d?.refresh?.();
        return saved;
    }
}

/**
 * Project canonical reference styling before regenerating glyph geometry
 * and refreshing any open 3D view.
 */
export class SetRefStyleCommand extends ModelSetRefStyleCommand {
    constructor(app, compId, before, after) {
        super(app.placementState, compId, before, after, app.placements?.get(compId));
        this.app = app;
    }
    _apply(state) {
        const saved = super._apply(state);
        const pl = this.app.placements?.get(this.compId);
        if (pl) {
            if (state.refSize !== undefined) pl.refSize = saved.refSize;
            if (state.refStrokeWidth !== undefined) pl.refStrokeWidth = saved.refStrokeWidth;
            if (state.refRot !== undefined) pl.refRot = saved.refRot;
        }
        this.app._rerenderRef?.(this.compId);
        this.app._markDirty?.();
        this.app._drawRefOverlay?.(this.compId, false);
        this.app._board3d?.refresh?.();
        return saved;
    }
}
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
 * @param {object} app - PCBApp
 * @param {string} compId
 */
export function disconnectIncompatiblePadNodes(app, compId) {
    const pl = app.placements?.get(compId);
    if (!pl) return;
    const touched = disconnectIncompatiblePadNodesData(app.tracks || [], compId, pl.padOffsets || []);
    for (const track of touched) {
        renderTrack(track, (id) => app._getLayerGroup(id), _opts(app, track));
    }
}

/**
 * Move a placement to the top or bottom copper side: reparent each footprint
 * layer group to its (optionally mirrored) board layer and swap pad/paste
 * layers for the ratsnest, DRC and gerber export. Geometry mirroring itself is
 * handled by {@link applyPlacementPose} via {@link isPlacementMirrored}; the
 * caller must invoke that afterwards. Does not touch history.
 * @param {object} app - PCBApp
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

/** Reparent and recolor footprint artwork without changing pads or track bonds. */
export function renderPlacementSide(app, compId, side) {
    const pl = app.placements.get(compId);
    const flip = side === 'bottom';
    for (const el of (pl.elements || [])) {
        const base = el.getAttribute('data-fp-layer');
        if (!base) continue;
        const target = flip ? (FP_LAYER_FLIP[base] || base) : base;
        const group = app._getLayerGroup?.(target);
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
    constructor(app, compId, side) {
        super(app.project, compId, side, app.placements?.get(compId));
        this.app = app;
    }
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
    constructor(app, before, after) {
        super(app.pcbDocument, before, after);
        this.app = app;
    }
    _apply(s) {
        super._apply(s);
        this.app._drawBoardOutline?.();
        this.app._syncBoardOutlineInputs?.();
        this.app._refreshFills?.();
    }
}

/**
 * Group N commands into one atomic history entry. execute() runs them
 * in order; undo() runs them in reverse. Useful for compound gestures
 * (e.g. dragging a via that also moves connected track endpoints).
 */
export class CompoundCommand {
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
