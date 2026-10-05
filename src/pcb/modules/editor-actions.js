import { cancelPcbPosePreviews, cancelPcbPropertyPreview, hasPcbInteractionInProgress } from './edit-lifecycle.js';
import { finishSelectionInteraction, clearSelectionInteractionUi, setSelectionInteraction, showPcbSelectionProperties } from './selection-interaction.js';
import { beginGroupDrag, updateGroupDrag, endGroupDrag, cancelGroupDrag, clearBoxSelection, getGroupDrag, hasBoxSelection, deleteBoxSelection } from './box-select.js';
import { getBoardDimensionPreview, endBoardOutlineResize, finishBoardDimensionPreview, getBoardOutlineResize } from './board-outline-resize.js';
import { getBoardShapeDrag, getBoardShapeRotationPreview, finishBoardShapeRotationPreview, endBoardShapeDrag, deleteFocusedBoardShape } from './board-shapes.js';
import { cancelVertexDrag, cancelViaDrag, getVertexDrag, getViaDrag, setSegmentClickEdgeId } from './track-drag.js';
import { getPcbSelection, getPcbSelectionEntries } from './selection-registry.js';
import { getSelectedTrack, getSelectedVia, clearTrackSelection, deleteSelectedTrack } from './track-select.js';
import { canEditFill, deleteFocusedFillPart } from './copper-fill-edit.js';
import { resetPcbTool } from './tool-lifecycle.js';
import { isPcbDrawing } from './pcb-interactions.js';
import { getPropertyEditor } from './property-editors.js';
import { isEditorActive } from './pcb-editor-api.js';
import { flushSettledChanges } from '../../shared/ui/settled-input.js';
import { cancelPcbPaste, isPcbPasteActive } from './pcb-paste.js';
import { endComponentDrag, getComponentDrag } from './component-selection.js';
import { endRefDrag, getRefDrag } from './ref-text-selection.js';

/**
 * Delete the current refinement or selection, retaining drawing/paste ownership
 * and the schematic's ownership of components.
 * @param {import('../../ui/PCBApp.js').default} app
 */
export function runPcbDeleteAction(app) {
    if (!isEditorActive(app) || isPcbDrawing(app)) return false;
    if (isPcbPasteActive(app)) { cancelPcbPaste(app); return true; }
    if (getGroupDrag(app)) cancelPcbPosePreviews(app);
    getPropertyEditor(app, 'boardShape')?.cancel();
    getPropertyEditor(app, 'track')?.cancel();
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
    if (!isEditorActive(app) || app.currentTool !== 'select'
        || isPcbDrawing(app)
        || hasPcbInteractionInProgress(app) || app._boxSelectArm
        || app._boxSelectActive || app.viewport.isPanning) return false;
    const selected = getPcbSelectionEntries(app);
    // Locked members stay put (the group drag skips them); one movable member is enough.
    if (!selected.some(entry => !entry.locked) || selected.some(entry => entry.visible === false
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
    if (!isEditorActive(app)) return false;
    if (cancelPcbPropertyPreview(app)) return true;
    if (getBoardOutlineResize(app)) {
        endBoardOutlineResize(app, false);
        app.viewport.svg.style.cursor = 'default';
        return true;
    }
    if (getPropertyEditor(app, 'boardDimension')?.active) {
        getPropertyEditor(app, 'boardDimension').cancel();
        return true;
    }
    if (finishSelectionInteraction(app, false)) {
        app._clearCursorCrosshair();
        return true;
    }
    if (getComponentDrag(app)) {
        endComponentDrag(app, false);
        app._clearCursorCrosshair();
        return true;
    }
    if (getRefDrag(app)) {
        endRefDrag(app, false);
        app._clearCursorCrosshair();
        return true;
    }
    if (getGroupDrag(app)) {
        cancelGroupDrag(app);
        app.viewport.svg.style.cursor = 'default';
        return true;
    }
    if (isPcbPasteActive(app)) {
        cancelPcbPaste(app);
        return true;
    }
    if (getVertexDrag(app)) {
        cancelVertexDrag(app);
        app.viewport.hideCrosshair();
        // No mouse-up cleanup follows a cancelled drag.
        setSegmentClickEdgeId(app, null);
        return true;
    }
    if (getViaDrag(app)) { cancelViaDrag(app); return true; }
    if (app.currentTool !== 'select') {
        clearSelectionInteractionUi(app);
        clearBoxSelection(app);
        app.clearProperties?.();
        resetPcbTool(app);
        app.setActiveRibbonTab?.('pcb-home');
        return true;
    }
    if (hasBoxSelection(app)) {
        clearBoxSelection(app);
        clearSelectionInteractionUi(app);
        return true;
    }
    if (getPcbSelection(app, 'text').length) {
        app.selectText(null);
        app.clearProperties?.();
        app.setActiveRibbonTab?.('pcb-home');
        return true;
    }
    if (getSelectedTrack(app) || getSelectedVia(app)) {
        clearTrackSelection(app);
        app.clearProperties?.();
        return true;
    }
    if (getPcbSelection(app, 'fill').length) {
        app.selectFill(null);
        app.clearProperties?.();
        return true;
    }
    if (getPcbSelection(app, 'reftext').length) {
        app._selectRefText(null);
        app.clearProperties?.();
        app.setActiveRibbonTab?.('pcb-home');
        return true;
    }
    app.setActiveRibbonTab?.('pcb-home');
    return true;
}

/**
 * Apply the PCB keyboard history policy to every UI entry point.
 * Returns whether the request was consumed, not whether a history entry existed.
 * @param {import('../../ui/PCBApp.js').default} app
 * @param {'undo'|'redo'} action
 */
export function runPcbHistoryAction(app, action) {
    if (!isEditorActive(app) || isPcbDrawing(app)) return false;
    // A spinner run still settling becomes its own undo step first.
    flushSettledChanges();
    if (isPcbPasteActive(app)) {
        cancelPcbPaste(app);
        return true;
    }
    if (getBoardDimensionPreview(app) || getBoardOutlineResize(app)) {
        getPropertyEditor(app, 'boardDimension')?.cancel();
        endBoardOutlineResize(app, false);
        finishBoardDimensionPreview(app);
        return true;
    }
    if (getGroupDrag(app)) {
        if (action === 'undo') {
            cancelGroupDrag(app);
            setSelectionInteraction(app, null);
        } else cancelPcbPosePreviews(app);
        return true;
    }
    if (action === 'undo') {
        finishSelectionInteraction(app, false);
        if (getComponentDrag(app)) endComponentDrag(app, false);
        if (getRefDrag(app)) endRefDrag(app, false);
        if (getVertexDrag(app)) { cancelVertexDrag(app); app.viewport.hideCrosshair(); }
        if (getViaDrag(app)) cancelViaDrag(app);
        if (getBoardShapeDrag(app)) {
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
