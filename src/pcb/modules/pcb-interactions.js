/**
 * Every in-progress PCB interaction stored on the editor, in pointer-move priority.
 *
 * The fields stay on the editor; this table is the one list of them. Pointer-move and
 * cancellation handlers are in pcb-interaction-routing.js, keyed by the same fields.
 * This module has no imports so that worker-loaded export code can use its predicates.
 *
 * category
 *   'gesture'  Pointer or inline edit that must finish before another selection action.
 *   'drawing'  Tool-owned session that persists across pans and other gestures.
 * blocksExport
 *   Fabrication export refuses to snapshot while the interaction is active.
 *
 * At most one pointer drag is active at a time; `_pcbSelectionInteraction` can wrap one.
 */
export const PCB_INTERACTIONS = Object.freeze([
    { key: '_boardOutlineResize', category: 'gesture', blocksExport: true },
    { key: '_pasteDrop', category: 'gesture', blocksExport: false },
    { key: '_pcbSelectionInteraction', category: 'gesture', blocksExport: false },
    { key: '_drag', category: 'gesture', blocksExport: false },
    { key: '_groupDrag', category: 'gesture', blocksExport: false },
    { key: '_textDrag', category: 'gesture', blocksExport: false },
    { key: '_shapeDrag', category: 'gesture', blocksExport: true },
    { key: '_refDrag', category: 'gesture', blocksExport: false },
    { key: '_vertexDrag', category: 'gesture', blocksExport: true },
    { key: '_viaDrag', category: 'gesture', blocksExport: true },
    { key: '_fillDrag', category: 'gesture', blocksExport: false },
    { key: '_trackDraw', category: 'drawing', blocksExport: false },
    { key: '_fillDraw', category: 'drawing', blocksExport: false },
    { key: '_shapeDraw', category: 'drawing', blocksExport: false },
    { key: '_textEdit', category: 'gesture', blocksExport: true },
    { key: '_rotationHandleDrag', category: 'gesture', blocksExport: true },
].map(entry => Object.freeze(entry)));

const keysWhere = predicate => Object.freeze(PCB_INTERACTIONS.filter(predicate).map(entry => entry.key));
const GESTURE_KEYS = keysWhere(entry => entry.category === 'gesture');
const DRAWING_KEYS = keysWhere(entry => entry.category === 'drawing');
const EXPORT_BLOCKING_KEYS = keysWhere(entry => entry.blocksExport);

const anyActive = (app, keys) => {
    for (const key of keys) if (app[key]) return true;
    return false;
};

/** A pointer or inline-edit gesture is in progress. */
export const hasPcbGesture = app => anyActive(app, GESTURE_KEYS);

/** A track, fill or shape drawing session is open. */
export const isPcbDrawing = app => anyActive(app, DRAWING_KEYS);

/** An interaction whose transient geometry must not reach fabrication output. */
export const blocksPcbExport = app => anyActive(app, EXPORT_BLOCKING_KEYS);
