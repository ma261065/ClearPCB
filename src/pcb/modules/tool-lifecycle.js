import { getPcbInteraction, isPcbDrawing } from './pcb-interactions.js';
import { cancelShapeDraw, getShapeDraw } from './board-shapes.js';
import { showBoardShapeToolProperties } from './board-shape-properties.js';
import { showFillToolProperties } from './copper-fill-edit.js';
import { getFillDraw, cancelFillDraw } from './copper-fill-draw.js';
import { showPadToolProperties } from './pad-tool.js';
import { clearPadPreview } from './pad-tool.js';
import { showTextToolProperties } from './text-properties.js';
import { showTrackDrawProperties } from './track-draw.js';
import { clearViaRing, showViaToolProperties } from './via-tool.js';
import { activeTextInlineEdit, endTextInlineEdit } from './text-inline-edit.js';
import { hoverComponent } from './component-selection.js';
import { selectRefText } from './ref-text-selection.js';
import { setToolCursor } from '../../shared/ui/cursor.js';
import { clearCursorCrosshair } from './cursor-state.js';

export const PCB_SHAPE_TOOLS = new Set(['line', 'circle', 'arc', 'rect', 'polygon']);
export const PCB_CROSSHAIR_TOOLS = new Set(['track', 'via', 'pad', 'text', 'fill', ...PCB_SHAPE_TOOLS]);

export function normalizePcbTool(tool) {
    return tool === 'select' || PCB_CROSSHAIR_TOOLS.has(tool) ? tool : 'select';
}

export function updateCursorForTool(app) {
    if (!app.viewport?.svg) return;
    if (getPcbInteraction(app, '_pasteDrop')) {
        app.viewport.svg.style.cursor = 'crosshair';
        clearViaRing(app);
        clearPadPreview(app);
        return;
    }
    const t = app.currentTool;
    if (PCB_CROSSHAIR_TOOLS.has(t)) {
        setToolCursor(app, t, app.viewport.svg);
        if (t !== 'via') clearViaRing(app);
        if (t !== 'pad') clearPadPreview(app);
        return;
    }
    app.viewport.svg.style.cursor =
        t === 'pan' ? 'grab' :
        'default';
    if (t !== 'via') clearViaRing(app);
    if (t !== 'pad') clearPadPreview(app);
    clearCursorCrosshair(app);
}

/** @param {import('../../ui/PCBApp.js').default} app */
export function resetPcbTool(app) {
    app.currentTool = 'select';
    updateCursorForTool(app);
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
    if (getFillDraw(app) && next !== 'fill') cancelFillDraw(app);
    if (getShapeDraw(app) && getShapeDraw(app).kind !== next) cancelShapeDraw(app);
    app.currentTool = next;
    if (next !== 'select') {
        hoverComponent(app, null);
        selectRefText(app, null);
    }
    app._syncPcbHomeToolHighlight?.();
    updateCursorForTool(app);
    app.setPcbStatus?.();
    if (next === 'fill') showFillToolProperties(app);
    else if (next === 'via') showViaToolProperties(app);
    else if (next === 'pad') showPadToolProperties(app);
    else if (next === 'track') showTrackDrawProperties(app);
    else if (next === 'text') showTextToolProperties(app);
    else if (PCB_SHAPE_TOOLS.has(next)) showBoardShapeToolProperties(app, next);
}

/** @param {import('../../ui/PCBApp.js').default} app */
export function cancelPcbDrawingMode(app) {
    if (!PCB_CROSSHAIR_TOOLS.has(app.currentTool) && !isPcbDrawing(app) && !activeTextInlineEdit(app)) return false;
    // Leaving an inline text edit (another tool, a ribbon tab, the other editor) keeps what
    // was typed, as clicking elsewhere on the board does; only Escape discards it.
    if (activeTextInlineEdit(app)) endTextInlineEdit(app, true);
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
    else if (getShapeDraw(app)) {
        cancelShapeDraw(app);
        resetPcbTool(app);
    }
}
