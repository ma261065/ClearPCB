import { resolveBoardShapeGeometry } from './board-shapes.js';

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