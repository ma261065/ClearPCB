import { editTargets } from './edit-guard.js';
/** @typedef {import('./PcbDocument.js').PcbDocument} PcbDocument */
/** @typedef {import('../shapes/track.js').Track} Track */
/** @typedef {import('../shapes/via.js').Via} Via */
/** @typedef {Record<string, any>} TrackState */
/** @typedef {{tracks: Track[], vias: Via[]}} RouteState */

export class AddTrackCommand {
    /** @param {PcbDocument} document @param {Track} track @param {Via[]} [vias] */
    constructor(document, track, vias = []) {
        this.document = document;
        this.track = track;
        this.vias = Array.isArray(vias) ? vias.slice() : [];
    }
    lockTargets() { return []; }
    execute() {
        if (!this.document.tracks.includes(this.track)) this.document.tracks.push(this.track);
        for (const via of this.vias) {
            if (!this.document.vias.includes(via)) this.document.vias.push(via);
        }
    }
    undo() {
        for (const via of this.vias) {
            const index = this.document.vias.indexOf(via);
            if (index >= 0) this.document.vias.splice(index, 1);
        }
        const index = this.document.tracks.indexOf(this.track);
        if (index >= 0) this.document.tracks.splice(index, 1);
    }
}

export class RemoveTrackCommand {
    /** @param {PcbDocument} document @param {Track} track */
    constructor(document, track) { this.document = document; this.track = track; }
    lockTargets() { return [{ kind: 'track', object: this.track }]; }
    execute() {
        const index = this.document.tracks.indexOf(this.track);
        if (index >= 0) this.document.tracks.splice(index, 1);
    }
    undo() {
        if (!this.document.tracks.includes(this.track)) this.document.tracks.push(this.track);
    }
}

export class ModifyTrackCommand {
    /** @param {Track} track @param {TrackState} before @param {TrackState} after */
    constructor(track, before, after) {
        this.track = track;
        this.before = { ...before };
        this.after = { ...after };
    }
    /** @param {TrackState} state */
    _apply(state) {
        Object.assign(this.track, state);
        this.track.invalidate();
    }
    lockTargets() { return editTargets('track', this.track, this.before, this.after); }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}

export class MoveVertexCommand {
    /** @param {Track} track @param {string} nodeId @param {number} fromX @param {number} fromY @param {number} toX @param {number} toY */
    constructor(track, nodeId, fromX, fromY, toX, toY) {
        this.track = track;
        this.nodeId = nodeId;
        this.from = { x: fromX, y: fromY };
        this.to = { x: toX, y: toY };
    }
    /** @param {{x:number,y:number}} point */
    _set(point) {
        const node = this.track.nodes.get(this.nodeId);
        if (!node) throw new Error(`PCB track node is no longer available: ${this.track.id}/${this.nodeId}`);
        node.x = point.x;
        node.y = point.y;
        this.track.invalidate();
    }
    lockTargets() { return [{ kind: 'track', object: this.track }]; }
    execute() { this._set(this.to); }
    undo() { this._set(this.from); }
}

export class ModifyTrackGraphCommand {
    /** @param {Track} track @param {TrackState} before @param {TrackState} after */
    constructor(track, before, after) {
        this.track = track;
        this.before = structuredClone(before);
        this.after = structuredClone(after);
    }
    /** @param {TrackState} state */
    _apply(state) { this.track.applyState(state); }
    lockTargets() { return editTargets('track', this.track, this.before, this.after); }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}

/** Replace routed copper as one reversible edit, preserving entity identities. */
export class ReplaceRoutesCommand {
    /** @param {PcbDocument} document @param {Track[]} tracks @param {Via[]} vias */
    constructor(document, tracks, vias) {
        this.document = document;
        this.before = { tracks: [...document.tracks], vias: [...document.vias] };
        this.after = { tracks: [...tracks], vias: [...vias] };
    }
    /** @param {RouteState} state */
    _apply(state) {
        this.document.tracks.splice(0, this.document.tracks.length, ...state.tracks);
        this.document.vias.splice(0, this.document.vias.length, ...state.vias);
    }
    /** Routing keeps locked copper; anything it would remove is a target. */
    lockTargets() {
        /** @param {Array<Track|Via>} before @param {Array<Track|Via>} after */
        const removed = (before, after) => before.filter(item => !after.includes(item));
        return [
            ...removed(this.before.tracks, this.after.tracks).map(object => ({ kind: 'track', object })),
            ...removed(this.before.vias, this.after.vias).map(object => ({ kind: 'via', object })),
        ];
    }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}
