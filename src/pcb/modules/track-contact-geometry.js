import { resolveBoardShapeGeometry } from './board-shape-geometry.js';
import { distanceToSegment, pointInPolygon } from '../../core/geometry.js';
import { spatialCrossPairs } from '../../core/spatial-pairs.js';
import earcut from '../../../assets/vendor/earcut.module.js';

const regionShapes = new WeakMap();
const regionContacts = new WeakMap();

export function pointInCopperRegion(point, region) {
    return pointInPolygon(point, region.outer)
        && !region.holes.some(hole => pointInPolygon(point, hole));
}

export function copperRegionShape(region) {
    let shape = regionShapes.get(region);
    if (!shape) {
        shape = { kind: 'polygon', filled: true, lineWidth: 0, points: region.outer,
            region: region.holes ? region : { ...region, holes: [] } };
        regionShapes.set(region, shape);
    }
    return shape;
}

export function copperSegmentShape(segment) {
    return { kind: 'line', points: [segment.start, segment.end], layer: segment.layer,
        lineWidth: segment.width, copperSegment: segment };
}

function contactsForRegion(region) {
    let contacts = regionContacts.get(region);
    if (!contacts) {
        const points = [region.outer, ...region.holes].flat();
        let offset = region.outer.length;
        const holes = region.holes.map(hole => {
            const start = offset;
            offset += hole.length;
            return start;
        });
        const indices = earcut(points.flatMap(point => [point.x, point.y]), holes);
        contacts = [];
        for (let index = 0; index < indices.length; index += 3) {
            const contour = indices.slice(index, index + 3).map(vertex => points[vertex]);
            contacts.push({
                geometry: { centerline: contour, areaOutline: contour, lineWidth: 0,
                    filled: true, pathClosed: true, strokeSegments: [], circle: null },
                bounds: {
                    minX: Math.min(...contour.map(point => point.x)),
                    minY: Math.min(...contour.map(point => point.y)),
                    maxX: Math.max(...contour.map(point => point.x)),
                    maxY: Math.max(...contour.map(point => point.y)),
                },
            });
        }
        regionContacts.set(region, contacts);
    }
    return contacts;
}

const cache = new WeakMap();
const geometryKeys = ['kind', 'x', 'y', 'radius', 'start', 'end', 'bulge', 'points',
    'lineWidth', 'segmentWidths', 'segmentBulges', 'filled', 'cornerRadius', 'nodeCornerRadii', 'copperMode', 'layer', 'copperSegment'];

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
    if (previous && previous.region === shape.region
        && geometryKeys.every((key) => equalInput(shape[key], previous.inputs[key]))) return previous;
    const inputs = structuredClone(Object.fromEntries(geometryKeys.map((key) => [key, shape[key]])));
    const result = { inputs, ...createContact(shape) };
    cache.set(shape, result);
    return result;
}

/** Resolve pass-local segment descriptors without authored-shape cache snapshots. */
export function copperSegmentContact(segment) {
    return createContact({ copperSegment: segment });
}

function createContact(shape) {
    // Track widths are physical values, not generic-shape UI stroke defaults.
    const segment = shape.copperSegment;
    const geometry = segment ? {
        centerline: [segment.start, segment.end], areaOutline: [], pathClosed: false,
        filled: false, lineWidth: segment.width, circle: null,
        strokeSegments: [{ start: segment.start, end: segment.end, lineWidth: segment.width }],
    } : resolveBoardShapeGeometry(shape);
    // Pictures use their transformed frame as solid logical copper, not pixels.
    if (shape.region || shape.kind === 'image') geometry.lineWidth = 0;
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
    return { geometry, region: shape.region, bounds: {
        minX: minX - halfWidth, minY: minY - halfWidth,
        maxX: maxX + halfWidth, maxY: maxY + halfWidth,
    } };
}

export function copperShapesTouch(first, second) {
    return copperContactsTouch(resolveTrackContactGeometry(first), resolveTrackContactGeometry(second));
}

/** Compare contacts prepared for the same synchronous geometry pass. */
export function copperContactsTouch(firstContact, secondContact) {
    const firstBounds = firstContact.bounds, secondBounds = secondContact.bounds;
    const tolerance = 1e-7;
    if (firstBounds.maxX + tolerance < secondBounds.minX || secondBounds.maxX + tolerance < firstBounds.minX
        || firstBounds.maxY + tolerance < secondBounds.minY || secondBounds.maxY + tolerance < firstBounds.minY) return false;
    const firstGeometry = firstContact.geometry, secondGeometry = secondContact.geometry;
    if (!firstContact.region && !secondContact.region) {
        return copperGeometryTouches(firstGeometry, secondGeometry);
    }
    const regions = contact => contact.region ? contactsForRegion(contact.region) : [contact];
    for (const [a, b] of spatialCrossPairs(regions(firstContact), regions(secondContact),
        contact => contact.bounds, tolerance)) {
        if (copperGeometryTouches(a.geometry, b.geometry)) return true;
    }
    return false;
}

function copperGeometryTouches(firstGeometry, secondGeometry) {
    const tolerance = 1e-7;
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
        if (other.filled && pointInPolygon({ x: circle.x + outerRadius, y: circle.y }, other.areaOutline)) return true;
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