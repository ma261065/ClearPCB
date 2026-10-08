import { getPcbInteraction, isPcbDrawing } from './pcb-interactions.js';
import { cancelShapeDraw, getShapeDraw, resolveShapeDrawLayer } from './board-shapes.js';
import { showBoardShapeToolProperties } from './board-shape-properties.js';
import { showFillToolProperties } from './copper-fill-edit.js';
import { getFillDraw, cancelFillDraw, fillToolDefaults } from './copper-fill-draw.js';
import { getPadToolDefaults, showPadToolProperties } from './pad-tool.js';
import { clearPadPreview } from './pad-tool.js';
import { getTextToolDefaults, showTextToolProperties } from './text-properties.js';
import { cancelTrackDrawing, getTrackDraw, getTrackToolLayer, showTrackDrawProperties } from './track-draw.js';
import { clearPlacementBlock, placementBlock, placementBlockAction, placementBlockMessage, placementBlockName,
    refuseBlockedPlacement } from './layers.js';
import { getPcbSelectionEntries } from './selection-registry.js';
import { padLayers } from '../../shapes/pad-geometry.js';
import { clearViaRing, showViaToolProperties } from './via-tool.js';
import { activeTextInlineEdit, endTextInlineEdit } from './text-inline-edit.js';
import { hoverComponent } from './component-selection.js';
import { selectRefText } from './ref-text-selection.js';
import { setToolCursor } from '../../shared/ui/cursor.js';
import { clearCursorCrosshair } from './cursor-state.js';

export const PCB_SHAPE_TOOLS = new Set(['line', 'circle', 'arc', 'rect', 'polygon']);
export const PCB_CROSSHAIR_TOOLS = new Set(['track', 'via', 'pad', 'text', 'fill', ...PCB_SHAPE_TOOLS]);
/** Tools that show their own Properties panel (see selectPcbTool), so a canvas press keeps that tab open. */
export const PCB_PROPERTIES_TOOLS = new Set(['track', 'via', 'pad', 'text', 'fill', ...PCB_SHAPE_TOOLS]);

export function normalizePcbTool(tool) {
    return tool === 'select' || PCB_CROSSHAIR_TOOLS.has(tool) ? tool : 'select';
}

/**
 * The layer-panel rows a placement tool would put new objects on, from the tool's own
 * settings (or the draw in progress). Its press, cursor, ribbon button and Properties
 * all read this, so they always agree. Tools that place nothing give none.
 * @param {any} app
 * @param {string} [tool]
 * @returns {import('./layers.js').PlacementLayer[]}
 */
export function pcbToolTargets(app, tool = app.currentTool) {
    if (tool === 'via') return [{ id: 'vias' }];
    if (tool === 'pad') return padLayers(getPadToolDefaults(app)).map(id => ({ id }));
    if (tool === 'text') return [{ id: getTextToolDefaults(app).layer }];
    if (tool === 'track') return [{ id: getTrackDraw(app)?.currentLayer || getTrackToolLayer(app) || 'top-copper' }];
    if (tool === 'fill') {
        const layer = getFillDraw(app)?.layer || fillToolDefaults(app).layer;
        return [{ id: layer }, { id: layer, fill: true }];
    }
    if (tool === 'hole') return [{ id: 'hole' }];
    if (PCB_SHAPE_TOOLS.has(tool)) {
        const draw = getShapeDraw(app);
        return [{ id: (draw?.kind === tool && draw.layer) || resolveShapeDrawLayer(app, app.activeLayer) }];
    }
    return [];
}

/** Why the tool cannot place here, or null. */
export const pcbToolBlock = (app, tool = app.currentTool) => placementBlock(pcbToolTargets(app, tool));

/** Refuse a placement press on a locked or hidden layer, explaining it at the pointer. */
export const refuseBlockedToolPlacement = (app, event) => refuseBlockedPlacement(app, pcbToolTargets(app), event);

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

/** Placement tools whose ribbon button carries a lock badge when its layer is blocked. */
export const PCB_RIBBON_PLACEMENT_TOOLS = Object.freeze(['track', 'via', 'pad', 'hole', 'text', 'fill', ...PCB_SHAPE_TOOLS]);

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

/** Show the Properties panel the tool owns (its defaults, or the draw in progress). */
export function showPcbToolProperties(app, tool = app.currentTool) {
    if (tool === 'fill') showFillToolProperties(app);
    else if (tool === 'via') showViaToolProperties(app);
    else if (tool === 'pad') showPadToolProperties(app);
    else if (tool === 'track') showTrackDrawProperties(app);
    else if (tool === 'text') showTextToolProperties(app);
    else if (PCB_SHAPE_TOOLS.has(tool)) showBoardShapeToolProperties(app, tool);
}

/**
 * A layer's lock or eye changed: refresh the ribbon badges and, while a placement tool
 * owns Properties (nothing drawn or selected), its panel and its layer warning.
 */
export function refreshPcbToolLayerState(app) {
    syncPcbToolBlocks(app);
    if (!PCB_PROPERTIES_TOOLS.has(app.currentTool) || isPcbDrawing(app) || activeTextInlineEdit(app)) return;
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
    if (!PCB_CROSSHAIR_TOOLS.has(app.currentTool) && !isPcbDrawing(app) && !activeTextInlineEdit(app)) return false;
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
