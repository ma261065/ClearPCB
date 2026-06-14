/**
 * Shape decomposition — turn a rounded-corner polygon into an explicit
 * outline of straight segments and circular arcs.
 *
 * A `Polyline` with `cornerRadius > 0` *renders* rounded corners but stores
 * only the sharp polygon vertices. This converts it into a new `Polyline`
 * whose corners are real, editable **arc edges** (per-edge `bulge`), so each
 * corner becomes a draggable quarter/− arc instead of an implicit rounding.
 *
 * Pure geometry + shape construction only (no DOM, no editor/command state),
 * so the PCB editor can reuse it. The schematic/UI glue (undo command,
 * selection) lives in the UI layer.
 *
 * The corner construction mirrors `PolylineGraph._buildRoundedPath` exactly
 * (tangent points set back by `min(cornerRadius, halfEdge)` along each edge),
 * but emits a true circular arc instead of the quadratic-Bézier preview. The
 * arc `bulge` for a corner whose interior angle is θ is `tan((π − θ)/4)` — e.g.
 * a 90° rectangle corner yields `bulge = tan(22.5°) = √2 − 1 ≈ 0.4142`. The
 * sign is derived geometrically (apex toward the cut corner) so it is correct
 * for either winding direction.
 */

import { Polyline } from './polyline.js';
import { bulgeRatio } from '../core/geometry.js';

/** Corners shorter than this (world units) are left sharp. */
const MIN_CORNER = 0.01;

/**
 * Whether a shape is a rounded-corner polygon that can be decomposed.
 * @param {any} shape
 * @returns {boolean}
 */
export function canDecomposeRoundedCorners(shape) {
    return !!shape
        && shape.type === 'polyline'
        && shape.closed === true
        && (shape.cornerRadius || 0) > 0
        && typeof shape.getOrderedPoints === 'function'
        && !(typeof shape._hasBulgedEdges === 'function' && shape._hasBulgedEdges());
}

/**
 * Decompose a rounded-corner polygon into a new `Polyline` of straight edges
 * and arc (bulge) edges. Returns `null` when the shape isn't decomposable or
 * no corner actually rounds.
 * @param {any} shape
 * @returns {Polyline|null}
 */
export function decomposeRoundedCorners(shape) {
    if (!canDecomposeRoundedCorners(shape)) return null;

    const pts = shape.getOrderedPoints();
    if (!pts || pts.length < 3) return null;

    const r = shape.cornerRadius;
    const n = pts.length;

    const graphNodes = {};
    const graphEdges = {};
    const edgeBulges = {};
    let nodeIdx = 0;
    let edgeIdx = 0;

    // Per-corner first/last node ids (a sharp corner has first === last).
    const firstNode = new Array(n);
    const lastNode = new Array(n);
    let anyRounded = false;

    for (let i = 0; i < n; i++) {
        const prev = pts[(i - 1 + n) % n];
        const curr = pts[i];
        const next = pts[(i + 1) % n];

        const dx1 = prev.x - curr.x, dy1 = prev.y - curr.y;
        const dx2 = next.x - curr.x, dy2 = next.y - curr.y;
        const len1 = Math.hypot(dx1, dy1);
        const len2 = Math.hypot(dx2, dy2);

        // Same setback clamp as the rounded-corner renderer.
        const cr = Math.min(r, Math.min(len1, len2) / 2);

        // Unit edge directions away from the corner.
        const u1x = dx1 / len1, u1y = dy1 / len1;
        const u2x = dx2 / len2, u2y = dy2 / len2;
        const dot = Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y));
        const theta = Math.acos(dot);               // interior angle at the corner
        const halfSin = Math.sin(theta / 2);

        const roundable = cr >= MIN_CORNER
            && len1 >= MIN_CORNER && len2 >= MIN_CORNER
            && halfSin > 1e-6                        // not collinear (straight-through)
            && theta > 1e-6;                         // not a zero-area spike

        if (!roundable) {
            const id = `n${nodeIdx++}`;
            graphNodes[id] = { x: curr.x, y: curr.y };
            firstNode[i] = id;
            lastNode[i] = id;
            continue;
        }

        // Tangent points on each incident edge.
        const s = { x: curr.x + u1x * cr, y: curr.y + u1y * cr };
        const e = { x: curr.x + u2x * cr, y: curr.y + u2y * cr };

        // Fillet geometry: radius ρ and centre along the interior bisector.
        const rho = cr * Math.tan(theta / 2);
        let bisx = u1x + u2x, bisy = u1y + u2y;
        const bisLen = Math.hypot(bisx, bisy);
        bisx /= bisLen; bisy /= bisLen;
        const centreDist = rho / halfSin;
        const cx = curr.x + bisx * centreDist;
        const cy = curr.y + bisy * centreDist;

        // Arc apex (point on the fillet nearest the cut corner) → signed bulge.
        const ax = curr.x - cx, ay = curr.y - cy;
        const aLen = Math.hypot(ax, ay) || 1;
        const apex = { x: cx + (ax / aLen) * rho, y: cy + (ay / aLen) * rho };
        const bulge = bulgeRatio(s, e, apex);

        const sId = `n${nodeIdx++}`; graphNodes[sId] = s;
        const eId = `n${nodeIdx++}`; graphNodes[eId] = e;
        firstNode[i] = sId;
        lastNode[i] = eId;

        const arcId = `e${edgeIdx++}`;
        graphEdges[arcId] = { from: sId, to: eId };
        if (bulge) { edgeBulges[arcId] = bulge; anyRounded = true; }
    }

    if (!anyRounded) return null;

    // Straight edges connecting each corner's exit to the next corner's entry.
    for (let i = 0; i < n; i++) {
        const a = lastNode[i];
        const b = firstNode[(i + 1) % n];
        if (a === b) continue;
        graphEdges[`e${edgeIdx++}`] = { from: a, to: b };
    }

    return new Polyline({
        color: shape.color,
        lineWidth: shape.lineWidth,
        layer: shape.layer,
        visible: shape.visible,
        locked: shape.locked,
        closed: true,
        fill: shape.fill,
        fillColor: shape.fillColor,
        fillAlpha: shape.fillAlpha,
        isRect: false,
        cornerRadius: 0,
        graphNodes,
        graphEdges,
        edgeBulges,
    });
}
