/**
 * Design Rule Checker (DRC) — geometric verification of a PCB layout.
 *
 * Pure, DOM-free engine: it reads the board's data model (placements/pads,
 * tracks, vias) from the PCBApp, plus the routing design rules, and returns
 * a list of violations. The UI layer (PCBApp) renders the results — a
 * status indicator, a problem dropdown, and clickable markers that point to
 * each issue on the board.
 *
 * Checks implemented:
 *   1. Clearance — copper of different nets, on a shared layer, closer than
 *      the design-rule Clearance gap (pad/pad, pad/track, pad/via, track/
 *      track, track/via, via/via). Pads within the SAME footprint are
 *      trusted (intra-footprint pad geometry is defined by the part, not the
 *      layout) and skipped to avoid flooding on fine-pitch ICs.
 *   2. Via annular ring — copper ring (diameter − drill)/2 below a minimum,
 *      and invalid drills (drill ≥ diameter or non-positive).
 *   3. Incomplete connections — every remaining ratsnest line (an air wire
 *      between copper that should be joined but isn't yet) is a violation.
 *
 * Distances are edge-to-edge in millimetres. Pad shapes are treated as their
 * axis-aligned bounding box (matching the existing clearance-overlay and the
 * offline clearance tools) — a slightly conservative approximation for
 * rounded/oval pads, which is the safe direction for a checker.
 */

/** Minimum acceptable via annular ring (mm) when not otherwise specified. */
const DEFAULT_MIN_ANNULAR_RING = 0.05;

/** Numeric tolerance (mm) so coincident-by-design copper isn't flagged. */
const EPS = 1e-4;

/* ───────────────────────── Geometry helpers ───────────────────────── */

/** Distance from a point to an axis-aligned rectangle (0 if inside). */
function pointRectDistance(px, py, cx, cy, hw, hh) {
    const dx = Math.max(0, Math.abs(px - cx) - hw);
    const dy = Math.max(0, Math.abs(py - cy) - hh);
    return Math.hypot(dx, dy);
}

/** Distance between two axis-aligned rectangles (0 if overlapping). */
function rectRectDistance(ax, ay, ahw, ahh, bx, by, bhw, bhh) {
    const dx = Math.max(0, Math.abs(ax - bx) - (ahw + bhw));
    const dy = Math.max(0, Math.abs(ay - by) - (ahh + bhh));
    return Math.hypot(dx, dy);
}

/** Closest point on segment [a,b] to point p, returned as {x,y}. */
function closestOnSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return { x: ax, y: ay };
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return { x: ax + t * dx, y: ay + t * dy };
}

/** Distance from point p to segment [a,b]. */
function pointSegmentDistance(px, py, ax, ay, bx, by) {
    const c = closestOnSegment(px, py, ax, ay, bx, by);
    return Math.hypot(px - c.x, py - c.y);
}

/**
 * Intersection point of segments [p1,p2] and [p3,p4], or null if they don't
 * cross. Used to anchor a marker at the actual crossing rather than a midpoint.
 */
function segmentsIntersectionPoint(p1x, p1y, p2x, p2y, p3x, p3y, p4x, p4y) {
    const d = (p2x - p1x) * (p4y - p3y) - (p2y - p1y) * (p4x - p3x);
    if (Math.abs(d) < 1e-12) return null; // parallel
    const t = ((p3x - p1x) * (p4y - p3y) - (p3y - p1y) * (p4x - p3x)) / d;
    const u = ((p3x - p1x) * (p2y - p1y) - (p3y - p1y) * (p2x - p1x)) / d;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { x: p1x + t * (p2x - p1x), y: p1y + t * (p2y - p1y) };
}

/**
 * Minimum distance between two segments, with the closest pair of points.
 * @returns {{dist:number, x:number, y:number}} dist and the midpoint of the
 *   closest pair (a good spot to point a marker at).
 */
function segmentSegmentDistance(ax, ay, bx, by, cx, cy, dx, dy) {
    const hit = segmentsIntersectionPoint(ax, ay, bx, by, cx, cy, dx, dy);
    if (hit) {
        // They cross — report the actual crossing point.
        return { dist: 0, x: hit.x, y: hit.y };
    }
    const candidates = [
        [ax, ay, closestOnSegment(ax, ay, cx, cy, dx, dy)],
        [bx, by, closestOnSegment(bx, by, cx, cy, dx, dy)],
        [cx, cy, closestOnSegment(cx, cy, ax, ay, bx, by)],
        [dx, dy, closestOnSegment(dx, dy, ax, ay, bx, by)],
    ];
    let best = Infinity;
    let bx2 = (ax + cx) / 2;
    let by2 = (ay + cy) / 2;
    for (const [px, py, q] of candidates) {
        const dist = Math.hypot(px - q.x, py - q.y);
        if (dist < best) {
            best = dist;
            bx2 = (px + q.x) / 2;
            by2 = (py + q.y) / 2;
        }
    }
    return { dist: best, x: bx2, y: by2 };
}

/**
 * Minimum distance between a segment [a,b] and an axis-aligned rect, plus the
 * approximate closest point (used to position a marker).
 * @returns {{dist:number, x:number, y:number}}
 */
function segmentRectDistance(ax, ay, bx, by, cx, cy, hw, hh) {
    const left = cx - hw, right = cx + hw, top = cy - hh, bottom = cy + hh;
    const corners = [
        [left, top], [right, top], [right, bottom], [left, bottom],
    ];
    // Segment intersects the rect → 0.
    const insideA = ax >= left && ax <= right && ay >= top && ay <= bottom;
    const insideB = bx >= left && bx <= right && by >= top && by <= bottom;
    if (insideA && insideB) {
        // Whole segment inside the rect → its midpoint is inside the overlap.
        return { dist: 0, x: (ax + bx) / 2, y: (ay + by) / 2 };
    }
    if (insideA) return { dist: 0, x: ax, y: ay };
    if (insideB) return { dist: 0, x: bx, y: by };
    for (let i = 0; i < 4; i++) {
        const [c1x, c1y] = corners[i];
        const [c2x, c2y] = corners[(i + 1) % 4];
        const hit = segmentsIntersectionPoint(ax, ay, bx, by, c1x, c1y, c2x, c2y);
        if (hit) {
            return { dist: 0, x: hit.x, y: hit.y };
        }
    }
    // Closest of: endpoints→rect, and rect corners→segment.
    let best = Infinity;
    let mx = cx, my = cy;
    const considerPointRect = (px, py) => {
        const ddx = Math.max(0, Math.abs(px - cx) - hw);
        const ddy = Math.max(0, Math.abs(py - cy) - hh);
        const dist = Math.hypot(ddx, ddy);
        if (dist < best) {
            best = dist;
            // closest point on rect boundary to (px,py)
            const qx = Math.max(left, Math.min(right, px));
            const qy = Math.max(top, Math.min(bottom, py));
            mx = (px + qx) / 2;
            my = (py + qy) / 2;
        }
    };
    considerPointRect(ax, ay);
    considerPointRect(bx, by);
    for (const [qx, qy] of corners) {
        const c = closestOnSegment(qx, qy, ax, ay, bx, by);
        const dist = Math.hypot(qx - c.x, qy - c.y);
        if (dist < best) {
            best = dist;
            mx = (qx + c.x) / 2;
            my = (qy + c.y) / 2;
        }
    }
    return { dist: best, x: mx, y: my };
}

/* ───────────────────── Copper primitive collection ───────────────── */

/** Normalize a track edge layer ('top-copper') to 'top' / 'bottom'. */
function normLayer(layer) {
    if (typeof layer === 'string' && layer.startsWith('bottom')) return 'bottom';
    return 'top';
}

/** Do two layer descriptors share a copper layer? 'both' matches anything. */
function layersOverlap(a, b) {
    if (a === 'both' || b === 'both') return true;
    return a === b;
}

/**
 * Two copper features are allowed to touch (no clearance violation) when they
 * carry the same net name — including the case where BOTH have no net ("No
 * Net"). Unconnected copper is not assigned to any signal, so two no-net
 * features are not a clearance violation. A no-net feature is still kept clear
 * of any named net.
 */
function sameNet(a, b) {
    return (a || '') === (b || '');
}

/**
 * Collect every copper primitive from the board into flat arrays.
 * @param {object} app - PCBApp instance.
 * @returns {{pads:Array, segments:Array, vias:Array}}
 */
export function collectCopper(app) {
    const pads = [];
    const segments = [];
    const vias = [];

    // Build a (componentId|pinNumber) → net lookup from the netlist.
    const padNet = new Map();
    for (const entry of (app.netlist || [])) {
        for (const pin of (entry.pins || [])) {
            padNet.set(`${pin.componentId}|${pin.pinNumber}`, entry.net || '');
        }
    }

    // Pads from placed footprints.
    for (const [componentId, pl] of (app.placements || new Map())) {
        if (!pl?.padOffsets) continue;
        const ortho = Math.abs((pl.rotation || 0) % 180) === 90;
        for (const off of pl.padOffsets) {
            const pos = pl.pads?.get(off.padId);
            if (!pos) continue;
            const ow = off.width || 1.2;
            const oh = off.height || 1.2;
            // 90°/270° placements swap width/height in world space.
            const hw = (ortho ? oh : ow) / 2;
            const hh = (ortho ? ow : oh) / 2;
            const layer = off.layer || 'top'; // 'top' | 'bottom' | 'both'
            pads.push({
                kind: 'pad',
                componentId,
                pin: off.number,
                uid: `pad:${componentId}.${off.number}`,
                label: `${pl.reference || pl.name || componentId}.${off.number}`,
                x: pos.x,
                y: pos.y,
                hw,
                hh,
                layer,
                net: padNet.get(`${componentId}|${off.number}`) || '',
            });
        }
    }

    // Track segments (per edge — each edge carries its own layer/width).
    for (const track of (app.tracks || [])) {
        if (!track?.edges || !track?.nodes) continue;
        for (const [edgeId, edge] of track.edges) {
            const a = track.nodes.get(edge.from);
            const b = track.nodes.get(edge.to);
            if (!a || !b) continue;
            const width = (track.getEdgeWidth ? track.getEdgeWidth(edgeId) : track.width) || track.width || 0.2;
            const layer = normLayer((track.getEdgeLayer ? track.getEdgeLayer(edgeId) : track.layer) || track.layer);
            segments.push({
                kind: 'track',
                uid: `trk:${track.id || '?'}:${edgeId}`,
                keyId: `trk:${track.id || '?'}`,
                trackId: track.id || track,
                label: track.net ? `Track ${track.net}` : 'Track',
                ax: a.x, ay: a.y, bx: b.x, by: b.y,
                hw: width / 2,
                layer,
                net: track.net || '',
            });
        }
    }

    // Standalone vias (through-hole — present on both copper layers).
    for (const via of (app.vias || [])) {
        const dia = via.diameter || via.size || 0.6;
        vias.push({
            uid: `via:${via.id || `${via.x},${via.y}`}`,
            kind: 'via',
            label: via.net ? `Via ${via.net}` : 'Via',
            x: via.x,
            y: via.y,
            r: dia / 2,
            diameter: dia,
            drill: via.drill || 0,
            layer: 'both',
            net: via.net || '',
            ref: via,
        });
    }

    return { pads, segments, vias };
}

/* ──────────────────────────── DRC runner ──────────────────────────── */

let _vid = 0;
function makeViolation(rule, severity, message, x, y, marker, key) {
    // Stable id: derive from a content key when provided so the same physical
    // violation keeps its id across re-runs (an unrelated edit elsewhere won't
    // renumber it and drop a selected marker). Fall back to a counter.
    const id = key ? `drc:${key}` : `drc-${++_vid}`;
    return { id, rule, severity, message, x, y, marker };
}

/**
 * Run all design-rule checks against the board.
 * @param {object} app - PCBApp instance.
 * @param {object} rules - { clearance, minAnnularRing, ratlines }. `ratlines`
 *   is an array of { net, x1, y1, x2, y2 } air wires (remaining ratsnest),
 *   each reported as an incomplete-connection violation.
 * @returns {{ok:boolean, violations:Array, counts:{errors:number, warnings:number}}}
 */
export function runDRC(app, rules = {}) {
    const clearance = Number.isFinite(rules.clearance) && rules.clearance > 0 ? rules.clearance : 0.1;
    const minRing = Number.isFinite(rules.minAnnularRing) && rules.minAnnularRing > 0
        ? rules.minAnnularRing : DEFAULT_MIN_ANNULAR_RING;

    const { pads, segments, vias } = collectCopper(app);
    const violations = [];

    const fmt = (n) => `${n.toFixed(3)} mm`;

    // Helper to record a clearance violation with a leader-line marker between
    // the two offending features.
    const clearanceByKey = new Map();
    const addClearance = (gap, x, y, aLabel, bLabel, fa, fb) => {
        // Key on the two features' stable entity identities (not the location,
        // and for tracks not the individual edge) so the violation keeps its id
        // when the overlap moves to a different segment of the same track, or
        // the track is dragged but still overlaps the same object.
        const ua = fa.keyId || fa.uid || aLabel;
        const ub = fb.keyId || fb.uid || bLabel;
        const key = `clearance|${[ua, ub].sort().join('~')}`;
        const v = makeViolation(
            'clearance', 'error',
            `Clearance ${fmt(gap)} < ${fmt(clearance)} between ${aLabel} and ${bLabel}`,
            x, y,
            { type: 'clearance', a: featureAnchor(fa), b: featureAnchor(fb) },
            key,
        );
        // The same pair of entities can touch at more than one point (e.g. two
        // segments of a track both crossing a pad). Collapse those into a
        // single violation, keeping the worst (smallest) gap.
        const prev = clearanceByKey.get(key);
        if (prev) {
            if (gap < prev.gap) { Object.assign(prev.v, v); prev.gap = gap; }
            return;
        }
        clearanceByKey.set(key, { v, gap });
        violations.push(v);
    };

    /* ---- Clearance: every unordered pair of copper features ---- */

    // Pad ↔ Pad (skip pairs within the same footprint).
    for (let i = 0; i < pads.length; i++) {
        for (let j = i + 1; j < pads.length; j++) {
            const a = pads[i], b = pads[j];
            if (a.componentId === b.componentId) continue;
            if (!layersOverlap(a.layer, b.layer)) continue;
            if (sameNet(a.net, b.net)) continue;
            const gap = rectRectDistance(a.x, a.y, a.hw, a.hh, b.x, b.y, b.hw, b.hh);
            if (gap < clearance - EPS) {
                const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
                addClearance(gap, mx, my, a.label, b.label, a, b);
            }
        }
    }

    // Track ↔ Pad.
    for (const seg of segments) {
        for (const pad of pads) {
            if (!layersOverlap(seg.layer, pad.layer)) continue;
            if (sameNet(seg.net, pad.net)) continue;
            const r = segmentRectDistance(seg.ax, seg.ay, seg.bx, seg.by, pad.x, pad.y, pad.hw, pad.hh);
            const gap = r.dist - seg.hw;
            if (gap < clearance - EPS) {
                addClearance(Math.max(0, gap), r.x, r.y, seg.label, pad.label, seg, pad);
            }
        }
    }

    // Track ↔ Track.
    for (let i = 0; i < segments.length; i++) {
        for (let j = i + 1; j < segments.length; j++) {
            const a = segments[i], b = segments[j];
            // Edges of the same track legitimately meet at shared nodes; their
            // internal geometry is defined by the track, so skip self-pairs.
            if (a.trackId === b.trackId) continue;
            if (!layersOverlap(a.layer, b.layer)) continue;
            if (sameNet(a.net, b.net)) continue;
            const r = segmentSegmentDistance(a.ax, a.ay, a.bx, a.by, b.ax, b.ay, b.bx, b.by);
            const gap = r.dist - a.hw - b.hw;
            if (gap < clearance - EPS) {
                addClearance(Math.max(0, gap), r.x, r.y, a.label, b.label, a, b);
            }
        }
    }

    // Via ↔ Pad.
    for (const via of vias) {
        for (const pad of pads) {
            if (sameNet(via.net, pad.net)) continue;
            const d = pointRectDistance(via.x, via.y, pad.x, pad.y, pad.hw, pad.hh);
            const gap = d - via.r;
            if (gap < clearance - EPS) {
                addClearance(Math.max(0, gap), via.x, via.y, via.label, pad.label, via, pad);
            }
        }
    }

    // Via ↔ Track.
    for (const via of vias) {
        for (const seg of segments) {
            if (sameNet(via.net, seg.net)) continue;
            const d = pointSegmentDistance(via.x, via.y, seg.ax, seg.ay, seg.bx, seg.by);
            const gap = d - via.r - seg.hw;
            if (gap < clearance - EPS) {
                addClearance(Math.max(0, gap), via.x, via.y, via.label, seg.label, via, seg);
            }
        }
    }

    // Via ↔ Via.
    for (let i = 0; i < vias.length; i++) {
        for (let j = i + 1; j < vias.length; j++) {
            const a = vias[i], b = vias[j];
            if (sameNet(a.net, b.net)) continue;
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            const gap = d - a.r - b.r;
            if (gap < clearance - EPS) {
                const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
                addClearance(Math.max(0, gap), mx, my, a.label, b.label, a, b);
            }
        }
    }

    /* ---- Via annular ring / drill validity ---- */

    for (const via of vias) {
        if (via.drill <= 0) continue; // no drill info — skip rather than false-flag
        if (via.drill >= via.diameter - EPS) {
            violations.push(makeViolation(
                'via', 'error',
                `${via.label}: drill ${fmt(via.drill)} ≥ pad ${fmt(via.diameter)} (no copper ring)`,
                via.x, via.y,
                { type: 'ring', x: via.x, y: via.y, r: via.r },
                `ring|${via.uid}`,
            ));
            continue;
        }
        const ring = (via.diameter - via.drill) / 2;
        if (ring < minRing - EPS) {
            violations.push(makeViolation(
                'via', 'warning',
                `${via.label}: annular ring ${fmt(ring)} < ${fmt(minRing)}`,
                via.x, via.y,
                { type: 'ring', x: via.x, y: via.y, r: via.r },
                `ring|${via.uid}`,
            ));
        }
    }

    /* ---- Incomplete connections (remaining ratsnest air wires) ---- */

    for (const rl of (rules.ratlines || [])) {
        if (![rl.x1, rl.y1, rl.x2, rl.y2].every(Number.isFinite)) continue;
        const mx = (rl.x1 + rl.x2) / 2, my = (rl.y1 + rl.y2) / 2;
        const net = rl.net || '';
        // Stable key on the (net + unordered endpoints) so the violation keeps
        // its id across re-runs while the air wire stays put.
        const ends = [
            `${Math.round(rl.x1 * 1000)},${Math.round(rl.y1 * 1000)}`,
            `${Math.round(rl.x2 * 1000)},${Math.round(rl.y2 * 1000)}`,
        ].sort().join('~');
        violations.push(makeViolation(
            'unrouted', 'error',
            net ? `Incomplete connection on net ${net}` : 'Incomplete connection',
            mx, my,
            { type: 'ratline', a: { x: rl.x1, y: rl.y1 }, b: { x: rl.x2, y: rl.y2 } },
            `unrouted|${net}|${ends}`,
        ));
    }

    let errors = 0, warnings = 0;
    for (const v of violations) {
        if (v.severity === 'error') errors++; else warnings++;
    }

    return { ok: violations.length === 0, violations, counts: { errors, warnings } };
}

/** A representative anchor point for a copper feature (for marker leaders). */
function featureAnchor(f) {
    if (!f) return { x: 0, y: 0 };
    if (f.kind === 'track') return { x: (f.ax + f.bx) / 2, y: (f.ay + f.by) / 2 };
    return { x: f.x, y: f.y };
}
