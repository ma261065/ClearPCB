import { cancelPcbPosePreviews } from './edit-lifecycle.js';
import { finishSelectionInteraction } from './selection-interaction.js';
import { cancelGroupDrag } from './box-select.js';
import { getBoardDimensionPreview, endBoardOutlineResize, finishBoardDimensionPreview } from './board-outline-resize.js';
import { getBoardShapeRotationPreview, finishBoardShapeRotationPreview, endBoardShapeDrag } from './board-shapes.js';
import { cancelVertexDrag, cancelViaDrag } from './track-drag.js';

/**
 * Apply the PCB keyboard history policy to every UI entry point.
 * Returns whether the request was consumed, not whether a history entry existed.
 * @param {import('../../ui/PCBApp.js').default} app
 * @param {'undo'|'redo'} action
 */
export function runPcbHistoryAction(app, action) {
    if (app._active === false || app._trackDraw || app._fillDraw || app._shapeDraw) return false;
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
