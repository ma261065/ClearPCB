import { editTargets } from './edit-guard.js';
import { applyShapeGeometry, applyShapeSnapshot } from './pcb-board-shapes.js';
import { validBoardOutline } from '../shared/pcb/board-outline.js';

/** @typedef {import('./PcbDocument.js').PcbDocument} PcbDocument */
/** @typedef {import('./pcb-board-shapes.js').BoardShape} BoardShape */
/** @typedef {import('./pcb-board-shapes.js').BoardShapeSnapshot|import('./pcb-board-shapes.js').BoardShapeGeometry} BoardShapeState */

/**
 * @template {BoardShapeState} T
 * @param {PcbDocument} document
 * @param {BoardShape} shape
 * @param {T} state
 * @param {(shape: BoardShape, state: T) => void} apply
 */
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
    const { artwork, ...snapshot } = /** @type {import('./pcb-board-shapes.js').BoardShapeSnapshot} */ (state);
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
    /** @param {PcbDocument} document @param {any} shape @param {import('./pcb-board-shapes.js').BoardShapeGeometry} before @param {import('./pcb-board-shapes.js').BoardShapeGeometry} after */
    constructor(document, shape, before, after) {
        this.document = document;
        this.shape = shape;
        this.before = structuredClone(before);
        this.after = structuredClone(after);
    }

    /** @param {import('./pcb-board-shapes.js').BoardShapeGeometry} geometry */
    _apply(geometry) { return applyEdit(this.document, this.shape, geometry, applyShapeGeometry); }
    lockTargets() { return [{ kind: 'shape', object: this.shape }]; }
    execute() { return this._apply(this.after); }
    undo() { return this._apply(this.before); }
}

export class ModifyBoardShapeCommand {
    /** @param {PcbDocument} document @param {any} shape @param {import('./pcb-board-shapes.js').BoardShapeSnapshot} before @param {import('./pcb-board-shapes.js').BoardShapeSnapshot} after */
    constructor(document, shape, before, after) {
        this.document = document;
        this.shape = shape;
        this.before = copySnapshot(before);
        this.after = copySnapshot(after);
    }

    /** @param {import('./pcb-board-shapes.js').BoardShapeSnapshot} state */
    _apply(state) { return applyEdit(this.document, this.shape, state, applyShapeSnapshot); }
    lockTargets() { return editTargets('shape', this.shape, this.before, this.after); }
    execute() { return this._apply(this.after); }
    undo() { return this._apply(this.before); }
}
