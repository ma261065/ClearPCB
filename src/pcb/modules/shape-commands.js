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
    renderBoardShapeSegmentSelection,
} from './board-shapes.js';
import { renderPcbSelectionAnchors } from './selection-anchors.js';
import { getPcbSelectionEntries, setPcbSelection } from './selection-registry.js';
import { cancelPictureCopperRefresh, schedulePictureCopperRefresh } from './picture-refresh.js';
import { validBoardOutline } from './board-outline.js';

function deselectRemovedShape(app, shape) {
    const selected = getPcbSelectionEntries(app);
    const remaining = selected.filter((entry) => entry.kind !== 'shape' || entry.object.id !== shape.id);
    if (remaining.length === selected.length) return;
    setPcbSelection(app, remaining);
    renderPcbSelectionAnchors(app);
}

export class AddBoardShapeCommand {
    constructor(app, shape) {
        this.app = app;
        this.shape = shape;
    }

    execute() {
        if (this.shape.layer === 'board-outline') return;
        if (!this.app.boardShapes.includes(this.shape)) this.app.boardShapes.push(this.shape);
        renderBoardShape(this.app, this.shape);
        this.app._refreshFills?.();
        this.app._updateRatsnest?.();
        this.app._board3d?.refresh?.();
    }

    undo() {
        if (this.shape.layer === 'board-outline') return;
        deselectRemovedShape(this.app, this.shape);
        removeBoardShapeElement(this.app, this.shape.id);
        const i = this.app.boardShapes.indexOf(this.shape);
        if (i >= 0) this.app.boardShapes.splice(i, 1);
        this.app._updateCopperCuts?.();
        this.app._refreshFills?.();
        this.app._updateRatsnest?.();
        this.app._board3d?.refresh?.();
    }
}

export class RemoveBoardShapeCommand {
    constructor(app, shape) {
        this.app = app;
        this.shape = shape;
    }

    execute() {
        if (this.shape.layer === 'board-outline') return;
        deselectRemovedShape(this.app, this.shape);
        removeBoardShapeElement(this.app, this.shape.id);
        const i = this.app.boardShapes.indexOf(this.shape);
        if (i >= 0) this.app.boardShapes.splice(i, 1);
        this.app._updateCopperCuts?.();
        this.app._refreshFills?.();
        this.app._updateRatsnest?.();
        this.app._board3d?.refresh?.();
    }

    undo() {
        if (this.shape.layer === 'board-outline') return;
        if (!this.app.boardShapes.includes(this.shape)) this.app.boardShapes.push(this.shape);
        renderBoardShape(this.app, this.shape);
        this.app._refreshFills?.();
        this.app._updateRatsnest?.();
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

    _apply(geometry) {
        const previous = this.shape.layer === 'board-outline' ? structuredClone(this.shape) : null;
        applyShapeGeometry(this.shape, geometry);
        if (previous && !validBoardOutline(this.shape)) Object.assign(this.shape, previous);
        schedulePictureCopperRefresh(this.app);
        renderBoardShape(this.app, this.shape);
        if (this.shape.layer === 'board-outline' || this.shape.kind === 'circle' || this.shape.kind === 'image') refreshBoardShapeProperties(this.app, this.shape);
        renderBoardShapeSegmentSelection(this.app);
        renderPcbSelectionAnchors(this.app);
    }

    execute() {
        this._apply(this.after);
    }

    undo() {
        this._apply(this.before);
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
        const previous = this.shape.layer === 'board-outline' ? structuredClone(this.shape) : null;
        const affectsCopper = this.shape.kind !== 'image'
            || this.shape.layer.endsWith('copper') || state.layer.endsWith('copper');
        const geometryEdit = this.shape.layer === state.layer && (this.shape.net || '') === (state.net || '');
        if (affectsCopper && !geometryEdit) cancelPictureCopperRefresh(this.app);
        applyShapeSnapshot(this.shape, state);
        if (previous && !validBoardOutline(this.shape)) Object.assign(this.shape, previous);
        if (affectsCopper && geometryEdit) schedulePictureCopperRefresh(this.app, this.shape);
        renderBoardShape(this.app, this.shape, {
            skipCopperUpdate: !affectsCopper,
            liveDrag: !affectsCopper || geometryEdit,
        });
        if (affectsCopper) {
            if (!geometryEdit) {
                this.app._refreshFills?.();
                this.app._updateRatsnest?.();
            }
        }
        this.app._board3d?.refresh?.();
        refreshBoardShapeProperties(this.app, this.shape);
        renderBoardShapeSegmentSelection(this.app);
        renderPcbSelectionAnchors(this.app);
    }

    execute() {
        this._apply(this.after);
    }

    undo() {
        this._apply(this.before);
    }
}
