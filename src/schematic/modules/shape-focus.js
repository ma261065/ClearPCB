/**
 * The refined node or segment focus within the selected schematic shape, owned here
 * rather than as `app._…` fields — the counterpart of pcb/modules/board-shape-state.js.
 * Kept per editor in a WeakMap. No imports, so any module (including the view and
 * selection plumbing) can read it.
 *
 * Node focus is `{ shapeId, nodeId }`; segment focus is `{ shapeId, edgeId }`.
 */

const states = new WeakMap();

function state(app) {
    let current = states.get(app);
    if (!current) states.set(app, current = { node: null, segment: null });
    return current;
}

export function getShapeNodeFocus(app) { return state(app).node; }
export function setShapeNodeFocus(app, focus) { state(app).node = focus || null; }
export function getShapeSegmentFocus(app) { return state(app).segment; }
export function setShapeSegmentFocus(app, focus) { state(app).segment = focus || null; }
