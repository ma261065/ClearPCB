import { editTargets } from './edit-guard.js';
/** @typedef {import('./PcbDocument.js').PcbDocument} PcbDocument */
/** @typedef {import('../shapes/pad.js').Pad} Pad */

export class AddPadCommand {
    /** @param {PcbDocument} document @param {Pad} pad */
    constructor(document, pad) { this.document = document; this.pad = pad; }
    lockTargets() { return []; }
    execute() {
        if (!this.document.pads.includes(this.pad)) this.document.pads.push(this.pad);
    }
    undo() {
        const index = this.document.pads.indexOf(this.pad);
        if (index >= 0) this.document.pads.splice(index, 1);
    }
}

export class RemovePadCommand {
    /** @param {PcbDocument} document @param {Pad} pad */
    constructor(document, pad) { this.document = document; this.pad = pad; }
    lockTargets() { return [{ kind: 'pad', object: this.pad }]; }
    execute() {
        const index = this.document.pads.indexOf(this.pad);
        if (index >= 0) this.document.pads.splice(index, 1);
    }
    undo() {
        if (!this.document.pads.includes(this.pad)) this.document.pads.push(this.pad);
    }
}

export class ModifyPadCommand {
    /** @param {Pad} pad */
    constructor(pad, before, after) {
        this.pad = pad; this.before = { ...before }; this.after = { ...after };
    }
    _apply(state) { this.pad.applyState(state); }
    lockTargets() { return editTargets('pad', this.pad, this.before, this.after); }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}

export class MovePadCommand {
    /** @param {Pad} pad */
    constructor(pad, from, to) {
        this.pad = pad;
        this.from = { x: from.x, y: from.y };
        this.to = { x: to.x, y: to.y };
    }
    _apply(point) {
        this.pad.x = point.x;
        this.pad.y = point.y;
    }
    lockTargets() { return [{ kind: 'pad', object: this.pad }]; }
    execute() { this._apply(this.to); }
    undo() { this._apply(this.from); }
}
