import { distanceToSegment } from '../core/geometry.js';
import { sampleArcEdge, arcFromBulge, distanceToArcEdge } from './arc-edge.js';
import { roundedPathCorners, sampleRoundedCorner } from './rounded-path.js';

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
    const curved = corners.flatMap(corner => {
        const samples = sampleRoundedCorner(corner);
        return samples.slice(0, -1).map((start, index) => ({
            start, end: samples[index + 1], lineWidth: cornerWidth, logicalSegment: null,
        }));
    });
    return [...curved, ...straight];
}

export function hitTestStrokeSegments(point, segments, tolerance) {
    return segments.some(segment => distanceToSegment(point, segment.start, segment.end)
        <= Math.max(tolerance, segment.lineWidth / 2 + 0.12));
}

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

export function pathHandleDescriptors(vertices, edges, midpointId, bulgeId, curves = true) {
    const nodes = vertices.map(vertex => ({ ...vertex, cursor: 'nwse-resize' }));
    const midpoints = edges.filter(edge => !edge.bulge).map(edge => ({
        id: midpointId(edge.id), x: (edge.start.x + edge.end.x) / 2, y: (edge.start.y + edge.end.y) / 2,
        midpoint: true, round: true, fill: '#ffffff', symbol: 'plus', cursor: 'copy',
    }));
    const bulges = !curves ? [] : edges.flatMap(edge => {
        const arc = arcFromBulge(edge.start, edge.end, edge.bulge);
        return arc ? [{ id: bulgeId(edge.id), ...arc.bulgePoint,
            bulge: true, round: true, fill: '#33dd77', cursor: 'grab' }] : [];
    });
    return [...nodes, ...midpoints, ...bulges];
}

export function circleOuterRadius(shape) {
    return Math.max(0.05, Number(shape?.radius) || 0);
}

export function circleHitTest(shape, point, tolerance, filled, width) {
    const radius = circleOuterRadius(shape);
    const distance = Math.hypot(point.x - shape.x, point.y - shape.y);
    return distance <= radius + tolerance && (filled || distance >= Math.max(0, radius - width) - tolerance);
}

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