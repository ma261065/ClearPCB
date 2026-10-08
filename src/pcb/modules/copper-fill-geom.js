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

import { resolveBoardShapeGeometry, boardShapeArcGeometry, normalizeShapeCopperMode } from '../../shared/pcb/board-shape-geometry.js';
import ClipperLib from '../../../assets/vendor/clipper.esm.js';
import { pcbTextSegments } from './pcb-text.js';
import { padCopperOutline } from './copper-model.js';
import { resolveTrackSegments } from '../../shared/pcb/board-geometry.js';

/** @typedef {import('../../shapes/copper-fill.js').CopperFill} CopperFill */
/** @typedef {{x:number,y:number}} Point */
/** @typedef {{X:number,Y:number}} ClipperPoint */
/** @typedef {ClipperPoint[]} ClipperPath */
/** @typedef {ClipperPath[]} ClipperPaths */
/** @typedef {{outer:Point[], holes:Point[][]}} FillRegion */
/**
 * @typedef {{AddPaths: (paths: ClipperPaths, polyType: number, closed: boolean) => void, Execute: (clipType: number, solution: ClipperPaths|ClipperPolyTree, subjFillType: number, clipFillType: number) => boolean}} ClipperInstance
 * @typedef {{AddPath: (path: ClipperPath, joinType: number, endType: number) => void, AddPaths: (paths: ClipperPaths, joinType: number, endType: number) => void, Execute: (solution: ClipperPaths, delta: number) => void}} ClipperOffsetInstance
 * @typedef {{}} ClipperPolyTree
 * @typedef {{new(): ClipperInstance, Orientation: (path: ClipperPath) => boolean}} ClipperConstructor
 * @typedef {{new(miterLimit?: number, arcTolerance?: number): ClipperOffsetInstance}} ClipperOffsetConstructor
 * @typedef {{new(): ClipperPaths}} ClipperPathsConstructor
 * @typedef {{new(): ClipperPolyTree}} ClipperPolyTreeConstructor
 * @typedef {{Clipper: ClipperConstructor, ClipperOffset: ClipperOffsetConstructor, Paths: ClipperPathsConstructor, PolyTree: ClipperPolyTreeConstructor, PolyType: {ptSubject: number, ptClip: number}, ClipType: {ctIntersection: number, ctUnion: number, ctDifference: number}, PolyFillType: {pftNonZero: number}, JoinType: {jtRound: number}, EndType: {etClosedPolygon: number, etOpenRound: number}, JS: {PolyTreeToExPolygons: (tree: ClipperPolyTree) => Array<{outer: ClipperPath, holes?: ClipperPath[]}>}}} ClipperNamespace
 */

const SCALE = 10000;            // 0.1 µm integer resolution
const ARC_TOL = 0.001 * SCALE;   // offset arc flattening tolerance (scaled mm)
const CIRCLE_SEGMENTS = 48;     // points used for via / round-pad discs
const ROUNDING_MARGIN = 2 / SCALE;
const MAX_ARC_CHORD_ERROR = 2.25 * ARC_TOL / SCALE;
const OFFSET_MARGIN = MAX_ARC_CHORD_ERROR + ROUNDING_MARGIN;

/** @type {ClipperNamespace|null} */
let _clipper = null;
/** @type {Promise<ClipperNamespace>|null} */
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
            .then((mod) => {
                const loaded = /** @type {ClipperNamespace} */ (mod.default || mod);
                _clipper = loaded;
                return loaded;
            });
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

/** @param {number} v */
const S = (v) => Math.round(v * SCALE);
/** @param {number} v */
const U = (v) => v / SCALE;

/**
 * @typedef {object} FillContext
 * @property {Array<any>} tracks        - app.tracks (PolylineGraph tracks)
 * @property {Array<any>} vias          - app.vias (Via)
 * @property {Array<{x:number,y:number,width:number,height:number,shape:string,layer:string,net:string}>} pads
 * @property {Array<any>} boardShapes - app.boardShapes (including hole-layer cutouts)
 * @property {Array<any>} texts
 * @property {CopperFill[]} fills - every pour, in document (precedence) order
 * @property {Map<string, FillRegion[]>} [poured] - copper already poured by earlier pours, by id (computeFillPolygonsInOrder)
 * @property {Array<{x:number,y:number,dia:number,slot?:null|{x2:number,y2:number}}>} holes
 * @property {{clearance:number}} params
 * @property {{w:number,h:number,r:number,x?:number,y?:number,points?:Array<{x:number,y:number}>}|null} board
 */

/**
 * Compute the poured copper geometry for one fill.
 * @param {import('../../shapes/copper-fill.js').CopperFill} fill
 * @param {FillContext} ctx
 * @param {ClipperNamespace|null} [C] - ClipperLib namespace (defaults to the loaded module)
 * @returns {FillRegion[]}
 */
export function computeFillPolygons(fill, ctx, C = _clipper) {
    if (!C) return [];
    const outline = fill?.getOutline?.() || fill?.outline;
    if (!Array.isArray(outline) || outline.length < 3) return [];

    const clearance = Math.max(0, Number(ctx?.params?.clearance) || 0);

    // ── 1. Subject region: the user-drawn outline ──
    const subject = [outline.map((p) => ({ X: S(p.x), Y: S(p.y) }))];

    // ── 2. Clip to board (shrunk by clearance) ──
    let region = subject;
    const boardPath = buildBoardClip(C, ctx.board, clearance);
    if (boardPath) {
        const clip = new C.Clipper();
        clip.AddPaths(subject, C.PolyType.ptSubject, true);
        clip.AddPaths(boardPath, C.PolyType.ptClip, true);
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

    const exPolys = /** @type {Array<{outer:ClipperPath, holes?:ClipperPath[]}>} */ (C.JS.PolyTreeToExPolygons(polytree));
    return exPolys.map((ex) => ({
        outer: ex.outer.map((pt) => ({ x: U(pt.X), y: U(pt.Y) })),
        holes: (ex.holes || []).map((h) => h.map((pt) => ({ x: U(pt.X), y: U(pt.Y) }))),
    }));
}

/** A pour's precedence: its place in document order (a pour not listed comes last). */
/** @param {CopperFill[]} order @param {CopperFill} fill */
function pourRank(order, fill) {
    const index = order.findIndex(other => other === fill || (other?.id != null && other.id === fill?.id));
    return index < 0 ? order.length : index;
}

/**
 * Compute pours in precedence order (document order), each seeing the copper the
 * earlier ones poured: where pours of different nets overlap, the earlier pour keeps the
 * copper and the later one flows around it.
 * @param {CopperFill[]} fills
 * @param {FillContext} ctx
 * @param {ClipperNamespace|null} [C] ClipperLib namespace
 * @param {(done: number, total: number) => void} [onEach] called before each pour
 * @returns {FillRegion[][]} results in `fills` order
 */
export function computeFillPolygonsInOrder(fills, ctx, C = _clipper, onEach = () => {}) {
    const order = ctx?.fills || fills;
    const poured = new Map();
    const context = { ...ctx, poured };
    const sorted = [...fills].sort((a, b) => pourRank(order, a) - pourRank(order, b));
    /** @type {Map<CopperFill, FillRegion[]>} */
    const results = new Map();
    sorted.forEach((fill, index) => {
        onEach(index, sorted.length);
        const result = computeFillPolygons(fill, context, C);
        results.set(fill, result);
        poured.set(fill.id, result);
    });
    return fills.map(fill => /** @type {FillRegion[]} */ (results.get(fill)));
}

/** An earlier pour's copper (outer contours and holes), grown by the clearance. */
/** @param {ClipperNamespace} C @param {FillRegion[]} regions @param {number} clearance @returns {ClipperPaths} */
function offsetPouredCopper(C, regions, clearance) {
    const paths = [];
    for (const { outer, holes = [] } of regions || []) {
        if (!Array.isArray(outer) || outer.length < 3) continue;
        const contour = outer.map(point => ({ X: S(point.x), Y: S(point.y) }));
        if (!C.Clipper.Orientation(contour)) contour.reverse();
        paths.push(contour);
        for (const hole of holes) {
            if (!Array.isArray(hole) || hole.length < 3) continue;
            const path = hole.map(point => ({ X: S(point.x), Y: S(point.y) }));
            if (C.Clipper.Orientation(path)) path.reverse();
            paths.push(path);
        }
    }
    if (!paths.length) return [];
    const offset = new C.ClipperOffset(2, ARC_TOL);
    offset.AddPaths(paths, C.JoinType.jtRound, C.EndType.etClosedPolygon);
    const result = new C.Paths();
    offset.Execute(result, (clearance + OFFSET_MARGIN) * SCALE);
    return result;
}

/** Build the (optional) board clip polygon, shrunk inward by `clearance`. */
/** @param {ClipperNamespace} C @param {FillContext['board']} board @param {number} clearance @returns {ClipperPaths|null} */
function buildBoardClip(C, board, clearance) {
    if (!board || !(board.w > 0) || !(board.h > 0)) return null;
    const boardPoints = board.points;
    if (boardPoints && boardPoints.length >= 3) {
        const path = boardPoints.map(point => ({ X: S(point.x), Y: S(point.y) }));
        if (!C.Clipper.Orientation(path)) path.reverse();
        if (!clearance) return [path];
        const offset = new C.ClipperOffset(2, 0.001 * SCALE);
        offset.AddPath(path, C.JoinType.jtRound, C.EndType.etClosedPolygon);
        const result = new C.Paths();
        offset.Execute(result, -S(clearance));
        return result;
    }
    const w = board.w, h = board.h, r = Math.max(0, board.r || 0);
    // Board rect in world (SVG) coords spans (0,-h)..(w,0).
    const x1 = clearance, y1 = -h + clearance;
    const x2 = w - clearance, y2 = -clearance;
    if (x2 <= x1 || y2 <= y1) return [];
    const rr = Math.max(0, r - clearance);
    return [roundedRectPath(C, x1, y1, x2 - x1, y2 - y1, rr)];
}

/** Collect all other-net copper obstacle paths (scaled, inflated). */
/** @param {ClipperNamespace} C @param {CopperFill} fill @param {FillContext} ctx @param {number} clearance @returns {ClipperPaths} */
function collectObstacles(C, fill, ctx, clearance) {
    /** @type {ClipperPaths} */
    const out = [];
    const fillNet = fill.net || '';
    /** @param {string} n */
    const sameNet = (n) => !!fillNet && (n || '') === fillNet;

    // ── Tracks (per-edge, on this copper layer, other net) ──
    for (const track of (ctx.tracks || [])) {
        if (!track || !track.edges) continue;
        const tnet = track.net || '';
        if (sameNet(tnet)) continue; // solid connection: keep same-net copper
        for (const { start: a, end: b, layer, width: w } of resolveTrackSegments(track)) {
            if (layer !== fill.layer) continue;
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
        if (shape.layer !== 'hole' && shape.layer !== fill.layer) continue;
        if (shape.kind === 'image') {
            if (normalizeShapeCopperMode(shape.copperMode) !== 'add' || sameNet(shape.net || '')) continue;
            out.push(...offsetClosedPath(C, shape.points, clearance + OFFSET_MARGIN));
            continue;
        }
        const geometry = resolveBoardShapeGeometry(shape);
        const isHole = shape.layer === 'hole';
        const isCopper = shape.layer === fill.layer && geometry.copperMode === 'add';
        if (!isHole && (!isCopper || sameNet(shape.net || ''))) continue;
        out.push(...shapeObstaclePaths(C, shape, clearance, geometry));
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

    // Pours of another net (or none) never share copper: the earlier pour (document
    // order) keeps an overlap and a later one flows around the copper it poured, keeping
    // the clearance; until that copper is known, around its outline. Same-net pours may
    // overlap and merge.
    const order = ctx.fills || [];
    const rank = pourRank(order, fill);
    for (const [index, otherFill] of order.entries()) {
        if (index >= rank) break;
        if (!otherFill || otherFill.layer !== fill.layer || sameNet(otherFill.net || '')) continue;
        const poured = ctx.poured?.get(otherFill.id);
        if (poured) {
            out.push(...offsetPouredCopper(C, poured, clearance));
            continue;
        }
        const outline = otherFill.getOutline?.() || otherFill.outline;
        if (!Array.isArray(outline) || outline.length < 3) continue;
        out.push(...offsetClosedPath(C, outline, clearance));
    }

    // ── Pads (on this copper layer) ──
    for (const hole of ctx.holes || []) {
        if (hole.slot) {
            out.push(...offsetOpenSegment(C, hole, { x: hole.slot.x2, y: hole.slot.y2 }, hole.dia / 2 + clearance));
        } else {
            out.push(circlePath(C, hole.x, hole.y, hole.dia / 2 + clearance));
        }
    }

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

/** @param {ClipperNamespace} C @param {any} shape @param {number} clearance @param {any} [geometry] @returns {ClipperPaths} */
function shapeObstaclePaths(C, shape, clearance, geometry = resolveBoardShapeGeometry(shape)) {
    const arc = boardShapeArcGeometry(shape);
    const halfStep = arc ? Math.abs(arc.endAngle - arc.startAngle) / (2 * (geometry.centerline.length - 1)) : 0;
    const chordError = arc ? 2 * arc.radius * Math.sin(halfStep / 2) ** 2 : 0;
    return resolvedShapeObstaclePaths(C, geometry, clearance + chordError);
}

/** @param {any} shape @param {number} clearance @returns {Point[][]} */
export function boardShapeClearanceOutlines(shape, clearance) {
    if (!shape || shape.type === 'fill') return [];
    if (shape.layer !== 'hole' && !['top-copper', 'bottom-copper'].includes(shape.layer)) return [];
    if (shape.kind === 'image') {
        if (normalizeShapeCopperMode(shape.copperMode) !== 'add') return [];
        return mergeClearancePaths(offsetClosedPath(ClipperLib, shape.points, clearance + OFFSET_MARGIN));
    }
    const geometry = resolveBoardShapeGeometry(shape);
    if (shape.layer !== 'hole' && (!['top-copper', 'bottom-copper'].includes(shape.layer)
        || geometry.copperMode !== 'add')) return [];
    const paths = shapeObstaclePaths(ClipperLib, shape, clearance, geometry);
    return mergeClearancePaths(paths);
}

/** @param {any} text @param {number} clearance @returns {Point[][]} */
export function pcbTextClearanceOutlines(text, clearance) {
    if (!['top-copper', 'bottom-copper'].includes(text.layer)) return [];
    const paths = pcbTextSegments(text).flatMap(([start, end]) =>
        offsetOpenSegment(ClipperLib, start, end, text.strokeWidth / 2 + clearance));
    return mergeClearancePaths(paths);
}

/** @param {ClipperPaths} paths @returns {Point[][]} */
function mergeClearancePaths(paths) {
    if (!paths.length) return [];
    const clipper = new ClipperLib.Clipper();
    clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
    const result = new ClipperLib.Paths();
    clipper.Execute(ClipperLib.ClipType.ctUnion, result,
        ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    return /** @type {ClipperPaths} */ (result).map(path => path.map(point => ({ x: point.X / SCALE, y: point.Y / SCALE })));
}

/** @param {ClipperNamespace} C @param {any} geometry @param {number} clearance @returns {ClipperPaths} */
function resolvedShapeObstaclePaths(C, geometry, clearance) {
    if (geometry.physicalContours) {
        const offset = new C.ClipperOffset(2, ARC_TOL);
        offset.AddPaths(/** @type {Point[][]} */ (geometry.physicalContours).map((contour) => contour.map((point) => ({ X: S(point.x), Y: S(point.y) }))),
            C.JoinType.jtRound, C.EndType.etClosedPolygon);
        const result = new C.Paths();
        offset.Execute(result, (clearance + OFFSET_MARGIN) * SCALE);
        return result;
    }
    if (geometry.circle) {
        if (geometry.filled) {
            return [circlePath(
                C, geometry.circle.x, geometry.circle.y,
                geometry.circle.outerRadius + clearance,
            )];
        }
        const halfObstacleWidth = geometry.lineWidth / 2 + clearance;
        const outer = circlePath(
            C, geometry.circle.x, geometry.circle.y,
            geometry.circle.radius + halfObstacleWidth,
        );
        const innerRadius = geometry.circle.radius - halfObstacleWidth;
        return innerRadius > 0
            ? [outer, circlePath(C, geometry.circle.x, geometry.circle.y, innerRadius, false).reverse()]
            : [outer];
    }
    if (geometry.filled && geometry.path.length >= 3) {
        return offsetClosedPath(C, geometry.path, geometry.lineWidth / 2 + clearance);
    }
    if (geometry.strokeSegments?.length) {
        /** @type {ClipperPaths} */
        const paths = [];
        for (const segment of geometry.strokeSegments) {
            paths.push(...offsetOpenSegment(
                C, segment.start, segment.end, segment.lineWidth / 2 + clearance));
        }
        return paths;
    }
    /** @type {ClipperPaths} */
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
/** @param {string|undefined} padLayer @param {string} fillLayer */
function padOnLayer(padLayer, fillLayer) {
    const pl = padLayer || 'top';
    if (pl === 'both') return true;
    if (fillLayer === 'top-copper') return pl === 'top';
    if (fillLayer === 'bottom-copper') return pl === 'bottom';
    return false;
}

/** Offset a single segment into a round-capped capsule. Returns Paths. */
/** @param {ClipperNamespace} C @param {Point} a @param {Point} b @param {number} delta @returns {ClipperPaths} */
function offsetOpenSegment(C, a, b, delta) {
    const co = new C.ClipperOffset(2, ARC_TOL);
    co.AddPath([{ X: S(a.x), Y: S(a.y) }, { X: S(b.x), Y: S(b.y) }],
        C.JoinType.jtRound, C.EndType.etOpenRound);
    const sol = new C.Paths();
    co.Execute(sol, (delta + OFFSET_MARGIN) * SCALE);
    return sol;
}

/** @param {ClipperNamespace} C @param {Point[]} points @param {number} delta @returns {ClipperPaths} */
function offsetClosedPath(C, points, delta) {
    const path = points.map((point) => ({ X: S(point.x), Y: S(point.y) }));
    if (delta <= 0) return [path];
    const co = new C.ClipperOffset(2, ARC_TOL);
    co.AddPath(path, C.JoinType.jtRound, C.EndType.etClosedPolygon);
    const sol = new C.Paths();
    co.Execute(sol, (delta + OFFSET_MARGIN) * SCALE);
    return sol;
}

/** Enclose circular obstacles; keep their inner voids inside the exact circle. */
/** @param {ClipperNamespace} C @param {number} cx @param {number} cy @param {number} r @param {boolean} [enclose] @returns {ClipperPath} */
function circlePath(C, cx, cy, r, enclose = true) {
    /** @type {ClipperPath} */
    const path = [];
    const radius = enclose ? (r + ROUNDING_MARGIN) / Math.cos(Math.PI / CIRCLE_SEGMENTS)
        : Math.max(0, r - ROUNDING_MARGIN);
    for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
        const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
        path.push({ X: S(cx + radius * Math.cos(a)), Y: S(cy + radius * Math.sin(a)) });
    }
    return path;
}

/** Expand a conservative enclosure of the physical pad outline measured by DRC. */
/** @param {ClipperNamespace} C @param {any} pad @param {number} clearance @returns {ClipperPaths} */
function padObstaclePaths(C, pad, clearance) {
    return offsetClosedPath(C, pad.outline || padCopperOutline(pad), clearance);
}

/** Thermal spoke width (mm) for same-net pad connections. */
const THERMAL_SPOKE_WIDTH = 0.4;

/**
 * Void geometry for a same-net pad with a plus-shaped thermal relief. Takes
 * the pad's clearance ring and subtracts two crossed spokes along the pad's own
 * axes (its width and height, turned by its rotation like its outline), so the
 * returned obstacle leaves four copper bridges tying the pad to the surrounding
 * pour, whatever the pad's aspect ratio and rotation.
 * @param {ClipperNamespace} C
 * @param {any} pad
 * @param {number} clearance
 * @returns {ClipperPaths} scaled int paths to subtract from the pour
 */
function thermalReliefPaths(C, pad, clearance) {
    const hw = (pad.width || 0) / 2;
    const hh = (pad.height || 0) / 2;
    // Spoke can't be wider than the pad, or the relief would have no gaps.
    const sh = Math.min(THERMAL_SPOKE_WIDTH, Math.min(hw, hh) * 1.5) / 2;
    // Arms reach two clearances past the ring so they merge with the pour.
    const armX = hw + clearance * 2;
    const armY = hh + clearance * 2;
    const rad = -(pad.rotation || 0) * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    /** @param {number} halfAlong @param {number} halfAcross @returns {ClipperPath} */
    const bar = (halfAlong, halfAcross) => [[-halfAlong, -halfAcross], [halfAlong, -halfAcross],
        [halfAlong, halfAcross], [-halfAlong, halfAcross]]
        .map(([x, y]) => ({ X: S(pad.x + x * cos - y * sin), Y: S(pad.y + x * sin + y * cos) }));
    const ring = padObstaclePaths(C, pad, clearance);
    const plus = [bar(armX, sh), bar(sh, armY)];
    const clip = new C.Clipper();
    clip.AddPaths(ring, C.PolyType.ptSubject, true);
    clip.AddPaths(plus, C.PolyType.ptClip, true);
    const sol = new C.Paths();
    clip.Execute(C.ClipType.ctDifference, sol,
        C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
    return sol;
}

/** Rounded-rectangle polygon (scaled int path). x,y = top-left, w,h size. */
/** @param {ClipperNamespace} C @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r @returns {ClipperPath} */
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
