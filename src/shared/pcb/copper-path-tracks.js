/**
 * Copper paths are Tracks. A Line, or an unfilled Polygon/Rectangle, drawn in
 * additive copper is routing intent whether or not it has a net yet, so it lives
 * in the Track model; its line/polygon/rectangle "kind" is just the track's
 * topology (open chain, closed loop, axis-aligned 4-node loop). Filled shapes are
 * copper areas, subtract-mode shapes cut copper, and other layers carry no
 * connectivity, so those stay board shapes.
 */
import { Track, sourceShapeRecord } from '../../shapes/track.js';
import { normalizeShapeCopperMode, rectCornerRadius, shapeIsFilled } from './board-shape-geometry.js';

/**
 * @typedef {import('../../core/geometry.js').Point} Point
 * @typedef {import('./board-shape-geometry.js').BoardShape} BoardShape
 * @typedef {import('./board-shape-geometry.js').NumberRecord} NumberRecord
 * @typedef {BoardShape & {kind: 'line'|'rect'|'polygon', points: Point[], layer: string}} CopperPathShape
 */

/** Whether a board shape is a copper path that belongs in the Track model. @param {BoardShape|null|undefined} shape */
export function isCopperPathShape(shape) {
    // Copper pours share the shape collection and kinds but are areas, not paths.
    if (shape?.type === 'fill') return false;
    const closed = shape?.kind === 'polygon' || shape?.kind === 'rect';
    return (shape?.kind === 'line' || (closed && !shapeIsFilled(shape)))
        && (shape.layer === 'top-copper' || shape.layer === 'bottom-copper')
        && normalizeShapeCopperMode(shape.copperMode) === 'add'
        && Array.isArray(shape.points)
        && shape.points.length >= (closed ? 3 : 2);
}

/**
 * Track with the shape's nodes `n<i>` and segments `e<i>`; closed shapes get the
 * closing edge. A rectangle keeps its corner radius: a rectangular track loop
 * rounds with the same circular corners (see isTrackRectangleLoop). The source
 * shape's id and plating are kept so turning the track back into a shape (Fill,
 * a non-copper layer, a removal mode) can reuse them.
 * @param {CopperPathShape} shape
 * @param {string} [net]
 */
export function trackFromBoardShape(shape, net = shape?.net || '') {
    const count = shape.points.length;
    const edgeCount = shape.kind === 'line' ? count - 1 : count;
    /** @param {NumberRecord|null|undefined} record */
    const byEdge = (record) => Object.fromEntries(Object.entries(record || {}).map(([index, value]) => [`e${index}`, value]));
    return new Track({
        net: String(net || '').trim(),
        width: Math.max(0.05, Number(shape.lineWidth) || 0.2),
        layer: shape.layer,
        graphNodes: Object.fromEntries(shape.points.map((point, index) => [`n${index}`, { x: point.x, y: point.y }])),
        graphEdges: Object.fromEntries(Array.from({ length: edgeCount }, (_, index) =>
            [`e${index}`, { from: `n${index}`, to: `n${(index + 1) % count}` }])),
        edgeWidths: byEdge(shape.segmentWidths),
        edgeBulges: byEdge(shape.segmentBulges),
        cornerRadius: shape.kind === 'rect' ? rectCornerRadius(shape) : shape.cornerRadius,
        nodeCornerRadii: Object.fromEntries(Object.entries(shape.nodeCornerRadii || {}).map(([index, radius]) => [`n${index}`, radius])),
        sourceBoardShape: sourceShapeRecord(shape),
    });
}
