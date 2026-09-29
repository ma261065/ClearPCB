import { shapeOutline } from './board-shape-geometry.js';
import { validClosedShape } from '../../shapes/closed-outline.js';

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
    if (!shape) return { x: 0, y: -(app._boardHeight || app.boardHeight || 80),
        w: app._boardWidth || app.boardWidth || 100, h: app._boardHeight || app.boardHeight || 80,
        r: app._boardRadius || app.boardRadius || 0, points: null };
    const points = shapeOutline(shape);
    const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
    const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y));
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, r: 0, points };
}

export function syncBoardOutlineDimensions(app) {
    const bounds = boardBoundary(app);
    app._boardWidth = bounds.w;
    app._boardHeight = bounds.h;
    app._boardRadius = getBoardOutline(app)?.cornerRadius || 0;
}