import { boardShapeLocked } from './object-locks.js';
import { isLayerVisible, pcbLayerHoverColor, pcbLayerSelectionColor } from './layers.js';
import { activeTextInlineEdit } from './text-inline-edit.js';
import { renderPcbSelectionAnchors } from './selection-anchors.js';
import { isPcbSelected } from './selection-registry.js';
import { pcbTextHitTest, renderPcbText } from './pcb-text.js';
import { refreshBoardShapeClearance } from './clearance-overlay.js';
import { refreshSelectedDrcMarker } from './drc-state.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */

const textElements = new WeakMap();
const hoveredTexts = new WeakMap();

/** @param {PcbEditor} app */
function elementMap(app) {
    let map = textElements.get(app);
    if (!map) {
        map = new Map();
        textElements.set(app, map);
    }
    return map;
}

/**
 * Render `text` into its layer group, replacing any prior SVG for the same id.
 * @param {PcbEditor} app
 */
export function renderText(app, text) {
    removeTextElement(app, text.id);
    const layerG = app.getLayerGroup(text.layer);
    if (!layerG) return;
    const isSel = isPcbSelected(app, 'text', text);
    const isHover = !isSel && hoveredTexts.get(app)?.id === text.id;
    // While inline-editing, render the text in white so it doesn't
    // disappear against same-coloured tracks/pads on the layer.
    const isEditing = activeTextInlineEdit(app)?.text?.id === text.id;
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const selColor = pcbLayerSelectionColor(text.layer);
    const hoverColor = pcbLayerHoverColor(text.layer);
    const editColor = isLight ? '#000000' : '#ffffff';
    const strokeOverride = isEditing ? editColor
        : isSel ? selColor
        : isHover ? hoverColor
        : undefined;
    const el = renderPcbText(text, strokeOverride);
    layerG.appendChild(el);
    elementMap(app).set(text.id, el);
    refreshBoardShapeClearance(app, text);
    if (isSel) renderPcbSelectionAnchors(app);
    if (isEditing) activeTextInlineEdit(app)?.updateCaret?.();
}

/**
 * Remove the SVG element for a text id (model untouched).
 * @param {PcbEditor} app
 */
export function removeTextElement(app, id) {
    const map = elementMap(app);
    const el = map.get(id);
    if (el?.parentNode) el.parentNode.removeChild(el);
    map.delete(id);
}

/**
 * Return the currently rendered SVG element for a text id, or null.
 * @param {PcbEditor} app
 */
export function getTextElement(app, id) {
    return elementMap(app).get(id) || null;
}

/**
 * Remove all tracked text SVG elements for an editor instance.
 * @param {PcbEditor} app
 */
export function clearTextElements(app) {
    for (const id of [...elementMap(app).keys()]) removeTextElement(app, id);
}

/**
 * Hit-test the given world point against every text. Returns the
 * topmost (last-added) hit, or null.
 * @param {PcbEditor} app
 */
export function hitTestText(app, worldPos) {
    let hit = null;
    for (const t of app.texts.values()) {
        if (boardShapeLocked(t) || !isLayerVisible(t.layer)) continue;
        if (pcbTextHitTest(t, worldPos.x, worldPos.y)) hit = t;
    }
    return hit;
}

/**
 * Set/clear hover highlight for text annotations.
 * @param {PcbEditor} app
 */
export function setTextHover(app, text) {
    const prev = hoveredTexts.get(app) || null;
    const next = text || null;
    if (prev === next || (prev && next && prev.id === next.id)) return;
    if (next) hoveredTexts.set(app, next);
    else hoveredTexts.delete(app);
    if (prev && (!next || prev.id !== next.id)) app.refreshText(prev.id);
    if (next) app.refreshText(next.id);
}

/**
 * Re-render an existing text in place (e.g. after a property change).
 * @param {PcbEditor} app
 */
export function refreshText(app, id) {
    const t = app.texts.get(id);
    if (!t) return;
    renderText(app, t);
    refreshSelectedDrcMarker(app);
}
