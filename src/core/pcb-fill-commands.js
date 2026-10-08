import { editTargets } from './edit-guard.js';
/** @typedef {import('./PcbDocument.js').PcbDocument} PcbDocument */
/** @typedef {import('../shapes/copper-fill.js').CopperFill} CopperFill */
/** @typedef {ReturnType<CopperFill['captureState']>} FillState */

/** @param {PcbDocument} document @returns {Array<import('./pcb-board-shapes.js').BoardShape|CopperFill>} */
const fillShapeList = document => /** @type {Array<import('./pcb-board-shapes.js').BoardShape|CopperFill>} */ (/** @type {unknown} */ (document.boardShapes));

export class AddFillCommand {
    /** @param {PcbDocument} document @param {CopperFill} fill */
    constructor(document, fill) { this.document = document; this.fill = fill; }
    lockTargets() { return []; }
    execute() {
        const shapes = fillShapeList(this.document);
        if (!shapes.includes(this.fill)) shapes.push(this.fill);
    }
    undo() {
        const shapes = fillShapeList(this.document);
        const index = shapes.indexOf(this.fill);
        if (index >= 0) shapes.splice(index, 1);
    }
}

export class RemoveFillCommand {
    /** @param {PcbDocument} document @param {CopperFill} fill */
    constructor(document, fill) { this.document = document; this.fill = fill; }
    lockTargets() { return [{ kind: 'fill', object: this.fill }]; }
    execute() {
        const shapes = fillShapeList(this.document);
        const index = shapes.indexOf(this.fill);
        if (index >= 0) shapes.splice(index, 1);
    }
    undo() {
        const shapes = fillShapeList(this.document);
        if (!shapes.includes(this.fill)) shapes.push(this.fill);
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
