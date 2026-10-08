import { BULGE_EPS, arcFromBulge } from './arc-edge.js';
import { validClosedShape } from './closed-outline.js';

/** @typedef {{x:number,y:number}} Point */
/** @typedef {{kind?: string, points: Point[], id?: string, lineWidth?: number, cornerRadius?: number, filled?: boolean, segmentWidths?: Record<number, number>, segmentBulges?: Record<number, number>, edgeIds?: Record<number, string>, nodeCornerRadii?: Record<number, number>, nodeIds?: Record<number, string>, [key: string]: any}} PathShape */

const EDGE_FIELDS = ['segmentWidths', 'segmentBulges', 'edgeIds'];
const NODE_FIELDS = ['nodeCornerRadii', 'nodeIds'];

/** Collapse exact duplicate neighbours on a rounded save copy, not live geometry. */
/** @param {PathShape} path */
export function collapseRoundedPolygon(path) {
    if (path.kind !== 'polygon') return false;
    const points = path.points;
    /** @param {Point} a @param {Point} b */
    const same = (a, b) => a.x === b.x && a.y === b.y;
    if (points.length < 2 || !points.some((point, index) => same(point, points[(index + 1) % points.length]))) return false;
    /** @type {number[][]} */
    const groups = [];
    for (let index = 0; index < points.length; index++) {
        if (index && same(points[index - 1], points[index])) groups[groups.length - 1].push(index);
        else groups.push([index]);
    }
    if (groups.length > 1 && same(points[0], /** @type {Point} */ (points.at(-1)))) {
        groups[0] = [.../** @type {number[]} */ (groups.pop()), ...groups[0]];
    }
    /** @param {string} reason */
    const fail = reason => { throw new Error(`Cannot save polygon${path.id ? ` "${path.id}"` : ''}: ${reason}`); };
    if (groups.length < 3) fail('rounding leaves fewer than three distinct corners.');
    for (const group of groups) {
        const outgoing = /** @type {number} */ (group.at(-1));
        const width = path.segmentWidths?.[outgoing] ?? path.lineWidth ?? 0.2;
        const radius = path.nodeCornerRadii?.[outgoing] ?? path.cornerRadius ?? 0;
        // Removing a tiny edge can release the radius clamp and enlarge a rounded corner.
        if (group.length > 1 && radius > 0) fail('rounding collapses a rounded corner.');
        for (const index of group.slice(0, -1)) {
            if (path.segmentBulges?.[index]) fail('rounding collapses a curved edge.');
            if ((path.segmentWidths?.[index] ?? path.lineWidth ?? 0.2) !== width) {
                fail('a collapsed edge has a conflicting width.');
            }
            if ((path.nodeCornerRadii?.[index] ?? path.cornerRadius ?? 0) !== radius) {
                fail('merged corners have conflicting radii.');
            }
        }
    }
    const retained = groups.map(group => group.includes(0) ? 0 : group[0]);
    const cleaned = /** @type {PathShape} */ ({ ...path, points: retained.map(index => ({ ...points[index] })) });
    for (const field of [...EDGE_FIELDS, ...NODE_FIELDS]) {
        if (!path[field]) continue;
        cleaned[field] = Object.fromEntries(groups.flatMap((group, index) => {
            const source = EDGE_FIELDS.includes(field) ? group.at(-1)
                : field === 'nodeCornerRadii' ? group.find(old => Object.hasOwn(path[field] || {}, old)) : retained[index];
            return source !== undefined && Object.hasOwn(path[field], source) ? [[index, path[field][source]]] : [];
        }));
    }
    if (!validClosedShape(cleaned, { allowCrossings: true })) fail('rounding leaves an invalid closed outline.');
    Object.assign(path, cleaned);
    for (const field of [...EDGE_FIELDS, ...NODE_FIELDS]) {
        if (path[field] && !Object.keys(path[field]).length) delete path[field];
    }
    return true;
}

/** @param {PathShape} path @param {number} segment @param {'line'|'arc'} type */
export function setPathSegmentType(path, segment, type) {
    if (!Array.isArray(path?.points)) return false;
    const count = path?.points?.length - (path?.kind === 'line' ? 1 : 0);
    if (typeof path.kind !== 'string' || !['line', 'polygon', 'rect'].includes(path.kind) || !['line', 'arc'].includes(type)
        || !Number.isInteger(segment) || segment < 0 || segment >= count) return false;
    const start = path.points[segment];
    const end = path.points[(segment + 1) % path.points.length];
    if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-9) return false;
    if (type === 'arc') {
        const existing = Number(path.segmentBulges?.[segment]);
        const bulge = Number.isFinite(existing) && Math.abs(existing) >= BULGE_EPS
            ? Math.max(-1, Math.min(1, existing)) : 0.25;
        if (!arcFromBulge(start, end, bulge)) return false;
        path.segmentBulges ||= {};
        path.segmentBulges[segment] = bulge;
        if (path.kind === 'rect') path.kind = 'polygon';
    } else if (path.segmentBulges) delete path.segmentBulges[segment];
    return true;
}

/** @param {Point[]|null|undefined} points */
export function pointsFormAxisAlignedRect(points) {
    if (!Array.isArray(points) || points.length !== 4) return false;
    const epsilon = 1e-6;
    for (let index = 0; index < 4; index++) {
        const point = points[index];
        const next = points[(index + 1) % 4];
        const nextNext = points[(index + 2) % 4];
        const horizontal = Math.abs(point.y - next.y) <= epsilon && Math.abs(point.x - next.x) > epsilon;
        const vertical = Math.abs(point.x - next.x) <= epsilon && Math.abs(point.y - next.y) > epsilon;
        if (!horizontal && !vertical) return false;
        const nextHorizontal = Math.abs(next.y - nextNext.y) <= epsilon && Math.abs(next.x - nextNext.x) > epsilon;
        if (horizontal === nextHorizontal) return false;
    }
    return true;
}

/** @param {Point[]} points @param {number} index @param {Point} target @returns {Point[]} */
export function resizeRectanglePoints(points, index, target) {
    const opposite = points[(index + 2) % 4];
    const adjacent = points[(index + 1) % 4];
    const dx = adjacent.x - opposite.x, dy = adjacent.y - opposite.y;
    const lengthSquared = dx * dx + dy * dy;
    if (!Number.isFinite(lengthSquared) || lengthSquared === 0) {
        throw new Error('Cannot resize a rectangle without a nonzero side axis.');
    }
    // Resolve the moving diagonal along the rectangle's own axes, not world X/Y.
    const projection = ((target.x - opposite.x) * dx + (target.y - opposite.y) * dy) / lengthSquared;
    const along = dx === 0 ? { x: opposite.x, y: target.y }
        : dy === 0 ? { x: target.x, y: opposite.y }
        : { x: opposite.x + dx * projection, y: opposite.y + dy * projection };
    const across = dx === 0 ? { x: target.x, y: opposite.y }
        : dy === 0 ? { x: opposite.x, y: target.y }
        : { x: target.x - dx * projection, y: target.y - dy * projection };
    const resized = points.map(point => ({ ...point }));
    resized[index] = { x: target.x, y: target.y };
    resized[(index + 1) % 4] = along;
    resized[(index + 3) % 4] = across;
    return resized;
}

/** @param {PathShape} path @param {number} segment @returns {PathShape[]|null} */
export function deletePathSegment(path, segment) {
    const count = path.kind === 'line' ? path.points.length - 1 : path.points.length;
    if (!Number.isInteger(segment) || segment < 0 || segment >= count) return null;
    const indices = path.points.map((_, index) => index);
    const chains = path.kind === 'line'
        ? [indices.slice(0, segment + 1), indices.slice(segment + 1)]
        : [indices.map(index => (segment + 1 + index) % indices.length)];
    return chains.filter(chain => chain.length >= 2).map(chain => pathChain(path, chain));
}

/** @param {PathShape} path @param {number} endpoint @param {number} [tolerance] */
export function closePathIfCoincident(path, endpoint, tolerance = 0.15) {
    if (path.kind !== 'line' || !Array.isArray(path.points)) return false;
    const last = path.points.length - 1;
    if (path.kind !== 'line' || last < 3 || endpoint !== 0 && endpoint !== last) return false;
    if (Math.hypot(path.points[0].x - path.points[last].x, path.points[0].y - path.points[last].y) >= tolerance) return false;
    if (endpoint === 0) {
        for (const field of EDGE_FIELDS) {
            if (!path[field]) continue;
            path[field] = Object.fromEntries(Object.entries(path[field]).map(([key, value]) =>
                [(Number(key) + last - 1) % last, value]));
        }
    }
    path.points.splice(endpoint, 1);
    remapPathNodes(path, endpoint, -1);
    path.kind = 'polygon';
    return true;
}

/** @param {PathShape} path @param {(index: number) => number} [widthAt] */
export function collapseCollinearPath(path, widthAt = index => path.segmentWidths?.[index] ?? path.lineWidth ?? 0.2) {
    if (typeof path.kind !== 'string' || !['line', 'polygon'].includes(path.kind)) return false;
    const closed = path.kind === 'polygon';
    let changed = false;
    let repeat = true;
    while (repeat && path.points.length > (closed ? 3 : 2)) {
        repeat = false;
        const points = path.points;
        for (let index = closed ? 0 : 1; index < (closed ? points.length : points.length - 1); index++) {
            const previousIndex = (index + points.length - 1) % points.length;
            if (Math.abs(path.segmentBulges?.[previousIndex] || 0) >= 1e-4
                || Math.abs(path.segmentBulges?.[index] || 0) >= 1e-4
                || Math.abs(widthAt(previousIndex) - widthAt(index)) > 1e-9) continue;
            const previous = points[previousIndex], point = points[index], next = points[(index + 1) % points.length];
            const cross = Math.abs((point.x - previous.x) * (next.y - point.y) - (point.y - previous.y) * (next.x - point.x));
            const length = Math.hypot(next.x - previous.x, next.y - previous.y);
            const forward = (point.x - previous.x) * (next.x - point.x) + (point.y - previous.y) * (next.y - point.y);
            if (length <= 1e-9 || cross / length >= 1e-6 || forward <= 0) continue;
            for (const field of EDGE_FIELDS) {
                if (!path[field]) continue;
                path[field] = Object.fromEntries(Object.entries(path[field] || {}).filter(([key]) => Number(key) !== index)
                    .map(([key, value]) => [Number(key) > index ? Number(key) - 1 : Number(key), value]));
            }
            points.splice(index, 1);
            remapPathNodes(path, index, -1);
            changed = repeat = true;
            break;
        }
    }
    return changed;
}

/** @param {PathShape} path @param {number[]} indices @returns {PathShape} */
export function pathChain(path, indices) {
    const result = /** @type {PathShape} */ ({ ...path, kind: 'line', filled: false,
        points: indices.map(index => ({ ...path.points[index] })) });
    for (const field of [...EDGE_FIELDS, ...NODE_FIELDS]) {
        if (!path[field]) continue;
        const count = NODE_FIELDS.includes(field) ? indices.length : indices.length - 1;
        result[field] = Object.fromEntries(indices.slice(0, count).flatMap((source, index) =>
            Object.hasOwn(path[field] || {}, source) ? [[index, path[field][source]]] : []));
    }
    return result;
}

/** @param {PathShape} path @param {number} index @returns {{moving: PathShape, remainder: PathShape|null}|null} */
export function splitPathAtNode(path, index) {
    const count = path?.points?.length || 0;
    const open = path?.kind === 'line';
    if (count < 3 || !Number.isInteger(index) || index < 0 || index >= count
        || open && (index === 0 || index === count - 1)) return null;
    const remainder = open ? pathChain(path, Array.from({ length: index + 1 }, (_, offset) => offset)) : null;
    const moving = pathChain(path, Array.from({ length: open ? count - index : count + 1 },
        (_, offset) => (index + offset) % count));
    if (!open && moving.nodeIds) delete moving.nodeIds[count];
    return { moving, remainder };
}

/** @param {PathShape} path @returns {PathShape} */
export function reversePath(path) {
    const count = path.points.length - 1;
    const result = /** @type {PathShape} */ ({ ...path, points: [...path.points].reverse().map(point => ({ ...point })) });
    for (const field of [...EDGE_FIELDS, ...NODE_FIELDS]) {
        if (!path[field]) continue;
        result[field] = Object.fromEntries(Object.entries(path[field] || {}).map(([key, value]) => [
            (NODE_FIELDS.includes(field) ? count : count - 1) - Number(key),
            field === 'segmentBulges' ? -Number(value) : value,
        ]));
    }
    return result;
}

/** @param {PathShape} first @param {number} firstEndpoint @param {PathShape} second @param {number} secondEndpoint @returns {PathShape} */
export function joinPaths(first, firstEndpoint, second, secondEndpoint) {
    const firstPart = firstEndpoint === first.points.length - 1 ? pathChain(first, first.points.map((_, index) => index)) : reversePath(first);
    const secondPart = secondEndpoint === 0 ? pathChain(second, second.points.map((_, index) => index)) : reversePath(second);
    for (const part of [firstPart, secondPart]) {
        part.segmentWidths = Object.fromEntries(part.points.slice(0, -1).map((_, index) =>
            [index, part.segmentWidths?.[index] ?? part.lineWidth ?? 0.2]));
        part.nodeCornerRadii = Object.fromEntries(part.points.map((_, index) =>
            [index, part.nodeCornerRadii?.[index] ?? part.cornerRadius ?? 0]));
    }
    const offset = firstPart.points.length - 1;
    const result = /** @type {PathShape} */ ({ ...first, kind: 'line', points: [...firstPart.points, ...secondPart.points.slice(1)] });
    for (const field of [...EDGE_FIELDS, ...NODE_FIELDS]) {
        if (!firstPart[field] && !secondPart[field]) continue;
        result[field] = { ...firstPart[field], ...Object.fromEntries(Object.entries(secondPart[field] || {})
            .filter(([index]) => !NODE_FIELDS.includes(field) || Number(index) > 0)
            .map(([index, value]) => [Number(index) + offset, value])) };
    }
    return result;
}

/** @param {PathShape} path @param {number} index @param {number} delta */
export function remapPathNodes(path, index, delta) {
    for (const field of NODE_FIELDS) {
    if (!path[field]) continue;
        path[field] = Object.fromEntries(Object.entries(path[field] || {}).flatMap(([key, value]) => {
            const nodeIndex = Number(key);
            if (!Number.isInteger(nodeIndex) || (delta < 0 && nodeIndex === index)) return [];
            return [[nodeIndex < index ? nodeIndex : nodeIndex + delta, value]];
        }));
    }
}

/** @param {PathShape} path @param {number} segment */
export function splitPathSegmentMetadata(path, segment) {
    for (const field of EDGE_FIELDS) {
    if (!path[field]) continue;
        /** @type {Record<number, any>} */
        const remapped = {};
        for (const [key, value] of Object.entries(path[field] || {})) {
            const index = Number(key);
            if (!Number.isInteger(index)) continue;
            if (index < segment) remapped[index] = value;
            else if (index === segment) {
                const splitValue = field === 'segmentBulges' ? Math.tan(Math.atan(Number(value)) / 2) : value;
                remapped[index] = splitValue;
                if (field !== 'edgeIds') remapped[index + 1] = splitValue;
            } else remapped[index + 1] = value;
        }
        path[field] = remapped;
    }
}

/** @param {PathShape} path @param {number} vertexIndex */
export function deletePathVertex(path, vertexIndex) {
    const count = path.points.length;
    if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= count || count <= 2) return false;
    const closed = path.kind !== 'line';
    for (const field of EDGE_FIELDS) {
        if (!path[field]) continue;
        const values = path[field] || {};
        /** @type {Record<number, any>} */
        const remapped = {};
        if (closed && count === 3) {
            const source = vertexIndex === 0 ? 1 : vertexIndex === 2 ? 0 : 2;
            if (Object.hasOwn(values, source)) remapped[0] = field === 'segmentBulges' && vertexIndex === 1 ? -Number(values[source]) : values[source];
        } else {
            const previous = (vertexIndex + count - 1) % count;
            for (const [key, value] of Object.entries(values)) {
                const index = Number(key);
                if (index === vertexIndex || index === previous) continue;
                remapped[index > vertexIndex ? index - 1 : index] = value;
            }
            if (field !== 'segmentBulges' && (closed || vertexIndex > 0 && vertexIndex < count - 1)
                && Object.hasOwn(values, previous)) remapped[vertexIndex === 0 ? count - 2 : previous] = values[previous];
        }
        path[field] = remapped;
    }
    path.points.splice(vertexIndex, 1);
    remapPathNodes(path, vertexIndex, -1);
    path.kind = path.points.length < 3 || !closed ? 'line' : 'polygon';
    collapseCollinearPath(path);
    return true;
}