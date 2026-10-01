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
 *      Each bonded component reports one detected contact for its marker.
 *
 * Distances are edge-to-edge in millimetres. Pads use posed physical outlines;
 * copper-removal artwork is subtracted per layer before clearance and shorts.
 * Contact markers account for stroke widths and the empty bores of vias.
 * Additive copper pictures are checked as solid transformed rectangles,
 * independent of the pixels used to render and manufacture the artwork.
 * The object pair represented by a short is not repeated as a zero-clearance
 * error. Other offending pairs remain reportable, even in the same copper group.
 */

import { resolveCopperPads } from './copper-model.js';
import { resolveTrackSegments } from './board-geometry.js';
import { collectCopperArtwork } from './copper-artwork.js';
import { getComputedFill } from './computed-fill-cache.js';
import { subtractCopperArtwork } from './copper-removal.js';
import { normalizeShapeCopperMode } from './board-shape-geometry.js';
import { spatialPairs, prepareSpatialOrder, filterSpatialOrder, spatialCrossPairsPrepared } from '../../core/spatial-pairs.js';
import { pointInPolygon } from '../../core/geometry.js';
import { circleCircleDistance, circleSegmentDistance } from './circle-clearance.js';
import { arcPoint, arcSegmentDistance, arcArcDistance, arcCircleDistance, containsArcInterior, strokedPointDistance } from './arc-clearance.js';

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
 * Centreline distance between segments, with a marker on their stroked copper
 * overlap (or halfway across the copper gap).
 * @returns {{dist:number, x:number, y:number}}
 */
function segmentSegmentDistance(ax, ay, bx, by, cx, cy, dx, dy, firstWidth = 0, secondWidth = 0) {
    const hit = segmentsIntersectionPoint(ax, ay, bx, by, cx, cy, dx, dy);
    if (hit) {
        // They cross — report the actual crossing point.
        return { dist: 0, x: hit.x, y: hit.y };
    }
    const candidates = [
        [{ x: ax, y: ay }, closestOnSegment(ax, ay, cx, cy, dx, dy)],
        [{ x: bx, y: by }, closestOnSegment(bx, by, cx, cy, dx, dy)],
        [closestOnSegment(cx, cy, ax, ay, bx, by), { x: cx, y: cy }],
        [closestOnSegment(dx, dy, ax, ay, bx, by), { x: dx, y: dy }],
    ];
    let best = Infinity;
    let bx2 = (ax + cx) / 2;
    let by2 = (ay + cy) / 2;
    for (const [p, q] of candidates) {
        const dist = Math.hypot(p.x - q.x, p.y - q.y);
        if (dist < best) {
            best = dist;
            const point = strokedPointDistance(p, q, firstWidth, secondWidth);
            bx2 = point.x;
            by2 = point.y;
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

    for (const pad of resolveCopperPads(app, { physical: true })) {
        pads.push({ ...pad, kind: 'pad', pin: pad.number,
            uid: `pad:${pad.componentId}.${pad.padId}`, label: `${pad.reference}.${pad.number}` });
    }

    // Track segments (per edge — each edge carries its own layer/width).
    for (const track of (app.tracks || [])) {
        if (!track?.edges || !track?.nodes) continue;
        for (const [index, segment] of resolveTrackSegments(track).entries()) {
            const { edgeId, start: a, end: b, width } = segment;
            const layer = normLayer(segment.layer);
            segments.push({
                kind: 'track',
                uid: `trk:${track.id || '?'}:${edgeId}:${index}`,
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

    const artwork = collectCopperArtwork(app, { pictureBounds: true });
    segments.push(...artwork.segments);
    return { pads, segments, vias, areas: artwork.areas, circles: artwork.circles, arcs: artwork.arcs };
}

/** Retain the physical junction that first joins two differently named copper groups. */
function shortConnectivity(features) {
    const parent = new Map(features.map(feature => [feature, feature]));
    const net = new Map(features.map(feature => [feature, feature.net || '']));
    const contact = new Map();
    const find = feature => {
        let root = feature;
        while (parent.get(root) !== root) root = parent.get(root);
        while (parent.get(feature) !== root) {
            const next = parent.get(feature);
            parent.set(feature, root);
            feature = next;
        }
        return root;
    };
    const union = (first, second, point) => {
        const a = find(first), b = find(second);
        if (a === b) return;
        const junction = contact.get(a) || contact.get(b) ||
            (net.get(a) && net.get(b) && net.get(a) !== net.get(b)
                ? { point, features: new Set([first, second]) } : null);
        parent.set(a, b);
        net.set(b, net.get(b) || net.get(a));
        if (junction) contact.set(b, junction);
    };
    const shorts = () => {
        const groups = new Map();
        for (const feature of features) {
            const root = find(feature);
            if (!groups.has(root)) groups.set(root, { nets: new Set(), features: new Set() });
            const group = groups.get(root);
            if (feature.net) group.nets.add(feature.net);
            group.features.add(feature);
        }
        return [...groups].filter(([, group]) => group.nets.size > 1)
            .map(([root, group]) => ({
                nets: [...group.nets].sort(), point: contact.get(root).point,
                features: group.features, contactFeatures: contact.get(root).features,
            }));
    };
    return { union, shorts };
}

/**
 * Detect shorted nets: two or more distinct named nets electrically bonded by
 * coincident copper. Net-agnostic union-find over pad/via/track-segment
 * terminals (mirrors the ratsnest connectivity model, but unions ACROSS nets
 * so cross-net bonds surface instead of being hidden). Distinct nets are taken
 * from any copper (pad/track/via net) within each bonded component.
 * @returns {Array<{nets:string[], point:{x:number,y:number}, features:Set<object>, contactFeatures:Set<object>}>}
 */
function detectShorts({ pads, segments, vias }, distance) {
    const normL = (l) => (l === 'both' ? 'all' : l);

    /** @type {Array<{x:number,y:number,layer:string,net:string,isPad:boolean,feature:object}>} */
    const terms = [];
    for (const p of pads) {
        terms.push({ x: p.x, y: p.y, layer: normL(p.layer), net: p.net || '', isPad: true, feature: p });
    }
    for (const v of vias) {
        terms.push({ x: v.x, y: v.y, layer: 'all', net: v.net || '', isPad: false, feature: v });
    }
    // Each track segment contributes two endpoints, bonded to each other.
    /** @type {Array<[number,number]>} */
    const segPairs = [];
    for (const s of segments) {
        const i = terms.length;
        terms.push({ x: s.ax, y: s.ay, layer: normL(s.layer), net: s.net || '', isPad: false, feature: s });
        terms.push({ x: s.bx, y: s.by, layer: normL(s.layer), net: s.net || '', isPad: false, feature: s });
        segPairs.push([i, i + 1]);
    }

    const connectivity = shortConnectivity(terms);

    // 1) Bond the two endpoints of each track segment.
    for (const [i, j] of segPairs) connectivity.union(terms[i], terms[j]);

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
                const first = terms[arr[a]], second = terms[arr[b]];
                if (compat(first.layer, second.layer)) {
                    if (first.feature.kind === 'via' || second.feature.kind === 'via') {
                        const contact = distance(first.feature, second.feature);
                        if (contact.dist <= EPS) connectivity.union(first, second, { x: contact.x, y: contact.y });
                    } else connectivity.union(first, second, { x: first.x, y: first.y });
                }
            }
        }
    }

    return connectivity.shorts().map(short => ({
        ...short, features: new Set([...short.features].map(term => term.feature)),
        contactFeatures: new Set([...short.contactFeatures].map(term => term.feature)),
    }));
}

/* ──────────────────────────── DRC runner ──────────────────────────── */

let _vid = 0;
function copperPairKey(first, second) {
    return [first.keyId || first.uid || first.label, second.keyId || second.uid || second.label].sort().join('~');
}

function markerPair(first, second) {
    return [first, second].map(feature => ({
        key: feature.keyId || feature.uid || feature.label,
        ...(feature.componentId != null ? { componentId: feature.componentId } : {}),
    }));
}

/** Recheck only the selected entity pair against the displayed (possibly preview) geometry. */
export function resolveDrcPairMarker(app, violation, rules = {}) {
    const pair = violation.marker?.pair;
    if (!pair || pair.length !== 2) return null;
    const keys = new Set(pair.map(item => item.key));
    const components = new Set(pair.map(item => item.componentId).filter(id => id != null));
    const shapes = (app.boardShapes || []).filter(shape => keys.has(`shape:${shape.id}`)
        || keys.has(`fill:${shape.id}`)
        || ['remove-copper', 'remove-copper-mask'].includes(normalizeShapeCopperMode(shape.copperMode)));
    const fills = (app.copperFills || shapes.filter(shape => shape.type === 'fill'))
        .filter(fill => keys.has(`fill:${fill.id}`));
    if (fills.length && (app._fillRefreshPending || app._fillRefreshError)) return null;
    const copper = collectCopper({
        tracks: (app.tracks || []).filter(track => keys.has(`trk:${track.id}`)),
        vias: (app.vias || []).filter(via => keys.has(`via:${via.id}`)),
        pads: (app.pads || []).filter(pad => keys.has(`pad:null.${pad.id}`)),
        texts: new Map([...(app.texts || [])].filter(([id]) => keys.has(`text:${id}`))),
        placements: new Map([...(app.placements || [])].filter(([id]) => components.has(id))),
        netlist: components.size ? app.netlist : [], boardShapes: shapes, copperFills: fills,
    });
    const features = subtractCopperArtwork(Object.values(copper).flat().filter(feature =>
        keys.has(feature.keyId || feature.uid || feature.label)), shapes, featureBounds);
    const first = features.filter(feature => (feature.keyId || feature.uid || feature.label) === pair[0].key);
    const second = features.filter(feature => (feature.keyId || feature.uid || feature.label) === pair[1].key);
    const clearance = Number.isFinite(rules.clearance) && rules.clearance > 0 ? rules.clearance : 0.1;
    const distance = createCopperDistanceChecker(clearance);
    let closest = null;
    for (const [a, b] of spatialCrossPairsPrepared(
        prepareSpatialOrder(first, featureBounds), prepareSpatialOrder(second, featureBounds), clearance)) {
        if (!layersOverlap(a.layer, b.layer)) continue;
        // A short's joining pair can be an unassigned bridge between named groups.
        if (sameNet(a.net, b.net) && !(violation.rule === 'short' && !a.net && !b.net)) continue;
        if ((a.originalKind || a.kind) === 'pad' && (b.originalKind || b.kind) === 'pad'
            && a.componentId === b.componentId) continue;
        if (a.trackId && a.trackId === b.trackId) continue;
        const gap = distance(a, b);
        if (gap.dist < clearance - EPS && (!closest || gap.dist < closest.dist)) closest = gap;
    }
    return closest ? { ...violation, x: closest.x, y: closest.y } : null;
}

function hasMultipleNamedNets(features) {
    let net;
    for (const feature of features) {
        if (!feature.net) continue;
        if (net && net !== feature.net) return true;
        net = feature.net;
    }
    return false;
}

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
    return runDrcInputs(collectDrcInputs(app, rules));
}

/** Physical inputs shared by direct checks and detached worker snapshots. */
export function collectDrcInputs(app, rules = {}) {
    const fills = (app.copperFills || (app.boardShapes || []).filter(shape => shape.type === 'fill')).map(fill => ({
        id: fill.id, point: fill.outline?.[0] || { x: fill.x || 0, y: fill.y || 0 },
        computed: getComputedFill(fill) != null,
    }));
    return { copper: collectCopper(app), boardShapes: app.boardShapes || [], fills, rules,
        fillPending: !!app._fillRefreshPending, fillFailed: !!app._fillRefreshError };
}

/** DOM-free checker over physical features; fragment identities are created within this pass. */
export function runDrcInputs({ copper, boardShapes, fills, rules = {}, fillPending, fillFailed }) {
    const clearance = Number.isFinite(rules.clearance) && rules.clearance > 0 ? rules.clearance : 0.1;
    const minRing = Number.isFinite(rules.minAnnularRing) && rules.minAnnularRing > 0
        ? rules.minAnnularRing : DEFAULT_MIN_ANNULAR_RING;

    const { pads, segments, vias, areas, circles, arcs } = copper;
    const violations = [];
    for (const fill of fills) {
        if (fill.computed && !fillPending && !fillFailed) continue;
        const point = fill.point;
        const message = fillFailed
            ? 'Copper pour refresh failed; displayed copper is not current.'
            : fillPending ? 'Copper pour refresh is pending; displayed copper is not current.'
                : 'Copper pour has not been computed.';
        violations.push(makeViolation('fill', 'error', message,
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
        const key = `clearance|${copperPairKey(fa, fb)}`;
        const v = makeViolation(
            'clearance', 'error',
            `Clearance ${fmt(gap)} < ${fmt(clearance)} between ${aLabel} and ${bLabel}`,
            x, y,
            { type: 'clearance', a: featureAnchor(fa), b: featureAnchor(fb), pair: markerPair(fa, fb) },
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
    const originalCopper = [...pads, ...segments, ...vias, ...areas, ...circles, ...arcs];
    const remainingCopper = subtractCopperArtwork(originalCopper, boardShapes, featureBounds);
    let shorts = [];
    if (hasMultipleNamedNets(remainingCopper)) {
        shorts = remainingCopper === originalCopper ? detectShorts({ pads, segments, vias }, copperDistance)
            : detectRemainingShorts(remainingCopper, copperDistance);
    }
    const shortByFeature = new Map();
    for (const short of shorts) {
        const [first, second] = short.contactFeatures;
        const report = { pairKey: copperPairKey(first, second) };
        for (const feature of short.features) shortByFeature.set(feature, report);
    }
    for (const [first, second] of spatialPairs(remainingCopper, featureBounds, clearance)) {
        if (!layersOverlap(first.layer, second.layer) || sameNet(first.net, second.net)) continue;
        if ((first.originalKind || first.kind) === 'pad' && (second.originalKind || second.kind) === 'pad'
            && first.componentId === second.componentId) continue;
        if (first.trackId && first.trackId === second.trackId) continue;
        const distance = copperDistance(first, second);
        // Match both the reported pair and its connected component.
        const short = shortByFeature.get(first);
        if (distance.dist <= EPS && short && short === shortByFeature.get(second)
            && short.pairKey === copperPairKey(first, second)) continue;
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

    for (const sh of shorts) {
        const [first, second] = sh.contactFeatures;
        const msg = sh.nets.length > 2
            ? `Shorted nets: ${sh.nets.join(', ')}`
            : `Shorted nets: ${sh.nets[0]} and ${sh.nets[1]}`;
        violations.push(makeViolation(
            'short', 'error', msg, sh.point.x, sh.point.y,
            { type: 'short', pair: markerPair(first, second) },
            `short|${sh.nets.join('~')}`,
        ));
    }

    let errors = 0, warnings = 0;
    for (const v of violations) {
        if (v.severity === 'error') errors++; else warnings++;
    }

    return { ok: violations.length === 0, violations, counts: { errors, warnings } };
}

function detectRemainingShorts(features, distance) {
    const connectivity = shortConnectivity(features);
    for (const [first, second] of spatialPairs(features, featureBounds, EPS)) {
        if (!layersOverlap(first.layer, second.layer)) continue;
        const contact = distance(first, second);
        if (contact.dist <= EPS) connectivity.union(first, second, { x: contact.x, y: contact.y });
    }
    const barrels = new Map();
    for (const feature of features) {
        const source = feature.source;
        if (!source || source.layer !== 'both' || !(source.drill > 0)) continue;
        const bore = source.slot ? { kind: 'track', ax: source.slot.x1, ay: source.slot.y1,
            bx: source.slot.x2, by: source.slot.y2, hw: source.drill / 2 }
            : { kind: 'circle', x: source.x, y: source.y,
                innerRadius: source.drill / 2, outerRadius: source.drill / 2 };
        const contact = distance(feature, bore);
        if (contact.dist > EPS) continue;
        if (barrels.has(source)) connectivity.union(feature, barrels.get(source), { x: contact.x, y: contact.y });
        else barrels.set(source, feature);
    }
    return connectivity.shorts();
}

/** A representative anchor point for a copper feature (for marker leaders). */
function featureAnchor(f) {
    if (!f) return { x: 0, y: 0 };
    if (f.kind === 'track') return { x: (f.ax + f.bx) / 2, y: (f.ay + f.by) / 2 };
    return { x: f.x, y: f.y };
}

function ringBounds(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const point of points) {
        minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
    }
    return { minX, minY, maxX, maxY };
}

function boundsContainPoint(bounds, point) {
    return point.x >= bounds.minX && point.x <= bounds.maxX
        && point.y >= bounds.minY && point.y <= bounds.maxY;
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
        return ringBounds(feature.outer || feature.outline);
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

function containsCopper(feature, point, holeBounds = null) {
    if (feature.kind === 'arc') return containsArcInterior(feature, point);
    if (feature.kind === 'area') return pointInPolygon(point, feature.outer)
        && !feature.holes.some((hole, index) =>
            (!holeBounds || boundsContainPoint(holeBounds[index], point)) && pointInPolygon(point, hole));
    if (feature.kind !== 'pad') return false;
    return pointInPolygon(point, feature.outline);
}

/** A checker owns one immutable DRC snapshot; gaps beyond clearance may return Infinity. */
export function createCopperDistanceChecker(clearance = Infinity) {
    const cache = new WeakMap();
    const viaCircles = new WeakMap();
    const holeBounds = new WeakMap();
    const copperGeometry = (feature) => {
        if (feature.kind !== 'via') return feature;
        let circle = viaCircles.get(feature);
        if (!circle) {
            circle = { kind: 'circle', x: feature.x, y: feature.y,
                innerRadius: Math.max(0, (feature.drill || 0) / 2), outerRadius: feature.r };
            viaCircles.set(feature, circle);
        }
        return circle;
    };
    const boundary = (feature) => {
        let result = cache.get(feature);
        if (!result) {
            result = {
                bounds: featureBounds(feature),
                edges: featureEdges(feature).map(([start, end], index) => ({
                    start, end, index,
                    minX: Math.min(start.x, end.x), maxX: Math.max(start.x, end.x),
                    minY: Math.min(start.y, end.y), maxY: Math.max(start.y, end.y),
                })),
            };
            for (const edge of result.edges) {
                result.bounds.minX = Math.min(result.bounds.minX, edge.minX);
                result.bounds.minY = Math.min(result.bounds.minY, edge.minY);
                result.bounds.maxX = Math.max(result.bounds.maxX, edge.maxX);
                result.bounds.maxY = Math.max(result.bounds.maxY, edge.maxY);
            }
            cache.set(feature, result);
        }
        return result;
    };
    const orderedEdges = (boundary) => boundary.ordered ||= prepareSpatialOrder(boundary.edges, edge => edge);
    const contains = (feature, bounds, point) => {
        if (!boundsContainPoint(bounds, point)) return false;
        let holes;
        if (feature.kind === 'area') {
            holes = holeBounds.get(feature);
            if (!holes) {
                holes = feature.holes.map(ringBounds);
                holeBounds.set(feature, holes);
            }
        }
        return containsCopper(feature, point, holes);
    };
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
                        edge.start.x, edge.start.y, edge.end.x, edge.end.y, arc.hw, radius(other));
                    distance.dist = Math.max(0, distance.dist - arc.hw - radius(other));
                    candidates.push(distance);
                }
            }
        }
        return candidates.reduce((best, candidate) => candidate.dist < best.dist ? candidate : best,
            { dist: Infinity, x: 0, y: 0 });
    };
    return (first, second) => {
        first = copperGeometry(first);
        second = copperGeometry(second);
        if (first.kind === 'arc') return arcDistance(first, second);
        if (second.kind === 'arc') return arcDistance(second, first);
        if (first.kind === 'circle' || second.kind === 'circle') {
            const circle = first.kind === 'circle' ? first : second;
            const other = circle === first ? second : first;
            if (other.kind === 'circle') return circleCircleDistance(circle, other);
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
        let firstIndex = Infinity, secondIndex = Infinity;
        const firstOrder = filterSpatialOrder(orderedEdges(firstBoundary), secondBoundary.bounds, limit);
        const secondOrder = filterSpatialOrder(orderedEdges(secondBoundary), firstBoundary.bounds, limit);
        for (const [edge, other] of spatialCrossPairsPrepared(firstOrder, secondOrder, limit)) {
            const gapX = Math.max(0, edge.minX - other.maxX, other.minX - edge.maxX);
            const gapY = Math.max(0, edge.minY - other.maxY, other.minY - edge.maxY);
            if (gapX > limit || gapY > limit || gapX * gapX + gapY * gapY > limit * limit) continue;
            const candidate = segmentSegmentDistance(edge.start.x, edge.start.y, edge.end.x, edge.end.y,
                other.start.x, other.start.y, other.end.x, other.end.y, radius(first), radius(second));
            // Sweeps reorder candidates; equal gaps retain the original nested-loop witness.
            if (candidate.dist < nearest.dist || (candidate.dist === nearest.dist && Number.isFinite(candidate.dist)
                && (edge.index < firstIndex || (edge.index === firstIndex && other.index < secondIndex)))) {
                nearest = candidate;
                firstIndex = edge.index;
                secondIndex = other.index;
                limit = Math.min(limit, nearest.dist + EPS);
            }
        }
        nearest.dist = Math.max(0, nearest.dist - combinedRadius);
        return nearest;
    };
}
