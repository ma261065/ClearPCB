/**
 * Command classes for PCB Track/Via undo/redo.
 *
 * Each command owns enough state to fully reverse itself. Render/SVG
 * updates run inside execute()/undo() so the visible board state always
 * matches the model.
 */

import {
    renderTrack,
    renderVia,
    removeTrackElements,
    removeViaElements,
} from './track-render.js';
import { reconcileRatsnest } from './track-draw.js';
import { refreshTrackSelectionHalo } from './track-select.js';

function _opts(app, track) {
    return {
        viaDiameter: app._getRoutingParams?.()?.viaDiameter,
        viaDrill: app._getRoutingParams?.()?.viaDrill,
        hideNetLabel: _shouldHideNetLabel(app, track),
    };
}

/** Net labels are hidden while a track is selected or being dragged. */
function _shouldHideNetLabel(app, track) {
    return !!track && (track === app._selectedTrack || track === app._vertexDrag?.track);
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
    const touched = new Set();
    for (const track of (app.tracks || [])) {
        if (!track.padConnections?.size) continue;
        for (const [nid, conn] of track.padConnections) {
            if (!conn || conn.componentId !== compId) continue;
            const pad = pl.pads.get(conn.pinNumber)
                ?? pl.pads.get(String(conn.pinNumber))
                ?? pl.pads.get(Number(conn.pinNumber));
            if (!pad) continue;
            const n = track.nodes.get(nid);
            if (!n) continue;
            if (n.x !== pad.x || n.y !== pad.y) {
                n.x = pad.x;
                n.y = pad.y;
                touched.add(track);
            }
        }
    }
    for (const track of touched) {
        renderTrack(track, (id) => app._getLayerGroup(id), _opts(app, track));
    }
    return touched;
}

/** True when a placement's footprint geometry is mirrored on screen.
 *  A user flip (`mirror`) and a bottom-side placement each mirror the
 *  footprint; together they cancel out. */
export function isPlacementMirrored(pl) {
    return (!!pl?.mirror) !== (pl?.side === 'bottom');
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
    const rot = pl.rotation || 0;
    const transform = placementTransform(pl);
    for (const el of (pl.elements || [])) el.setAttribute('transform', transform);
    if (pl.lodEl) pl.lodEl.setAttribute('transform', transform);
    const halo = app._padHaloGroups?.get(compId);
    if (halo) halo.setAttribute('transform', transform);
    const rad = rot * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const mirrored = isPlacementMirrored(pl);
    const mx = mirrored ? -1 : 1;
    for (const off of (pl.padOffsets || [])) {
        const lx = off.dx * mx;
        const wx = pl.x + lx * cos - off.dy * sin;
        const wy = pl.y + lx * sin + off.dy * cos;
        pl.pads.set(off.padId, { x: wx, y: wy, number: off.number });
    }
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
    repositionPadConnectedNodes(app, compId);
}

/** Add a freshly-built Track to app.tracks and render it. Optionally
 *  also add associated standalone Vias (e.g. at layer-change nodes)
 *  in the same atomic undo step. */
export class AddTrackCommand {
    constructor(app, track, vias = []) {
        this.app = app;
        this.track = track;
        this.vias = Array.isArray(vias) ? vias : [];
    }
    execute() {
        if (!this.app.tracks.includes(this.track)) this.app.tracks.push(this.track);
        renderTrack(this.track, (id) => this.app._getLayerGroup(id), _opts(this.app, this.track));
        for (const v of this.vias) {
            if (!this.app.vias.includes(v)) this.app.vias.push(v);
            renderVia(v, (id) => this.app._getLayerGroup(id));
        }
        reconcileRatsnest(this.app);
    }
    undo() {
        for (const v of this.vias) {
            removeViaElements(v);
            const j = this.app.vias.indexOf(v);
            if (j >= 0) this.app.vias.splice(j, 1);
        }
        removeTrackElements(this.track);
        const i = this.app.tracks.indexOf(this.track);
        if (i >= 0) this.app.tracks.splice(i, 1);
        reconcileRatsnest(this.app);
    }
}

/** Remove an existing Track from app.tracks and its SVG. */
export class RemoveTrackCommand {
    constructor(app, track) {
        this.app = app;
        this.track = track;
    }
    execute() {
        removeTrackElements(this.track);
        const i = this.app.tracks.indexOf(this.track);
        if (i >= 0) this.app.tracks.splice(i, 1);
        reconcileRatsnest(this.app);
    }
    undo() {
        if (!this.app.tracks.includes(this.track)) this.app.tracks.push(this.track);
        renderTrack(this.track, (id) => this.app._getLayerGroup(id), _opts(this.app, this.track));
        reconcileRatsnest(this.app);
    }
}

/**
 * Change one or more scalar properties of a Track (e.g. width). Both
 * snapshots are plain {key: value} objects.
 */
export class ModifyTrackCommand {
    constructor(app, track, before, after) {
        this.app = app;
        this.track = track;
        this.before = { ...before };
        this.after = { ...after };
    }
    _apply(state) {
        Object.assign(this.track, state);
        renderTrack(this.track, (id) => this.app._getLayerGroup(id), _opts(this.app, this.track));
        reconcileRatsnest(this.app);
    }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}

/** Move a single Track node from (fromX, fromY) to (toX, toY). */
export class MoveVertexCommand {
    constructor(app, track, nodeId, fromX, fromY, toX, toY) {
        this.app = app;
        this.track = track;
        this.nodeId = nodeId;
        this.from = { x: fromX, y: fromY };
        this.to = { x: toX, y: toY };
    }
    _set(pt) {
        const n = this.track.nodes.get(this.nodeId);
        if (!n) return;
        n.x = pt.x;
        n.y = pt.y;
        renderTrack(this.track, (id) => this.app._getLayerGroup(id), _opts(this.app, this.track));
        reconcileRatsnest(this.app);
        refreshTrackSelectionHalo(this.app);
    }
    execute() { this._set(this.to); }
    undo() { this._set(this.from); }
}

/**
 * Replace a Track's entire graph (nodes, edges, layers, pad links) with
 * a captured snapshot. Used for edits that change topology — e.g. a
 * segment drag that pins a via and grows a bridging segment. `before`
 * and `after` are `track.captureState()` snapshots.
 */
export class ModifyTrackGraphCommand {
    constructor(app, track, before, after) {
        this.app = app;
        this.track = track;
        this.before = before;
        this.after = after;
    }
    _apply(state) {
        this.track.applyState(state);
        renderTrack(this.track, (id) => this.app._getLayerGroup(id), _opts(this.app, this.track));
        reconcileRatsnest(this.app);
        refreshTrackSelectionHalo(this.app);
    }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}

export class AddViaCommand {
    constructor(app, via) { this.app = app; this.via = via; }
    execute() {
        if (!this.app.vias.includes(this.via)) this.app.vias.push(this.via);
        renderVia(this.via, (id) => this.app._getLayerGroup(id));
        reconcileRatsnest(this.app);
    }
    undo() {
        removeViaElements(this.via);
        const i = this.app.vias.indexOf(this.via);
        if (i >= 0) this.app.vias.splice(i, 1);
        reconcileRatsnest(this.app);
    }
}

export class RemoveViaCommand {
    constructor(app, via) { this.app = app; this.via = via; }
    execute() {
        removeViaElements(this.via);
        const i = this.app.vias.indexOf(this.via);
        if (i >= 0) this.app.vias.splice(i, 1);
        reconcileRatsnest(this.app);
    }
    undo() {
        if (!this.app.vias.includes(this.via)) this.app.vias.push(this.via);
        renderVia(this.via, (id) => this.app._getLayerGroup(id));
        reconcileRatsnest(this.app);
    }
}

export class ModifyViaCommand {
    constructor(app, via, before, after) {
        this.app = app;
        this.via = via;
        this.before = { ...before };
        this.after = { ...after };
    }
    _apply(state) {
        Object.assign(this.via, state);
        renderVia(this.via, (id) => this.app._getLayerGroup(id));
        reconcileRatsnest(this.app);
    }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}

/** Move a standalone Via from (fromX, fromY) to (toX, toY). */
export class MoveViaCommand {
    constructor(app, via, fromX, fromY, toX, toY) {
        this.app = app;
        this.via = via;
        this.from = { x: fromX, y: fromY };
        this.to = { x: toX, y: toY };
    }
    _set(pt) {
        this.via.x = pt.x;
        this.via.y = pt.y;
        renderVia(this.via, (id) => this.app._getLayerGroup(id));
        refreshTrackSelectionHalo(this.app);
    }
    execute() { this._set(this.to); }
    undo() { this._set(this.from); }
}

export class MovePlacementCommand {
    constructor(app, compId, fromX, fromY, toX, toY) {
        this.app = app;
        this.compId = compId;
        this.from = { x: fromX, y: fromY };
        this.to = { x: toX, y: toY };
    }
    _apply(pt) {
        const pl = this.app.placements.get(this.compId);
        if (!pl) return;
        pl.x = pt.x;
        pl.y = pt.y;
        applyPlacementPose(this.app, this.compId);
        // Remember the new position so it survives schematic re-syncs / reload.
        this.app._recordPlacementOverride?.(this.compId);
        this.app._updateRatsnest?.();
        // Pads moved — recompute copper-pour clearances around them.
        this.app._refreshFills?.();
        this.app._board3d?.refresh?.();
    }
    execute() { this._apply(this.to); }
    undo() { this._apply(this.from); }
}

/**
 * Rotate a placement about its origin to an absolute angle (degrees).
 * Re-orients the footprint SVG, re-glues pad-bonded tracks, persists the
 * pose override, reconciles the ratsnest and refreshes any open 3D view.
 */
export class RotatePlacementCommand {
    constructor(app, compId, fromDeg, toDeg) {
        this.app = app;
        this.compId = compId;
        this.from = ((fromDeg % 360) + 360) % 360;
        this.to = ((toDeg % 360) + 360) % 360;
    }
    _apply(deg) {
        const pl = this.app.placements.get(this.compId);
        if (!pl) return;
        pl.rotation = deg;
        applyPlacementPose(this.app, this.compId);
        this.app._recordPlacementOverride?.(this.compId);
        this.app._updateRatsnest?.();
        // Pads rotated — recompute copper-pour clearances around them.
        this.app._refreshFills?.();
        this.app._board3d?.refresh?.();
    }
    execute() { this._apply(this.to); }
    undo() { this._apply(this.from); }
}

/**
 * Flip a placement horizontally or vertically. Mirrors the schematic editor's
 * model: a flip toggles the `mirror` flag and adjusts the rotation so the net
 * visual is a pure mirror across the chosen world axis (H = vertical axis,
 * V = horizontal axis), regardless of current orientation.
 */
export class FlipPlacementCommand {
    constructor(app, compId, axis) {
        this.app = app;
        this.compId = compId;
        const pl = app.placements?.get(compId);
        const rot = ((pl?.rotation || 0) % 360 + 360) % 360;
        const mir = !!pl?.mirror;
        this.before = { rotation: rot, mirror: mir };
        const nextRot = axis === 'V'
            ? (180 - rot + 360) % 360
            : (360 - rot) % 360;
        this.after = { rotation: nextRot, mirror: !mir };
    }
    _apply(state) {
        const pl = this.app.placements.get(this.compId);
        if (!pl) return;
        pl.rotation = state.rotation;
        pl.mirror = state.mirror;
        applyPlacementPose(this.app, this.compId);
        this.app._recordPlacementOverride?.(this.compId);
        this.app._updateRatsnest?.();
        // Pads mirrored — recompute copper-pour clearances around them.
        this.app._refreshFills?.();
        this.app._board3d?.refresh?.();
    }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
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
export class SetPlacementRefVisibleCommand {
    constructor(app, compId, visible) {
        this.app = app;
        this.compId = compId;
        const pl = app.placements?.get(compId);
        this.before = pl?.refVisible !== false;
        this.after = visible !== false;
    }
    _apply(v) {
        if (!this.app.placements?.get(this.compId)) return;
        applyPlacementRefVisible(this.app, this.compId, v);
        this.app._recordPlacementOverride?.(this.compId);
        this.app._board3d?.refresh?.();
    }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}

/**
 * Move a placement's reference designator relative to its footprint. The
 * offset (`refDx`, `refDy`) is stored in the footprint's authored-local frame
 * — the same frame as the pad offsets — so it survives rotation, mirroring and
 * side changes of the parent placement.
 */
export class MoveRefTextCommand {
    constructor(app, compId, fromDx, fromDy, toDx, toDy) {
        this.app = app;
        this.compId = compId;
        this.from = { dx: fromDx, dy: fromDy };
        this.to = { dx: toDx, dy: toDy };
    }
    _apply(s) {
        const pl = this.app.placements.get(this.compId);
        if (!pl) return;
        pl.refDx = s.dx;
        pl.refDy = s.dy;
        applyPlacementPose(this.app, this.compId);
        this.app._recordPlacementOverride?.(this.compId);
        this.app._drawRefOverlay?.(this.compId, false);
        this.app._board3d?.refresh?.();
    }
    execute() { this._apply(this.to); }
    undo() { this._apply(this.from); }
}

/**
 * Rotate a placement's reference designator about its own centre to an
 * absolute angle (degrees), independent of the footprint's rotation.
 */
export class RotateRefTextCommand {
    constructor(app, compId, fromDeg, toDeg) {
        this.app = app;
        this.compId = compId;
        this.from = ((fromDeg % 360) + 360) % 360;
        this.to = ((toDeg % 360) + 360) % 360;
    }
    _apply(deg) {
        const pl = this.app.placements.get(this.compId);
        if (!pl) return;
        pl.refRot = deg;
        applyPlacementPose(this.app, this.compId);
        this.app._recordPlacementOverride?.(this.compId);
        this.app._drawRefOverlay?.(this.compId, false);
        this.app._board3d?.refresh?.();
    }
    execute() { this._apply(this.to); }
    undo() { this._apply(this.from); }
}

/**
 * Change a reference designator's silk text size and/or line width. The glyph
 * geometry is regenerated by the app (which also re-applies the placement
 * pose), then the override is persisted and any open 3D view refreshed.
 */
export class SetRefStyleCommand {
    constructor(app, compId, before, after) {
        this.app = app;
        this.compId = compId;
        this.before = { ...before };
        this.after = { ...after };
    }
    _apply(state) {
        const pl = this.app.placements.get(this.compId);
        if (!pl) return;
        if (state.refSize !== undefined) pl.refSize = state.refSize;
        if (state.refStrokeWidth !== undefined) pl.refStrokeWidth = state.refStrokeWidth;
        if (state.refRot !== undefined) pl.refRot = state.refRot;
        this.app._rerenderRef?.(this.compId);
        this.app._recordPlacementOverride?.(this.compId);
        this.app._drawRefOverlay?.(this.compId, false);
        this.app._board3d?.refresh?.();
    }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}
const FP_LAYER_FLIP = {
    'top-copper': 'bottom-copper', 'bottom-copper': 'top-copper',
    'top-pad-numbers': 'bottom-pad-numbers', 'bottom-pad-numbers': 'top-pad-numbers',
    'top-silk': 'bottom-silk', 'bottom-silk': 'top-silk',
    'top-paste': 'bottom-paste', 'bottom-paste': 'top-paste',
    'top-mask': 'bottom-mask', 'bottom-mask': 'top-mask',
};
const flipShortLayer = (l) => (l === 'top' ? 'bottom' : l === 'bottom' ? 'top' : l);

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
    const padLayer = new Map();
    for (const off of (pl.padOffsets || [])) padLayer.set(String(off.number), off.layer);
    const touched = new Set();
    for (const track of (app.tracks || [])) {
        if (!track.padConnections?.size) continue;
        for (const [nid, conn] of [...track.padConnections]) {
            if (!conn || conn.componentId !== compId) continue;
            const short = padLayer.get(String(conn.pinNumber));
            if (short === 'both') continue; // through-hole reaches every layer
            const copper = short === 'bottom' ? 'bottom-copper' : 'top-copper';
            const incident = track.incidentEdges(nid);
            const compatible = incident.length
                ? incident.some((e) => track.getEdgeLayer(e.edgeId) === copper)
                : track.layer === copper;
            if (!compatible) {
                track.padConnections.delete(nid);
                touched.add(track);
            }
        }
    }
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
    const flip = side === 'bottom';
    pl.side = flip ? 'bottom' : 'top';
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
    for (const off of (pl.padOffsets || [])) {
        if (off._baseLayer === undefined) off._baseLayer = off.layer;
        off.layer = flip ? flipShortLayer(off._baseLayer) : off._baseLayer;
    }
    for (const off of (pl.pasteOffsets || [])) {
        if (off._baseSide === undefined) off._baseSide = off.side;
        off.side = flip ? flipShortLayer(off._baseSide) : off._baseSide;
    }
    // SMD pads have just changed copper layer — drop any track bonds that no
    // longer share a layer with their pad so the trace stops sticking.
    disconnectIncompatiblePadNodes(app, compId);
}

/**
 * Place a component on the top or bottom copper side. Reparents its artwork to
 * the matching layers, mirrors the footprint, re-glues pad-bonded tracks,
 * persists the override, reconciles the ratsnest and refreshes any 3D view.
 */
export class SetPlacementSideCommand {
    constructor(app, compId, side) {
        this.app = app;
        this.compId = compId;
        const pl = app.placements?.get(compId);
        this.before = pl?.side === 'bottom' ? 'bottom' : 'top';
        this.after = side === 'bottom' ? 'bottom' : 'top';
        this._bonds = null;
    }
    _snapshotBonds() {
        // Capture every track's pad bonds so undo can restore the ones that
        // applyPlacementSide drops when single-sided pads change layer.
        const snap = new Map();
        for (const track of (this.app.tracks || [])) {
            if (!track.padConnections?.size) continue;
            const m = new Map();
            for (const [nid, conn] of track.padConnections) m.set(nid, { ...conn });
            snap.set(track, m);
        }
        return snap;
    }
    _restoreBonds(snap) {
        if (!snap) return;
        for (const [track, m] of snap) {
            track.padConnections.clear();
            for (const [nid, conn] of m) track.padConnections.set(nid, { ...conn });
        }
    }
    _apply(side) {
        if (!this.app.placements?.get(this.compId)) return;
        applyPlacementSide(this.app, this.compId, side);
        applyPlacementPose(this.app, this.compId);
        this.app._recordPlacementOverride?.(this.compId);
        this.app._updateRatsnest?.();
        // Pads changed side — recompute copper-pour clearances around them.
        this.app._refreshFills?.();
        this.app._board3d?.refresh?.();
    }
    execute() {
        this._bonds = this._snapshotBonds();
        this._apply(this.after);
    }
    undo() {
        this._restoreBonds(this._bonds);
        this._apply(this.before);
    }
}

export class SetBoardOutlineCommand {
    constructor(app, before, after) {
        this.app = app;
        this.before = { ...before };
        this.after = { ...after };
    }
    _apply(s) {
        this.app._boardWidth = s.width;
        this.app._boardHeight = s.height;
        this.app._boardRadius = s.radius;
        this.app._drawBoardOutline?.();
    }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}

/**
 * Group N commands into one atomic history entry. execute() runs them
 * in order; undo() runs them in reverse. Useful for compound gestures
 * (e.g. dragging a via that also moves connected track endpoints).
 */
export class CompoundCommand {
    constructor(commands) {
        this.commands = Array.isArray(commands) ? commands.slice() : [];
    }
    execute() {
        for (const c of this.commands) c.execute();
    }
    undo() {
        for (let i = this.commands.length - 1; i >= 0; i--) this.commands[i].undo();
    }
}

