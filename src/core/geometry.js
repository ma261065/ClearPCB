/**
 * Geometry - Math utilities for schematic and PCB operations
 * 
 * All functions work with points in the form { x: number, y: number }
 */

// ==================== Point Operations ====================

/**
 * Create a point
 */
export function point(x, y) {
    return { x, y };
}

/**
 * Add two points
 */
export function add(p1, p2) {
    return { x: p1.x + p2.x, y: p1.y + p2.y };
}

/**
 * Subtract p2 from p1
 */
export function subtract(p1, p2) {
    return { x: p1.x - p2.x, y: p1.y - p2.y };
}

/**
 * Scale a point by a factor
 */
export function scale(p, factor) {
    return { x: p.x * factor, y: p.y * factor };
}

/**
 * Get distance between two points
 */
export function distance(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Get squared distance (faster, good for comparisons)
 */
export function distanceSquared(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    return dx * dx + dy * dy;
}

/**
 * Get midpoint between two points
 */
export function midpoint(p1, p2) {
    return {
        x: (p1.x + p2.x) / 2,
        y: (p1.y + p2.y) / 2
    };
}

/**
 * Rotate a point around an origin
 */
export function rotate(point, origin, angleDegrees) {
    const rad = angleDegrees * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    return {
        x: origin.x + dx * cos - dy * sin,
        y: origin.y + dx * sin + dy * cos
    };
}

/**
 * Normalize a vector to unit length
 */
export function normalize(p) {
    const len = Math.sqrt(p.x * p.x + p.y * p.y);
    if (len === 0) return { x: 0, y: 0 };
    return { x: p.x / len, y: p.y / len };
}

/**
 * Get perpendicular vector
 */
export function perpendicular(p) {
    return { x: -p.y, y: p.x };
}

/**
 * Dot product of two vectors
 */
export function dot(p1, p2) {
    return p1.x * p2.x + p1.y * p2.y;
}

/**
 * Cross product (returns scalar for 2D)
 */
export function cross(p1, p2) {
    return p1.x * p2.y - p1.y * p2.x;
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

/**
 * Check if two line segments intersect
 */
export function segmentsIntersect(a1, a2, b1, b2) {
    const d1 = cross(subtract(b2, b1), subtract(a1, b1));
    const d2 = cross(subtract(b2, b1), subtract(a2, b1));
    const d3 = cross(subtract(a2, a1), subtract(b1, a1));
    const d4 = cross(subtract(a2, a1), subtract(b2, a1));
    
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
        return true;
    }
    
    // Check for collinear cases
    if (d1 === 0 && onSegment(b1, a1, b2)) return true;
    if (d2 === 0 && onSegment(b1, a2, b2)) return true;
    if (d3 === 0 && onSegment(a1, b1, a2)) return true;
    if (d4 === 0 && onSegment(a1, b2, a2)) return true;
    
    return false;
}

/**
 * Check if point q lies on segment pr (when collinear)
 */
function onSegment(p, q, r) {
    return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) &&
           q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
}

/**
 * Get intersection point of two line segments (or null if no intersection)
 */
export function segmentIntersection(a1, a2, b1, b2) {
    const d1 = subtract(a2, a1);
    const d2 = subtract(b2, b1);
    const d3 = subtract(b1, a1);
    
    const crossD1D2 = cross(d1, d2);
    
    if (Math.abs(crossD1D2) < 1e-10) {
        return null; // Parallel or collinear
    }
    
    const t = cross(d3, d2) / crossD1D2;
    const u = cross(d3, d1) / crossD1D2;
    
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        return {
            x: a1.x + t * d1.x,
            y: a1.y + t * d1.y
        };
    }
    
    return null;
}

// ==================== Rectangle/Bounding Box Operations ====================

/**
 * Create a bounding box from min/max points
 */
export function bbox(minX, minY, maxX, maxY) {
    return { minX, minY, maxX, maxY };
}

/**
 * Get bounding box of a set of points
 */
export function getBoundingBox(points) {
    if (points.length === 0) {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }
    
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    
    for (const p of points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    }
    
    return { minX, minY, maxX, maxY };
}

/**
 * Check if a point is inside a bounding box
 */
export function pointInBBox(point, bbox) {
    return point.x >= bbox.minX && point.x <= bbox.maxX &&
           point.y >= bbox.minY && point.y <= bbox.maxY;
}

/**
 * Check if two bounding boxes overlap
 */
export function bboxOverlap(a, b) {
    return a.minX <= b.maxX && a.maxX >= b.minX &&
           a.minY <= b.maxY && a.maxY >= b.minY;
}

/**
 * Expand a bounding box by a margin
 */
export function expandBBox(bbox, margin) {
    return {
        minX: bbox.minX - margin,
        minY: bbox.minY - margin,
        maxX: bbox.maxX + margin,
        maxY: bbox.maxY + margin
    };
}

/**
 * Merge two bounding boxes
 */
export function mergeBBox(a, b) {
    return {
        minX: Math.min(a.minX, b.minX),
        minY: Math.min(a.minY, b.minY),
        maxX: Math.max(a.maxX, b.maxX),
        maxY: Math.max(a.maxY, b.maxY)
    };
}

// ==================== Circle Operations ====================

/**
 * Check if a point is inside a circle
 */
export function pointInCircle(point, center, radius) {
    return distanceSquared(point, center) <= radius * radius;
}

/**
 * Get intersection points of a line with a circle
 */
export function lineCircleIntersection(lineStart, lineEnd, center, radius) {
    const d = subtract(lineEnd, lineStart);
    const f = subtract(lineStart, center);
    
    const a = dot(d, d);
    const b = 2 * dot(f, d);
    const c = dot(f, f) - radius * radius;
    
    const discriminant = b * b - 4 * a * c;
    
    if (discriminant < 0) {
        return [];
    }
    
    const results = [];
    const sqrtDiscriminant = Math.sqrt(discriminant);
    
    const t1 = (-b - sqrtDiscriminant) / (2 * a);
    const t2 = (-b + sqrtDiscriminant) / (2 * a);
    
    if (t1 >= 0 && t1 <= 1) {
        results.push({
            x: lineStart.x + t1 * d.x,
            y: lineStart.y + t1 * d.y
        });
    }
    
    if (t2 >= 0 && t2 <= 1 && Math.abs(t2 - t1) > 1e-10) {
        results.push({
            x: lineStart.x + t2 * d.x,
            y: lineStart.y + t2 * d.y
        });
    }
    
    return results;
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

/**
 * Get area of a polygon (positive if counterclockwise)
 */
export function polygonArea(polygon) {
    let area = 0;
    const n = polygon.length;
    
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        area += polygon[i].x * polygon[j].y;
        area -= polygon[j].x * polygon[i].y;
    }
    
    return area / 2;
}

/**
 * Check if polygon vertices are in clockwise order
 */
export function isClockwise(polygon) {
    return polygonArea(polygon) < 0;
}

// ==================== Arc Operations ====================

/**
 * Get point on arc at given angle
 */
export function pointOnArc(center, radius, angleDegrees) {
    const rad = angleDegrees * Math.PI / 180;
    return {
        x: center.x + radius * Math.cos(rad),
        y: center.y + radius * Math.sin(rad)
    };
}

/**
 * Get angle from center to point (in degrees)
 */
export function angleToPoint(center, point) {
    return Math.atan2(point.y - center.y, point.x - center.x) * 180 / Math.PI;
}

// ==================== Utility Functions ====================

/**
 * Snap a value to a grid
 */
export function snapToGrid(value, gridSize) {
    return Math.round(value / gridSize) * gridSize;
}

/**
 * Snap a point to a grid
 */
export function snapPointToGrid(point, gridSize) {
    return {
        x: snapToGrid(point.x, gridSize),
        y: snapToGrid(point.y, gridSize)
    };
}

/**
 * Clamp a value between min and max
 */
export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

/**
 * Linear interpolation between two values
 */
export function lerp(a, b, t) {
    return a + (b - a) * t;
}

/**
 * Linear interpolation between two points
 */
export function lerpPoint(p1, p2, t) {
    return {
        x: lerp(p1.x, p2.x, t),
        y: lerp(p1.y, p2.y, t)
    };
}

/**
 * Check if two numbers are approximately equal
 */
export function approxEqual(a, b, epsilon = 1e-10) {
    return Math.abs(a - b) < epsilon;
}

/**
 * Check if two points are approximately equal
 */
export function pointsEqual(p1, p2, epsilon = 1e-10) {
    return approxEqual(p1.x, p2.x, epsilon) && approxEqual(p1.y, p2.y, epsilon);
}

/**
 * Get orthogonal direction (for schematic wiring)
 * Returns 'horizontal' or 'vertical' based on angle between points
 */
export function getOrthoDirection(p1, p2) {
    const dx = Math.abs(p2.x - p1.x);
    const dy = Math.abs(p2.y - p1.y);
    return dx >= dy ? 'horizontal' : 'vertical';
}

/**
 * Generate orthogonal path between two points (for schematic wiring)
 * Returns array of points forming an L-shaped or straight path
 */
export function orthogonalPath(start, end, preferHorizontalFirst = true) {
    if (pointsEqual(start, end)) {
        return [start];
    }
    
    // Straight horizontal or vertical
    if (approxEqual(start.x, end.x) || approxEqual(start.y, end.y)) {
        return [start, end];
    }
    
    // L-shaped path
    if (preferHorizontalFirst) {
        return [start, { x: end.x, y: start.y }, end];
    } else {
        return [start, { x: start.x, y: end.y }, end];
    }
}