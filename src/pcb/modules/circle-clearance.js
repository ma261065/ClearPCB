import { closestPointOnSegment } from '../../core/geometry.js';

/** @typedef {{x: number, y: number}} Point */
/** @typedef {Record<string, any>} ClearanceCircle */

/** @param {ClearanceCircle} first @param {ClearanceCircle} second */
export function circleCircleDistance(first, second) {
    const dx = second.x - first.x, dy = second.y - first.y;
    const separation = Math.hypot(dx, dy);
    const ux = separation ? dx / separation : 1, uy = separation ? dy / separation : 0;
    let firstRadius, secondRadius, direction = 1;
    const external = separation - first.outerRadius - second.outerRadius;
    const insideFirst = first.innerRadius - separation - second.outerRadius;
    const insideSecond = second.innerRadius - separation - first.outerRadius;
    const gap = Math.max(external, insideFirst, insideSecond, 0);
    if (gap > 0) {
        if (gap === external) {
            firstRadius = first.outerRadius;
            secondRadius = -second.outerRadius;
        } else if (gap === insideFirst) {
            firstRadius = first.innerRadius;
            secondRadius = second.outerRadius;
        } else {
            firstRadius = -first.outerRadius;
            secondRadius = -second.innerRadius;
        }
        return { dist: gap, x: (first.x + ux * firstRadius + second.x + ux * secondRadius) / 2,
            y: (first.y + uy * firstRadius + second.y + uy * secondRadius) / 2 };
    }
    firstRadius = Math.max(first.innerRadius, separation - second.outerRadius, second.innerRadius - separation, 0);
    secondRadius = Math.max(second.innerRadius, Math.abs(separation - firstRadius));
    if (separation && firstRadius) {
        direction = Math.max(-1, Math.min(1,
            (separation * separation + firstRadius * firstRadius - secondRadius * secondRadius) / (2 * separation * firstRadius)));
    }
    const perpendicular = Math.sqrt(Math.max(0, 1 - direction * direction));
    return { dist: 0, x: first.x + firstRadius * (ux * direction - uy * perpendicular),
        y: first.y + firstRadius * (uy * direction + ux * perpendicular) };
}

/** @param {ClearanceCircle} circle @param {Point} start @param {Point} end @param {number} [halfWidth] */
export function circleSegmentDistance(circle, start, end, halfWidth = 0) {
    const closest = closestPointOnSegment(/** @type {Point} */ (circle), start, end);
    const startDistance = Math.hypot(start.x - circle.x, start.y - circle.y);
    const endDistance = Math.hypot(end.x - circle.x, end.y - circle.y);
    const farthest = startDistance >= endDistance ? start : end;
    const minimum = Math.hypot(closest.x - circle.x, closest.y - circle.y);
    const maximum = Math.max(startDistance, endDistance);
    let point, radius;
    if (minimum > circle.outerRadius) {
        point = closest;
        radius = circle.outerRadius;
    } else if (maximum < circle.innerRadius) {
        point = farthest;
        radius = circle.innerRadius;
    } else {
        radius = Math.max(minimum, circle.innerRadius);
        const dx = farthest.x - closest.x, dy = farthest.y - closest.y;
        const lengthSquared = dx * dx + dy * dy;
        const projection = (closest.x - circle.x) * dx + (closest.y - circle.y) * dy;
        const offset = minimum * minimum - radius * radius;
        const fraction = lengthSquared ? Math.max(0, Math.min(1,
            (-projection + Math.sqrt(Math.max(0, projection * projection - lengthSquared * offset))) / lengthSquared)) : 0;
        return { dist: 0, x: closest.x + fraction * dx, y: closest.y + fraction * dy };
    }
    const radialDistance = Math.hypot(point.x - circle.x, point.y - circle.y);
    const ux = radialDistance ? (point.x - circle.x) / radialDistance : 1;
    const uy = radialDistance ? (point.y - circle.y) / radialDistance : 0;
    const delta = radius - radialDistance;
    const gap = Math.max(0, Math.abs(delta) - halfWidth);
    const offset = Math.sign(delta) * Math.min(halfWidth, Math.abs(delta));
    return { dist: gap, x: point.x + ux * (delta + offset) / 2,
        y: point.y + uy * (delta + offset) / 2 };
}