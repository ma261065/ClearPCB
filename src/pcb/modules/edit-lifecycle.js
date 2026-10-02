import { finishSelectionInteraction } from './selection-interaction.js';
import { cancelPcbPaste } from './pcb-paste.js';
import { finishBoardShapeRotationPreview, getBoardShapeRotationPreview } from './board-shapes.js';
import { endBoardOutlineResize, finishBoardDimensionPreview } from './board-outline-resize.js';
import { finishPadRotationPreview } from './pad-commands.js';
import { disposeFillRefresh } from './fill-refresh.js';
import { disposeDrcRefresh } from './drc-refresh.js';
import { hasPcbGesture } from './pcb-interactions.js';
import { cancelPcbPointerGestures } from './pcb-interaction-routing.js';

const PROPERTY_EDITORS = [
    '_textPropertyBinding', '_componentProperties', '_padPropertyBinding', '_viaPropertyBinding',
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
    return hasPcbGesture(app);
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
        // The component owner survives panel replacement; its retained controls do not.
        if (key !== '_componentProperties') app[key] = null;
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

    // The selection state machine owns every adapter kind and gesture mode;
    // direct pointer paths may exist without a selection-state wrapper.
    cancelPcbPointerGestures(app);
    finishBoardShapeRotationPreview(app);
    finishPadRotationPreview(app);
    if (app._drcPending) app._scheduleDRC();
}
