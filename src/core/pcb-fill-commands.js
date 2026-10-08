import { editTargets } from './edit-guard.js';
/** @typedef {import('./PcbDocument.js').PcbDocument} PcbDocument */
/** @typedef {import('../shapes/copper-fill.js').CopperFill} CopperFill */
/** @typedef {Record<string, any>} FillState */

export class AddFillCommand {
    /** @param {PcbDocument} document @param {CopperFill} fill */
    constructor(document, fill) { this.document = document; this.fill = fill; }
    lockTargets() { return []; }
    execute() {
        if (!this.document.boardShapes.includes(this.fill)) this.document.boardShapes.push(this.fill);
    }
    undo() {
        const index = this.document.boardShapes.indexOf(this.fill);
        if (index >= 0) this.document.boardShapes.splice(index, 1);
    }
}

export class RemoveFillCommand {
    /** @param {PcbDocument} document @param {CopperFill} fill */
    constructor(document, fill) { this.document = document; this.fill = fill; }
    lockTargets() { return [{ kind: 'fill', object: this.fill }]; }
    execute() {
        const index = this.document.boardShapes.indexOf(this.fill);
        if (index >= 0) this.document.boardShapes.splice(index, 1);
    }
    undo() {
        if (!this.document.boardShapes.includes(this.fill)) this.document.boardShapes.push(this.fill);
    }
}

export class ModifyFillCommand {
    /** @param {CopperFill} fill @param {FillState} before @param {FillState} after */
    constructor(fill, before, after) {
        this.fill = fill;
        this.before = structuredClone(before);
        this.after = structuredClone(after);
    }
    /** @param {FillState} state */
    _apply(state) { this.fill.applyState(state); }
    lockTargets() { return editTargets('fill', this.fill, this.before, this.after); }
    execute() { this._apply(this.after); }
    undo() { this._apply(this.before); }
}
