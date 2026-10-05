/**
 * Schematic lock-icon placement: the outline each entity presents to the shared
 * lock positioner, so a lock sits just outside what is drawn, beside the part
 * nearest the press that selected it (the same rule as the PCB editor).
 */
import { boundsOutline, lockPositionBesideBounds, lockPositionOutsideOutline } from '../../core/lock-position.js';
import { sampleArcEdge } from '../../shapes/arc-edge.js';

const TWO_PI = Math.PI * 2;
const turn = angle => ((angle % TWO_PI) + TWO_PI) % TWO_PI;

/** Points along an Arc shape from start, through its middle, to its end. */
function arcShapePoints(shape) {
    const start = shape.getStartPoint(), end = shape.getEndPoint(), middle = shape.getMidPoint();
    const cx = shape.x, cy = shape.y, radius = shape.radius;
    if (!(radius > 0)) return [start, middle, end];
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
 * @returns {{points: any[], closed: boolean, margin: number|number[]}|null}
 */
function lockOutline(entity) {
    const halfWidth = Math.max(0, Number(entity.lineWidth) || 0) / 2;
    // A closed shape is one loop, so a press just inside it still puts the lock outside.
    if (entity.closed && typeof entity.getOrderedEdgeChain === 'function') {
        const chain = entity.getOrderedEdgeChain();
        if (chain.length >= 2 && chain.length === entity.edges.size) {
            const points = [chain[0].a];
            for (const segment of chain) points.push(...sampleArcEdge(segment.a, segment.b, segment.bulge, 48));
            points.pop();
            return { points, closed: true, margin: halfWidth };
        }
    }
    if (entity.nodes instanceof Map && entity.edges instanceof Map) {
        const paths = [], margins = [];
        for (const [edgeId, edge] of entity.edges) {
            const from = entity.nodes.get(edge.from), to = entity.nodes.get(edge.to);
            if (!from || !to) continue;
            paths.push([from, ...sampleArcEdge(from, to, Number(edge.bulge) || 0, 48)]);
            const width = Number(entity.getEdgeAttr?.(edgeId, 'width'));
            margins.push(Number.isFinite(width) ? width / 2 : halfWidth);
        }
        return paths.length ? { points: paths, closed: false, margin: margins } : null;
    }
    if (entity.type === 'circle' && entity.radius > 0) {
        const points = Array.from({ length: 32 }, (_, index) => ({
            x: entity.x + entity.radius * Math.cos(index * TWO_PI / 32),
            y: entity.y + entity.radius * Math.sin(index * TWO_PI / 32),
        }));
        return { points, closed: true, margin: halfWidth };
    }
    if (entity.type === 'arc' && typeof entity.getStartPoint === 'function') {
        return { points: arcShapePoints(entity), closed: false, margin: halfWidth };
    }
    const bounds = entity.getBounds?.();
    return bounds ? { points: boundsOutline(bounds), closed: true, margin: 0 } : null;
}

/**
 * World position (top-left of the icon) for a selected locked entity's lock.
 * @param {any} entity shape or component
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
