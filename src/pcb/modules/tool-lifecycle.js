import { getPcbInteraction, isPcbDrawing } from './pcb-interactions.js';
import { cancelShapeDraw, getShapeDraw } from './board-shape-draw.js';
import { getFillDraw, cancelFillDraw } from './copper-fill-draw.js';
import { clearPadPreview } from './pad-tool.js';
import { cancelTrackDrawing } from './track-draw.js';
import { placementBlock, placementBlockMessage } from './layers.js';
import { getPcbSelectionEntries } from './selection-registry.js';
import { clearViaRing } from './via-tool.js';
import { PCB_PLACEMENT_TOOLS, PCB_RIBBON_PLACEMENT_TOOLS, PCB_TOOL_PRESETS, normalizePcbTool, pcbToolAllLayersLocked, pcbToolTargets, preparePcbToolLayer, showPcbToolProperties } from './pcb-tools.js';
import { activeTextInlineEdit, endTextInlineEdit } from './text-inline-edit.js';
import { hoverComponent } from './component-selection.js';
import { selectRefText } from './ref-text-selection.js';
import { setToolCursor } from '../../shared/ui/cursor.js';
import { clearCursorCrosshair } from './cursor-state.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */

/**
 * Why the tool cannot place here, or null.
 * @param {PcbEditor} app
 */
export const pcbToolBlock = (app, tool = app.currentTool) => placementBlock(pcbToolTargets(app, tool));

/**
 * A warning on the tool's layer field when placement is blocked; locks are managed in Layers.
 * @param {PcbEditor} app
 * @returns {{warning?: string, actions: import('../../shared/ui/property-fields.js').PropertyActionGroup[]}}
 */
export function pcbToolBlockNotice(app, tool = app.currentTool) {
    const block = pcbToolBlock(app, tool);
    if (!block) return { actions: [] };
    const message = placementBlockMessage(block);
    return {
        warning: `${message}: new objects can't be placed on it`,
        actions: [],
    };
}

const ribbonBlockSignatures = new WeakMap();

/**
 * Refresh the ribbon's tool availability when which tools are blocked changes. Called where
 * the status bar shows the tool's layer (setPcbStatus) and on layer lock/eye changes.
 * @param {PcbEditor} app
 */
export function syncPcbToolBlocks(app) {
    const signature = PCB_RIBBON_PLACEMENT_TOOLS.map(tool => pcbToolAllLayersLocked(app, tool) ? 'L' : '-').join('');
    if (ribbonBlockSignatures.get(app) === signature) return;
    ribbonBlockSignatures.set(app, signature);
    app.refreshPcbRibbon?.();
}

/**
 * A layer's lock or eye changed: refresh the ribbon and, while a placement tool
 * owns Properties (nothing drawn or selected), its panel and its layer warning.
 * @param {PcbEditor} app
 */
export function refreshPcbToolLayerState(app) {
    syncPcbToolBlocks(app);
    if (!PCB_PLACEMENT_TOOLS.has(app.currentTool) || isPcbDrawing(app) || activeTextInlineEdit(app)) return;
    if (getPcbSelectionEntries(app).length) return;
    showPcbToolProperties(app);
}

/** @param {PcbEditor} app */
export function updateCursorForTool(app) {
    const svg = app.viewport?.svg;
    if (!svg) return;
    if (getPcbInteraction(app, '_pasteDrop')) {
        svg.style.cursor = 'crosshair';
        clearViaRing(app);
        clearPadPreview(app);
        return;
    }
    const t = app.currentTool;
    if (PCB_PLACEMENT_TOOLS.has(t)) {
        setToolCursor(app, t, svg);
        if (t !== 'via') clearViaRing(app);
        if (t !== 'pad') clearPadPreview(app);
        return;
    }
    svg.style.cursor =
        t === 'pan' ? 'grab' :
        'default';
    if (t !== 'via') clearViaRing(app);
    if (t !== 'pad') clearPadPreview(app);
    clearCursorCrosshair(app);
}

/** @param {PcbEditor} app */
export function resetPcbTool(app) {
    app.currentTool = 'select';
    updateCursorForTool(app);
    app.refreshPcbRibbon?.();
    app.setPcbStatus();
}

/**
 * Select a tool without cancelling a drawing already owned by that tool.
 * @param {PcbEditor} app
 * @param {string} tool
 */
export function selectPcbTool(app, tool) {
    if (pcbToolAllLayersLocked(app, tool)) {
        app.setStatus('All layers for this drawing tool are locked.');
        return;
    }
    const next = PCB_TOOL_PRESETS[tool]?.tool || normalizePcbTool(tool);
    if (next !== 'track') cancelTrackDrawing(app);
    if (getFillDraw(app) && next !== 'fill') cancelFillDraw(app);
    const shapeDraw = getShapeDraw(app);
    if (shapeDraw && shapeDraw.kind !== next) cancelShapeDraw(app);
    if (!isPcbDrawing(app)) preparePcbToolLayer(app, tool);
    app.currentTool = next;
    if (next !== 'select') {
        hoverComponent(app, null);
        selectRefText(app, null);
    }
    app.refreshPcbRibbon?.();
    updateCursorForTool(app);
    app.setPcbStatus();
    showPcbToolProperties(app, next);
}

/** @param {PcbEditor} app */
export function cancelPcbDrawingMode(app) {
    if (!PCB_PLACEMENT_TOOLS.has(app.currentTool) && !isPcbDrawing(app) && !activeTextInlineEdit(app)) return false;
    // Leaving an inline text edit (another tool, a ribbon tab, the other editor) keeps what
    // was typed, as clicking elsewhere on the board does; only Escape discards it.
    if (activeTextInlineEdit(app)) endTextInlineEdit(app, true);
    cancelTrackDrawing(app);
    cancelFillDraw(app);
    cancelShapeDraw(app);
    resetPcbTool(app);
    return true;
}

/**
 * Explicit navigation exits drawing; programmatic Properties navigation retains
 * track/fill sessions. Shape drawing keeps its existing tab-change cancellation.
 * @param {PcbEditor} app
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
