import { snapToGridLines } from '../../core/grid-snap.js';
import { resolvePathPoint, resolvePathTranslation, pathContinuationConstraints } from '../../shapes/path-snap.js';
import { findNearbyPin } from './wire.js';
import { axisAlignment, pathAlignmentSegments, renderAxisGlow, squareAlignmentSegments } from '../../shapes/axis-glow.js';
import { bulgeRatio } from '../../core/geometry.js';
import { BULGE_EPS } from '../../shapes/arc-edge.js';
import { snapArcBulgeToChord } from '../../shapes/arc-edit.js';

export function snapShapeBulge(app, shape, anchorId, point) {
    const edge = shape.type === 'polyline' ? shape.edges.get(anchorId.slice(6)) : null;
    const start = edge ? shape.nodes.get(edge.from) : shape.startPoint;
    const end = edge ? shape.nodes.get(edge.to) : shape.endPoint;
    if (!start || !end || app.viewport.shiftHeld) return point;
    const snapped = snapShapePoint(app, point);
    const threshold = 8 / Math.max(0.01, app.viewport.scale || 1);
    return snapArcBulgeToChord(start, end, point, snapped, threshold);
}

export function renderShapeAlignment(app, shape, anchorIds, excludedEdges = []) {
    let segments = [];
    if (shape.type === 'polyline') {
        const path = shape.toEditablePath();
        if (path) {
            const nodeIds = Object.values(path.nodeIds);
            const edgeIds = Object.values(path.edgeIds);
            const bulgeId = anchorIds.find(id => String(id).startsWith('bulge_'));
            if (bulgeId) {
                const index = edgeIds.indexOf(bulgeId.slice(6));
                if (index >= 0 && Math.abs(path.segmentBulges[index] || 0) < BULGE_EPS) {
                    segments = [{ a: path.points[index], b: path.points[(index + 1) % path.points.length],
                        width: path.segmentWidths[index], collinear: true }];
                }
            } else if (shape.isRect) {
                segments = squareAlignmentSegments(path.points, Object.values(path.segmentWidths));
            } else {
                segments = pathAlignmentSegments(path.points, shape.closed,
                    anchorIds.map(id => nodeIds.indexOf(id)), Object.values(path.segmentWidths),
                    Object.values(path.segmentBulges), excludedEdges.map(id => edgeIds.indexOf(id)));
                edgeIds.forEach((edgeId, index) => {
                    const next = (index + 1) % path.points.length;
                    if (Math.abs(path.segmentBulges[index] || 0) < BULGE_EPS || excludedEdges.includes(edgeId)
                        || !anchorIds.includes(nodeIds[index]) && !anchorIds.includes(nodeIds[next])) return;
                    const start = path.points[index], end = path.points[next];
                    const axisKind = axisAlignment(start, end);
                    if (axisKind) segments.push({ a: start, b: end, width: path.segmentWidths[index], axisKind });
                });
            }
        }
    } else if (shape.type === 'arc') {
        const start = shape.getStartPoint(), end = shape.getEndPoint();
        if (anchorIds.includes('mid') || anchorIds.includes('bulge')) {
            if (Math.abs(bulgeRatio(start, end, shape.bulgePoint)) < BULGE_EPS) {
                segments = [{ a: start, b: end, width: shape.lineWidth, collinear: true }];
            }
        } else if (anchorIds.includes('start') || anchorIds.includes('end')) {
            segments = pathAlignmentSegments([start, end], false, [0], [shape.lineWidth]);
        }
    }
    renderAxisGlow(app, segments);
}

export function snapShapePoint(app, point, neighbours = [], continuations = []) {
    const viewport = app.viewport;
    if (viewport.shiftHeld) return { ...point };
    const threshold = 8 / Math.max(0.01, viewport.scale || 1);
    const target = findNearbyPin(app.components || [], point, threshold, app.shapes || []);
    const gridSize = viewport.gridVisible ? (viewport.getEffectiveGridSize?.() ?? viewport.gridSize) : 0;
    const grid = snapToGridLines(point, gridSize, viewport.scale);
    return resolvePathPoint(point, neighbours, { x: grid.x, y: grid.y }, threshold, target?.worldPos, continuations);
}

export function shapeContinuationConstraints(shape, anchorId) {
    if (shape.isRect) return [];
    const path = shape.toEditablePath();
    if (!path) return [];
    const index = Object.values(path.nodeIds).indexOf(anchorId);
    return index < 0 ? [] : pathContinuationConstraints(path.points, shape.closed, index, path.segmentBulges);
}

export function snapShapeDrawingPoint(app, point) {
    if (app.currentTool === 'arc' && app.arcEndpoint) return point;
    const previous = !app.isDrawing ? null : app.currentTool === 'line' ? app.linePoints?.at(-1)
        : app.currentTool === 'polygon' ? app.polygonPoints?.at(-1) : app.drawStart;
    const points = app.currentTool === 'line' ? app.linePoints : app.currentTool === 'polygon' ? app.polygonPoints : null;
    const continuations = app.isDrawing && points?.length
        ? pathContinuationConstraints([...points, point], false, points.length) : [];
    return snapShapePoint(app, point, previous ? [previous] : [], continuations);
}

export function snapShapeTranslation(app, points, delta, neighbours = [], constraints = []) {
    if (app.viewport.shiftHeld) return delta;
    return resolvePathTranslation(points, delta, neighbours, constraints, 8 / Math.max(0.01, app.viewport.scale || 1),
        (point, tolerance) => findNearbyPin(app.components || [], point, tolerance, app.shapes || [])?.worldPos,
        (point, fixed) => snapShapePoint(app, point, fixed));
}