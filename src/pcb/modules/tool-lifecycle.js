import { getPcbInteraction, isPcbDrawing } from './pcb-interactions.js';
import { cancelShapeDraw, getShapeDraw } from './board-shapes.js';
import { getFillDraw, cancelFillDraw } from './copper-fill-draw.js';
import { clearPadPreview } from './pad-tool.js';
import { cancelTrackDrawing } from './track-draw.js';
import { clearPlacementBlock, placementBlock, placementBlockAction, placementBlockMessage, placementBlockName } from './layers.js';
import { getPcbSelectionEntries } from './selection-registry.js';
import { clearViaRing } from './via-tool.js';
import { PCB_PLACEMENT_TOOLS, PCB_RIBBON_PLACEMENT_TOOLS, normalizePcbTool, pcbToolTargets, showPcbToolProperties } from './pcb-tools.js';
import { activeTextInlineEdit, endTextInlineEdit } from './text-inline-edit.js';
import { hoverComponent } from './component-selection.js';
import { selectRefText } from './ref-text-selection.js';
import { setToolCursor } from '../../shared/ui/cursor.js';
import { clearCursorCrosshair } from './cursor-state.js';

/** Why the tool cannot place here, or null. */
export const pcbToolBlock = (app, tool = app.currentTool) => placementBlock(pcbToolTargets(app, tool));

/**
 * What a tool's Properties shows when its layer is blocked: a warning on its layer field
 * and an action group that unlocks or shows the layer.
 * @returns {{warning?: string, actions: import('../../shared/ui/property-fields.js').PropertyActionGroup[]}}
 */
export function pcbToolBlockNotice(app, tool = app.currentTool) {
    const block = pcbToolBlock(app, tool);
    if (!block) return { actions: [] };
    const message = placementBlockMessage(block);
    const verb = placementBlockAction(block);
    return {
        warning: `${message}: new objects can't be placed on it`,
        actions: [{ title: `${block.reason === 'locked' ? '🔒' : '🚫'} ${message}`, actions: [{
            id: 'pcbToolUnblockLayer', label: `${verb} ${placementBlockName(block)}`,
            title: `${verb} the layer so this tool can place on it`,
            run: () => clearPlacementBlock(app, block),
        }] }],
    };
}

const toolBadges = new WeakMap();

/** The pointer badge saying the active tool's layer is blocked. */
function toolBadge(app) {
    let badge = toolBadges.get(app);
    if (!badge && typeof document !== 'undefined' && document.body) {
        badge = document.createElement('div');
        badge.className = 'pcb-tool-blocked-badge';
        badge.setAttribute('aria-hidden', 'true');
        document.body.appendChild(badge);
        toolBadges.set(app, badge);
    }
    return badge || null;
}

/**
 * Show at the pointer, before any press, that the active tool's layer is locked or
 * hidden: a not-allowed cursor, the tool's preview dimmed, and a badge naming the layer.
 * Called on every canvas pointer move (a few lookups), and with no event to hide it.
 * @param {any} app
 * @param {{clientX: number, clientY: number}|null} [event]
 */
export function syncToolBlockIndicator(app, event = null) {
    const svg = app.viewport?.svg;
    if (!svg) return;
    const block = event && !getPcbInteraction(app, '_pasteDrop') ? pcbToolBlock(app) : null;
    svg.classList?.toggle('pcb-placement-blocked', !!block);
    app.viewport.crosshairContainer?.classList?.toggle('pcb-placement-blocked', !!block);
    if (block) svg.style.cursor = 'not-allowed';
    else if (svg.style.cursor === 'not-allowed') updateCursorForTool(app);
    const badge = block ? toolBadge(app) : toolBadges.get(app);
    if (!badge) return;
    if (!block) {
        badge.style.display = 'none';
        return;
    }
    badge.textContent = `${block.reason === 'locked' ? '🔒' : '🚫'} ${placementBlockName(block)} ${block.reason}`;
    badge.style.display = 'block';
    badge.style.left = `${event.clientX + 14}px`;
    badge.style.top = `${event.clientY + 14}px`;
}

const ribbonBlockSignatures = new WeakMap();

/**
 * Refresh the ribbon's tool badges when which tools are blocked changes. Called where
 * the status bar shows the tool's layer (setPcbStatus) and on layer lock/eye changes.
 */
export function syncPcbToolBlocks(app) {
    const signature = PCB_RIBBON_PLACEMENT_TOOLS.map(tool => pcbToolBlock(app, tool)?.reason?.[0] || '-').join('');
    if (ribbonBlockSignatures.get(app) === signature) return;
    ribbonBlockSignatures.set(app, signature);
    app.refreshPcbRibbon?.();
}

/**
 * A layer's lock or eye changed: refresh the ribbon badges and, while a placement tool
 * owns Properties (nothing drawn or selected), its panel and its layer warning.
 */
export function refreshPcbToolLayerState(app) {
    syncPcbToolBlocks(app);
    if (!PCB_PLACEMENT_TOOLS.has(app.currentTool) || isPcbDrawing(app) || activeTextInlineEdit(app)) return;
    if (getPcbSelectionEntries(app).length) return;
    showPcbToolProperties(app);
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
    if (PCB_PLACEMENT_TOOLS.has(t)) {
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
    app.refreshPcbRibbon?.();
    app.setPcbStatus?.();
}

/**
 * Select a tool without cancelling a drawing already owned by that tool.
 * @param {import('../../ui/PCBApp.js').default} app
 * @param {string} tool
 */
export function selectPcbTool(app, tool) {
    const next = normalizePcbTool(tool);
    if (next !== 'track') cancelTrackDrawing(app);
    if (getFillDraw(app) && next !== 'fill') cancelFillDraw(app);
    if (getShapeDraw(app) && getShapeDraw(app).kind !== next) cancelShapeDraw(app);
    app.currentTool = next;
    if (next !== 'select') {
        hoverComponent(app, null);
        selectRefText(app, null);
    }
    app.refreshPcbRibbon?.();
    updateCursorForTool(app);
    app.setPcbStatus?.();
    showPcbToolProperties(app, next);
}

/** @param {import('../../ui/PCBApp.js').default} app */
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
