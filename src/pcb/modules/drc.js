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
 *   4. Shorted nets — two or more distinct named nets electrically bonded by
 *      coincident copper (a track/via/pad junction tying nets together).
 *
 * Distances are edge-to-edge in millimetres. Pads use the same posed,
 * conservative polygon outlines as the copper-pour clearance engine.
 */

import { resolveCopperPads } from './copper-model.js';
import { collectCopperArtwork } from './copper-artwork.js';
import { spatialPairs } from '../../core/spatial-pairs.js';
import { pointInPolygon } from '../../core/geometry.js';
import { circleCircleDistance, circleSegmentDistance } from './circle-clearance.js';
import { arcPoint, arcSegmentDistance, arcArcDistance, arcCircleDistance, containsArcInterior } from './arc-clearance.js';

/** Minimum acceptable via annular ring (mm) when not otherwise specified. */
const DEFAULT_MIN_ANNULAR_RING = 0.05;

/** Numeric tolerance (mm) so coincident-by-design copper isn't flagged. */
const EPS = 1e-4;

/* ───────────────────────── Geometry helpers ───────────────────────── */

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

/** Quantised coordinate key (0.1 µm grid) — coincident points share a key. */
function coincKey(x, y) {
    return `${Math.round(x * 10000)},${Math.round(y * 10000)}`;
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
 * @returns {{pads:Array, segments:Array, vias:Array, areas:Array, circles:Array, arcs:Array}}
 */
export function collectCopper(app) {
    const pads = [];
    const segments = [];
    const vias = [];

    for (const pad of resolveCopperPads(app)) {
        pads.push({ ...pad, kind: 'pad', pin: pad.number,
            uid: `pad:${pad.componentId}.${pad.padId}`, label: `${pad.reference}.${pad.number}` });
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

    const artwork = collectCopperArtwork(app);
    segments.push(...artwork.segments);
    return { pads, segments, vias, areas: artwork.areas, circles: artwork.circles, arcs: artwork.arcs };
}

/**
 * Detect shorted nets: two or more distinct named nets electrically bonded by
 * coincident copper. Net-agnostic union-find over pad/via/track-segment
 * terminals (mirrors the ratsnest connectivity model, but unions ACROSS nets
 * so cross-net bonds surface instead of being hidden). Distinct nets are taken
 * from any copper (pad/track/via net) within each bonded component.
 * @param {object} app - PCBApp instance.
 * @returns {Array<{nets:string[], a:{x:number,y:number}, b:{x:number,y:number}}>}
 */
function detectShorts({ pads, segments, vias }) {
    const normL = (l) => (l === 'both' ? 'all' : l);

    /** @type {Array<{x:number,y:number,layer:string,net:string,isPad:boolean}>} */
    const terms = [];
    for (const p of pads) {
        terms.push({ x: p.x, y: p.y, layer: normL(p.layer), net: p.net || '', isPad: true });
    }
    for (const v of vias) {
        terms.push({ x: v.x, y: v.y, layer: 'all', net: v.net || '', isPad: false });
    }
    // Each track segment contributes two endpoints, bonded to each other.
    /** @type {Array<[number,number]>} */
    const segPairs = [];
    for (const s of segments) {
        const i = terms.length;
        terms.push({ x: s.ax, y: s.ay, layer: normL(s.layer), net: s.net || '', isPad: false });
        terms.push({ x: s.bx, y: s.by, layer: normL(s.layer), net: s.net || '', isPad: false });
        segPairs.push([i, i + 1]);
    }

    const parent = terms.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

    // 1) Bond the two endpoints of each track segment.
    for (const [i, j] of segPairs) union(i, j);

    // 2) Bond coincident, layer-compatible terminals.
    const compat = (a, b) => a === b || a === 'all' || b === 'all';
    /** @type {Map<string, number[]>} */
    const buckets = new Map();
    for (let i = 0; i < terms.length; i++) {
        const k = coincKey(terms[i].x, terms[i].y);
        let arr = buckets.get(k);
        if (!arr) { arr = []; buckets.set(k, arr); }
        arr.push(i);
    }
    for (const arr of buckets.values()) {
        if (arr.length < 2) continue;
        for (let a = 0; a < arr.length; a++) {
            for (let b = a + 1; b < arr.length; b++) {
                if (compat(terms[arr[a]].layer, terms[arr[b]].layer)) union(arr[a], arr[b]);
            }
        }
    }

    // Per bonded component, collect the distinct nets carried by ANY copper in
    // it (pads, tracks and vias). Two or more distinct named nets bonded into
    // one component = a short — including a track whose net differs from the
    // pads it joins (e.g. a +5V↔+5V pad pair wired by a stale Net0113 track).
    // Pads are listed first in `terms`, so a pad point is preferred as each
    // net's sample location when one exists.
    /** @type {Map<number, Map<string,{x:number,y:number}>>} */
    const compNets = new Map();
    for (let i = 0; i < terms.length; i++) {
        const t = terms[i];
        if (!t.net) continue;
        const r = find(i);
        let m = compNets.get(r);
        if (!m) { m = new Map(); compNets.set(r, m); }
        if (!m.has(t.net)) m.set(t.net, { x: t.x, y: t.y });
    }

    const shorts = [];
    for (const m of compNets.values()) {
        if (m.size < 2) continue;
        const nets = [...m.keys()].sort();
        const a = m.get(nets[0]);
        const b = m.get(nets[1]);
        if (a && b) shorts.push({ nets, a, b });
    }
    return shorts;
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

    const { pads, segments, vias, areas, circles, arcs } = collectCopper(app);
    const violations = [];
    for (const fill of app.copperFills || (app.boardShapes || []).filter((shape) => shape.type === 'fill')) {
        if (fill._computed != null) continue;
        const point = fill.outline?.[0] || { x: 0, y: 0 };
        violations.push(makeViolation('fill', 'error', 'Copper pour has not been computed.',
            point.x, point.y, null, `fill-pending|${fill.id}`));
    }

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

    const copperDistance = createCopperDistanceChecker(clearance);
    for (const [first, second] of spatialPairs([...pads, ...segments, ...vias, ...areas, ...circles, ...arcs], featureBounds, clearance)) {
        if (!layersOverlap(first.layer, second.layer) || sameNet(first.net, second.net)) continue;
        if (first.kind === 'pad' && second.kind === 'pad' && first.componentId === second.componentId) continue;
        if (first.trackId && first.trackId === second.trackId) continue;
        const distance = copperDistance(first, second);
        if (distance.dist < clearance - EPS) {
            addClearance(distance.dist, distance.x, distance.y, first.label, second.label, first, second);
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
            { type: 'ratline', net, a: { x: rl.x1, y: rl.y1 }, b: { x: rl.x2, y: rl.y2 } },
            `unrouted|${net}|${ends}`,
        ));
    }

    /* ---- Shorted nets (distinct nets bonded by coincident copper) ---- */

    for (const sh of detectShorts({ pads, segments, vias })) {
        const msg = sh.nets.length > 2
            ? `Shorted nets: ${sh.nets.join(', ')}`
            : `Shorted nets: ${sh.nets[0]} and ${sh.nets[1]}`;
        const mx = (sh.a.x + sh.b.x) / 2, my = (sh.a.y + sh.b.y) / 2;
        violations.push(makeViolation(
            'short', 'error', msg, mx, my,
            { type: 'short', a: sh.a, b: sh.b },
            `short|${sh.nets.join('~')}`,
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

function featureBounds(feature) {
    if (feature.kind === 'arc') {
        const radius = feature.radius + feature.hw;
        return { minX: feature.x - radius, maxX: feature.x + radius,
            minY: feature.y - radius, maxY: feature.y + radius };
    }
    if (feature.kind === 'circle') return {
        minX: feature.x - feature.outerRadius, maxX: feature.x + feature.outerRadius,
        minY: feature.y - feature.outerRadius, maxY: feature.y + feature.outerRadius,
    };
    if (feature.kind === 'track') return {
        minX: Math.min(feature.ax, feature.bx) - feature.hw, maxX: Math.max(feature.ax, feature.bx) + feature.hw,
        minY: Math.min(feature.ay, feature.by) - feature.hw, maxY: Math.max(feature.ay, feature.by) + feature.hw,
    };
    if (feature.kind === 'area' || feature.kind === 'pad') {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const point of feature.outer || feature.outline) {
            minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
        }
        return { minX, minY, maxX, maxY };
    }
    const halfWidth = feature.kind === 'via' ? feature.r : feature.hw;
    const halfHeight = feature.kind === 'via' ? feature.r : feature.hh;
    return { minX: feature.x - halfWidth, maxX: feature.x + halfWidth,
        minY: feature.y - halfHeight, maxY: feature.y + halfHeight };
}

function featureEdges(feature) {
    if (feature.kind === 'track') return [[{ x: feature.ax, y: feature.ay }, { x: feature.bx, y: feature.by }]];
    if (feature.kind === 'via') return [[{ x: feature.x, y: feature.y }, { x: feature.x, y: feature.y }]];
    const rings = feature.kind === 'area' ? [feature.outer, ...feature.holes] : [feature.outline];
    return rings.flatMap((ring) => ring.map((point, index) => [point, ring[(index + 1) % ring.length]]));
}

function containsCopper(feature, point) {
    if (feature.kind === 'arc') return containsArcInterior(feature, point);
    if (feature.kind === 'area') return pointInPolygon(point, feature.outer)
        && !feature.holes.some((hole) => pointInPolygon(point, hole));
    if (feature.kind !== 'pad') return false;
    return pointInPolygon(point, feature.outline);
}

/** A checker owns one immutable DRC snapshot; gaps beyond clearance may return Infinity. */
export function createCopperDistanceChecker(clearance = Infinity) {
    const cache = new WeakMap();
    const boundary = (feature) => {
        let result = cache.get(feature);
        if (!result) {
            result = {
                bounds: featureBounds(feature),
                edges: featureEdges(feature).map(([start, end]) => ({
                    start, end,
                    minX: Math.min(start.x, end.x), maxX: Math.max(start.x, end.x),
                    minY: Math.min(start.y, end.y), maxY: Math.max(start.y, end.y),
                })),
            };
            cache.set(feature, result);
        }
        return result;
    };
    const contains = (feature, bounds, point) => point.x >= bounds.minX && point.x <= bounds.maxX
        && point.y >= bounds.minY && point.y <= bounds.maxY && containsCopper(feature, point);
    const radius = (feature) => feature.kind === 'via' ? feature.r : feature.kind === 'track' ? feature.hw : 0;
    const chord = (arc) => [arcPoint(arc, arc.startAngle), arcPoint(arc, arc.endAngle)];
    const chordFeature = (arc) => {
        const [start, end] = chord(arc);
        return { kind: 'track', ax: start.x, ay: start.y, bx: end.x, by: end.y, hw: arc.hw };
    };
    const arcDistance = (arc, other) => {
        const start = arcPoint(arc, arc.startAngle);
        if (containsCopper(other, start)) return { dist: 0, ...start };
        let candidates = [];
        if (other.kind === 'arc') {
            const otherStart = arcPoint(other, other.startAngle);
            if (containsArcInterior(arc, otherStart)) return { dist: 0, ...otherStart };
            candidates.push(arcArcDistance(arc, other));
            if (arc.filled) candidates.push(arcDistance(other, chordFeature(arc)));
            if (other.filled) candidates.push(arcDistance(arc, chordFeature(other)));
        } else if (other.kind === 'circle') {
            const anchor = { x: other.x + other.outerRadius, y: other.y };
            if (containsArcInterior(arc, anchor)) return { dist: 0, ...anchor };
            candidates.push(arcCircleDistance(arc, other));
            if (arc.filled) {
                const [first, second] = chord(arc);
                candidates.push(circleSegmentDistance(other, first, second, arc.hw));
            }
        } else {
            for (const edge of boundary(other).edges) {
                if (containsArcInterior(arc, edge.start)) return { dist: 0, ...edge.start };
                candidates.push(arcSegmentDistance(arc, edge.start, edge.end, radius(other)));
                if (arc.filled) {
                    const [first, second] = chord(arc);
                    const distance = segmentSegmentDistance(first.x, first.y, second.x, second.y,
                        edge.start.x, edge.start.y, edge.end.x, edge.end.y);
                    distance.dist = Math.max(0, distance.dist - arc.hw - radius(other));
                    candidates.push(distance);
                }
            }
        }
        return candidates.reduce((best, candidate) => candidate.dist < best.dist ? candidate : best,
            { dist: Infinity, x: 0, y: 0 });
    };
    return (first, second) => {
        if (first.kind === 'arc') return arcDistance(first, second);
        if (second.kind === 'arc') return arcDistance(second, first);
        if (first.kind === 'circle' || second.kind === 'circle') {
            const circle = first.kind === 'circle' ? first : second;
            const other = circle === first ? second : first;
            if (other.kind === 'circle') return circleCircleDistance(circle, other);
            if (other.kind === 'via') return circleCircleDistance(circle,
                { x: other.x, y: other.y, innerRadius: 0, outerRadius: other.r });
            const otherBoundary = boundary(other);
            const anchor = { x: circle.x + circle.outerRadius, y: circle.y };
            if (contains(other, otherBoundary.bounds, anchor)) return { dist: 0, ...anchor };
            let nearest = { dist: Infinity, x: 0, y: 0 };
            for (const edge of otherBoundary.edges) {
                const candidate = circleSegmentDistance(circle, edge.start, edge.end, radius(other));
                if (candidate.dist < nearest.dist) nearest = candidate;
            }
            return nearest;
        }
        const firstBoundary = boundary(first), secondBoundary = boundary(second);
        for (const edge of firstBoundary.edges) {
            if (contains(second, secondBoundary.bounds, edge.start)) return { dist: 0, ...edge.start };
        }
        for (const edge of secondBoundary.edges) {
            if (contains(first, firstBoundary.bounds, edge.start)) return { dist: 0, ...edge.start };
        }
        const combinedRadius = radius(first) + radius(second);
        let limit = clearance + combinedRadius + EPS;
        let nearest = { dist: Infinity, x: 0, y: 0 };
        for (const edge of firstBoundary.edges) {
            for (const other of secondBoundary.edges) {
                const gapX = Math.max(0, edge.minX - other.maxX, other.minX - edge.maxX);
                const gapY = Math.max(0, edge.minY - other.maxY, other.minY - edge.maxY);
                if (gapX > limit || gapY > limit || gapX * gapX + gapY * gapY > limit * limit) continue;
                const candidate = segmentSegmentDistance(edge.start.x, edge.start.y, edge.end.x, edge.end.y,
                    other.start.x, other.start.y, other.end.x, other.end.y);
                if (candidate.dist < nearest.dist) {
                    nearest = candidate;
                    limit = Math.min(limit, nearest.dist + EPS);
                }
            }
        }
        nearest.dist = Math.max(0, nearest.dist - combinedRadius);
        return nearest;
    };
}
