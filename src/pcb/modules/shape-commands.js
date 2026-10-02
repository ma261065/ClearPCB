/**
 * Undoable commands for free-standing PCB board shapes (rectangle, polygon, arc).
 *
 * Editor adapters for the neutral board-shape commands in core.
 * Copper-mode changes refresh connectivity immediately rather than waiting
 * for the live-geometry edit debounce.
 */

import {
    renderBoardShape,
    removeBoardShapeElement,
    refreshBoardShapeProperties,
    renderBoardShapeSegmentSelection,
    canonicalBoardShape,
    getBoardShapeRotationPreview,
    getBoardShapePropertyPreview,
    finishBoardShapeRotationPreview,
    endBoardShapeDrag,
} from './board-shapes.js';
import { renderPcbSelectionAnchors } from './selection-anchors.js';
import { getPcbSelectionEntries, setPcbSelection } from './selection-registry.js';
import { finishSelectionInteraction } from './selection-interaction.js';
import { cancelPictureCopperRefresh, schedulePictureCopperRefresh } from './picture-refresh.js';
import { normalizeShapeCopperMode } from './board-shape-geometry.js';
import { getPropertyEditor } from './property-editors.js';
import {
    AddBoardShapeCommand as ModelAddBoardShapeCommand,
    RemoveBoardShapeCommand as ModelRemoveBoardShapeCommand,
    MoveBoardShapeCommand as ModelMoveBoardShapeCommand,
    ModifyBoardShapeCommand as ModelModifyBoardShapeCommand,
} from '../../core/pcb-shape-commands.js';

function deselectRemovedShape(app, shape) {
    const selected = getPcbSelectionEntries(app);
    const remaining = selected.filter((entry) => entry.kind !== 'shape' || entry.object.id !== shape.id);
    if (remaining.length === selected.length) return;
    setPcbSelection(app, remaining);
    renderPcbSelectionAnchors(app);
}

export class AddBoardShapeCommand extends ModelAddBoardShapeCommand {
    constructor(app, shape) {
        super(app.pcbDocument, shape);
        this.app = app;
    }

    execute() {
        if (this.shape.layer === 'board-outline') return;
        super.execute();
        renderBoardShape(this.app, this.shape);
        this.app.refreshFills?.();
        this.app.updateRatsnest?.();
        this.app._board3d?.refresh?.();
    }

    undo() {
        if (this.shape.layer === 'board-outline') return;
        deselectRemovedShape(this.app, this.shape);
        removeBoardShapeElement(this.app, this.shape.id);
        super.undo();
        this.app.updateCopperCuts?.();
        this.app.refreshFills?.();
        this.app.updateRatsnest?.();
        this.app._board3d?.refresh?.();
    }
}

export class RemoveBoardShapeCommand extends ModelRemoveBoardShapeCommand {
    constructor(app, shape) {
        super(app.pcbDocument, canonicalBoardShape(app, shape));
        this.app = app;
    }

    execute() {
        if (this.shape.layer === 'board-outline') return;
        if (getBoardShapePropertyPreview(this.app)?.originals.includes(this.shape)) getPropertyEditor(this.app, 'boardShape').cancel();
        if (getBoardShapeRotationPreview(this.app)?.original === this.shape) {
            if (!finishSelectionInteraction(this.app, false)) finishBoardShapeRotationPreview(this.app);
        }
        if (this.app._shapeDrag?.original === this.shape) endBoardShapeDrag(this.app, false);
        deselectRemovedShape(this.app, this.shape);
        removeBoardShapeElement(this.app, this.shape.id);
        super.execute();
        this.app.updateCopperCuts?.();
        this.app.refreshFills?.();
        this.app.updateRatsnest?.();
        this.app._board3d?.refresh?.();
    }

    undo() {
        if (this.shape.layer === 'board-outline') return;
        super.undo();
        renderBoardShape(this.app, this.shape);
        this.app.refreshFills?.();
        this.app.updateRatsnest?.();
        this.app._board3d?.refresh?.();
    }
}

export class MoveBoardShapeCommand extends ModelMoveBoardShapeCommand {
    constructor(app, shape, before, after) {
        super(app.pcbDocument, canonicalBoardShape(app, shape), before, after);
        this.app = app;
    }

    _apply(geometry) {
        if (getBoardShapePropertyPreview(this.app)?.originals.includes(this.shape)) getPropertyEditor(this.app, 'boardShape').cancel();
        if (this.app._shapeDrag?.original === this.shape) endBoardShapeDrag(this.app, false);
        const applied = super._apply(geometry);
        // Retain translated halos; only rebind clearance already invalidated by handle edits.
        schedulePictureCopperRefresh(this.app, this.app._pendingShapeClearances?.has(this.shape.id) ? this.shape : undefined);
        renderBoardShape(this.app, this.shape);
        refreshBoardShapeProperties(this.app, this.shape);
        renderBoardShapeSegmentSelection(this.app);
        renderPcbSelectionAnchors(this.app);
        return applied;
    }
}

export class ModifyBoardShapeCommand extends ModelModifyBoardShapeCommand {
    constructor(app, shape, before, after) {
        super(app.pcbDocument, canonicalBoardShape(app, shape), before, after);
        this.app = app;
    }

    _apply(state) {
        if (getBoardShapePropertyPreview(this.app)?.originals.includes(this.shape)) getPropertyEditor(this.app, 'boardShape').cancel();
        if (this.app._shapeDrag?.original === this.shape) endBoardShapeDrag(this.app, false);
        const affectsCopper = this.shape.kind !== 'image'
            || this.shape.layer.endsWith('copper') || state.layer.endsWith('copper');
        const geometryEdit = this.shape.layer === state.layer && (this.shape.net || '') === (state.net || '')
            && normalizeShapeCopperMode(this.shape.copperMode) === normalizeShapeCopperMode(state.copperMode);
        if (affectsCopper && !geometryEdit) cancelPictureCopperRefresh(this.app);
        const applied = super._apply(state);
        if (affectsCopper && geometryEdit) schedulePictureCopperRefresh(this.app, this.shape);
        renderBoardShape(this.app, this.shape, {
            skipCopperUpdate: !affectsCopper,
            liveDrag: !affectsCopper || geometryEdit,
        });
        if (affectsCopper) {
            if (!geometryEdit) {
                this.app.refreshFills?.();
                this.app.updateRatsnest?.();
            }
        }
        this.app._board3d?.refresh?.();
        refreshBoardShapeProperties(this.app, this.shape);
        renderBoardShapeSegmentSelection(this.app);
        renderPcbSelectionAnchors(this.app);
        return applied;
    }
}
