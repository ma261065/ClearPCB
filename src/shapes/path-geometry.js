import { distanceToSegment } from '../core/geometry.js';
import { sampleArcEdge, arcFromBulge, distanceToArcEdge } from './arc-edge.js';
import { roundedPathCorners, sampleRoundedCorner } from './rounded-path.js';

/** @typedef {{x: number, y: number}} Point */
/** @typedef {{id?: string, start: Point, end: Point, lineWidth: number, bulge?: number, logicalSegment?: number|null}} StrokeSegment */
/** @typedef {{points?: Point[], kind?: string, segmentBulges?: Record<string|number, number>}} PathLike */

/** Whether a path node joins two straight, non-collinear edges. */
/** @param {PathLike} path @param {number} index */
export function canRoundPathNode(path, index) {
    const points = path.points || [];
    if (!Number.isInteger(index) || index < 0 || index >= points.length || points.length < 3
        || (path.kind === 'line' && (index === 0 || index === points.length - 1))) return false;
    const previousIndex = (index + points.length - 1) % points.length;
    if (path.segmentBulges?.[previousIndex] || path.segmentBulges?.[index]) return false;
    const vertex = points[index], previous = points[previousIndex], next = points[(index + 1) % points.length];
    const ax = previous.x - vertex.x, ay = previous.y - vertex.y;
    const bx = next.x - vertex.x, by = next.y - vertex.y;
    const firstLength = Math.hypot(ax, ay), secondLength = Math.hypot(bx, by);
    return firstLength > 1e-9 && secondLength > 1e-9
        && Math.abs(ax * by - ay * bx) > 1e-9 * firstLength * secondLength;
}

/**
 * @param {Point[]} points
 * @param {boolean} closed
 * @param {number[]} widths
 * @param {number[]} bulges
 * @param {number[]} radii
 * @param {number} cornerWidth
 * @param {boolean} [circular]
 * @returns {StrokeSegment[]}
 */
export function pathStrokeSegments(points, closed, widths, bulges, radii, cornerWidth, circular = false) {
    const effectiveRadii = points.map((_, index) =>
        bulges[(index + points.length - 1) % points.length] || bulges[index] ? 0 : radii[index] || 0);
    const corners = roundedPathCorners(points, effectiveRadii, closed, circular);
    const count = closed ? points.length : Math.max(0, points.length - 1);
    const straight = corners.slice(0, count).flatMap((corner, logicalSegment) => {
        const samples = [corner.exit, ...sampleArcEdge(corner.exit,
            corners[(logicalSegment + 1) % corners.length].entry, bulges[logicalSegment] || 0, 64)];
        return samples.slice(0, -1).map((start, index) => ({
            start, end: samples[index + 1], lineWidth: widths[logicalSegment], logicalSegment,
        }));
    });
    // Each half of a rounded corner takes the width of the segment it joins, as Tracks do.
    const curved = corners.flatMap((corner, index) => {
        const samples = sampleRoundedCorner(corner);
        const middle = (samples.length - 1) / 2;
        const before = widths[(index + points.length - 1) % points.length] ?? cornerWidth;
        const after = widths[index] ?? cornerWidth;
        return samples.slice(0, -1).map((start, sample) => ({
            start, end: samples[sample + 1], lineWidth: sample < middle ? before : after, logicalSegment: null,
        }));
    });
    return [...curved, ...straight];
}

/** Points a curve offers as ratline endpoints: evenly spaced samples on it, ends included. */
export const RATLINE_CURVE_POINTS = 9;

/**
 * Thin a curve's samples to at most RATLINE_CURVE_POINTS. Every point stays on
 * the curve, and ratline spanning trees compare clusters point by point, so
 * this bounds their cost however finely the curve is drawn.
 */
/** @param {Point[]} samples @returns {Point[]} */
export function curveRatlineTargets(samples) {
    if (samples.length <= RATLINE_CURVE_POINTS) return samples;
    const step = (samples.length - 1) / (RATLINE_CURVE_POINTS - 1);
    return Array.from({ length: RATLINE_CURVE_POINTS }, (_, index) => samples[Math.round(index * step)]);
}

/** One stroke reach for every editor: within half the stroke width plus the pick tolerance. */
/** @param {Point} point @param {StrokeSegment[]} segments @param {number} tolerance */
export function hitTestStrokeSegments(point, segments, tolerance) {
    return segments.some(segment => distanceToSegment(point, segment.start, segment.end)
        <= segment.lineWidth / 2 + tolerance);
}

/** @param {Point[]} points @param {number} [margin] */
export function pointsBounds(points, margin = 0) {
    if (!points.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    let minX = points[0].x, maxX = points[0].x;
    let minY = points[0].y, maxY = points[0].y;
    for (const point of points.slice(1)) {
        minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
    }
    return { minX: minX - margin, minY: minY - margin, maxX: maxX + margin, maxY: maxY + margin };
}

/**
 * @param {Array<Point & {id: string}>} vertices
 * @param {Array<{id: string, start: Point, end: Point, bulge?: number}>} edges
 * @param {(id: string) => string} midpointId
 * @param {(id: string) => string} bulgeId
 * @param {boolean} [curves]
 * @returns {Array<{id: string, x: number, y: number, cursor: string, midpoint?: boolean, round?: boolean, fill?: string, symbol?: string, bulge?: boolean}>}
 */
export function pathHandleDescriptors(vertices, edges, midpointId, bulgeId, curves = true) {
    const nodes = vertices.map(vertex => ({ ...vertex, cursor: 'nwse-resize' }));
    const midpoints = edges.filter(edge => !edge.bulge).map(edge => ({
        id: midpointId(edge.id), x: (edge.start.x + edge.end.x) / 2, y: (edge.start.y + edge.end.y) / 2,
        midpoint: true, round: true, fill: '#ffffff', symbol: 'plus', cursor: 'copy',
    }));
    const bulges = !curves ? [] : edges.flatMap(edge => {
        const arc = arcFromBulge(edge.start, edge.end, edge.bulge || 0);
        return arc ? [{ id: bulgeId(edge.id), ...arc.bulgePoint,
            bulge: true, round: true, fill: '#33dd77', cursor: 'grab' }] : [];
    });
    return [...nodes, ...midpoints, ...bulges];
}

/** @param {{radius?: number}|null|undefined} shape */
export function circleOuterRadius(shape) {
    return Math.max(0.05, Number(shape?.radius) || 0);
}

/** @param {any} shape @param {Point} point @param {number} tolerance @param {boolean} filled @param {number} width */
export function circleHitTest(shape, point, tolerance, filled, width) {
    const radius = circleOuterRadius(shape);
    const distance = Math.hypot(point.x - shape.x, point.y - shape.y);
    return distance <= radius + tolerance && (filled || distance >= Math.max(0, radius - width) - tolerance);
}

/** @param {Point} point @param {StrokeSegment[]} segments @param {number} tolerance @returns {string|null|undefined} */
export function pathSegmentAt(point, segments, tolerance) {
    let selected = null;
    let bestDistance = tolerance;
    for (const segment of segments) {
        const distance = Math.max(0, distanceToArcEdge(point, segment.start, segment.end, segment.bulge || 0)
            - segment.lineWidth / 2);
        if (distance <= bestDistance) {
            selected = segment.id;
            bestDistance = distance;
        }
    }
    return selected;
}