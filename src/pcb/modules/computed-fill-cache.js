/** @typedef {ReturnType<typeof import('./copper-fill-geom.js').computeFillPolygons>} FillPolygons */

/** @type {WeakMap<object, FillPolygons>} */
const computedFills = new WeakMap();

/** Last published geometry; the editor may have a pending/failed refresh. Null means none, [] means empty. */
export function getComputedFill(fill) {
    return computedFills.get(fill) ?? null;
}

/** @param {object} fill @param {FillPolygons|null} polygons */
export function setComputedFill(fill, polygons) {
    if (polygons === null) computedFills.delete(fill);
    else computedFills.set(fill, polygons);
}
