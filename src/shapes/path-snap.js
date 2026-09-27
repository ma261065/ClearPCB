import { collinearSnap } from '../core/geometry.js';
import { BULGE_EPS } from './arc-edge.js';

export function pathContinuationConstraints(points, closed, index, bulges = []) {
    const constraints = [];
    for (const direction of [-1, 1]) {
        const neighbourIndex = index + direction;
        const beyondIndex = index + 2 * direction;
        if (!closed && (beyondIndex < 0 || beyondIndex >= points.length)) continue;
        if (points.length < 3) continue;
        const wrap = value => (value + points.length) % points.length;
        const firstEdge = wrap(direction < 0 ? neighbourIndex : index);
        const secondEdge = wrap(direction < 0 ? beyondIndex : neighbourIndex);
        if (Math.abs(bulges[firstEdge] || 0) >= BULGE_EPS || Math.abs(bulges[secondEdge] || 0) >= BULGE_EPS) continue;
        constraints.push([points[wrap(neighbourIndex)], points[wrap(beyondIndex)]]);
    }
    return constraints;
}

export function pathSegmentConstraints(points, closed, segment, bulges = []) {
    const count = points.length;
    if (segment < 0 || segment >= count - (closed ? 0 : 1)) return [];
    const indices = [segment, (segment + 1) % count];
    const moving = new Set(indices.map(index => points[index]));
    return indices.map((index, movingIndex) => {
        const fixedIndex = index + (movingIndex === 0 ? -1 : 1);
        const edgeIndex = movingIndex === 0 ? fixedIndex : index;
        const fixed = closed || fixedIndex >= 0 && fixedIndex < count ? points[(fixedIndex + count) % count] : null;
        const straight = Math.abs(bulges[(edgeIndex + count) % count] || 0) < BULGE_EPS;
        return {
            index: movingIndex,
            neighbours: fixed && straight && !moving.has(fixed) ? [fixed] : [],
            continuations: pathContinuationConstraints(points, closed, index, bulges)
                .filter(pair => pair.every(point => !moving.has(point))),
        };
    });
}

export function snapNodeToAxis(point, neighbours, threshold = Infinity, fallback = point) {
    let bestX = null, bestY = null, bestDiagonal = null;
    for (const [index, neighbour] of neighbours.entries()) {
        const horizontalDistance = Math.abs(point.y - neighbour.y);
        const verticalDistance = Math.abs(point.x - neighbour.x);
        if (verticalDistance <= threshold && (!bestX || verticalDistance < bestX.distance)) bestX = { value: neighbour.x, distance: verticalDistance, index };
        if (horizontalDistance <= threshold && (!bestY || horizontalDistance < bestY.distance)) bestY = { value: neighbour.y, distance: horizontalDistance, index };
        const dx = point.x - neighbour.x, dy = point.y - neighbour.y;
        const diagonal = Math.abs(dx) >= Math.abs(dy)
            ? { x: point.x, y: neighbour.y + (Math.sign(dy) || 1) * Math.abs(dx) }
            : { x: neighbour.x + (Math.sign(dx) || 1) * Math.abs(dy), y: point.y };
        const distance = Math.hypot(diagonal.x - point.x, diagonal.y - point.y);
        if (distance <= threshold && (!bestDiagonal || distance < bestDiagonal.distance)) bestDiagonal = { ...diagonal, distance };
    }
    if (bestX && bestY && bestX.index !== bestY.index) return { x: bestX.value, y: bestY.value };
    let best = fallback;
    let distance = Infinity;
    if (bestX && bestX.distance < distance) { distance = bestX.distance; best = { x: bestX.value, y: fallback.y }; }
    if (bestY && bestY.distance < distance) { distance = bestY.distance; best = { x: fallback.x, y: bestY.value }; }
    if (bestDiagonal && bestDiagonal.distance < distance) best = { x: bestDiagonal.x, y: bestDiagonal.y };
    return best;
}

export function snapNodeToCollinear(point, neighbours, threshold) {
    return neighbours.length === 2 ? collinearSnap(neighbours[0], point, neighbours[1], threshold) : null;
}

function snapPathCollinear(point, neighbours, grid, threshold, continuations) {
    let continuation = null;
    let bestDistance = Infinity;
    for (const [fixed, beyond] of continuations) {
        const snapped = collinearSnap(fixed, point, beyond, threshold);
        if (!snapped || (snapped.x - fixed.x) * (beyond.x - fixed.x)
            + (snapped.y - fixed.y) * (beyond.y - fixed.y) >= 0) continue;
        const distance = Math.hypot(snapped.x - point.x, snapped.y - point.y);
        if (distance < bestDistance) {
            continuation = snapped;
            bestDistance = distance;
        }
    }
    const collinear = snapNodeToCollinear(point, neighbours, threshold);
    if (continuation && (!collinear || bestDistance < Math.hypot(collinear.x - point.x, collinear.y - point.y))) return continuation;
    if (collinear) {
        if (Math.abs(neighbours[0].x - neighbours[1].x) < 1e-9) return { x: collinear.x, y: grid.y };
        if (Math.abs(neighbours[0].y - neighbours[1].y) < 1e-9) return { x: grid.x, y: collinear.y };
        return collinear;
    }
    return null;
}

export function resolvePathPoint(point, neighbours, grid, threshold, target = null, continuations = []) {
    if (target) return { x: target.x, y: target.y };
    return snapPathCollinear(point, neighbours, grid, threshold, continuations)
        || snapNodeToAxis(point, neighbours, threshold, grid);
}

export function resolvePathTranslation(points, delta, neighbours, constraints, threshold, findTarget, snapPoint) {
    let best = null;
    for (const point of points) {
        const target = { x: point.x + delta.x, y: point.y + delta.y };
        const connection = findTarget(target, threshold);
        if (!connection) continue;
        const distance = Math.hypot(connection.x - target.x, connection.y - target.y);
        if (!best || distance < best.distance) best = { x: connection.x - point.x, y: connection.y - point.y, distance };
    }
    if (best) return best;
    const anchor = points[0];
    if (!anchor) return delta;
    for (const collinearOnly of [true, false]) {
        for (const { index, neighbours: fixed, continuations = [] } of constraints) {
            const point = points[index];
            const target = { x: point.x + delta.x, y: point.y + delta.y };
            const aligned = collinearOnly ? snapPathCollinear(target, fixed, target, threshold, continuations)
                : snapNodeToAxis(target, fixed, threshold, target);
            if (!aligned || aligned === target) continue;
            const distance = Math.hypot(aligned.x - target.x, aligned.y - target.y);
            if (!best || distance < best.distance) best = { x: aligned.x - point.x, y: aligned.y - point.y, distance };
        }
        if (best) return best;
    }
    const target = snapPoint({ x: anchor.x + delta.x, y: anchor.y + delta.y }, neighbours);
    return { x: target.x - anchor.x, y: target.y - anchor.y };
}