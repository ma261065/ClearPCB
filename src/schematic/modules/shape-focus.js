/**
 * The refined node or segment focus within the selected schematic shape, owned here
 * rather than as `app._…` fields — the counterpart of pcb/modules/board-shape-state.js.
 * Kept per editor in a WeakMap. No imports, so any module (including the view and
 * selection plumbing) can read it.
 *
 * Node focus is `{ shapeId, nodeId }`; segment focus is `{ shapeId, edgeId }`.
 */
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {{shapeId: string, nodeId?: string, edgeId?: string}|null} ShapeFocus */

const states = new WeakMap();

/** @param {SchematicEditor} app */
function state(app) {
    let current = states.get(app);
    if (!current) states.set(app, current = { node: null, segment: null });
    return current;
}

/** @param {SchematicEditor} app */
export function getShapeNodeFocus(app) { return state(app).node; }
/** @param {SchematicEditor} app @param {ShapeFocus} focus */
export function setShapeNodeFocus(app, focus) { state(app).node = focus || null; }
/** @param {SchematicEditor} app */
export function getShapeSegmentFocus(app) { return state(app).segment; }
/** @param {SchematicEditor} app @param {ShapeFocus} focus */
export function setShapeSegmentFocus(app, focus) { state(app).segment = focus || null; }
