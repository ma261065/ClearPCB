/**
 * Owns PCB editor selection service actions that coordinate multiple selection adapters.
 */
import { isLayerVisible, isViaVisible, isCopperFillVisible } from './layers.js';
import { isPcbObjectLayerLocked } from './object-locks.js';
import { trackIsSelectable } from './track-select.js';
import { getPcbSelection, setPcbSelection } from './selection-registry.js';
import { refreshBoxSelectionHighlights } from './box-select.js';
import { showPcbSelectionProperties } from './selection-interaction.js';
import { renderPcbSelectionAnchors } from './selection-anchors.js';
import { updatePcbCulling } from './component-selection.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../core/pcb-text.js').PcbText} PcbText */
/** @typedef {'component'|'reftext'|'track'|'via'|'pad'|'shape'|'text'|'fill'} PcbSelectionKind */
/** @typedef {import('./selection-registry.js').PcbSelectionValue} PcbSelectionEntry */

/** @param {PcbEditor} app */
export function selectAllPcbObjects(app) {
    window.getSelection?.()?.removeAllRanges();
    /** @type {PcbSelectionEntry[]} */
    const selected = [];
    /**
     * @param {PcbSelectionKind} kind
     * @param {unknown} object
     */
    const add = (kind, object) => {
        if (!isPcbObjectLayerLocked(app, kind, object)) selected.push({ kind, object });
    };
    for (const [componentId] of app.placements) add('component', componentId);
    for (const track of app.tracks) {
        if (trackIsSelectable(track)) add('track', track);
    }
    if (isViaVisible()) {
        for (const via of app.vias) if (via.visible !== false) add('via', via);
    }
    for (const pad of app.pads || []) {
        if (pad.visible !== false) add('pad', pad);
    }
    for (const shape of app.boardShapes) {
        if (shape?.type === 'fill') {
            if (shape.visible !== false && isCopperFillVisible(shape.layer)) add('fill', shape);
        } else if (shape && isLayerVisible(shape.layer)) {
            add('shape', shape);
        }
    }
    for (const text of app.texts.values()) {
        if (isLayerVisible(text.layer)) add('text', text);
    }
    setPcbSelection(app, selected);
    refreshBoxSelectionHighlights(app);
    showPcbSelectionProperties(app);
    app.syncClipboardButtons();
}

/**
 * Select a component, or clear the component selection.
 * @param {PcbEditor} app
 * @param {string|null} compId
 */
export function selectPcbComponent(app, compId) {
    const previousCompId = getPcbSelection(app, 'component')[0] || null;
    if (previousCompId === compId) {
        if (!compId) renderPcbSelectionAnchors(app);
        return;
    }

    if (previousCompId) {
        const oldPlacement = app.placements.get(previousCompId);
        if (oldPlacement?.elements) {
            for (const element of oldPlacement.elements) {
                element.querySelector('.pcb-selection-highlight')?.remove();
            }
        }
    }

    setPcbSelection(app, compId ? [{ kind: 'component', object: compId }] : []);
    app.syncClipboardButtons();

    if (!compId) {
        renderPcbSelectionAnchors(app);
        if (app.viewport) app.viewport.svg.style.cursor = 'default';
        return;
    }

    const placement = app.placements.get(compId);
    if (!placement?.elements?.length) return;

    const bounds = placement.bounds;
    if (!bounds) return;

    const highlight = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    highlight.setAttribute('class', 'pcb-selection-highlight');
    highlight.setAttribute('x', String(bounds.x));
    highlight.setAttribute('y', String(bounds.y));
    highlight.setAttribute('width', String(bounds.width));
    highlight.setAttribute('height', String(bounds.height));
    highlight.setAttribute('fill', 'rgba(51,153,255,0.15)');
    highlight.setAttribute('stroke', '#3399ff');
    highlight.setAttribute('stroke-width', '0.2');
    highlight.setAttribute('pointer-events', 'none');
    placement.elements[0].appendChild(highlight);
    renderPcbSelectionAnchors(app);

    if (app.viewport) app.viewport.svg.style.cursor = placement.locked ? 'default' : 'grab';
    updatePcbCulling(app);
}

/**
 * Select or deselect a free PCB text object.
 * @param {PcbEditor} app
 * @param {object|null} text
 */
export function selectPcbText(app, text) {
    const previous = /** @type {PcbText|null} */ (getPcbSelection(app, 'text')[0] || null);
    const next = /** @type {PcbText|null} */ (text || null);
    if (previous === next || (previous && next && previous.id === next.id)) return;
    setPcbSelection(app, next ? [{ kind: 'text', object: next }] : []);
    app.syncClipboardButtons();
    if (previous && (!next || previous.id !== next.id)) app.refreshText(previous.id);
    if (next) app.refreshText(next.id);
    else renderPcbSelectionAnchors(app);
}
