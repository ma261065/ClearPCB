/** @typedef {ReturnType<typeof import('./copper-fill-geom.js').computeFillPolygons>} FillPolygons */

/** @type {WeakMap<object, FillPolygons>} */
const computedFills = new WeakMap();

/** Null means pending/failed; an empty array is a successfully computed empty pour. */
export function getComputedFill(fill) {
    return computedFills.get(fill) ?? null;
}

/** @param {object} fill @param {FillPolygons|null} polygons */
export function setComputedFill(fill, polygons) {
    if (polygons === null) computedFills.delete(fill);
    else computedFills.set(fill, polygons);
}
