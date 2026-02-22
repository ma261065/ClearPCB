/**
 * Geometry - Math utilities for schematic operations
 * 
 * All functions work with points in the form { x: number, y: number }
 */

// ==================== Point Operations ====================

/**
 * Get distance between two points
 */
export function distance(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
}

// ==================== Line Operations ====================

/**
 * Get closest point on a line segment to a given point
 */
export function closestPointOnSegment(point, lineStart, lineEnd) {
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const lengthSquared = dx * dx + dy * dy;
    
    if (lengthSquared === 0) {
        return { ...lineStart };
    }
    
    let t = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
    
    return {
        x: lineStart.x + t * dx,
        y: lineStart.y + t * dy
    };
}

/**
 * Get distance from a point to a line segment
 */
export function distanceToSegment(point, lineStart, lineEnd) {
    const closest = closestPointOnSegment(point, lineStart, lineEnd);
    return distance(point, closest);
}

// ==================== Polygon Operations ====================

/**
 * Check if a point is inside a polygon (using ray casting)
 */
export function pointInPolygon(point, polygon) {
    let inside = false;
    const n = polygon.length;
    
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = polygon[i].x, yi = polygon[i].y;
        const xj = polygon[j].x, yj = polygon[j].y;
        
        if (((yi > point.y) !== (yj > point.y)) &&
            (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    
    return inside;
}

// ==================== Arc Operations ====================

/**
 * Calculate circumcircle (center + radius) from three points.
 * Returns { cx, cy, radius } or null if points are collinear.
 */
export function circumcircle(p1, p2, p3) {
    const d1 = p1.x * p1.x + p1.y * p1.y;
    const d2 = p2.x * p2.x + p2.y * p2.y;
    const d3 = p3.x * p3.x + p3.y * p3.y;

    const det = 2 * (p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y));

    if (Math.abs(det) < 0.0001) return null; // Collinear

    const cx = (d1 * (p2.y - p3.y) + d2 * (p3.y - p1.y) + d3 * (p1.y - p2.y)) / det;
    const cy = (d1 * (p3.x - p2.x) + d2 * (p1.x - p3.x) + d3 * (p2.x - p1.x)) / det;
    const radius = Math.hypot(p1.x - cx, p1.y - cy);

    return { cx, cy, radius };
}

/**
 * Project a point onto the perpendicular bisector of chord p1->p2.
 * Returns the projected point. If the chord is degenerate, returns the original point.
 */
export function projectOntoChordBisector(p1, p2, pt) {
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const nx = -(p2.y - p1.y);
    const ny =  (p2.x - p1.x);
    const nLenSq = nx * nx + ny * ny;
    if (nLenSq <= 1e-12) return { x: pt.x, y: pt.y };
    const t = ((pt.x - mx) * nx + (pt.y - my) * ny) / nLenSq;
    return { x: mx + t * nx, y: my + t * ny };
}

/**
 * Clamp a bulge point so it stays within half-chord distance of the chord midpoint.
 */
export function clampBulgePoint(p1, p2, b) {
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const maxRadius = Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2;
    if (maxRadius === 0) return { x: b.x, y: b.y };
    const dx = b.x - mx;
    const dy = b.y - my;
    const dist = Math.hypot(dx, dy);
    if (dist <= maxRadius) return { x: b.x, y: b.y };
    const scale = maxRadius / dist;
    return { x: mx + dx * scale, y: my + dy * scale };
}

/**
 * Compute a signed bulge ratio for a bulge point relative to chord p1->p2.
 * The ratio is the signed perpendicular distance from the chord midpoint,
 * normalized by the half-chord length.  Positive = left side of p1->p2.
 * Returns 0 if the chord is degenerate.
 */
export function bulgeRatio(p1, p2, b) {
    const halfChord = Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2;
    if (halfChord < 1e-12) return 0;
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    // Perpendicular (left-normal) of the chord direction
    const nx = -(p2.y - p1.y);
    const ny =  (p2.x - p1.x);
    const nLen = Math.hypot(nx, ny);
    if (nLen < 1e-12) return 0;
    const signedDist = ((b.x - mx) * nx + (b.y - my) * ny) / nLen;
    return signedDist / halfChord;
}

/**
 * Reconstruct a bulge point from a signed ratio and a chord p1->p2.
 * Inverse of bulgeRatio().  The result is clamped to half-chord distance.
 */
export function bulgePointFromRatio(p1, p2, ratio) {
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const halfChord = Math.hypot(p2.x - p1.x, p2.y - p1.y) / 2;
    if (halfChord < 1e-12) return { x: mx, y: my };
    // Unit perpendicular (left-normal)
    const nx = -(p2.y - p1.y);
    const ny =  (p2.x - p1.x);
    const nLen = Math.hypot(nx, ny);
    const ux = nx / nLen;
    const uy = ny / nLen;
    // Clamp ratio to [-1, 1] so point stays within semicircle
    const clamped = Math.max(-1, Math.min(1, ratio));
    const dist = clamped * halfChord;
    return { x: mx + ux * dist, y: my + uy * dist };
}