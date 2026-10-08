import { closestPointOnSegment } from '../../core/geometry.js';

/** @typedef {{x:number,y:number}} Point */
/** @typedef {Record<string, any>} ArcShape DRC passes dynamic copper features; geometry fields are validated by callers before clearance math. */
/** @typedef {Record<string, any>} CircleBand DRC circle-band features carry dynamic copper metadata alongside radii. */
/** @typedef {{dist:number,x:number,y:number}} ClearancePoint */

const TURN = 2 * Math.PI;
/** @param {number} angle */
const normalize = (angle) => ((angle % TURN) + TURN) % TURN;
/** @param {ArcShape} arc @param {number} angle @returns {Point} */
export const arcPoint = (arc, angle) => ({ x: arc.x + arc.radius * Math.cos(angle), y: arc.y + arc.radius * Math.sin(angle) });
/** @param {ArcShape} arc @returns {[Point, Point]} */
const endpoints = (arc) => [arcPoint(arc, arc.startAngle), arcPoint(arc, arc.endAngle)];

/** @param {ArcShape} arc @param {number} angle */
function onSweep(arc, angle) {
    const sweep = arc.endAngle - arc.startAngle;
    if (Math.abs(sweep) >= TURN - 1e-12) return true;
    return normalize(Math.sign(sweep || 1) * (angle - arc.startAngle)) <= Math.abs(sweep) + 1e-12;
}

/** @param {ArcShape} arc @param {Point} point @returns {Point} */
function pointOnArc(arc, point) {
    const angle = Math.atan2(point.y - arc.y, point.x - arc.x);
    if (onSweep(arc, angle)) return arcPoint(arc, angle);
    const [start, end] = endpoints(arc);
    return Math.hypot(point.x - start.x, point.y - start.y) <= Math.hypot(point.x - end.x, point.y - end.y) ? start : end;
}

/**
 * Gap midpoint, or a shared copper point when the round strokes overlap.
 * @param {Point} first
 * @param {Point} second
 * @param {number} firstWidth
 * @param {number} secondWidth
 * @returns {ClearancePoint}
 */
export function strokedPointDistance(first, second, firstWidth, secondWidth) {
    const dx = second.x - first.x, dy = second.y - first.y;
    const distance = Math.hypot(dx, dy);
    const totalWidth = firstWidth + secondWidth;
    const factor = totalWidth > distance && totalWidth ? distance / totalWidth : 1;
    const offset = distance ? (firstWidth - secondWidth) * factor / (2 * distance) : 0;
    return { dist: Math.max(0, distance - totalWidth),
        x: (first.x + second.x) / 2 + dx * offset, y: (first.y + second.y) / 2 + dy * offset };
}

/** @param {ArcShape} arc @param {Point} start @param {Point} end @param {number} [halfWidth] @returns {ClearancePoint} */
export function arcSegmentDistance(arc, start, end, halfWidth = 0) {
    let best = { dist: Infinity, x: 0, y: 0 };
    /** @param {Point} first @param {Point} second */
    const consider = (first, second) => {
        const result = strokedPointDistance(first, second, arc.hw || 0, halfWidth);
        if (result.dist < best.dist) best = result;
    };
    for (const point of endpoints(arc)) consider(point, closestPointOnSegment(point, start, end));
    for (const point of [start, end]) consider(pointOnArc(arc, point), point);
    const dx = end.x - start.x, dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) return best;
    const normalAngle = Math.atan2(dx, -dy);
    for (const angle of [normalAngle, normalAngle + Math.PI]) {
        if (!onSweep(arc, angle)) continue;
        const point = arcPoint(arc, angle);
        consider(point, closestPointOnSegment(point, start, end));
    }
    const projection = ((arc.x - start.x) * dx + (arc.y - start.y) * dy) / lengthSquared;
    const foot = { x: start.x + projection * dx, y: start.y + projection * dy };
    const heightSquared = arc.radius * arc.radius - (foot.x - arc.x) ** 2 - (foot.y - arc.y) ** 2;
    if (heightSquared >= 0) {
        const offset = Math.sqrt(heightSquared / lengthSquared);
        for (const fraction of [projection - offset, projection + offset]) {
            if (fraction < 0 || fraction > 1) continue;
            const point = { x: start.x + fraction * dx, y: start.y + fraction * dy };
            if (onSweep(arc, Math.atan2(point.y - arc.y, point.x - arc.x))) consider(point, point);
        }
    }
    return best;
}

/** @param {ArcShape} first @param {ArcShape} second @returns {ClearancePoint} */
export function arcArcDistance(first, second) {
    let best = { dist: Infinity, x: 0, y: 0 };
    /** @param {Point} firstPoint @param {Point} secondPoint */
    const consider = (firstPoint, secondPoint) => {
        const result = strokedPointDistance(firstPoint, secondPoint, first.hw || 0, second.hw || 0);
        if (result.dist < best.dist) best = result;
    };
    for (const point of endpoints(first)) consider(point, pointOnArc(second, point));
    for (const point of endpoints(second)) consider(pointOnArc(first, point), point);
    const dx = second.x - first.x, dy = second.y - first.y;
    const separation = Math.hypot(dx, dy);
    if (!separation) return best;
    const angle = Math.atan2(dy, dx);
    for (const firstAngle of [angle, angle + Math.PI]) {
        for (const secondAngle of [angle, angle + Math.PI]) {
            if (onSweep(first, firstAngle) && onSweep(second, secondAngle)) {
                consider(arcPoint(first, firstAngle), arcPoint(second, secondAngle));
            }
        }
    }
    const along = (first.radius ** 2 - second.radius ** 2 + separation ** 2) / (2 * separation);
    const heightSquared = first.radius ** 2 - along ** 2;
    if (heightSquared >= 0 && separation <= first.radius + second.radius
        && separation >= Math.abs(first.radius - second.radius)) {
        const height = Math.sqrt(heightSquared);
        for (const sign of [-1, 1]) {
            const point = { x: first.x + (along * dx - sign * height * dy) / separation,
                y: first.y + (along * dy + sign * height * dx) / separation };
            if (onSweep(first, Math.atan2(point.y - first.y, point.x - first.x))
                && onSweep(second, Math.atan2(point.y - second.y, point.x - second.x))) consider(point, point);
        }
    }
    return best;
}

/** @param {ArcShape} arc @param {Point} point */
export function containsArcInterior(arc, point) {
    if (!arc.filled || Math.hypot(point.x - arc.x, point.y - arc.y) > arc.radius) return false;
    const [start, end] = endpoints(arc);
    const middle = arcPoint(arc, (arc.startAngle + arc.endAngle) / 2);
    /** @param {Point} target */
    const side = (target) => (end.x - start.x) * (target.y - start.y) - (end.y - start.y) * (target.x - start.x);
    return side(point) * side(middle) >= 0;
}

/** @param {ArcShape} arc @param {CircleBand} circle @returns {ClearancePoint} */
export function arcCircleDistance(arc, circle) {
    const point = arcPoint(arc, arc.startAngle);
    const radial = Math.hypot(point.x - circle.x, point.y - circle.y);
    if (radial >= circle.innerRadius && radial <= circle.outerRadius) return { dist: 0, ...point };
    const outer = { x: circle.x, y: circle.y, radius: circle.outerRadius, startAngle: 0, endAngle: TURN, hw: 0 };
    let best = arcArcDistance(arc, outer);
    if (circle.innerRadius > 0) {
        const inner = arcArcDistance(arc, { ...outer, radius: circle.innerRadius });
        if (inner.dist < best.dist) best = inner;
    }
    return best;
}