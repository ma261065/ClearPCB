import { snapToGridLines } from '../../core/grid-snap.js';
import { resolvePathPoint, resolvePathTranslation, pathContinuationConstraints } from '../../shapes/path-snap.js';
import { findNearbyPin } from './wire-snap.js';
import { axisAlignment, pathAlignmentSegments, renderAxisGlow, squareAlignmentSegments } from '../../shapes/axis-glow.js';
import { bulgeRatio } from '../../core/geometry.js';
import { BULGE_EPS } from '../../shapes/arc-edge.js';
import { snapArcBulgeToChord } from '../../shapes/arc-edit.js';
import { isSchematicDrawingActive } from './drawing.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../core/SchematicDocument.js').SchematicItem} SchematicItem */
/** @typedef {import('../../shapes/polyline.js').Polyline} Polyline */
/** @typedef {import('../../shapes/arc.js').Arc} Arc */
/** @typedef {import('../../shapes/path-snap.js').PathDragConstraint} PathDragConstraint */
/** @typedef {{x: number, y: number}} Point */

/** @param {SchematicEditor} app @param {SchematicItem} shape @param {string} anchorId @param {Point} point */
export function snapShapeBulge(app, shape, anchorId, point) {
    const graph = shape.type === 'polyline' ? shape : null;
    const edge = graph ? graph.edges.get(anchorId.slice(6)) : null;
    const start = edge && graph ? graph.nodes.get(edge.from) : shape.type === 'arc' ? shape.startPoint : null;
    const end = edge && graph ? graph.nodes.get(edge.to) : shape.type === 'arc' ? shape.endPoint : null;
    if (!start || !end || app.viewport.shiftHeld) return point;
    const snapped = snapShapePoint(app, point);
    const threshold = 8 / Math.max(0.01, app.viewport.scale || 1);
    return snapArcBulgeToChord(start, end, point, snapped, threshold);
}

/** @param {SchematicEditor} app @param {SchematicItem} shape @param {string[]} anchorIds @param {string[]} [excludedEdges] */
export function renderShapeAlignment(app, shape, anchorIds, excludedEdges = []) {
    let segments = [];
    if (shape.type === 'polyline') {
        const graph = shape;
        const path = graph.toEditablePath();
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
            } else if (graph.isRect) {
                segments = squareAlignmentSegments(path.points, Object.values(path.segmentWidths));
            } else {
                segments = pathAlignmentSegments(path.points, graph.closed,
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
        const arc = shape;
        const start = arc.getStartPoint(), end = arc.getEndPoint();
        if (anchorIds.includes('mid') || anchorIds.includes('bulge')) {
            if (Math.abs(bulgeRatio(start, end, arc.bulgePoint)) < BULGE_EPS) {
                segments = [{ a: start, b: end, width: arc.lineWidth, collinear: true }];
            }
        } else if (anchorIds.includes('start') || anchorIds.includes('end')) {
            segments = pathAlignmentSegments([start, end], false, [0], [arc.lineWidth]);
        }
    }
    renderAxisGlow(app, segments);
}

/** @param {SchematicEditor} app @param {Point} point @param {Point[]} [neighbours] @param {Array<[Point, Point]>} [continuations] */
export function snapShapePoint(app, point, neighbours = [], continuations = []) {
    const viewport = app.viewport;
    if (viewport.shiftHeld) return { ...point };
    const threshold = 8 / Math.max(0.01, viewport.scale || 1);
    const target = findNearbyPin(app.components || [], point, threshold, app.shapes || []);
    const gridSize = viewport.gridVisible ? (viewport.getEffectiveGridSize?.() ?? viewport.gridSize) : 0;
    const grid = snapToGridLines(point, gridSize, viewport.scale);
    return resolvePathPoint(point, neighbours, { x: grid.x, y: grid.y }, threshold, target?.worldPos, continuations);
}

/** @param {Polyline} shape @param {string} anchorId */
export function shapeContinuationConstraints(shape, anchorId) {
    if (shape.isRect) return [];
    const path = shape.toEditablePath();
    if (!path) return [];
    const index = Object.values(path.nodeIds).indexOf(anchorId);
    return index < 0 ? [] : pathContinuationConstraints(path.points, shape.closed, index, path.segmentBulges);
}

/** @param {SchematicEditor} app @param {Point} point */
export function snapShapeDrawingPoint(app, point) {
    if (app.currentTool === 'arc' && app.arcEndpoint) return point;
    const previous = !isSchematicDrawingActive(app) ? null : app.currentTool === 'line' ? app.linePoints?.at(-1)
        : app.currentTool === 'polygon' ? app.polygonPoints?.at(-1) : app.drawStart;
    const points = app.currentTool === 'line' ? app.linePoints : app.currentTool === 'polygon' ? app.polygonPoints : null;
    const continuations = isSchematicDrawingActive(app) && points?.length
        ? pathContinuationConstraints([...points, point], false, points.length) : [];
    return snapShapePoint(app, point, previous ? [previous] : [], continuations);
}

/** @param {SchematicEditor} app @param {Point[]} points @param {Point} delta @param {Point[]} [neighbours] @param {PathDragConstraint[]} [constraints] */
export function snapShapeTranslation(app, points, delta, neighbours = [], constraints = []) {
    if (app.viewport.shiftHeld) return delta;
    return resolvePathTranslation(points, delta, neighbours, constraints, 8 / Math.max(0.01, app.viewport.scale || 1),
        (point, tolerance) => findNearbyPin(app.components || [], point, tolerance, app.shapes || [])?.worldPos || null,
        (point, fixed) => snapShapePoint(app, point, fixed));
}