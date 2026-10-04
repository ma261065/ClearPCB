/**
 * Every in-progress schematic interaction stored on the editor, in cancellation
 * priority — the counterpart of pcb/modules/pcb-interactions.js, with the same
 * categories. The fields stay on the editor; this table is the one list of them.
 * Their cancel handlers are in schematic-interaction-routing.js, keyed by the same
 * fields. No imports, so any module can use the predicates.
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
 */
export const SCHEMATIC_INTERACTIONS = Object.freeze([
    { key: 'textEdit', category: 'gesture', blocksSnapshot: true },
    { key: '_overlapCyclePress', category: 'gesture', blocksSnapshot: false },
    { key: 'drag', category: 'gesture', blocksSnapshot: true },
    { key: 'pendingAnchorDrag', category: 'gesture', blocksSnapshot: true },
    { key: 'isDrawing', category: 'drawing', blocksSnapshot: true },
    { key: 'pastingClipboard', category: 'gesture', blocksSnapshot: true },
    { key: 'placingComponent', category: 'gesture', blocksSnapshot: true },
].map(entry => Object.freeze(entry)));

const keysWhere = predicate => Object.freeze(SCHEMATIC_INTERACTIONS.filter(predicate).map(entry => entry.key));
const ALL_KEYS = keysWhere(() => true);
const GESTURE_KEYS = keysWhere(entry => entry.category === 'gesture');
const DRAWING_KEYS = keysWhere(entry => entry.category === 'drawing');
const SNAPSHOT_BLOCKING_KEYS = keysWhere(entry => entry.blocksSnapshot);

const anyActive = (app, keys) => {
    for (const key of keys) if (app[key]) return true;
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
    for (const key of ALL_KEYS) if (app[key]) return key;
    return null;
}
