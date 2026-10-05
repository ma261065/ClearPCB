import { isPcbDrawing } from './pcb-interactions.js';
import { cancelShapeDraw } from './board-shapes.js';
import { showFillToolProperties } from './copper-fill-edit.js';

export const PCB_SHAPE_TOOLS = new Set(['line', 'circle', 'arc', 'rect', 'polygon']);
export const PCB_CROSSHAIR_TOOLS = new Set(['track', 'via', 'pad', 'text', 'fill', ...PCB_SHAPE_TOOLS]);

export function normalizePcbTool(tool) {
    return tool === 'select' || PCB_CROSSHAIR_TOOLS.has(tool) ? tool : 'select';
}

/** @param {import('../../ui/PCBApp.js').default} app */
export function resetPcbTool(app) {
    app.currentTool = 'select';
    app._updateCursorForTool?.();
    app._syncPcbHomeToolHighlight?.();
    app.setPcbStatus?.();
}

/**
 * Select a tool without cancelling a drawing already owned by that tool.
 * @param {import('../../ui/PCBApp.js').default} app
 * @param {string} tool
 */
export function selectPcbTool(app, tool) {
    const next = normalizePcbTool(tool);
    if (next !== 'track') app._cancelTrackDraw?.();
    if (app._fillDraw && next !== 'fill') app._cancelFillDraw?.();
    if (app._shapeDraw && app._shapeDraw.kind !== next) app._cancelShapeDraw?.();
    app.currentTool = next;
    if (next !== 'select') {
        app._hoverComponent?.(null);
        app._selectRefText?.(null);
    }
    app._syncPcbHomeToolHighlight?.();
    app._updateCursorForTool?.();
    app.setPcbStatus?.();
    if (next === 'fill') showFillToolProperties(app);
    else if (next === 'via') app._showViaToolProperties?.();
    else if (next === 'pad') app._showPadToolProperties?.();
    else if (next === 'track') app._showTrackDrawProperties?.();
    else if (next === 'text') app._showTextToolProperties?.();
    else if (PCB_SHAPE_TOOLS.has(next)) app._showBoardShapeToolProperties?.(next);
}

/** @param {import('../../ui/PCBApp.js').default} app */
export function cancelPcbDrawingMode(app) {
    if (!PCB_CROSSHAIR_TOOLS.has(app.currentTool) && !isPcbDrawing(app) && !app._textEdit) return false;
    if (app._textEdit) app._endTextInlineEdit(false);
    app._cancelTrackDraw();
    app._cancelFillDraw();
    cancelShapeDraw(app);
    resetPcbTool(app);
    return true;
}

/**
 * Explicit navigation exits drawing; programmatic Properties navigation retains
 * track/fill sessions. Shape drawing keeps its existing tab-change cancellation.
 * @param {import('../../ui/PCBApp.js').default} app
 * @param {string|null} currentTab
 * @param {string} nextTab
 * @param {boolean} [userInitiated]
 */
export function preparePcbRibbonTransition(app, currentTab, nextTab, userInitiated = false) {
    if (currentTab === nextTab) return;
    if (userInitiated) cancelPcbDrawingMode(app);
    else if (app._shapeDraw) {
        cancelShapeDraw(app);
        resetPcbTool(app);
    }
}
