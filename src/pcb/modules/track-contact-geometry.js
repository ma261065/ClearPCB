import { resolveBoardShapeGeometry } from '../../shared/pcb/board-shape-geometry.js';
import { padFlashOutline } from '../../shared/pcb/board-geometry.js';
import { distanceToSegment, pointInPolygon } from '../../core/geometry.js';
import { spatialCrossPairs, prepareSpatialOrder, filterSpatialOrder, spatialCrossPairsPrepared } from '../../core/spatial-pairs.js';
import earcut from '../../../assets/vendor/earcut.module.js';

const regionShapes = new WeakMap();
const regionContacts = new WeakMap();
const preparedRegions = new WeakMap();
const validatedPreparations = new WeakSet();
const terminalRegions = new WeakSet();
const regionOrders = new WeakMap();

/** Worker-transferable triangles/bounds; region and payload become read-only after adoption. */
export function prepareCopperRegionContact(region) {
    const points = [region.outer, ...region.holes].flat();
    let offset = region.outer.length;
    const holes = region.holes.map(hole => {
        const start = offset;
        offset += hole.length;
        return start;
    });
    const indices = new Uint32Array(earcut(points.flatMap(point => [point.x, point.y]), holes));
    const bounds = new Float64Array([Infinity, Infinity, -Infinity, -Infinity]);
    for (const point of region.outer) {
        bounds[0] = Math.min(bounds[0], point.x); bounds[1] = Math.min(bounds[1], point.y);
        bounds[2] = Math.max(bounds[2], point.x); bounds[3] = Math.max(bounds[3], point.y);
    }
    const triangleBounds = new Float64Array(indices.length / 3 * 4);
    for (let index = 0, target = 0; index < indices.length; index += 3, target += 4) {
        const a = points[indices[index]], b = points[indices[index + 1]], c = points[indices[index + 2]];
        triangleBounds[target] = Math.min(a.x, b.x, c.x);
        triangleBounds[target + 1] = Math.min(a.y, b.y, c.y);
        triangleBounds[target + 2] = Math.max(a.x, b.x, c.x);
        triangleBounds[target + 3] = Math.max(a.y, b.y, c.y);
    }
    return { region, indices, bounds, triangleBounds };
}

/** Validate once at the transport boundary, binding metadata to the exact returned region. */
export function validateCopperRegionContact(region, prepared) {
    if (prepared?.region !== region) throw new Error('Prepared copper contact belongs to a different region');
    if (validatedPreparations.has(prepared)) return;
    const { indices, bounds, triangleBounds } = prepared;
    const count = region.outer.length + region.holes.reduce((sum, hole) => sum + hole.length, 0);
    if (!(indices instanceof Uint32Array) || indices.length % 3
        || !(bounds instanceof Float64Array) || bounds.length !== 4
        || !(triangleBounds instanceof Float64Array) || triangleBounds.length !== indices.length / 3 * 4
        || indices.some(index => index >= count)) throw new Error('Invalid prepared copper-contact triangles');
    for (const values of [bounds, triangleBounds]) {
        for (let index = 0; index < values.length; index += 4) {
            if (!Number.isFinite(values[index]) || !Number.isFinite(values[index + 1])
                || !Number.isFinite(values[index + 2]) || !Number.isFinite(values[index + 3])
                || values[index] > values[index + 2] || values[index + 1] > values[index + 3]) {
                throw new Error('Invalid prepared copper-contact bounds');
            }
        }
    }
    Object.freeze(prepared);
    validatedPreparations.add(prepared);
}

const polygonGeometry = contour => ({ centerline: contour, areaOutline: contour, lineWidth: 0,
    filled: true, pathClosed: true, strokeSegments: [], circle: null });
const unpackBounds = (values, offset = 0) => ({
    minX: values[offset], minY: values[offset + 1], maxX: values[offset + 2], maxY: values[offset + 3],
});

/** Adopt only validated, immutable worker results, never authored shapes or their metadata. */
export function installCopperRegionContact(region, prepared) {
    validateCopperRegionContact(region, prepared);
    preparedRegions.set(region, {
        prepared, contact: { region, geometry: polygonGeometry(region.outer), bounds: unpackBounds(prepared.bounds) },
    });
    regionContacts.delete(region);
    regionOrders.delete(region);
    const shape = regionShapes.get(region);
    if (shape) Object.freeze(shape);
}

class PreparedTriangle {
    constructor(points, prepared, index) {
        this.points = points;
        this.indices = prepared.indices;
        this.index = index;
        this.bounds = unpackBounds(prepared.triangleBounds, index / 3 * 4);
    }
    get geometry() {
        return this._geometry ||= polygonGeometry([
            this.points[this.indices[this.index]], this.points[this.indices[this.index + 1]],
            this.points[this.indices[this.index + 2]],
        ]);
    }
}

function preparedTriangle(entry, index) {
    const { prepared } = entry;
    entry.points ||= [prepared.region.outer, ...prepared.region.holes].flat();
    entry.triangles ||= new Array(prepared.indices.length / 3);
    return entry.triangles[index] ||= new PreparedTriangle(entry.points, prepared, index * 3);
}

function preparedRegionTouches(entry, other, tolerance) {
    const bounds = entry.prepared.triangleBounds, target = other.bounds;
    for (let offset = 0; offset < bounds.length; offset += 4) {
        if (bounds[offset + 2] + tolerance < target.minX || target.maxX + tolerance < bounds[offset]
            || bounds[offset + 3] + tolerance < target.minY || target.maxY + tolerance < bounds[offset + 1]) continue;
        if (copperGeometryTouches(preparedTriangle(entry, offset / 4).geometry, other.geometry)) return true;
    }
    return false;
}

export function pointInCopperRegion(point, region) {
    return pointInPolygon(point, region.outer)
        && !region.holes.some(hole => pointInPolygon(point, hole));
}

export function copperRegionShape(region) {
    let shape = regionShapes.get(region);
    if (!shape) {
        shape = { kind: 'polygon', filled: true, lineWidth: 0, points: region.outer,
            region: region.holes ? region : { ...region, holes: [] } };
        if (preparedRegions.has(region)) Object.freeze(shape);
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
        const entry = preparedRegions.get(region);
        if (entry) {
            contacts = Array.from({ length: entry.prepared.indices.length / 3 },
                (_, index) => preparedTriangle(entry, index));
            regionContacts.set(region, contacts);
            return contacts;
        }
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

const immutableRegion = region => preparedRegions.has(region) || terminalRegions.has(region);
function orderedContacts(contact) {
    const region = contact.region;
    let ordered = regionOrders.get(region);
    if (!ordered) {
        const items = prepareSpatialOrder(region ? contactsForRegion(region) : [contact], item => item.bounds);
        const bounds = { ...contact.bounds };
        // Include triangle extents even for an oversized authored bore/slot.
        for (const item of items) {
            bounds.minX = Math.min(bounds.minX, item.bounds.minX);
            bounds.minY = Math.min(bounds.minY, item.bounds.minY);
            bounds.maxX = Math.max(bounds.maxX, item.bounds.maxX);
            bounds.maxY = Math.max(bounds.maxY, item.bounds.maxY);
        }
        ordered = { items, bounds };
        if (immutableRegion(region)) regionOrders.set(region, ordered);
    }
    return ordered;
}

function contactCandidates(ordered, query, tolerance) {
    const bounds = ordered.bounds;
    if (query.minX <= bounds.minX && query.minY <= bounds.minY
        && query.maxX >= bounds.maxX && query.maxY >= bounds.maxY) return ordered.items;
    return filterSpatialOrder(ordered.items, query, tolerance);
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
    const prepared = preparedRegions.get(shape.region);
    if (prepared && regionShapes.get(shape.region) === shape) return prepared.contact;
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

function sameOutline(first, second) {
    if (first.length !== second.length) return false;
    for (let index = 0; index < first.length; index++) {
        if (first[index].x !== second[index].x || first[index].y !== second[index].y) return false;
    }
    return true;
}

/** Reuse only exact physical inputs; the retained geometry owns its contour and bore. */
export function resolveTerminalCopperContact(cluster, previous) {
    const terminal = cluster.pad || cluster.via;
    const outline = cluster.pad?.outline;
    const { x, y, drill } = terminal;
    const slot = terminal.slot || null;
    if (previous && previous.kind === cluster.kind && previous.x === x && previous.y === y
        && previous.radius === cluster.viaRadius && previous.drill === drill
        && !!previous.slot === !!slot && (!slot || (previous.slot.x1 === slot.x1
            && previous.slot.y1 === slot.y1 && previous.slot.x2 === slot.x2 && previous.slot.y2 === slot.y2))
        && previous.hasOutline === !!outline && (!outline || sameOutline(outline, previous.shape.region.outer))) {
        return previous;
    }
    const outer = outline ? outline.map(point => ({ x: point.x, y: point.y })) : padFlashOutline({
        x, y, w: cluster.viaRadius * 2, h: cluster.viaRadius * 2, shape: 'circle',
    }, 1e-4);
    const holes = [];
    if (drill > 0) holes.push(padFlashOutline({
        x: slot ? (slot.x1 + slot.x2) / 2 : x,
        y: slot ? (slot.y1 + slot.y2) / 2 : y,
        w: drill + (slot ? Math.hypot(slot.x2 - slot.x1, slot.y2 - slot.y1) : 0),
        h: drill, shape: slot ? 'oval' : 'circle',
        rad: slot ? Math.atan2(slot.y2 - slot.y1, slot.x2 - slot.x1) : 0,
    }, 1e-4));
    const shape = copperRegionShape({ outer, holes });
    terminalRegions.add(shape.region);
    return { kind: cluster.kind, x, y, drill, radius: cluster.viaRadius, hasOutline: !!outline,
        slot: slot ? { x1: slot.x1, y1: slot.y1, x2: slot.x2, y2: slot.y2 } : null,
        shape, resolved: resolveTrackContactGeometry(shape) };
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
    const firstPrepared = preparedRegions.get(firstContact.region), secondPrepared = preparedRegions.get(secondContact.region);
    if (firstPrepared && !secondContact.region) return preparedRegionTouches(firstPrepared, secondContact, tolerance);
    if (secondPrepared && !firstContact.region) return preparedRegionTouches(secondPrepared, firstContact, tolerance);
    const regions = contact => contact.region ? contactsForRegion(contact.region) : [contact];
    let pairs;
    if (immutableRegion(firstContact.region) || immutableRegion(secondContact.region)) {
        const first = orderedContacts(firstContact), second = orderedContacts(secondContact);
        pairs = spatialCrossPairsPrepared(contactCandidates(first, second.bounds, tolerance),
            contactCandidates(second, first.bounds, tolerance), tolerance);
    } else {
        pairs = spatialCrossPairs(regions(firstContact), regions(secondContact), contact => contact.bounds, tolerance);
    }
    for (const [a, b] of pairs) {
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