/**
 * Copper-fill geometry engine.
 *
 * Computes the *actual poured copper* for a CopperFill region as real
 * polygon geometry (Gerber-accurate), using polygon boolean / offset
 * operations from the vendored clipper-lib.
 *
 * Pour rule (net-aware, solid connection):
 *   poured = (fillOutline ∩ board-shrunk-by-clearance)
 *            − union(other-net copper on this layer, expanded by clearance)
 *
 * Same-net copper is NOT subtracted, so the pour merges solidly into it
 * (no thermal spokes). Tracks become capsules (centerline ⊕ disk of
 * radius width/2 + clearance); vias become discs (radius diameter/2 +
 * clearance); pads become their footprint outline expanded by clearance.
 *
 * Exception — same-net pads get a plus-shaped THERMAL RELIEF: the pad's
 * clearance ring is voided like any other pad, but two crossed spokes
 * (horizontal + vertical) are kept as copper so the pour ties to the pad
 * through four narrow bridges instead of a solid flood (eases soldering).
 *
 * Coordinates: world millimetres in, world millimetres out. Clipper works
 * on integers, so all geometry is scaled by SCALE during computation.
 *
 * NOTE: orphan-island removal (dropping poured copper that is not
 * galvanically connected to the net) is intentionally deferred — every
 * computed island is kept for now.
 */

import { resolveBoardShapeGeometry } from './board-shapes.js';
import { pcbTextSegments } from './pcb-text.js';

const SCALE = 10000;            // 0.1 µm integer resolution
const ARC_TOL = 0.01 * SCALE;   // offset arc flattening tolerance (scaled mm)
const CIRCLE_SEGMENTS = 48;     // points used for via / round-pad discs

let _clipper = null;
let _clipperPromise = null;

/**
 * Lazily import the vendored clipper module (once). Resolves to the
 * ClipperLib namespace. computeFillPolygons() requires this to have
 * resolved first.
 */
export function loadClipper() {
    if (_clipper) return Promise.resolve(_clipper);
    if (!_clipperPromise) {
        _clipperPromise = import('../../../assets/vendor/clipper.esm.js')
            .then((mod) => { _clipper = mod.default || mod; return _clipper; });
    }
    return _clipperPromise;
}

/** True once clipper is loaded and computeFillPolygons can run synchronously. */
export function isClipperReady() {
    return !!_clipper;
}

/** The loaded ClipperLib namespace, or null when not yet loaded. */
export function getClipper() {
    return _clipper;
}

const S = (v) => Math.round(v * SCALE);
const U = (v) => v / SCALE;

/**
 * @typedef {object} FillContext
 * @property {Array} tracks        - app.tracks (PolylineGraph tracks)
 * @property {Array} vias          - app.vias (Via)
 * @property {Array<{x:number,y:number,width:number,height:number,shape:string,layer:string,net:string}>} pads
 * @property {Array} boardShapes - app.boardShapes (including hole-layer cutouts)
 * @property {{clearance:number}} params
 * @property {{w:number,h:number,r:number}|null} board
 */

/**
 * Compute the poured copper geometry for one fill.
 * @param {import('../../shapes/copper-fill.js').CopperFill} fill
 * @param {FillContext} ctx
 * @param {object} [C] - ClipperLib namespace (defaults to the loaded module)
 * @returns {Array<{outer:Array<{x:number,y:number}>, holes:Array<Array<{x:number,y:number}>>}>}
 */
export function computeFillPolygons(fill, ctx, C = _clipper) {
    if (!C) return [];
    if (!fill || !Array.isArray(fill.outline) || fill.outline.length < 3) return [];

    const clearance = Math.max(0, Number(ctx?.params?.clearance) || 0);

    // ── 1. Subject region: the user-drawn outline ──
    const subject = [fill.outline.map((p) => ({ X: S(p.x), Y: S(p.y) }))];

    // ── 2. Clip to board (shrunk by clearance) ──
    let region = subject;
    const boardPath = buildBoardClip(C, ctx.board, clearance);
    if (boardPath) {
        const clip = new C.Clipper();
        clip.AddPaths(subject, C.PolyType.ptSubject, true);
        clip.AddPaths([boardPath], C.PolyType.ptClip, true);
        const sol = new C.Paths();
        clip.Execute(C.ClipType.ctIntersection, sol, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
        region = sol;
    }
    if (!region || region.length === 0) return [];

    // ── 3. Build other-net copper obstacles (already inflated by clearance) ──
    const obstacles = collectObstacles(C, fill, ctx, clearance);

    // ── 4. region − obstacles → PolyTree → ExPolygons ──
    let polytree;
    if (obstacles.length === 0) {
        // No knockouts: still normalise through a difference with no clip so
        // the result comes back as a clean PolyTree (handles self-holes).
        const clip = new C.Clipper();
        clip.AddPaths(region, C.PolyType.ptSubject, true);
        polytree = new C.PolyTree();
        clip.Execute(C.ClipType.ctUnion, polytree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
    } else {
        const clip = new C.Clipper();
        clip.AddPaths(region, C.PolyType.ptSubject, true);
        clip.AddPaths(obstacles, C.PolyType.ptClip, true);
        polytree = new C.PolyTree();
        clip.Execute(C.ClipType.ctDifference, polytree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
    }

    const exPolys = C.JS.PolyTreeToExPolygons(polytree);
    return exPolys.map((ex) => ({
        outer: ex.outer.map((pt) => ({ x: U(pt.X), y: U(pt.Y) })),
        holes: (ex.holes || []).map((h) => h.map((pt) => ({ x: U(pt.X), y: U(pt.Y) }))),
    }));
}

/** Build the (optional) board clip polygon, shrunk inward by `clearance`. */
function buildBoardClip(C, board, clearance) {
    if (!board || !(board.w > 0) || !(board.h > 0)) return null;
    const w = board.w, h = board.h, r = Math.max(0, board.r || 0);
    // Board rect in world (SVG) coords spans (0,-h)..(w,0).
    const x1 = clearance, y1 = -h + clearance;
    const x2 = w - clearance, y2 = -clearance;
    if (x2 <= x1 || y2 <= y1) return null;
    const rr = Math.max(0, r - clearance);
    return roundedRectPath(C, x1, y1, x2 - x1, y2 - y1, rr);
}

/** Collect all other-net copper obstacle paths (scaled, inflated). */
function collectObstacles(C, fill, ctx, clearance) {
    const out = [];
    const fillNet = fill.net || '';
    const sameNet = (n) => fillNet && (n || '') === fillNet;

    // ── Tracks (per-edge, on this copper layer, other net) ──
    for (const track of (ctx.tracks || [])) {
        if (!track || !track.edges) continue;
        const tnet = track.net || '';
        if (sameNet(tnet)) continue; // solid connection: keep same-net copper
        for (const [eid, e] of track.edges) {
            const layer = track.getEdgeLayer ? track.getEdgeLayer(eid) : track.layer;
            if (layer !== fill.layer) continue;
            const a = track.nodes.get(e.from);
            const b = track.nodes.get(e.to);
            if (!a || !b) continue;
            const w = (track.getEdgeWidth ? track.getEdgeWidth(eid) : track.width) || 0.2;
            const delta = w / 2 + clearance;
            const caps = offsetOpenSegment(C, a, b, delta);
            for (const path of caps) out.push(path);
        }
    }

    // ── Vias (all layers, other net) ──
    for (const via of (ctx.vias || [])) {
        if (!via) continue;
        if (sameNet(via.net || '')) continue;
        const rad = (via.diameter || 0.6) / 2 + clearance;
        out.push(circlePath(C, via.x, via.y, rad));
    }

    // ── Board shapes: holes always void; foreign/unassigned added copper on
    // this layer receives clearance. Same-net copper merges into the pour. ──
    for (const shape of (ctx.boardShapes || [])) {
        if (!shape || shape.type === 'fill') continue;
        const geometry = resolveBoardShapeGeometry(shape);
        const isHole = shape.layer === 'hole';
        const isCopper = shape.layer === fill.layer && geometry.copperMode === 'add';
        if (!isHole && (!isCopper || sameNet(shape.net || ''))) continue;
        out.push(...resolvedShapeObstaclePaths(C, geometry, clearance));
    }

    // PCB text has no net assignment, so copper-layer text always receives
    // clearance from a pour on that layer.
    for (const text of (ctx.texts || [])) {
        if (!text || text.layer !== fill.layer) continue;
        const width = Math.max(0.05, Number(text.strokeWidth) || 0.15);
        for (const [start, end] of pcbTextSegments(text)) {
            out.push(...offsetOpenSegment(C, start, end, width / 2 + clearance));
        }
    }

    // Other pours are copper too. Different/unassigned nets keep clearance;
    // same-net pours may overlap and merge.
    for (const otherFill of (ctx.fills || [])) {
        if (!otherFill || otherFill === fill || otherFill.layer !== fill.layer) continue;
        if (sameNet(otherFill.net || '')) continue;
        if (!Array.isArray(otherFill.outline) || otherFill.outline.length < 3) continue;
        out.push(...offsetClosedPath(C, otherFill.outline, clearance));
    }

    // ── Pads (on this copper layer) ──
    // Other-net pads are voided solid (pad + clearance). Same-net pads get a
    // plus-shaped thermal relief: the clearance ring is voided too, but four
    // spokes are left as copper so the pour stays tied to the pad.
    for (const pad of (ctx.pads || [])) {
        if (!pad) continue;
        if (!padOnLayer(pad.layer, fill.layer)) continue;
        if (sameNet(pad.net || '')) {
            out.push(...thermalReliefPaths(C, pad, clearance));
        } else {
            out.push(...padObstaclePaths(C, pad, clearance));
        }
    }

    return out;
}

function resolvedShapeObstaclePaths(C, geometry, clearance) {
    if (geometry.circle) {
        const radius = geometry.filled
            ? geometry.circle.outerRadius
            : geometry.circle.radius + geometry.lineWidth / 2;
        return [circlePath(C, geometry.circle.x, geometry.circle.y, radius + clearance)];
    }
    if (geometry.filled && geometry.path.length >= 3) {
        return offsetClosedPath(C, geometry.path, geometry.lineWidth / 2 + clearance);
    }
    if (geometry.strokeSegments?.length) {
        const paths = [];
        for (const segment of geometry.strokeSegments) {
            paths.push(...offsetOpenSegment(
                C, segment.start, segment.end, segment.lineWidth / 2 + clearance));
        }
        return paths;
    }
    const paths = [];
    const points = geometry.centerline;
    const segmentCount = geometry.centerlineClosed ? points.length : points.length - 1;
    for (let index = 0; index < segmentCount; index++) {
        paths.push(...offsetOpenSegment(
            C,
            points[index],
            points[(index + 1) % points.length],
            geometry.lineWidth / 2 + clearance,
        ));
    }
    return paths;
}

/** Does a pad's layer ('top'|'bottom'|'both') belong to the fill copper layer? */
function padOnLayer(padLayer, fillLayer) {
    const pl = padLayer || 'top';
    if (pl === 'both') return true;
    if (fillLayer === 'top-copper') return pl === 'top';
    if (fillLayer === 'bottom-copper') return pl === 'bottom';
    return false;
}

/** Offset a single segment into a round-capped capsule. Returns Paths. */
function offsetOpenSegment(C, a, b, delta) {
    const co = new C.ClipperOffset(2, ARC_TOL);
    co.AddPath([{ X: S(a.x), Y: S(a.y) }, { X: S(b.x), Y: S(b.y) }],
        C.JoinType.jtRound, C.EndType.etOpenRound);
    const sol = new C.Paths();
    co.Execute(sol, delta * SCALE);
    return sol;
}

function offsetClosedPath(C, points, delta) {
    const path = points.map((point) => ({ X: S(point.x), Y: S(point.y) }));
    if (delta <= 0) return [path];
    const co = new C.ClipperOffset(2, ARC_TOL);
    co.AddPath(path, C.JoinType.jtRound, C.EndType.etClosedPolygon);
    const sol = new C.Paths();
    co.Execute(sol, delta * SCALE);
    return sol;
}

/** A regular polygon approximating a circle (scaled int path). */
function circlePath(C, cx, cy, r) {
    const path = [];
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
        const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
        path.push({ X: S(cx + r * Math.cos(a)), Y: S(cy + r * Math.sin(a)) });
    }
    return path;
}

/**
 * Pad obstacle outline expanded by `clearance` (Minkowski sum of the pad
 * with a disc). Mirrors the clearance-halo geometry:
 *   - round / circle / ellipse → ellipse inflated by clearance
 *   - oval (stadium)           → rounded rect, corner r = min(hw,hh)+clearance
 *   - rect / default           → rounded rect, corner r = clearance
 */
function padObstaclePaths(C, pad, clearance) {
    const hw = (pad.width || 0) / 2;
    const hh = (pad.height || 0) / 2;
    const shape = pad.shape || 'rect';
    const cx = pad.x, cy = pad.y;
    if (shape === 'round' || shape === 'circle' || shape === 'ellipse') {
        return [ellipsePath(C, cx, cy, hw + clearance, hh + clearance)];
    }
    const cornerR = (shape === 'oval' ? Math.min(hw, hh) : 0) + clearance;
    return [roundedRectPath(C, cx - hw - clearance, cy - hh - clearance,
        (hw + clearance) * 2, (hh + clearance) * 2, cornerR)];
}

/** Thermal spoke width (mm) for same-net pad connections. */
const THERMAL_SPOKE_WIDTH = 0.4;

/**
 * Void geometry for a same-net pad with a plus-shaped thermal relief. Takes
 * the pad's clearance ring and subtracts two crossed spokes (a horizontal and
 * a vertical bar through the pad centre), so the returned obstacle leaves four
 * copper bridges tying the pad to the surrounding pour.
 * @returns {Array} scaled int paths to subtract from the pour
 */
function thermalReliefPaths(C, pad, clearance) {
    const hw = (pad.width || 0) / 2;
    const hh = (pad.height || 0) / 2;
    // Spoke can't be wider than the pad, or the relief would have no gaps.
    const sh = Math.min(THERMAL_SPOKE_WIDTH, Math.min(hw, hh) * 1.5) / 2;
    // Arms reach two clearances past the ring so they merge with the pour.
    const armX = hw + clearance * 2;
    const armY = hh + clearance * 2;
    const cx = pad.x, cy = pad.y;
    const ring = padObstaclePaths(C, pad, clearance);
    const plus = [
        roundedRectPath(C, cx - armX, cy - sh, armX * 2, sh * 2, 0), // horizontal
        roundedRectPath(C, cx - sh, cy - armY, sh * 2, armY * 2, 0), // vertical
    ];
    const clip = new C.Clipper();
    clip.AddPaths(ring, C.PolyType.ptSubject, true);
    clip.AddPaths(plus, C.PolyType.ptClip, true);
    const sol = new C.Paths();
    clip.Execute(C.ClipType.ctDifference, sol,
        C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
    return sol;
}

/** Ellipse polygon (scaled int path). */
function ellipsePath(C, cx, cy, rx, ry) {
    const path = [];
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
        const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
        path.push({ X: S(cx + rx * Math.cos(a)), Y: S(cy + ry * Math.sin(a)) });
    }
    return path;
}

/** Rounded-rectangle polygon (scaled int path). x,y = top-left, w,h size. */
function roundedRectPath(C, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    if (r <= 0) {
        return [
            { X: S(x), Y: S(y) },
            { X: S(x + w), Y: S(y) },
            { X: S(x + w), Y: S(y + h) },
            { X: S(x), Y: S(y + h) },
        ];
    }
    const seg = Math.max(2, Math.round(CIRCLE_SEGMENTS / 4));
    const path = [];
    // corner centres
    const corners = [
        { cx: x + w - r, cy: y + r, a0: -Math.PI / 2, a1: 0 },        // top-right
        { cx: x + w - r, cy: y + h - r, a0: 0, a1: Math.PI / 2 },     // bottom-right
        { cx: x + r, cy: y + h - r, a0: Math.PI / 2, a1: Math.PI },   // bottom-left
        { cx: x + r, cy: y + r, a0: Math.PI, a1: Math.PI * 1.5 },     // top-left
    ];
    for (const c of corners) {
        for (let i = 0; i <= seg; i++) {
            const a = c.a0 + (c.a1 - c.a0) * (i / seg);
            path.push({ X: S(c.cx + r * Math.cos(a)), Y: S(c.cy + r * Math.sin(a)) });
        }
    }
    return path;
}
