/**
 * Every in-progress PCB interaction stored for the editor, in pointer-move priority.
 *
 * This table is the one list of interaction slots. Pointer-move and cancellation
 * handlers are in pcb-interaction-routing.js, keyed by the same slots. The slot values
 * live in this module's WeakMap store so worker-loaded export code can use predicates
 * without depending on owner modules.
 *
 * category
 *   'gesture'  Pointer or inline edit that must finish before another selection action.
 *   'drawing'  Tool-owned session that persists across pans and other gestures.
 * blocksExport
 *   Fabrication export refuses to snapshot while the interaction is active.
 *
 * At most one pointer drag is active at a time; `_pcbSelectionInteraction` can wrap one.
 * Ending one notes the edit settled (refresh-state.js), so refreshes it held back resume.
 * The only import is refresh-state.js, itself import-free.
 */
import { noteEditSettled } from './refresh-state.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {{key: string, category: string, blocksExport: boolean, owner: string}} PcbInteractionEntry */
/** @typedef {Record<string, any>} PcbInteractionSlotState */

/** @type {readonly Readonly<PcbInteractionEntry>[]} */
export const PCB_INTERACTIONS = Object.freeze([
    { key: '_boardOutlineResize', category: 'gesture', blocksExport: true, owner: 'board-outline-resize.js' },
    { key: '_pasteDrop', category: 'gesture', blocksExport: false, owner: 'pcb-paste.js' },
    { key: '_pcbSelectionInteraction', category: 'gesture', blocksExport: false, owner: 'selection-interaction.js' },
    { key: '_drag', category: 'gesture', blocksExport: false, owner: 'component-selection.js' },
    { key: '_groupDrag', category: 'gesture', blocksExport: false, owner: 'box-select.js' },
    { key: '_textDrag', category: 'gesture', blocksExport: false, owner: 'pcb-text-selection.js' },
    { key: '_shapeDrag', category: 'gesture', blocksExport: true, owner: 'board-shapes.js' },
    { key: '_refDrag', category: 'gesture', blocksExport: false, owner: 'ref-text-selection.js' },
    { key: '_vertexDrag', category: 'gesture', blocksExport: true, owner: 'track-drag.js' },
    { key: '_viaDrag', category: 'gesture', blocksExport: true, owner: 'track-drag.js' },
    { key: '_trackDraw', category: 'drawing', blocksExport: false, owner: 'track-draw.js' },
    { key: '_fillDraw', category: 'drawing', blocksExport: false, owner: 'copper-fill-draw.js' },
    { key: '_shapeDraw', category: 'drawing', blocksExport: false, owner: 'board-shapes.js' },
    { key: '_textEdit', category: 'gesture', blocksExport: true, owner: 'text-inline-edit.js' },
    { key: '_rotationHandleDrag', category: 'gesture', blocksExport: true, owner: 'rotation-handle.js' },
].map(entry => Object.freeze(entry)));

const INTERACTION_KEYS = new Set(PCB_INTERACTIONS.map(entry => entry.key));
/** @param {(entry: Readonly<PcbInteractionEntry>) => boolean} predicate */
const keysWhere = predicate => Object.freeze(PCB_INTERACTIONS.filter(predicate).map(entry => entry.key));
const GESTURE_KEYS = keysWhere(entry => entry.category === 'gesture');
const DRAWING_KEYS = keysWhere(entry => entry.category === 'drawing');
const EXPORT_BLOCKING_KEYS = keysWhere(entry => entry.blocksExport);
/** @type {WeakMap<PcbEditor, PcbInteractionSlotState>} */
const interactionState = new WeakMap();

/** @param {PcbEditor} app */
function slotState(app) {
    let state = interactionState.get(app);
    if (!state) {
        state = Object.create(null);
        interactionState.set(app, /** @type {PcbInteractionSlotState} */ (state));
    }
    return /** @type {PcbInteractionSlotState} */ (state);
}

/** @param {string} key */
function assertInteractionKey(key) {
    if (!INTERACTION_KEYS.has(key)) throw new Error(`Unknown PCB interaction slot ${key}.`);
}

/**
 * Return one interaction slot's value, or null when inactive.
 * @param {PcbEditor} app
 * @param {string} key
 * @returns {any}
 */
export function getPcbInteraction(app, key) {
    assertInteractionKey(key);
    return interactionState.get(app)?.[key] || null;
}

/**
 * Set one interaction slot. Passing null/undefined/false clears the slot.
 * @param {PcbEditor} app
 * @param {string} key
 * @param {any} value
 */
export function setPcbInteraction(app, key, value) {
    assertInteractionKey(key);
    const state = slotState(app);
    if (value) {
        state[key] = value;
    } else if (key in state) {
        delete state[key];
        noteEditSettled(app);
    }
}

/** @param {PcbEditor} app @param {readonly string[]} keys */
const anyActive = (app, keys) => {
    const state = interactionState.get(app);
    if (!state) return false;
    const slots = /** @type {PcbInteractionSlotState} */ (state);
    for (const key of keys) if (slots[key]) return true;
    return false;
};

/**
 * A pointer or inline-edit gesture is in progress.
 * @param {PcbEditor} app
 */
export const hasPcbGesture = app => anyActive(app, GESTURE_KEYS);

/**
 * A track, fill or shape drawing session is open.
 * @param {PcbEditor} app
 */
export const isPcbDrawing = app => anyActive(app, DRAWING_KEYS);

/**
 * An interaction whose transient geometry must not reach fabrication output.
 * @param {PcbEditor} app
 */
export const blocksPcbExport = app => anyActive(app, EXPORT_BLOCKING_KEYS);
