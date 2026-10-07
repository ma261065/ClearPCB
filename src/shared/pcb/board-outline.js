import { shapeOutline } from './board-shape-geometry.js';
import { validClosedShape } from '../../shapes/closed-outline.js';

const dimensionPreviews = new WeakMap();

export function getBoardDimensionPreview(app) {
    return dimensionPreviews.get(app);
}

export function setBoardDimensionPreview(app, preview) {
    dimensionPreviews.set(app, preview);
}

export function clearBoardDimensionPreview(app) {
    const preview = dimensionPreviews.get(app);
    dimensionPreviews.delete(app);
    return preview;
}

/**
 * The editor's rectangular board dimensions (mm), exactly as stored; undefined until set.
 * @param {any} app
 * @returns {{width: number, height: number, radius: number}}
 */
export function boardDimensions(app) {
    const preview = getBoardDimensionPreview(app);
    const board = preview ? preview.board : app.pcbDocument ? app.pcbDocument.board : app.board || app;
    return {
        width: board.width !== undefined ? board.width : app.boardWidth,
        height: board.height !== undefined ? board.height : app.boardHeight,
        radius: board.radius !== undefined ? board.radius : app.boardRadius,
    };
}

export function getBoardOutline(app) {
    return app.boardShapes?.find(shape => shape.layer === 'board-outline') || null;
}

export function rectangleBoardOutline(width, height, radius = 0) {
    return { id: 'board-outline', kind: 'rect', layer: 'board-outline', lineWidth: 0.2,
        filled: false, cornerRadius: radius,
        points: [{ x: 0, y: -height }, { x: width, y: -height }, { x: width, y: 0 }, { x: 0, y: 0 }] };
}

export function validBoardOutline(shape) {
    return shape?.layer === 'board-outline' && validClosedShape(shape, { minArea: 1e-6 });
}

export function boardBoundary(app) {
    const shape = getBoardOutline(app);
    const { width, height, radius } = boardDimensions(app);
    if (!shape) return { x: 0, y: -(height || 80),
        w: width || 100,
        h: height || 80,
        r: radius || 0, points: null };
    const points = shapeOutline(shape);
    const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
    const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y));
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, r: 0, points };
}

export function syncBoardOutlineDimensions(app) {
    app.pcbDocument.syncBoardOutlineDimensions();
}