import { cancelPcbPosePreviews, cancelPcbPropertyPreview, hasPcbInteractionInProgress } from './edit-lifecycle.js';
import { finishSelectionInteraction, clearSelectionInteractionUi, showPcbSelectionProperties } from './selection-interaction.js';
import { beginGroupDrag, updateGroupDrag, endGroupDrag, cancelGroupDrag, clearBoxSelection, hasBoxSelection, deleteBoxSelection } from './box-select.js';
import { getBoardDimensionPreview, endBoardOutlineResize, finishBoardDimensionPreview } from './board-outline-resize.js';
import { getBoardShapeRotationPreview, finishBoardShapeRotationPreview, endBoardShapeDrag, deleteFocusedBoardShape } from './board-shapes.js';
import { cancelVertexDrag, cancelViaDrag } from './track-drag.js';
import { getPcbSelection, getPcbSelectionEntries } from './selection-registry.js';
import { getSelectedTrack, getSelectedVia, clearTrackSelection, deleteSelectedTrack } from './track-select.js';
import { canEditFill, deleteFocusedFillPart } from './copper-fill-edit.js';
import { resetPcbTool } from './tool-lifecycle.js';
import { isPcbDrawing } from './pcb-interactions.js';

/**
 * Delete the current refinement or selection, retaining drawing/paste ownership
 * and the schematic's ownership of components.
 * @param {import('../../ui/PCBApp.js').default} app
 */
export function runPcbDeleteAction(app) {
    if (app._active === false || isPcbDrawing(app)) return false;
    if (app._pasteDrop) { app._cancelPasteDrop(); return true; }
    if (app._groupDrag) app._cancelPosePreviews();
    app._boardShapePropertyBinding?.cancel();
    app._trackPropertyBinding?.cancel();
    if (deleteFocusedBoardShape(app)) return true;
    const focusedFill = getPcbSelection(app, 'fill')[0];
    if (focusedFill && canEditFill(focusedFill) && deleteFocusedFillPart(app, focusedFill)) return true;
    // Track refinement is narrower than whole-object selection deletion.
    if (app._trackEdit && getPcbSelection(app).length === 1 && getSelectedTrack(app) === app._trackEdit.track) {
        deleteSelectedTrack(app);
        return true;
    }
    const componentId = getPcbSelection(app, 'component')[0] || getPcbSelection(app, 'reftext')[0];
    const deleted = deleteBoxSelection(app);
    if (componentId) {
        app._showComponentPopup(componentId, 'Delete components from the schematic editor');
        return true;
    }
    return deleted;
}

/**
 * Move a selected group by one keyboard step using the existing pose/history
 * path. Group pickup owns committing pending numeric-property previews.
 * @param {import('../../ui/PCBApp.js').default} app
 * @param {'ArrowUp'|'ArrowDown'|'ArrowLeft'|'ArrowRight'} key
 */
export function runPcbNudgeAction(app, key) {
    if (app._active === false || app.currentTool !== 'select'
        || isPcbDrawing(app)
        || hasPcbInteractionInProgress(app) || app._boxSelectArm
        || app._boxSelectActive || app.viewport.isPanning) return false;
    const selected = getPcbSelectionEntries(app);
    if (!selected.length || selected.some(entry => entry.locked || entry.visible === false
        || entry.kind === 'reftext')) return false;
    const step = app.viewport.snapToGrid ? app.viewport.gridSize / 4 : 1;
    const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
    const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
    beginGroupDrag(app, { x: 0, y: 0 });
    updateGroupDrag(app, { x: dx, y: dy }, { snap: false });
    endGroupDrag(app);
    showPcbSelectionProperties(app);
    return true;
}

/**
 * Unwind one level after drawing-mode keys have been handled: preview, pointer,
 * tool, then selection. Unlike full lifecycle cleanup, Escape retains controls.
 * @param {import('../../ui/PCBApp.js').default} app
 */
export function runPcbEscapeAction(app) {
    if (app._active === false) return false;
    if (cancelPcbPropertyPreview(app)) return true;
    if (app._boardOutlineResize) {
        endBoardOutlineResize(app, false);
        app.viewport.svg.style.cursor = 'default';
        return true;
    }
    if (app._boardDimensionPropertyBinding?.active) {
        app._boardDimensionPropertyBinding.cancel();
        return true;
    }
    if (finishSelectionInteraction(app, false)) {
        app._clearCursorCrosshair();
        return true;
    }
    if (app._drag) {
        app._endDrag(false);
        app._clearCursorCrosshair();
        return true;
    }
    if (app._refDrag) {
        app._endRefDrag(false);
        app._clearCursorCrosshair();
        return true;
    }
    if (app._groupDrag) {
        cancelGroupDrag(app);
        app.viewport.svg.style.cursor = 'default';
        return true;
    }
    if (app._pasteDrop) {
        app._cancelPasteDrop();
        return true;
    }
    if (app._vertexDrag) {
        cancelVertexDrag(app);
        app.viewport.hideCrosshair();
        // No mouse-up cleanup follows a cancelled drag.
        app._segmentClickEdgeId = null;
        return true;
    }
    if (app._viaDrag) { cancelViaDrag(app); return true; }
    if (app.currentTool !== 'select') {
        clearSelectionInteractionUi(app);
        clearBoxSelection(app);
        app._clearProperties?.();
        resetPcbTool(app);
        app._setActiveRibbonTab?.('pcb-home');
        return true;
    }
    if (hasBoxSelection(app)) {
        clearBoxSelection(app);
        clearSelectionInteractionUi(app);
        return true;
    }
    if (getPcbSelection(app, 'text').length) {
        app._selectText(null);
        app._clearProperties?.();
        app._setActiveRibbonTab?.('pcb-home');
        return true;
    }
    if (getSelectedTrack(app) || getSelectedVia(app)) {
        clearTrackSelection(app);
        app._clearProperties?.();
        return true;
    }
    if (getPcbSelection(app, 'fill').length) {
        app._selectFill(null);
        app._clearProperties?.();
        return true;
    }
    if (getPcbSelection(app, 'reftext').length) {
        app._selectRefText(null);
        app._clearProperties?.();
        app._setActiveRibbonTab?.('pcb-home');
        return true;
    }
    app._setActiveRibbonTab?.('pcb-home');
    return true;
}

/**
 * Apply the PCB keyboard history policy to every UI entry point.
 * Returns whether the request was consumed, not whether a history entry existed.
 * @param {import('../../ui/PCBApp.js').default} app
 * @param {'undo'|'redo'} action
 */
export function runPcbHistoryAction(app, action) {
    if (app._active === false || isPcbDrawing(app)) return false;
    if (app._pasteDrop) {
        app._cancelPasteDrop();
        return true;
    }
    if (getBoardDimensionPreview(app) || app._boardOutlineResize) {
        app._boardDimensionPropertyBinding?.cancel();
        endBoardOutlineResize(app, false);
        finishBoardDimensionPreview(app);
        return true;
    }
    if (app._groupDrag) {
        if (action === 'undo') {
            cancelGroupDrag(app);
            app._pcbSelectionInteraction = null;
        } else cancelPcbPosePreviews(app);
        return true;
    }
    if (action === 'undo') {
        finishSelectionInteraction(app, false);
        if (app._drag) app._endDrag(false);
        if (app._refDrag) app._endRefDrag(false);
        if (app._vertexDrag) { cancelVertexDrag(app); app.viewport.hideCrosshair(); }
        if (app._viaDrag) cancelViaDrag(app);
        if (app._shapeDrag) {
            endBoardShapeDrag(app, false);
            app._clearCursorCrosshair();
        }
    } else if (getBoardShapeRotationPreview(app)) {
        if (!finishSelectionInteraction(app, false)) finishBoardShapeRotationPreview(app);
    }
    app.history[action]();
    return true;
}

/**
 * The editor's project owns save readiness, I/O and ordinary failure reporting.
 * @param {import('../../ui/PCBApp.js').default} app
 * @param {boolean} [saveAs]
 */
export async function savePcbProject(app, saveAs = false) {
    const project = app.project;
    if (!project) throw new Error('Cannot save PCB without its project.');
    const result = await (saveAs ? project.saveAs() : project.save());
    if (result?.success) app._showSaveToast?.('Saved');
    return result;
}
