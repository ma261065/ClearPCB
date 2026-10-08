import { editTargets } from './edit-guard.js';
import { applyShapeGeometry, applyShapeSnapshot } from './pcb-board-shapes.js';
import { validBoardOutline } from '../shared/pcb/board-outline.js';

/** @typedef {import('./PcbDocument.js').PcbDocument} PcbDocument */
/** @typedef {import('./pcb-board-shapes.js').BoardShapeData} BoardShape */
/** @typedef {Partial<import('./pcb-board-shapes.js').BoardShapeData> & Record<string, any>} BoardShapeState */

/** @param {PcbDocument} document @param {BoardShape} shape @param {BoardShapeState} state @param {(shape: BoardShape, state: BoardShapeState) => void} apply */
function applyEdit(document, shape, state, apply) {
    if (shape.layer === 'board-outline') {
        const candidate = { ...shape };
        apply(candidate, state);
        if (!validBoardOutline(candidate)) return false;
    }
    apply(shape, state);
    if (shape.layer === 'board-outline') document.syncBoardOutlineDimensions();
    return true;
}

/** @param {BoardShapeState} state */
function copySnapshot(state) {
    // Artwork is shared read-only; history owns the editable frame and properties.
    const { artwork, ...snapshot } = state;
    return { ...structuredClone(snapshot), ...(artwork ? { artwork } : {}) };
}

export class AddBoardShapeCommand {
    /** @param {PcbDocument} document @param {any} shape */
    constructor(document, shape) {
        this.document = document;
        this.shape = shape;
    }

    lockTargets() { return []; }
    execute() {
        if (this.shape.layer === 'board-outline') return;
        if (!this.document.boardShapes.includes(this.shape)) this.document.boardShapes.push(this.shape);
        const number = /pshape_(\d+)/.exec(this.shape.id);
        if (number) this.document.shapeIdCounter = Math.max(this.document.shapeIdCounter, Number(number[1]) + 1);
    }

    undo() {
        if (this.shape.layer === 'board-outline') return;
        const index = this.document.boardShapes.indexOf(this.shape);
        if (index >= 0) this.document.boardShapes.splice(index, 1);
    }
}

export class RemoveBoardShapeCommand {
    /** @param {PcbDocument} document @param {any} shape */
    constructor(document, shape) {
        this.document = document;
        this.shape = shape;
    }

    lockTargets() { return [{ kind: 'shape', object: this.shape }]; }
    execute() {
        if (this.shape.layer === 'board-outline') return;
        const index = this.document.boardShapes.indexOf(this.shape);
        if (index >= 0) this.document.boardShapes.splice(index, 1);
    }

    undo() {
        if (this.shape.layer === 'board-outline') return;
        if (!this.document.boardShapes.includes(this.shape)) this.document.boardShapes.push(this.shape);
    }
}

export class MoveBoardShapeCommand {
    /** @param {PcbDocument} document @param {any} shape @param {BoardShapeState} before @param {BoardShapeState} after */
    constructor(document, shape, before, after) {
        this.document = document;
        this.shape = shape;
        this.before = structuredClone(before);
        this.after = structuredClone(after);
    }

    /** @param {any} geometry */
    _apply(geometry) { return applyEdit(this.document, this.shape, geometry, applyShapeGeometry); }
    lockTargets() { return [{ kind: 'shape', object: this.shape }]; }
    execute() { return this._apply(this.after); }
    undo() { return this._apply(this.before); }
}

export class ModifyBoardShapeCommand {
    /** @param {PcbDocument} document @param {any} shape @param {BoardShapeState} before @param {BoardShapeState} after */
    constructor(document, shape, before, after) {
        this.document = document;
        this.shape = shape;
        this.before = copySnapshot(before);
        this.after = copySnapshot(after);
    }

    /** @param {any} state */
    _apply(state) { return applyEdit(this.document, this.shape, state, applyShapeSnapshot); }
    lockTargets() { return editTargets('shape', this.shape, this.before, this.after); }
    execute() { return this._apply(this.after); }
    undo() { return this._apply(this.before); }
}
