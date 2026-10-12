/** @typedef {ReturnType<typeof import('./copper-fill-geom.js').computeFillPolygons>} FillPolygons */
/** @typedef {import('../../shapes/copper-fill.js').CopperFill} CopperFill */

/** @type {WeakMap<object, FillPolygons>} */
const computedFills = new WeakMap();

/** Last published geometry; the editor may have a pending/failed refresh. Null means none, [] means empty. */
/** @param {CopperFill} fill */
export function getComputedFill(fill) {
    return computedFills.get(fill) ?? null;
}

/** @param {object} fill @param {FillPolygons|null} polygons */
export function setComputedFill(fill, polygons) {
    if (polygons === null) computedFills.delete(fill);
    else computedFills.set(fill, polygons);
}
