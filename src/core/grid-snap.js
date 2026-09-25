export const GRID_SNAP_PX = 8;

export function snapToGridLines(point, gridSize, scale) {
    if (!(gridSize > 0)) return { x: point.x, y: point.y, snappedX: false, snappedY: false };
    const tolerance = GRID_SNAP_PX / Math.max(0.01, scale || 1);
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