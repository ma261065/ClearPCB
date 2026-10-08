import { CORNER_CHORD_TOLERANCE, roundedPathCorners, sampleRoundedCorner } from './rounded-path.js';
import { BULGE_EPS, sampleArcEdge } from './arc-edge.js';
import ClipperLib from '../../assets/vendor/clipper.esm.js';

/**
 * @typedef {{x: number, y: number}} Point
 * @typedef {import('./rounded-path.js').RoundedCorner} RoundedCorner
 * @typedef {{kind?: string, points?: Point[], outline?: Point[], x?: number, y?: number, radius?: number, cornerRadius?: number, nodeCornerRadii?: Record<string|number, number>, segmentBulges?: Record<string|number, number>}} ClosedShape
 */

/**
 * @param {ClosedShape|null|undefined} shape
 * @param {{minArea?: number, allowCrossings?: boolean}} [options]
 */
export function validClosedShape(shape, { minArea = 0, allowCrossings = false } = {}) {
    if (!shape || !['rect', 'polygon', 'circle'].includes(shape.kind ?? '')) return false;
    if (shape.kind === 'circle') {
        const radius = Number(shape.radius);
        return Number.isFinite(shape.x) && Number.isFinite(shape.y)
            && Number.isFinite(radius) && radius > 0;
    }
    const inputPoints = shape.points;
    if (!Array.isArray(inputPoints) || inputPoints.length < 3
        || (shape.kind === 'rect' && inputPoints.length !== 4)
        || inputPoints.some(point => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) return false;
    if (inputPoints.some((point, index) => {
        const next = inputPoints[(index + 1) % inputPoints.length];
        return Math.hypot(next.x - point.x, next.y - point.y) < 1e-9;
    })) return false;
    const points = closedShapeOutline(shape);
    let area = 0;
    for (let index = 0; index < points.length; index++) {
        const start = points[index], end = points[(index + 1) % points.length];
        area += start.x * end.y - end.x * start.y;
    }
    if (!Number.isFinite(area) || (!allowCrossings && Math.abs(area) <= minArea)) return false;
    const path = points.map(point => ({ X: Math.round(point.x * 10000), Y: Math.round(point.y * 10000) }));
    const simple = /** @type {Array<Array<{X:number,Y:number}>>} */ (ClipperLib.Clipper.SimplifyPolygon(path, allowCrossings
        ? ClipperLib.PolyFillType.pftEvenOdd : ClipperLib.PolyFillType.pftNonZero));
    if (allowCrossings) return simple.some(outline => Math.abs(ClipperLib.Clipper.Area(outline)) > minArea * 1e8 / 2);
    return simple.length === 1 && Math.abs(Math.abs(ClipperLib.Clipper.Area(path))
        - Math.abs(ClipperLib.Clipper.Area(simple[0]))) < 1;
}

/**
 * @param {number} minX
 * @param {number} minY
 * @param {number} maxX
 * @param {number} maxY
 * @param {number} radius
 * @returns {Point[]}
 */
function roundedRectangleOutline(minX, minY, maxX, maxY, radius) {
    const segments = Math.max(16, Math.ceil(Math.PI / (8 * Math.asin(Math.sqrt(Math.min(1, CORNER_CHORD_TOLERANCE / (2 * radius)))))));
    return [
        { x: minX + radius, y: minY + radius, angle: Math.PI },
        { x: maxX - radius, y: minY + radius, angle: -Math.PI / 2 },
        { x: maxX - radius, y: maxY - radius, angle: 0 },
        { x: minX + radius, y: maxY - radius, angle: Math.PI / 2 },
    ].flatMap(center => Array.from({ length: segments + 1 }, (_, index) => {
        const angle = center.angle + Math.PI / 2 * index / segments;
        return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
    }));
}

/**
 * @param {ClosedShape} shape
 * @returns {Point[]}
 */
export function closedShapeOutline(shape) {
    const points = shape.points || shape.outline || [];
    if (shape.kind === 'circle') {
        const radius = Math.max(0.05, Number(shape.radius) || 0);
        const center = /** @type {{x: number, y: number}} */ (shape);
        return Array.from({ length: 48 }, (_, index) => {
            const angle = Math.PI * 2 * index / 48;
            return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
        });
    }
    if (points.length < 3) return points.map(point => ({ ...point }));
    /** @param {number} index */
    const bulge = index => {
        const value = Number(shape.segmentBulges?.[index]);
        return Number.isFinite(value) && Math.abs(value) >= BULGE_EPS ? Math.max(-1, Math.min(1, value)) : 0;
    };
    let radius = Math.max(0, Number(shape.cornerRadius) || 0);
    if (shape.kind === 'rect' && points.length === 4) {
        const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
        const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y));
        const width = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
        const height = Math.hypot(points[3].x - points[0].x, points[3].y - points[0].y);
        radius = Math.min(radius, width / 2, height / 2);
        if (radius > 0 && !Object.keys(shape.nodeCornerRadii || {}).length) {
            const axisAligned = points.every((point, index) => {
                const next = points[(index + 1) % points.length];
                return Math.abs(point.x - next.x) < 1e-9 || Math.abs(point.y - next.y) < 1e-9;
            });
            if (axisAligned) return roundedRectangleOutline(minX, minY, maxX, maxY, radius);
            const origin = points[0];
            return roundedRectangleOutline(0, 0, width, height, radius).map(point => ({
                x: origin.x + (points[1].x - origin.x) * point.x / width + (points[3].x - origin.x) * point.y / height,
                y: origin.y + (points[1].y - origin.y) * point.x / width + (points[3].y - origin.y) * point.y / height,
            }));
        }
    }
    const radii = points.map((_, index) => bulge((index + points.length - 1) % points.length) || bulge(index)
        ? 0 : Math.max(0, Number(shape.nodeCornerRadii?.[index] ?? radius) || 0));
    if (radii.some(value => value > 0)) {
        const corners = /** @type {RoundedCorner[]} */ (roundedPathCorners(points, radii, true));
        return corners.flatMap((corner, index) => [
            ...sampleRoundedCorner(corner),
            ...sampleArcEdge(corner.exit, corners[(index + 1) % corners.length].entry, bulge(index), 64),
        ]);
    }
    const sampled = [{ ...points[0] }];
    for (let index = 0; index < points.length; index++) {
        sampled.push(...sampleArcEdge(points[index], points[(index + 1) % points.length], bulge(index), 64));
    }
    sampled.pop();
    return sampled;
}