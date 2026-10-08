/**
 * Owns the PCB clipboard payload and copy/cut/paste entry points.
 */
import { serializePcbText } from '../../core/pcb-text.js';
import { getPcbSelection } from './selection-registry.js';
import { isPcbObjectLocked } from './object-locks.js';
import { preparePcbPaste, beginPcbPaste, cancelPcbPaste, isPcbPasteActive } from './pcb-paste.js';
import { deleteBoxSelection } from './box-select.js';
import { showComponentPopup } from './component-selection.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../shapes/track.js').Track} Track */
/** @typedef {import('../../shapes/via.js').Via} Via */
/** @typedef {import('../../shapes/pad.js').Pad} Pad */
/** @typedef {import('../../shapes/copper-fill.js').CopperFill} CopperFill */
/** @typedef {'component'|'reftext'|'track'|'via'|'pad'|'shape'|'text'|'fill'} PcbSelectionKind */
/** @typedef {{tracks: ReturnType<Track['toJSON']>[], vias: ReturnType<Via['toJSON']>[], pads: ReturnType<Pad['toJSON']>[],
 *   shapes: any[], texts: ReturnType<typeof serializePcbText>[], fills: ReturnType<CopperFill['captureState']>[]}} PcbClipboardPayload */

/** @type {WeakMap<PcbEditor, PcbClipboardPayload|null>} */
const clipboards = new WeakMap();

/** @param {PcbClipboardPayload|null} clipboard */
function hasData(clipboard) {
    return !!clipboard && (
        (clipboard.tracks?.length || 0) > 0
        || (clipboard.vias?.length || 0) > 0
        || (clipboard.pads?.length || 0) > 0
        || (clipboard.shapes?.length || 0) > 0
        || (clipboard.texts?.length || 0) > 0
        || (clipboard.fills?.length || 0) > 0
    );
}

/** @param {PcbEditor} app @param {PcbClipboardPayload|null} payload */
export function setPcbClipboard(app, payload) {
    clipboards.set(app, payload);
}

/** @param {PcbEditor} app */
export function hasPcbClipboardData(app) {
    return hasData(clipboards.get(app) || null);
}

/** @param {PcbEditor} app */
export function canCopyCutPcbSelection(app) {
    return getPcbSelection(app, 'track').length > 0
        || getPcbSelection(app, 'via').length > 0
        || getPcbSelection(app, 'pad').length > 0
        || getPcbSelection(app, 'shape').some(/** @param {any} shape */ (shape) => shape.layer !== 'board-outline')
        || getPcbSelection(app, 'text').length > 0
        || getPcbSelection(app, 'fill').length > 0;
}

/**
 * Build a clipboard payload from current PCB selection.
 * @param {PcbEditor} app
 * @param {{unlockedOnly?: boolean}} [options]
 */
export function capturePcbClipboardSelection(app, { unlockedOnly = false } = {}) {
    /** @type {PcbClipboardPayload} */
    const payload = { tracks: [], vias: [], pads: [], shapes: [], texts: [], fills: [] };
    /**
     * @param {PcbSelectionKind} kind
     * @returns {any[]}
     */
    const selected = kind => getPcbSelection(app, kind)
        .filter(/** @param {any} object */ (object) => !unlockedOnly || !isPcbObjectLocked(app, kind, object));
    for (const track of selected('track')) payload.tracks.push(track.toJSON());
    for (const via of selected('via')) payload.vias.push(via.toJSON());
    for (const pad of selected('pad')) payload.pads.push(pad.toJSON());
    for (const shape of selected('shape')) {
        if (shape.layer !== 'board-outline') payload.shapes.push(JSON.parse(JSON.stringify(shape)));
    }
    for (const text of selected('text')) payload.texts.push(serializePcbText(text));
    for (const fill of selected('fill')) payload.fills.push(fill.captureState());
    return hasData(payload) ? payload : null;
}

/**
 * Copy currently-selected PCB entities.
 * @param {PcbEditor} app
 * @param {{unlockedOnly?: boolean}} [options]
 */
export function copyPcbSelection(app, options) {
    const payload = capturePcbClipboardSelection(app, options);
    if (!payload) {
        const componentId = getPcbSelection(app, 'component')[0] || getPcbSelection(app, 'reftext')[0];
        if (componentId) {
            showComponentPopup(app, componentId,
                "Components can't be copied from PCB. Copy them in the schematic editor.");
        }
        app.syncClipboardButtons();
        return false;
    }
    setPcbClipboard(app, payload);
    app.syncClipboardButtons();
    return true;
}

/** @param {PcbEditor} app */
export function cutPcbSelection(app) {
    if (isPcbPasteActive(app)) {
        cancelPcbPaste(app);
        return true;
    }
    if (!copyPcbSelection(app, { unlockedOnly: true })) return false;
    const deleted = deleteBoxSelection(app);
    if (deleted) app.clearProperties();
    app.syncClipboardButtons();
    return deleted;
}

/** @param {PcbEditor} app */
export function pastePcbSelection(app) {
    const clipboard = clipboards.get(app) || null;
    if (!hasData(clipboard)) {
        app.syncClipboardButtons();
        return false;
    }
    const pasted = preparePcbPaste(app, clipboard);
    const started = beginPcbPaste(app, pasted);
    app.syncClipboardButtons();
    return started;
}
