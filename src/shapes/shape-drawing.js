import { circumcircle } from '../core/geometry.js';
import { projectArcBulge } from './arc-edit.js';
import { pointsBounds } from './path-geometry.js';

/** @typedef {{x: number, y: number}} Point */
/** @typedef {'line'|'polygon'|'rect'|'circle'|'arc'} DrawingKind */
/** @typedef {{kind: DrawingKind, points?: Point[], cornerRadius?: number, x?: number, y?: number, radius?: number, start?: Point, end?: Point, bulge?: Point}} PrimitiveShape */

export const DRAWING_SHAPES = new Set(['line', 'polygon', 'rect', 'circle', 'arc']);
/** @param {number} value */
const round = value => Math.round(value * 10000) / 10000;

/**
 * @param {DrawingKind} kind
 * @param {Point[]} points
 * @param {Point} point
 */
export function advanceShapeDrawing(kind, points, point) {
    const next = [...points, { x: point.x, y: point.y }];
    const count = kind === 'arc' ? 3 : kind === 'rect' || kind === 'circle' ? 2 : Infinity;
    return { points: next, complete: next.length >= count };
}

/**
 * @param {DrawingKind} kind
 * @param {Point[]} points
 */
export function canFinishShapeAtPoint(kind, points) {
    return kind === 'line' || kind === 'polygon'
        || (kind === 'arc' ? points.length === 2 : points.length === 1);
}

/**
 * @param {Point[]} points
 * @param {boolean} [closed]
 */
export function dedupePathPoints(points, closed = false) {
    /** @type {Point[]} */
    const result = [];
    for (const point of points) {
        const previous = result.at(-1);
        if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 1e-4) continue;
        result.push({ x: point.x, y: point.y });
    }
    const last = result.at(-1);
    if (closed && result.length >= 2 && last && Math.hypot(result[0].x - last.x, result[0].y - last.y) < 1e-4) result.pop();
    return result;
}

/**
 * @param {DrawingKind} kind
 * @param {Point[]} points
 * @param {boolean} [preview]
 * @returns {PrimitiveShape|null}
 */
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

/**
 * @param {PrimitiveShape} shape
 * @param {boolean} [close]
 */
export function primitiveShapePath(shape, close = false) {
    if (shape.kind === 'arc') {
        const arc = /** @type {{start: Point, end: Point, bulge: Point}} */ (shape);
        const circle = circumcircle(arc.start, arc.bulge, arc.end);
        if (!circle) return `M ${round(arc.start.x)} ${round(arc.start.y)} L ${round(arc.end.x)} ${round(arc.end.y)}`;
        const cross = (arc.end.x - arc.start.x) * (arc.bulge.y - arc.start.y)
            - (arc.end.y - arc.start.y) * (arc.bulge.x - arc.start.x);
        const radius = round(circle.radius);
        return `M ${round(arc.start.x)} ${round(arc.start.y)} A ${radius} ${radius} 0 0 ${cross > 0 ? 0 : 1} ${round(arc.end.x)} ${round(arc.end.y)}${close ? ' Z' : ''}`;
    }
    if (shape.kind === 'circle') {
        const circle = /** @type {{x: number, y: number, radius: number}} */ (shape);
        const radius = Math.max(0.05, Number(circle.radius) || 0);
        return `M ${round(circle.x - radius)} ${round(circle.y)}`
            + ` A ${round(radius)} ${round(radius)} 0 1 0 ${round(circle.x + radius)} ${round(circle.y)}`
            + ` A ${round(radius)} ${round(radius)} 0 1 0 ${round(circle.x - radius)} ${round(circle.y)} Z`;
    }
    const points = shape.points || [];
    if (!points.length) return '';
    const cornerRadius = shape.cornerRadius || 0;
    if (shape.kind === 'rect' && cornerRadius > 0) {
        const { minX, minY, maxX, maxY } = pointsBounds(points);
        const radius = Math.min(cornerRadius, (maxX - minX) / 2, (maxY - minY) / 2);
        return `M ${round(minX + radius)} ${round(minY)}`
            + ` L ${round(maxX - radius)} ${round(minY)} A ${round(radius)} ${round(radius)} 0 0 1 ${round(maxX)} ${round(minY + radius)}`
            + ` L ${round(maxX)} ${round(maxY - radius)} A ${round(radius)} ${round(radius)} 0 0 1 ${round(maxX - radius)} ${round(maxY)}`
            + ` L ${round(minX + radius)} ${round(maxY)} A ${round(radius)} ${round(radius)} 0 0 1 ${round(minX)} ${round(maxY - radius)}`
            + ` L ${round(minX)} ${round(minY + radius)} A ${round(radius)} ${round(radius)} 0 0 1 ${round(minX + radius)} ${round(minY)} Z`;
    }
    return `M ${points[0].x} ${points[0].y}` + points.slice(1).map(point => ` L ${point.x} ${point.y}`).join('')
        + (shape.kind === 'line' ? '' : ' Z');
}

/**
 * @param {DrawingKind} kind
 * @param {Point[]} points
 * @param {Point} cursor
 * @param {number} [cornerRadius]
 */
export function shapePreviewPath(kind, points, cursor, cornerRadius = 0) {
    if (!points.length) return '';
    if (kind === 'arc' && points.length === 1) return primitiveShapePath({ kind: 'line', points: [points[0], cursor] });
    const geometry = shapeFromPoints(kind, [...points, cursor], true);
    return geometry ? primitiveShapePath({ ...geometry, cornerRadius }) : '';
}