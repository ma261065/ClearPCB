import { finishSelectionInteraction } from './selection-interaction.js';
import { cancelGroupDrag } from './box-select.js';
import { cancelPcbPaste } from './pcb-paste.js';
import { endBoardShapeDrag, finishBoardShapeRotationPreview, getBoardShapeRotationPreview } from './board-shapes.js';
import { endBoardOutlineResize, finishBoardDimensionPreview } from './board-outline-resize.js';
import { cancelVertexDrag, cancelViaDrag } from './track-drag.js';
import { endFillEdit } from './copper-fill-edit.js';
import { finishPadRotationPreview } from './pad-commands.js';
import { disposeFillRefresh } from './fill-refresh.js';
import { disposeDrcRefresh } from './drc-refresh.js';

const PROPERTY_EDITORS = [
    '_textPropertyBinding', '_refPropertyBinding', '_padPropertyBinding', '_viaPropertyBinding',
    '_trackPropertyBinding', '_boardShapePropertyBinding',
];

/** Cancel one active property preview without disposing its controls.
 * @param {import('../../ui/PCBApp.js').default} app
 */
export function cancelPcbPropertyPreview(app) {
    // Shape/track previews retain their existing Escape priority.
    for (const key of ['_boardShapePropertyBinding', '_trackPropertyBinding', ...PROPERTY_EDITORS]) {
        if (!app[key]?.active) continue;
        app[key].cancel();
        return true;
    }
    return false;
}

/** Pointer/inline interactions that must finish before another selection action.
 * @param {import('../../ui/PCBApp.js').default} app
 */
export function hasPcbInteractionInProgress(app) {
    return !!(app._drag || app._refDrag || app._textDrag || app._groupDrag
        || app._shapeDrag || app._vertexDrag || app._viaDrag || app._fillDrag
        || app._pasteDrop || app._textEdit || app._boardOutlineResize
        || app._pcbSelectionInteraction || app._rotationHandleDrag);
}

/** @param {import('../../ui/PCBApp.js').default} app */
export function hasPcbEditInProgress(app) {
    return !!(hasPcbInteractionInProgress(app)
        || app._deferDragOverlays || app._suspendFillRefresh
        || app._boardDimensionPropertyBinding?.active
        || PROPERTY_EDITORS.some(key => app[key]?.active));
}

/** Release the old panel's editors before replacing its controls or document.
 * @param {import('../../ui/PCBApp.js').default} app
 * @param {object|null} [owner] Canonical target whose pointer gesture remains displayed.
 */
export function disposePcbPropertyEditors(app, owner = null) {
    app._boardDimensionPropertyBinding?.dispose();
    const rotation = getBoardShapeRotationPreview(app);
    if (rotation && rotation.original !== owner) {
        if (!finishSelectionInteraction(app, false)) finishBoardShapeRotationPreview(app);
    }
    for (const key of PROPERTY_EDITORS) {
        app[key]?.dispose();
        app[key] = null;
    }
}

/** Cancel previews, leaving drawing/inline-text policy to the caller.
 * @param {import('../../ui/PCBApp.js').default} app
 */
export function cancelPcbPosePreviews(app) {
    disposeFillRefresh(app);
    disposeDrcRefresh(app);
    cancelPcbPaste(app);
    for (const key of PROPERTY_EDITORS) app[key]?.cancel();
    app._boardDimensionPropertyBinding?.dispose();
    endBoardOutlineResize(app, false);
    finishBoardDimensionPreview(app);

    // The selection state machine owns every adapter kind and gesture mode.
    finishSelectionInteraction(app, false);
    // Direct pointer paths may exist without a selection-state wrapper.
    if (app._shapeDrag) endBoardShapeDrag(app, false);
    if (app._vertexDrag) cancelVertexDrag(app);
    finishBoardShapeRotationPreview(app);
    if (app._groupDrag?.posePreview) cancelGroupDrag(app);
    if (app._drag) app._endDrag(false);
    if (app._refDrag) app._endRefDrag(false);
    if (app._textDrag) app._endTextDrag(false);
    if (app._viaDrag) cancelViaDrag(app);
    if (app._fillDrag) endFillEdit(app, false);
    finishPadRotationPreview(app);
    if (app._drcPending) app._scheduleDRC();
}
