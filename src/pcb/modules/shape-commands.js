/**
 * Undoable commands for free-standing PCB board shapes (rectangle, polygon, arc).
 *
 * Operates on the generic `app.boardShapes` array. Geometry-specific behaviour
 * lives in board-shapes.js; these commands only push/splice the shape and
 * trigger re-render + fill refresh so history is the single source of truth.
 */

import {
    renderBoardShape,
    removeBoardShapeElement,
    applyShapeGeometry,
    applyShapeSnapshot,
    refreshBoardShapeProperties,
} from './board-shapes.js';

export class AddBoardShapeCommand {
    constructor(app, shape) {
        this.app = app;
        this.shape = shape;
    }

    execute() {
        if (!this.app.boardShapes.includes(this.shape)) this.app.boardShapes.push(this.shape);
        renderBoardShape(this.app, this.shape);
        this.app._refreshFills?.();
        this.app._board3d?.refresh?.();
    }

    undo() {
        removeBoardShapeElement(this.app, this.shape.id);
        const i = this.app.boardShapes.indexOf(this.shape);
        if (i >= 0) this.app.boardShapes.splice(i, 1);
        this.app._updateCopperCuts?.();
        this.app._refreshFills?.();
        this.app._board3d?.refresh?.();
    }
}

export class RemoveBoardShapeCommand {
    constructor(app, shape) {
        this.app = app;
        this.shape = shape;
    }

    execute() {
        removeBoardShapeElement(this.app, this.shape.id);
        const i = this.app.boardShapes.indexOf(this.shape);
        if (i >= 0) this.app.boardShapes.splice(i, 1);
        this.app._updateCopperCuts?.();
        this.app._refreshFills?.();
        this.app._board3d?.refresh?.();
    }

    undo() {
        if (!this.app.boardShapes.includes(this.shape)) this.app.boardShapes.push(this.shape);
        renderBoardShape(this.app, this.shape);
        this.app._refreshFills?.();
        this.app._board3d?.refresh?.();
    }
}

export class MoveBoardShapeCommand {
    constructor(app, shape, before, after) {
        this.app = app;
        this.shape = shape;
        this.before = before;
        this.after = after;
    }

    execute() {
        applyShapeGeometry(this.shape, this.after);
        renderBoardShape(this.app, this.shape);
        this.app._refreshFills?.();
        this.app._board3d?.refresh?.();
    }

    undo() {
        applyShapeGeometry(this.shape, this.before);
        renderBoardShape(this.app, this.shape);
        this.app._refreshFills?.();
        this.app._board3d?.refresh?.();
    }
}

export class ModifyBoardShapeCommand {
    constructor(app, shape, before, after) {
        this.app = app;
        this.shape = shape;
        this.before = before;
        this.after = after;
    }

    _apply(state) {
        applyShapeSnapshot(this.shape, state);
        renderBoardShape(this.app, this.shape);
        this.app._refreshFills?.();
        this.app._board3d?.refresh?.();
        refreshBoardShapeProperties(this.app, this.shape);
    }

    execute() {
        this._apply(this.after);
    }

    undo() {
        this._apply(this.before);
    }
}
