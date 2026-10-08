/**
 * Where to draw a selected object's lock icon, shared by both editors: just
 * outside the object's visible geometry, beside the part nearest the pointer that
 * selected it, so the icon is close to where the user is looking and never covers
 * the object.
 */
import { closestPointOnSegment, pointInPolygon } from './geometry.js';
import { lockIconMetrics, LOCK_SCREEN_GAP_PX } from './ui-helpers.js';

/** @typedef {{x:number,y:number}} Point */
/** @typedef {{minX:number,minY:number,maxX:number,maxY:number}} Bounds */
/** @typedef {{point: Point, start: Point, end: Point, distance: number, visualDistance: number, path: Point[], margin: number}} NearestBoundary */

/** A bounds rectangle as a closed outline.
 * @param {Bounds} bounds
 * @returns {Point[]}
 */
export function boundsOutline(bounds) {
    return [
        { x: bounds.minX, y: bounds.minY },
        { x: bounds.maxX, y: bounds.minY },
        { x: bounds.maxX, y: bounds.maxY },
        { x: bounds.minX, y: bounds.maxY },
    ];
}

/**
 * Position a lock beside the visible geometry nearest the pointer.
 * @param {Array<{x:number,y:number}> | Array<Array<{x:number,y:number}>>} points outline, or separate stroked segments
 * @param {{x:number,y:number}} pointer
 * @param {number} scale
 * @param {boolean} [closed]
 * @param {number|number[]} [objectMargin] painted half-width, per segment when an array
 */
export function lockPositionOutsideOutline(points, pointer, scale, closed = true, objectMargin = 0) {
    if (!pointer || !Array.isArray(points) || !points.length) return null;
    /** @type {Array<Array<{x:number,y:number}>>} */
    const paths = Array.isArray(points[0])
        ? /** @type {Array<Array<{x:number,y:number}>>} */ (points)
        : [/** @type {Array<{x:number,y:number}>} */ (points)];
    /** @type {NearestBoundary|null} */
    let nearest = null;
    for (let pathIndex = 0; pathIndex < paths.length; pathIndex++) {
        const path = paths[pathIndex];
        const margin = Array.isArray(objectMargin)
            ? Math.max(0, Number(objectMargin[pathIndex]) || 0)
            : Math.max(0, Number(objectMargin) || 0);
        const finite = path.filter(point => Number.isFinite(point?.x) && Number.isFinite(point?.y));
        if (!finite.length) continue;
        if (finite.length === 1) {
            const distance = Math.hypot(pointer.x - finite[0].x, pointer.y - finite[0].y);
            const visualDistance = Math.max(0, distance - margin);
            if (!nearest || visualDistance < nearest.visualDistance
                || (visualDistance === nearest.visualDistance && distance < nearest.distance)) {
                nearest = {
                    point: finite[0], start: finite[0], end: finite[0],
                    distance, visualDistance, path: finite, margin,
                };
            }
            continue;
        }
        const count = closed ? finite.length : finite.length - 1;
        for (let index = 0; index < count; index++) {
            const start = finite[index];
            const end = finite[(index + 1) % finite.length];
            const point = closestPointOnSegment(pointer, start, end);
            const distance = Math.hypot(pointer.x - point.x, pointer.y - point.y);
            const visualDistance = Math.max(0, distance - margin);
            if (!nearest || visualDistance < nearest.visualDistance
                || (visualDistance === nearest.visualDistance && distance < nearest.distance)) {
                nearest = { point, start, end, distance, visualDistance, path: finite, margin };
            }
        }
    }
    if (!nearest) return null;

    const pointerToBoundary = {
        x: nearest.point.x - pointer.x,
        y: nearest.point.y - pointer.y,
    };
    const pointerDistance = Math.hypot(pointerToBoundary.x, pointerToBoundary.y);
    let outward;
    if (pointerDistance > 1e-6) {
        const pointerIsInside = closed && nearest.path.length >= 3
            && pointInPolygon(pointer, nearest.path);
        const direction = pointerIsInside ? 1 : -1;
        outward = {
            x: pointerToBoundary.x / pointerDistance * direction,
            y: pointerToBoundary.y / pointerDistance * direction,
        };
    } else {
        const dx = nearest.end.x - nearest.start.x;
        const dy = nearest.end.y - nearest.start.y;
        const length = Math.hypot(dx, dy);
        const normals = length
            ? [{ x: -dy / length, y: dx / length }, { x: dy / length, y: -dx / length }]
            : [{ x: 0, y: -1 }];
        if (closed && nearest.path.length >= 3) {
            const probe = Math.max(0.1, 2 / Math.max(0.01, scale));
            outward = normals.find(candidate => !pointInPolygon({
                x: nearest.point.x + candidate.x * probe,
                y: nearest.point.y + candidate.y * probe,
            }, nearest.path)) || normals[0];
        } else {
            outward = normals.find(candidate => candidate.y < 0) || normals[0];
        }
    }

    const gap = LOCK_SCREEN_GAP_PX / Math.max(0.01, scale);
    const { bounds: lockBounds } = lockIconMetrics(scale);
    const boundary = {
        x: nearest.point.x + outward.x * nearest.margin,
        y: nearest.point.y + outward.y * nearest.margin,
    };
    const nearestLockX = outward.x >= 0 ? lockBounds.minX : lockBounds.maxX;
    const nearestLockY = outward.y >= 0 ? lockBounds.minY : lockBounds.maxY;
    const nearestProjection = outward.x * nearestLockX + outward.y * nearestLockY;
    const distance = gap - nearestProjection;
    return {
        x: boundary.x + outward.x * distance,
        y: boundary.y + outward.y * distance,
    };
}

/** Without a pointer, sit the lock just outside the top-left corner of the bounds.
 * @param {Bounds} bounds
 * @param {number} scale
 * @returns {Point}
 */
export function lockPositionBesideBounds(bounds, scale) {
    const gap = LOCK_SCREEN_GAP_PX / Math.max(0.01, scale);
    const { size } = lockIconMetrics(scale);
    return { x: bounds.minX - gap - size, y: bounds.minY - gap - size * 0.6 };
}
