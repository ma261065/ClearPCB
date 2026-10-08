/**
 * Schematic lock-icon placement: the outline each entity presents to the shared
 * lock positioner, so a lock sits just outside what is drawn, beside the part
 * nearest the press that selected it (the same rule as the PCB editor).
 */
import { boundsOutline, lockPositionBesideBounds, lockPositionOutsideOutline } from '../../core/lock-position.js';
import { sampleArcEdge } from '../../shapes/arc-edge.js';

/** @typedef {import('../../shapes/arc.js').Arc} Arc */
/** @typedef {import('../../shapes/circle.js').Circle} Circle */
/** @typedef {import('../../shapes/polyline-graph.js').PolylineGraph} PolylineGraph */
/** @typedef {import('../../core/SchematicDocument.js').SchematicItem} SchematicItem */
/** @typedef {{x:number,y:number}} Point */
/** @typedef {{points: Point[]|Point[][], closed: boolean, margin: number|number[]}} LockOutline */

const TWO_PI = Math.PI * 2;
/** @param {number} angle */
const turn = angle => ((angle % TWO_PI) + TWO_PI) % TWO_PI;

/** Points along an Arc shape from start, through its middle, to its end. */
/** @param {Arc} shape @returns {Point[]} */
function arcShapePoints(shape) {
    const start = shape.getStartPoint(), end = shape.getEndPoint(), middle = shape.getMidPoint();
    const cx = shape.x, cy = shape.y, radius = shape.radius;
    if (!(radius > 0)) return [start, middle, end];
    /** @param {Point} point */
    const angle = point => Math.atan2(point.y - cy, point.x - cx);
    const a0 = angle(start), am = angle(middle), a1 = angle(end);
    const forward = turn(am - a0) <= turn(a1 - a0);
    const span = forward ? turn(a1 - a0) : -turn(a0 - a1);
    const steps = 24;
    return Array.from({ length: steps + 1 }, (_, index) => {
        const a = a0 + span * index / steps;
        return { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) };
    });
}

/**
 * The geometry a lock should stay clear of.
 * @param {SchematicItem} entity
 * @returns {LockOutline|null}
 */
function lockOutline(entity) {
    const lineEntity = /** @type {{lineWidth?: number}} */ (entity);
    const halfWidth = Math.max(0, Number(lineEntity.lineWidth) || 0) / 2;
    // A closed shape is one loop, so a press just inside it still puts the lock outside.
    if ((entity.type === 'polyline' || entity.type === 'wire')) {
        const graph = entity;
        if (graph.closed && typeof graph.getOrderedEdgeChain === 'function') {
            const chain = graph.getOrderedEdgeChain();
            if (chain.length >= 2 && chain.length === graph.edges.size) {
                const points = [chain[0].a];
                for (const segment of chain) points.push(...sampleArcEdge(segment.a, segment.b, segment.bulge, 48));
                points.pop();
                return { points, closed: true, margin: halfWidth };
            }
        }
        const paths = [], margins = [];
        for (const [edgeId, edge] of graph.edges) {
            const from = graph.nodes.get(edge.from), to = graph.nodes.get(edge.to);
            if (!from || !to) continue;
            paths.push([from, ...sampleArcEdge(from, to, Number(edge.bulge) || 0, 48)]);
            const width = Number(graph.getEdgeAttr(edgeId, 'width'));
            margins.push(Number.isFinite(width) ? width / 2 : halfWidth);
        }
        return paths.length ? { points: paths, closed: false, margin: margins } : null;
    }
    if (entity.type === 'circle') {
        const circle = /** @type {Circle} */ (entity);
        if (circle.radius > 0) {
            const points = Array.from({ length: 32 }, (_, index) => ({
                x: circle.x + circle.radius * Math.cos(index * TWO_PI / 32),
                y: circle.y + circle.radius * Math.sin(index * TWO_PI / 32),
            }));
            return { points, closed: true, margin: halfWidth };
        }
    }
    if (entity.type === 'arc') {
        return { points: arcShapePoints(/** @type {Arc} */ (entity)), closed: false, margin: halfWidth };
    }
    const bounds = entity.getBounds?.();
    return bounds ? { points: boundsOutline(bounds), closed: true, margin: 0 } : null;
}

/**
 * World position (top-left of the icon) for a selected locked entity's lock.
 * @param {SchematicItem} entity shape or component
 * @param {{x:number,y:number}|null|undefined} pointer where the selecting press landed
 * @param {number} scale
 */
export function schematicLockPosition(entity, pointer, scale) {
    const outline = lockOutline(entity);
    const placed = outline && pointer
        ? lockPositionOutsideOutline(outline.points, pointer, scale, outline.closed, outline.margin)
        : null;
    if (placed) return placed;
    const bounds = entity.getBounds?.();
    return bounds ? lockPositionBesideBounds(bounds, scale) : null;
}
