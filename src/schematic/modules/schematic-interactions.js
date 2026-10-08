/**
 * Every in-progress schematic interaction, in cancellation
 * priority — the counterpart of pcb/modules/pcb-interactions.js, with the same
 * categories. This table is the one list of interaction slots. Pointer/cancel
 * handlers are in schematic-interaction-routing.js, keyed by the same slots. The
 * slot values live in this module's WeakMap store so snapshot/export guards can
 * use predicates without depending on owner modules.
 *
 * category
 *   'gesture'  Pointer, inline or placement edit that must finish before another
 *              selection action (delete, nudge, flip, rotate, clipboard, select all).
 *   'drawing'  Tool-owned drawing session (shape or wire) that persists across pans.
 * blocksSnapshot
 *   Save, autosave and MCP snapshots refuse to run while it is active, because it
 *   has changed the authored entities (previews edit them in place) or will add some.
 *
 * `drag` covers anchor, segment and move drags and box selection; `interactionState`
 * says which. The Properties panel's live preview is the other edit that blocks
 * snapshots; properties.js owns it.
 *
 * Keep this module import-free. Owner modules expose intent APIs and are the only
 * modules that write their slots.
 */
export const SCHEMATIC_INTERACTIONS = Object.freeze([
    { key: 'textEdit', category: 'gesture', blocksSnapshot: true, owner: 'text-edit.js' },
    { key: 'overlapCyclePress', category: 'gesture', blocksSnapshot: false, owner: 'draw-states.js' },
    { key: 'drag', category: 'gesture', blocksSnapshot: true, owner: 'drag.js' },
    { key: 'pendingAnchorDrag', category: 'gesture', blocksSnapshot: true, owner: 'drag.js' },
    { key: 'isDrawing', category: 'drawing', blocksSnapshot: true, owner: 'drawing.js' },
    { key: 'pastingClipboard', category: 'gesture', blocksSnapshot: true, owner: 'clipboard.js' },
    { key: 'placingComponent', category: 'gesture', blocksSnapshot: true, owner: 'components.js' },
].map(entry => Object.freeze(entry)));

const INTERACTION_KEYS = new Set(SCHEMATIC_INTERACTIONS.map(entry => entry.key));
const keysWhere = predicate => Object.freeze(SCHEMATIC_INTERACTIONS.filter(predicate).map(entry => entry.key));
const ALL_KEYS = keysWhere(() => true);
const GESTURE_KEYS = keysWhere(entry => entry.category === 'gesture');
const DRAWING_KEYS = keysWhere(entry => entry.category === 'drawing');
const SNAPSHOT_BLOCKING_KEYS = keysWhere(entry => entry.blocksSnapshot);
const interactionState = new WeakMap();

/** @param {any} app */
function slotState(app) {
    let state = interactionState.get(app);
    if (!state) {
        state = Object.create(null);
        interactionState.set(app, state);
    }
    return state;
}

function assertInteractionKey(key) {
    if (!INTERACTION_KEYS.has(key)) throw new Error(`Unknown schematic interaction slot ${key}.`);
}

/**
 * Return one schematic interaction slot's value, or null when inactive.
 * @param {any} app
 * @param {string} key
 * @returns {any}
 */
export function getSchematicInteraction(app, key) {
    assertInteractionKey(key);
    return interactionState.get(app)?.[key] || null;
}

/**
 * Set one schematic interaction slot. Passing null/undefined/false clears it.
 * @param {any} app
 * @param {string} key
 * @param {any} value
 */
export function setSchematicInteraction(app, key, value) {
    assertInteractionKey(key);
    const state = slotState(app);
    if (value) {
        state[key] = value;
    } else {
        delete state[key];
    }
}

/**
 * @param {any} app
 * @param {string} key
 */
export function schematicInteractionActive(app, key) {
    return !!getSchematicInteraction(app, key);
}

const anyActive = (app, keys) => {
    const state = interactionState.get(app);
    if (!state) return false;
    for (const key of keys) if (state[key]) return true;
    return false;
};

/** A pointer, inline-text, paste or placement edit is in progress. */
export const hasSchematicGesture = app => anyActive(app, GESTURE_KEYS);

/** A shape or wire drawing session is open. */
export const isSchematicDrawing = app => anyActive(app, DRAWING_KEYS);

/** Any interaction at all is in progress. */
export const hasSchematicInteraction = app => anyActive(app, ALL_KEYS);

/** An interaction whose transient state must not reach a saved snapshot. */
export const blocksSchematicSnapshot = app => anyActive(app, SNAPSHOT_BLOCKING_KEYS);

/** The active interaction with the highest cancellation priority, or null. */
export function activeSchematicInteraction(app) {
    for (const key of ALL_KEYS) {
        if (schematicInteractionActive(app, key)) return key;
    }
    return null;
}
