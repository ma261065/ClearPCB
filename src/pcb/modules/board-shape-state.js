/**
 * Board-shape editor state owned here rather than as `app._…` fields: the refined
 * node or segment focus within the selected shape, the hovered shapes, and the
 * shape tools' defaults. Kept per editor in a WeakMap. No imports, like
 * refresh-state.js, so any module (including selection plumbing) can read it.
 *
 * Node focus is `{ shapeId, index }`; segment focus is `{ shapeId, segment }`.
 */

const states = new WeakMap();

function state(app) {
    let current = states.get(app);
    if (!current) {
        states.set(app, current = {
            node: null, segment: null, hovered: null, netHovered: new Set(), defaults: { lineWidth: 0.2 },
        });
    }
    return current;
}

export function getBoardShapeNodeFocus(app) { return state(app).node; }
export function setBoardShapeNodeFocus(app, focus) { state(app).node = focus || null; }
export function getBoardShapeSegmentFocus(app) { return state(app).segment; }
export function setBoardShapeSegmentFocus(app, focus) { state(app).segment = focus || null; }

export function getHoveredBoardShape(app) { return state(app).hovered; }
export function setHoveredBoardShape(app, shape) { state(app).hovered = shape || null; }
/** IDs of shapes highlighted because they share the hovered net. */
export function getNetHoveredShapeIds(app) { return state(app).netHovered; }
export function setNetHoveredShapeIds(app, ids) { state(app).netHovered = ids || new Set(); }

/** Tool defaults for new shapes; callers update fields in place. */
export function getShapeDefaults(app) { return state(app).defaults; }
export function setShapeDefaults(app, defaults) { state(app).defaults = defaults; }
