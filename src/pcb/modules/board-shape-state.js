/**
 * Board-shape editor state owned here rather than as `app._…` fields: the refined
 * node or segment focus within the selected shape, the hovered shapes, and the
 * shape tools' defaults. Kept per editor in a WeakMap. No imports, like
 * refresh-state.js, so any module (including selection plumbing) can read it.
 *
 * Node focus is `{ shapeId, index }`; segment focus is `{ shapeId, segment }`.
 */
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */

const states = new WeakMap();

/** @param {PcbEditor} app */
function state(app) {
    let current = states.get(app);
    if (!current) {
        states.set(app, current = {
            node: null, segment: null, hovered: null, netHovered: new Set(), defaults: { lineWidth: 0.2 },
        });
    }
    return current;
}

/** @param {PcbEditor} app */
export function getBoardShapeNodeFocus(app) { return state(app).node; }
/** @param {PcbEditor} app */
export function setBoardShapeNodeFocus(app, focus) { state(app).node = focus || null; }
/** @param {PcbEditor} app */
export function getBoardShapeSegmentFocus(app) { return state(app).segment; }
/** @param {PcbEditor} app */
export function setBoardShapeSegmentFocus(app, focus) { state(app).segment = focus || null; }

/** @param {PcbEditor} app */
export function getHoveredBoardShape(app) { return state(app).hovered; }
/** @param {PcbEditor} app */
export function setHoveredBoardShape(app, shape) { state(app).hovered = shape || null; }
/**
 * IDs of shapes highlighted because they share the hovered net.
 * @param {PcbEditor} app
 */
export function getNetHoveredShapeIds(app) { return state(app).netHovered; }
/** @param {PcbEditor} app */
export function setNetHoveredShapeIds(app, ids) { state(app).netHovered = ids || new Set(); }

/**
 * Tool defaults for new shapes; callers update fields in place.
 * @param {PcbEditor} app
 */
export function getShapeDefaults(app) { return state(app).defaults; }
/** @param {PcbEditor} app */
export function setShapeDefaults(app, defaults) { state(app).defaults = defaults; }
