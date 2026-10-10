export const GRID_SNAP_PX = 8;

/** @param {number} gridSize @param {number|undefined} scale */
export function gridSnapTolerance(gridSize, scale) {
    return Math.min(GRID_SNAP_PX / Math.max(0.01, scale || 1), gridSize * 0.4);
}

/** @typedef {{x:number, y:number}} Point */
/** @typedef {{snapToGrid?:boolean, shiftHeld?:boolean, gridVisible?:boolean, gridSize:number, scale?:number, getEffectiveGridSize?:() => number}} GridViewport */

/** Shared displayed-grid magnet, including visibility and the temporary Shift override. */
/**
 * @param {Point} point
 * @param {GridViewport|null|undefined} viewport
 * @returns {Point}
 */
export function snapToViewportGrid(point, viewport) {
    let shouldSnap = viewport?.snapToGrid;
    if (viewport?.shiftHeld && viewport.gridVisible) shouldSnap = !shouldSnap;
    if (!shouldSnap || !viewport?.gridVisible) return point;
    const spacing = viewport.getEffectiveGridSize?.() ?? viewport.gridSize;
    const { x, y } = snapToGridLines(point, spacing, viewport.scale);
    return { x, y };
}

/**
 * @param {Point} point
 * @param {number} gridSize
 * @param {number|undefined} scale
 * @returns {Point & {snappedX:boolean, snappedY:boolean}}
 */
export function snapToGridLines(point, gridSize, scale) {
    if (!(gridSize > 0)) return { x: point.x, y: point.y, snappedX: false, snappedY: false };
    const tolerance = gridSnapTolerance(gridSize, scale);
    const gridX = Math.round(point.x / gridSize) * gridSize;
    const gridY = Math.round(point.y / gridSize) * gridSize;
    const snappedX = Math.abs(gridX - point.x) <= tolerance;
    const snappedY = Math.abs(gridY - point.y) <= tolerance;
    return {
        x: snappedX ? gridX : point.x,
        y: snappedY ? gridY : point.y,
        snappedX,
        snappedY,
    };
}