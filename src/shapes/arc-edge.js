/**
 * Arc-edge geometry — shared helpers for PolylineGraph edges that curve.
 *
 * A graph edge `a → b` carries an optional signed `bulge` per-edge attribute
 * (DXF-style ratio, see core/geometry.js `bulgeRatio`/`bulgePointFromRatio`):
 *   - `bulge === 0`  → straight segment
 *   - `bulge !== 0`  → circular arc; sign selects the side, magnitude the
 *                      curvature (clamped to a semicircle, |bulge| ≤ 1).
 *
 * This lets one Polyline hold a mix of straight and curved segments — the
 * data model behind "a polygon with some segments as arcs". It is pure
 * geometry (no DOM, no shape classes) so it is reusable by the PCB editor's
 * future drawing tools as well as the schematic shapes.
 */

import { circumcircle, bulgePointFromRatio, distanceToSegment } from '../core/geometry.js';

/** Below this magnitude a bulge is treated as a straight segment. */
export const BULGE_EPS = 1e-4;

const TWO_PI = Math.PI * 2;
const mod2pi = (a) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

/**
 * Resolve the circular-arc geometry for an edge `a → b` with a signed bulge.
 * Returns null when the edge is straight or degenerate.
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @param {number} bulge
 * @returns {{cx:number,cy:number,radius:number,startAngle:number,endAngle:number,sweep:0|1,largeArc:0|1,bulgePoint:{x:number,y:number}}|null}
 */
export function arcFromBulge(a, b, bulge) {
    if (!a || !b || !Number.isFinite(bulge) || Math.abs(bulge) < BULGE_EPS) return null;
    const bp = bulgePointFromRatio(a, b, bulge);
    const circ = circumcircle(a, bp, b);
    if (!circ) return null;
    const { cx, cy, radius } = circ;
    const startAngle = Math.atan2(a.y - cy, a.x - cx);
    const endAngle = Math.atan2(b.y - cy, b.x - cx);
    // Same sweep convention as the Arc shape (p1=a, p2=bulgePoint, p3=b).
    const cross = (b.x - a.x) * (bp.y - a.y) - (b.y - a.y) * (bp.x - a.x);
    const sweep = cross > 0 ? 0 : 1;
    // Bulge ratio is clamped to ±1 (≤ semicircle), so the large-arc flag is
    // always 0.
    return { cx, cy, radius, startAngle, endAngle, sweep, largeArc: 0, bulgePoint: bp };
}

/**
 * Whether a polar angle (about the arc centre) lies on the drawn arc.
 * Mirrors Arc._isAngleInRange.
 */
function angleInArc(arc, angle) {
    angle = mod2pi(angle);
    if (arc.sweep === 1) {
        const span = mod2pi(arc.endAngle - arc.startAngle);
        return mod2pi(angle - arc.startAngle) <= span;
    }
    const span = mod2pi(arc.startAngle - arc.endAngle);
    return mod2pi(arc.startAngle - angle) <= span;
}

/**
 * Full SVG path data for one edge (starts with its own `M`).
 * @returns {string}
 */
export function arcEdgePathD(a, b, bulge) {
    const arc = arcFromBulge(a, b, bulge);
    if (!arc) return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
    return `M ${a.x} ${a.y} A ${arc.radius} ${arc.radius} 0 ${arc.largeArc} ${arc.sweep} ${b.x} ${b.y}`;
}

/**
 * The path command to append to `b` assuming the current point is already `a`
 * (for chaining edges into one continuous outline path). Returns an `L` for
 * straight edges, an `A` for arcs.
 * @returns {string}
 */
export function arcEdgeContinuation(a, b, bulge) {
    const arc = arcFromBulge(a, b, bulge);
    if (!arc) return `L ${b.x} ${b.y}`;
    return `A ${arc.radius} ${arc.radius} 0 ${arc.largeArc} ${arc.sweep} ${b.x} ${b.y}`;
}

/**
 * Shortest distance from a point to an edge (segment or arc).
 * @returns {number}
 */
export function distanceToArcEdge(point, a, b, bulge) {
    const arc = arcFromBulge(a, b, bulge);
    if (!arc) return distanceToSegment(point, a, b);
    const d = Math.hypot(point.x - arc.cx, point.y - arc.cy);
    const ang = Math.atan2(point.y - arc.cy, point.x - arc.cx);
    if (angleInArc(arc, ang)) return Math.abs(d - arc.radius);
    return Math.min(
        Math.hypot(point.x - a.x, point.y - a.y),
        Math.hypot(point.x - b.x, point.y - b.y),
    );
}

/**
 * Sample points along an edge for fill/halo/bounds approximation. Excludes the
 * start point `a`; the final sample is the end point `b`. Straight edges return
 * just `[b]`.
 * @param {number} [segments] Target subdivisions for a full circle.
 * @returns {Array<{x:number,y:number}>}
 */
export function sampleArcEdge(a, b, bulge, segments = 32) {
    const arc = arcFromBulge(a, b, bulge);
    if (!arc) return [{ x: b.x, y: b.y }];
    let span, dir;
    if (arc.sweep === 1) { span = mod2pi(arc.endAngle - arc.startAngle); dir = 1; }
    else { span = mod2pi(arc.startAngle - arc.endAngle); dir = -1; }
    const n = Math.max(2, Math.ceil((segments * span) / TWO_PI));
    const pts = [];
    for (let i = 1; i <= n; i++) {
        const ang = arc.startAngle + dir * (span * (i / n));
        pts.push({ x: arc.cx + arc.radius * Math.cos(ang), y: arc.cy + arc.radius * Math.sin(ang) });
    }
    return pts;
}

/**
 * Axis-aligned bounds of an edge (segment or arc), including the arc bulge.
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}}
 */
export function arcEdgeBounds(a, b, bulge) {
    let minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    let minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    const arc = arcFromBulge(a, b, bulge);
    if (arc) {
        // Cardinal extrema of the circle that fall on the drawn arc.
        for (const ang of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
            if (!angleInArc(arc, ang)) continue;
            const px = arc.cx + arc.radius * Math.cos(ang);
            const py = arc.cy + arc.radius * Math.sin(ang);
            if (px < minX) minX = px; if (px > maxX) maxX = px;
            if (py < minY) minY = py; if (py > maxY) maxY = py;
        }
    }
    return { minX, minY, maxX, maxY };
}
