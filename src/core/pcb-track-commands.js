/** @typedef {import('./PcbDocument.js').PcbDocument} PcbDocument */
/** @typedef {import('../shapes/track.js').Track} Track */
/** @typedef {import('../shapes/via.js').Via} Via */

export class AddTrackCommand {
    /** @param {PcbDocument} document @param {Track} track @param {Via[]} [vias] */
    constructor(document, track, vias = []) {
        this.document = document;
        this.track = track;
        this.vias = Array.isArray(vias) ? vias.slice() : [];
    }
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
    execute() {
        const index = this.document.tracks.indexOf(this.track);
        if (index >= 0) this.document.tracks.splice(index, 1);
    }
    undo() {
        if (!this.document.tracks.includes(this.track)) this.document.tracks.push(this.track);
    }
}

export class ModifyTrackCommand {
    /** @param {Track} track */
    constructor(track, before, after) {
        this.track = track;
        this.before = { ...before };
        this.after = { ...after };
    }
    _apply(state) {
        Object.assign(this.track, state);
        this.track.invalidate();
    }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}

export class MoveVertexCommand {
    /** @param {Track} track */
    constructor(track, nodeId, fromX, fromY, toX, toY) {
        this.track = track;
        this.nodeId = nodeId;
        this.from = { x: fromX, y: fromY };
        this.to = { x: toX, y: toY };
    }
    _set(point) {
        const node = this.track.nodes.get(this.nodeId);
        if (!node) throw new Error(`PCB track node is no longer available: ${this.track.id}/${this.nodeId}`);
        node.x = point.x;
        node.y = point.y;
        this.track.invalidate();
    }
    execute() { this._set(this.to); }
    undo() { this._set(this.from); }
}

export class ModifyTrackGraphCommand {
    /** @param {Track} track */
    constructor(track, before, after) {
        this.track = track;
        this.before = structuredClone(before);
        this.after = structuredClone(after);
    }
    _apply(state) { this.track.applyState(state); }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}
