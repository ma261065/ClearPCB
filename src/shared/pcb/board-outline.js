import { shapeOutline } from './board-shape-geometry.js';
import { validClosedShape } from '../../shapes/closed-outline.js';

/**
 * The editor's rectangular board dimensions (mm), exactly as stored; undefined until set.
 * @param {any} app
 * @returns {{width: number, height: number, radius: number}}
 */
export function boardDimensions(app) {
    return { width: app._boardWidth, height: app._boardHeight, radius: app._boardRadius };
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
    if (!shape) return { x: 0, y: -(app._boardHeight || app.boardHeight || app.board?.height || 80),
        w: app._boardWidth || app.boardWidth || app.board?.width || 100,
        h: app._boardHeight || app.boardHeight || app.board?.height || 80,
        r: app._boardRadius || app.boardRadius || app.board?.radius || 0, points: null };
    const points = shapeOutline(shape);
    const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
    const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y));
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, r: 0, points };
}

export function syncBoardOutlineDimensions(app) {
    app.pcbDocument.syncBoardOutlineDimensions();
}