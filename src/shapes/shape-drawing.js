import { circumcircle } from '../core/geometry.js';
import { projectArcBulge } from './arc-edit.js';
import { pointsBounds } from './path-geometry.js';

export const DRAWING_SHAPES = new Set(['line', 'polygon', 'rect', 'circle', 'arc']);
const round = value => Math.round(value * 10000) / 10000;

export function advanceShapeDrawing(kind, points, point) {
    const next = [...points, { x: point.x, y: point.y }];
    const count = kind === 'arc' ? 3 : kind === 'rect' || kind === 'circle' ? 2 : Infinity;
    return { points: next, complete: next.length >= count };
}

export function canFinishShapeAtPoint(kind, points) {
    return kind === 'line' || kind === 'polygon'
        || (kind === 'arc' ? points.length === 2 : points.length === 1);
}

export function dedupePathPoints(points, closed = false) {
    const result = [];
    for (const point of points) {
        const previous = result.at(-1);
        if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 1e-4) continue;
        result.push({ x: point.x, y: point.y });
    }
    if (closed && result.length >= 2 && Math.hypot(result[0].x - result.at(-1).x, result[0].y - result.at(-1).y) < 1e-4) result.pop();
    return result;
}

export function shapeFromPoints(kind, points, preview = false) {
    const [first, second, third] = points;
    if (!first) return null;
    if (kind === 'line' || kind === 'polygon') {
        const cleaned = preview ? points.map(point => ({ ...point })) : dedupePathPoints(points, kind === 'polygon');
        if (!preview && (cleaned.length < (kind === 'line' ? 2 : 3)
            || kind === 'line' && cleaned.every(point => Math.hypot(point.x - first.x, point.y - first.y) < 0.05))) return null;
        return { kind, points: cleaned };
    }
    if (!second) return null;
    if (kind === 'rect') {
        const minX = Math.min(first.x, second.x), maxX = Math.max(first.x, second.x);
        const minY = Math.min(first.y, second.y), maxY = Math.max(first.y, second.y);
        if (!preview && (maxX - minX < 0.05 || maxY - minY < 0.05)) return null;
        return { kind, points: [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }] };
    }
    if (kind === 'circle') {
        const radius = Math.hypot(second.x - first.x, second.y - first.y);
        return !preview && radius < 0.05 ? null : { kind, x: first.x, y: first.y, radius };
    }
    if (kind === 'arc') {
        if (!third || !preview && Math.hypot(second.x - first.x, second.y - first.y) < 0.05) return null;
        return { kind, start: { ...first }, end: { ...second }, bulge: projectArcBulge(first, second, third) };
    }
    return null;
}

export function primitiveShapePath(shape, close = false) {
    if (shape.kind === 'arc') {
        const circle = circumcircle(shape.start, shape.bulge, shape.end);
        if (!circle) return `M ${round(shape.start.x)} ${round(shape.start.y)} L ${round(shape.end.x)} ${round(shape.end.y)}`;
        const cross = (shape.end.x - shape.start.x) * (shape.bulge.y - shape.start.y)
            - (shape.end.y - shape.start.y) * (shape.bulge.x - shape.start.x);
        const radius = round(circle.radius);
        return `M ${round(shape.start.x)} ${round(shape.start.y)} A ${radius} ${radius} 0 0 ${cross > 0 ? 0 : 1} ${round(shape.end.x)} ${round(shape.end.y)}${close ? ' Z' : ''}`;
    }
    if (shape.kind === 'circle') {
        const radius = Math.max(0.05, Number(shape.radius) || 0);
        return `M ${round(shape.x - radius)} ${round(shape.y)}`
            + ` A ${round(radius)} ${round(radius)} 0 1 0 ${round(shape.x + radius)} ${round(shape.y)}`
            + ` A ${round(radius)} ${round(radius)} 0 1 0 ${round(shape.x - radius)} ${round(shape.y)} Z`;
    }
    const points = shape.points || [];
    if (!points.length) return '';
    if (shape.kind === 'rect' && shape.cornerRadius > 0) {
        const { minX, minY, maxX, maxY } = pointsBounds(points);
        const radius = Math.min(shape.cornerRadius, (maxX - minX) / 2, (maxY - minY) / 2);
        return `M ${round(minX + radius)} ${round(minY)}`
            + ` L ${round(maxX - radius)} ${round(minY)} A ${round(radius)} ${round(radius)} 0 0 1 ${round(maxX)} ${round(minY + radius)}`
            + ` L ${round(maxX)} ${round(maxY - radius)} A ${round(radius)} ${round(radius)} 0 0 1 ${round(maxX - radius)} ${round(maxY)}`
            + ` L ${round(minX + radius)} ${round(maxY)} A ${round(radius)} ${round(radius)} 0 0 1 ${round(minX)} ${round(maxY - radius)}`
            + ` L ${round(minX)} ${round(minY + radius)} A ${round(radius)} ${round(radius)} 0 0 1 ${round(minX + radius)} ${round(minY)} Z`;
    }
    return `M ${points[0].x} ${points[0].y}` + points.slice(1).map(point => ` L ${point.x} ${point.y}`).join('')
        + (shape.kind === 'line' ? '' : ' Z');
}

export function shapePreviewPath(kind, points, cursor, cornerRadius = 0) {
    if (!points.length) return '';
    if (kind === 'arc' && points.length === 1) return primitiveShapePath({ kind: 'line', points: [points[0], cursor] });
    const geometry = shapeFromPoints(kind, [...points, cursor], true);
    return geometry ? primitiveShapePath({ ...geometry, cornerRadius }) : '';
}