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
    }
    execute() { this._set(this.to); }
    undo() { this._set(this.from); }
}

/**
 * Move a component placement from (fromX, fromY) to (toX, toY).
 * Mirrors the work done by PCBApp._handleDrag/_endDrag: transforms the
 * SVG group(s), updates pad world positions, and rebuilds the ratsnest.
 */
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
        for (const el of (pl.elements || [])) {
            el.setAttribute('transform', `translate(${pt.x}, ${pt.y})`);
        }
        if (pl.lodEl) pl.lodEl.setAttribute('transform', `translate(${pt.x}, ${pt.y})`);
        const halo = this.app._padHaloGroups?.get(this.compId);
        if (halo) halo.setAttribute('transform', `translate(${pt.x}, ${pt.y})`);
        for (const off of (pl.padOffsets || [])) {
            pl.pads.set(off.padId, { x: pt.x + off.dx, y: pt.y + off.dy, number: off.number });
        }
        // Keep pad-bonded track endpoints glued to the component.
        repositionPadConnectedNodes(this.app, this.compId);
        // Remember the new position so it survives schematic re-syncs / reload.
        this.app._recordPlacementOverride?.(this.compId);
        this.app._updateRatsnest?.();
    }
    execute() { this._apply(this.to); }
    undo() { this._apply(this.from); }
}

/**
 * Change the board outline (width / height / corner radius).
 * Both snapshots are plain {width, height, radius} objects.
 */
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

