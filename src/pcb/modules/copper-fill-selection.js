import { createBoardShapeSelectionAdapter } from './board-shapes.js';
import { fillEditProfile } from './copper-fill-edit.js';
import { isCopperFillLocked, isCopperFillVisible, isLayerLocked } from './layers.js';
import { getPcbSelection, isPcbSelected, registerPcbSelectionAdapter, setPcbSelection } from './selection-registry.js';
import { renderPcbSelectionAnchors } from './selection-anchors.js';
import { renderCopperFill } from './copper-fill-render.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../shapes/copper-fill.js').CopperFill} CopperFill */
/** @typedef {{x: number, y: number}} Point */

/** @param {PcbEditor} app @param {CopperFill} fill @param {string} id */
export function createCopperFillSelectionAdapter(app, fill, id) {
    return createBoardShapeSelectionAdapter(app,
        /** @type {import('../../core/pcb-board-shapes.js').BoardShape} */ (/** @type {unknown} */ (fill)),
        id, /** @type {any} */ (fillEditProfile()));
}

/**
 * Hit-test a world point against any pour region outline.
 * @param {Pick<PcbEditor, 'copperFills'>} app
 * @param {Point} worldPos
 */
export function hitTestFill(app, worldPos) {
    if (!app.copperFills) return null;
    // Topmost (last drawn) first.
    for (let i = app.copperFills.length - 1; i >= 0; i--) {
        const fill = app.copperFills[i];
        if (fill.visible === false || fill.locked) continue;
        if (isLayerLocked(fill.layer)) continue;
        if (isCopperFillLocked(fill.layer) || !isCopperFillVisible(fill.layer)) continue;
        // Only the outline edge (and its vertex nodes) selects a pour —
        // clicking the flooded interior must not, or every board click
        // would grab the fill.
        if (fill.distanceToEdge(worldPos.x, worldPos.y) < 0.6) {
            return fill;
        }
    }
    return null;
}

/**
 * Select (or clear) the active pour and refresh its highlight.
 * @param {PcbEditor} app
 * @param {CopperFill|null} fill
 */
export function selectPcbFill(app, fill) {
    const previous = getPcbSelection(app, 'fill')[0] || null;
    if (previous === fill) {
        if (fill) renderPcbSelectionAnchors(app);
        return;
    }
    const next = fill || null;
    setPcbSelection(app, next ? [{ kind: 'fill', object: next }] : []);
    app.syncClipboardButtons();
    const getGroup = /** @param {string} id */ (id) => app.getLayerGroup(id);
    if (previous) {
        renderCopperFill(previous, getGroup, { selected: false });
    }
    if (next) {
        renderCopperFill(next, getGroup, { selected: true });
        if (isPcbSelected(app, 'fill', next)) renderPcbSelectionAnchors(app);
    }
}

registerPcbSelectionAdapter('fill', createCopperFillSelectionAdapter);
