import { resolveBoardShapeGeometry } from './board-shapes.js';
import { distanceToSegment, pointInPolygon } from '../../core/geometry.js';

const cache = new WeakMap();
const geometryKeys = ['kind', 'x', 'y', 'radius', 'start', 'end', 'bulge', 'points',
    'lineWidth', 'segmentWidths', 'filled', 'cornerRadius', 'nodeCornerRadii', 'copperMode', 'layer'];

function equalInput(current, saved) {
    if (Object.is(current, saved)) return true;
    if (!current || !saved || typeof current !== 'object' || typeof saved !== 'object') return false;
    if (Array.isArray(current) !== Array.isArray(saved)) return false;
    if (Array.isArray(current)) {
        return current.length === saved.length && current.every((value, index) => equalInput(value, saved[index]));
    }
    const keys = Object.keys(current);
    return keys.length === Object.keys(saved).length
        && keys.every((key) => Object.prototype.hasOwnProperty.call(saved, key) && equalInput(current[key], saved[key]));
}

export function resolveTrackContactGeometry(shape) {
    const previous = cache.get(shape);
    if (previous && geometryKeys.every((key) => equalInput(shape[key], previous.inputs[key]))) return previous;
    const inputs = structuredClone(Object.fromEntries(geometryKeys.map((key) => [key, shape[key]])));
    const geometry = resolveBoardShapeGeometry(shape);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const point of geometry.centerline) {
        minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
    }
    let halfWidth = geometry.lineWidth / 2;
    for (const segment of geometry.strokeSegments) halfWidth = Math.max(halfWidth, segment.lineWidth / 2);
    if (geometry.circle) {
        const { x, y, radius } = geometry.circle;
        minX = x - radius; maxX = x + radius;
        minY = y - radius; maxY = y + radius;
    }
    const result = { inputs, geometry, bounds: {
        minX: minX - halfWidth, minY: minY - halfWidth,
        maxX: maxX + halfWidth, maxY: maxY + halfWidth,
    } };
    cache.set(shape, result);
    return result;
}

export function copperShapesTouch(first, second) {
    const firstContact = resolveTrackContactGeometry(first);
    const secondContact = resolveTrackContactGeometry(second);
    const firstBounds = firstContact.bounds, secondBounds = secondContact.bounds;
    const tolerance = 1e-7;
    if (firstBounds.maxX + tolerance < secondBounds.minX || secondBounds.maxX + tolerance < firstBounds.minX
        || firstBounds.maxY + tolerance < secondBounds.minY || secondBounds.maxY + tolerance < firstBounds.minY) return false;
    const firstGeometry = firstContact.geometry, secondGeometry = secondContact.geometry;
    const segments = (geometry) => {
        if (geometry.strokeSegments.length) return geometry.strokeSegments;
        const points = geometry.centerline;
        return points.slice(0, geometry.pathClosed ? points.length : -1).map((start, index) => ({
            start, end: points[(index + 1) % points.length], lineWidth: geometry.lineWidth,
        }));
    };
    const circleTouches = (circleGeometry, other) => {
        const circle = circleGeometry.circle;
        const outerRadius = circle.radius + circleGeometry.lineWidth / 2;
        const innerRadius = circleGeometry.filled ? 0 : Math.max(0, circle.radius - circleGeometry.lineWidth / 2);
        if (other.circle) {
            const separation = Math.hypot(circle.x - other.circle.x, circle.y - other.circle.y);
            const otherOuter = other.circle.radius + other.lineWidth / 2;
            const otherInner = other.filled ? 0 : Math.max(0, other.circle.radius - other.lineWidth / 2);
            return separation <= outerRadius + otherOuter + tolerance
                && separation + otherOuter + tolerance >= innerRadius
                && separation + outerRadius + tolerance >= otherInner;
        }
        if (other.filled && pointInPolygon(circle, other.areaOutline)) return true;
        return segments(other).some((segment) => {
            const nearest = distanceToSegment(circle, segment.start, segment.end);
            const farthest = Math.max(Math.hypot(circle.x - segment.start.x, circle.y - segment.start.y),
                Math.hypot(circle.x - segment.end.x, circle.y - segment.end.y));
            return nearest <= outerRadius + segment.lineWidth / 2 + tolerance
                && farthest + segment.lineWidth / 2 + tolerance >= innerRadius;
        });
    };
    if (firstGeometry.circle) return circleTouches(firstGeometry, secondGeometry);
    if (secondGeometry.circle) return circleTouches(secondGeometry, firstGeometry);
    if (firstGeometry.filled && secondGeometry.centerline.some((point) => pointInPolygon(point, firstGeometry.areaOutline))) return true;
    if (secondGeometry.filled && firstGeometry.centerline.some((point) => pointInPolygon(point, secondGeometry.areaOutline))) return true;
    const side = (start, end, point) => (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
    const firstSegments = segments(firstGeometry), secondSegments = segments(secondGeometry);
    for (const firstSegment of firstSegments) {
        for (const secondSegment of secondSegments) {
            const { start: firstStart, end: firstEnd } = firstSegment;
            const { start: secondStart, end: secondEnd } = secondSegment;
            const crosses = side(firstStart, firstEnd, secondStart) * side(firstStart, firstEnd, secondEnd) < 0
                && side(secondStart, secondEnd, firstStart) * side(secondStart, secondEnd, firstEnd) < 0;
            const gap = crosses ? 0 : Math.min(distanceToSegment(firstStart, secondStart, secondEnd),
                distanceToSegment(firstEnd, secondStart, secondEnd), distanceToSegment(secondStart, firstStart, firstEnd),
                distanceToSegment(secondEnd, firstStart, firstEnd));
            if (gap <= (firstSegment.lineWidth + secondSegment.lineWidth) / 2 + tolerance) return true;
        }
    }
    return false;
}