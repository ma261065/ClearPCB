import { applyShapeGeometry, applyShapeSnapshot } from './pcb-board-shapes.js';
import { validBoardOutline } from '../shared/pcb/board-outline.js';

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

function copySnapshot(state) {
    // Artwork is shared read-only; history owns the editable frame and properties.
    const { artwork, ...snapshot } = state;
    return { ...structuredClone(snapshot), ...(artwork ? { artwork } : {}) };
}

export class AddBoardShapeCommand {
    /** @param {import('./PcbDocument.js').PcbDocument} document */
    constructor(document, shape) {
        this.document = document;
        this.shape = shape;
    }

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
    /** @param {import('./PcbDocument.js').PcbDocument} document */
    constructor(document, shape) {
        this.document = document;
        this.shape = shape;
    }

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
    /** @param {import('./PcbDocument.js').PcbDocument} document */
    constructor(document, shape, before, after) {
        this.document = document;
        this.shape = shape;
        this.before = structuredClone(before);
        this.after = structuredClone(after);
    }

    _apply(geometry) { return applyEdit(this.document, this.shape, geometry, applyShapeGeometry); }
    execute() { return this._apply(this.after); }
    undo() { return this._apply(this.before); }
}

export class ModifyBoardShapeCommand {
    /** @param {import('./PcbDocument.js').PcbDocument} document */
    constructor(document, shape, before, after) {
        this.document = document;
        this.shape = shape;
        this.before = copySnapshot(before);
        this.after = copySnapshot(after);
    }

    _apply(state) { return applyEdit(this.document, this.shape, state, applyShapeSnapshot); }
    execute() { return this._apply(this.after); }
    undo() { return this._apply(this.before); }
}
