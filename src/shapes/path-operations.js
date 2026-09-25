import { BULGE_EPS, arcFromBulge } from './arc-edge.js';

const EDGE_FIELDS = ['segmentWidths', 'segmentBulges', 'edgeIds'];
const NODE_FIELDS = ['nodeCornerRadii', 'nodeIds'];

export function setPathSegmentType(path, segment, type) {
    if (!Array.isArray(path?.points)) return false;
    const count = path?.points?.length - (path?.kind === 'line' ? 1 : 0);
    if (!['line', 'polygon', 'rect'].includes(path?.kind) || !['line', 'arc'].includes(type)
        || !Number.isInteger(segment) || segment < 0 || segment >= count) return false;
    const start = path.points[segment];
    const end = path.points[(segment + 1) % path.points.length];
    if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-9) return false;
    if (type === 'arc') {
        const existing = path.segmentBulges?.[segment];
        const bulge = Number.isFinite(existing) && Math.abs(existing) >= BULGE_EPS
            ? Math.max(-1, Math.min(1, existing)) : 0.25;
        if (!arcFromBulge(start, end, bulge)) return false;
        path.segmentBulges ||= {};
        path.segmentBulges[segment] = bulge;
        if (path.kind === 'rect') path.kind = 'polygon';
    } else if (path.segmentBulges) delete path.segmentBulges[segment];
    return true;
}

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

export function resizeRectanglePoints(points, index, target) {
    const opposite = points[(index + 2) % 4];
    const corner = points[index];
    return points.map(point => ({
        x: Math.abs(point.x - corner.x) < 1e-9 ? target.x : opposite.x,
        y: Math.abs(point.y - corner.y) < 1e-9 ? target.y : opposite.y,
    }));
}

export function deletePathSegment(path, segment) {
    const count = path.kind === 'line' ? path.points.length - 1 : path.points.length;
    if (!Number.isInteger(segment) || segment < 0 || segment >= count) return null;
    const indices = path.points.map((_, index) => index);
    const chains = path.kind === 'line'
        ? [indices.slice(0, segment + 1), indices.slice(segment + 1)]
        : [indices.map(index => (segment + 1 + index) % indices.length)];
    return chains.filter(chain => chain.length >= 2).map(chain => pathChain(path, chain));
}

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

export function collapseCollinearPath(path, widthAt = index => path.segmentWidths?.[index] ?? path.lineWidth ?? 0.2) {
    if (!['line', 'polygon'].includes(path.kind)) return false;
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

export function pathChain(path, indices) {
    const result = { ...path, kind: 'line', filled: false,
        points: indices.map(index => ({ ...path.points[index] })) };
    for (const field of [...EDGE_FIELDS, ...NODE_FIELDS]) {
        if (!path[field]) continue;
        const count = NODE_FIELDS.includes(field) ? indices.length : indices.length - 1;
        result[field] = Object.fromEntries(indices.slice(0, count).flatMap((source, index) =>
            Object.hasOwn(path[field] || {}, source) ? [[index, path[field][source]]] : []));
    }
    return result;
}

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

export function reversePath(path) {
    const count = path.points.length - 1;
    const result = { ...path, points: [...path.points].reverse().map(point => ({ ...point })) };
    for (const field of [...EDGE_FIELDS, ...NODE_FIELDS]) {
        if (!path[field]) continue;
        result[field] = Object.fromEntries(Object.entries(path[field] || {}).map(([key, value]) => [
            (NODE_FIELDS.includes(field) ? count : count - 1) - Number(key),
            field === 'segmentBulges' ? -Number(value) : value,
        ]));
    }
    return result;
}

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
    const result = { ...first, kind: 'line', points: [...firstPart.points, ...secondPart.points.slice(1)] };
    for (const field of [...EDGE_FIELDS, ...NODE_FIELDS]) {
        if (!firstPart[field] && !secondPart[field]) continue;
        result[field] = { ...firstPart[field], ...Object.fromEntries(Object.entries(secondPart[field] || {})
            .filter(([index]) => !NODE_FIELDS.includes(field) || Number(index) > 0)
            .map(([index, value]) => [Number(index) + offset, value])) };
    }
    return result;
}

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

export function splitPathSegmentMetadata(path, segment) {
    for (const field of EDGE_FIELDS) {
    if (!path[field]) continue;
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

export function deletePathVertex(path, vertexIndex) {
    const count = path.points.length;
    if (!Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= count || count <= 2) return false;
    const closed = path.kind !== 'line';
    for (const field of EDGE_FIELDS) {
        if (!path[field]) continue;
        const values = path[field] || {};
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
    return true;
}