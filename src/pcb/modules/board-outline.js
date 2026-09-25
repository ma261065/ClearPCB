import { shapeOutline } from './board-shape-geometry.js';
import ClipperLib from '../../../assets/vendor/clipper.esm.js';

export function getBoardOutline(app) {
    return app.boardShapes?.find(shape => shape.layer === 'board-outline') || null;
}

export function rectangleBoardOutline(width, height, radius = 0) {
    return { id: 'board-outline', kind: 'rect', layer: 'board-outline', lineWidth: 0.2,
        filled: false, cornerRadius: radius,
        points: [{ x: 0, y: -height }, { x: width, y: -height }, { x: width, y: 0 }, { x: 0, y: 0 }] };
}

export function validBoardOutline(shape) {
    if (!shape || shape.layer !== 'board-outline' || !['rect', 'polygon', 'circle'].includes(shape.kind)) return false;
    if (shape.kind === 'circle') return Number.isFinite(shape.x) && Number.isFinite(shape.y)
        && Number.isFinite(shape.radius) && shape.radius > 0;
    if (!Array.isArray(shape.points) || shape.points.length < 3
        || (shape.kind === 'rect' && shape.points.length !== 4)
        || shape.points.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) return false;
    if (shape.points.some((point, index) => {
        const next = shape.points[(index + 1) % shape.points.length];
        return Math.hypot(next.x - point.x, next.y - point.y) < 1e-9;
    })) return false;
    const points = shapeOutline(shape);
    let area = 0;
    for (let index = 0; index < points.length; index++) {
        const start = points[index], end = points[(index + 1) % points.length];
        area += start.x * end.y - end.x * start.y;
    }
    if (!Number.isFinite(area) || Math.abs(area) <= 1e-6) return false;
    const path = points.map(point => ({ X: Math.round(point.x * 10000), Y: Math.round(point.y * 10000) }));
    const simple = ClipperLib.Clipper.SimplifyPolygon(path, ClipperLib.PolyFillType.pftNonZero);
    return simple.length === 1 && Math.abs(Math.abs(ClipperLib.Clipper.Area(path))
        - Math.abs(ClipperLib.Clipper.Area(simple[0]))) < 1;
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