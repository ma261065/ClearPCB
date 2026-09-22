/**
 * Minimal Gerber RS-274X + Excellon drill export for ClearPCB.
 *
 * Produces a Map of filename → string for the standard board layers:
 *   - top-copper.gtl    (tracks, pads, vias, top layer)
 *   - bottom-copper.gbl (tracks, pads, vias, bottom layer)
 *   - top-mask.gts      (soldermask openings, top — pad shape + expansion)
 *   - bottom-mask.gbs   (soldermask openings, bottom)
 *   - top-paste.gtp     (stencil apertures, top — SMD pads only)
 *   - bottom-paste.gbp  (stencil apertures, bottom)
 *   - top-silk.gto      (component reference labels on silkscreen)
 *   - board-outline.gko (closed board boundary and cutouts)
 *   - board-PTH.drl     (Excellon plated through-holes: pads, vias, plated holes)
 *   - board-NPTH.drl    (Excellon non-plated holes: mounting/tooling — when present)
 *
 * Coordinate system: ClearPCB stores PCB geometry in SVG-Y-down
 * millimetres (positive Y points down on screen). Gerber files use
 * Y-up, so this exporter negates every Y value at emission time.
 * Artwork is clipped to the sampled board boundary in input (Y-down) space.
 *
 * The output uses fixed-point 4.6 (four integer digits, six fractional)
 * which is the modern standard for sub-micron precision in mm.
 */

import { resolveReferenceText } from './reference-text.js';
import {
    orthoSwap as _orthoSwap,
    resolvePlacementDrills,
    resolvePadFlashes,
    resolveSilk,
    MASK_EXPANSION,
    TENT_VIAS,
    padFlashOutline,
} from './board-geometry.js';
import { resolveTrackSegments } from './board-geometry.js';
import { resolveBoardShapeGeometry, boardShapeFilledRemovalOutlines } from './board-shapes.js';
import { pcbTextSegments } from './pcb-text.js';
import ClipperLib from '../../../assets/vendor/clipper.esm.js';
import { regionFillContours } from './region-geometry.js';
import { getBoardOutline, boardBoundary, rectangleBoardOutline } from './board-outline.js';

const FORMAT = '%FSLAX46Y46*%\n%MOMM*%\n';
const SCALE = 1e6; // 4.6 fixed-point: multiply mm by 10^6

function padOperation(flash, getAp, bounds) {
    const contour = padFlashOutline(flash);
    if (bounds?.points && _clipContours([contour], bounds, ClipperLib.ClipType.ctDifference).length) {
        return { d: getAp('C:0.0010'), op: _shapeContourRegion([contour], bounds).trimEnd() };
    }
    let width = flash.w, height = flash.h;
    const angle = ((flash.rotation || 0) % 180 + 180) % 180;
    const round = ['ellipse', 'circle', 'round'].includes(flash.shape);
    if ((round && Math.abs(width - height) > 1e-9)
        || (!round && Math.min(angle, Math.abs(angle - 90), 180 - angle) > 1e-9)) {
        return { d: getAp('C:0.0010'), op: _shapeContourRegion([padFlashOutline(flash)]).trimEnd() };
    }
    if (_orthoSwap(flash.rotation)) [width, height] = [height, width];
    const key = round ? `C:${width.toFixed(4)}`
        : `${flash.shape === 'oval' ? 'O' : 'R'}:${width.toFixed(4)}x${height.toFixed(4)}`;
    return { d: getAp(key), op: `X${_fmt(flash.x)}Y${_fmtY(flash.y)}D03*` };
}

function _strokeContours(points, closed, width) {
    const offset = new ClipperLib.ClipperOffset(10, 0.001 * SCALE);
    offset.AddPath(points.map(point => ({ X: _fx(point.x), Y: _fx(point.y) })),
        ClipperLib.JoinType.jtRound, closed ? ClipperLib.EndType.etClosedLine : ClipperLib.EndType.etOpenRound);
    const result = [];
    offset.Execute(result, width * SCALE / 2);
    return result.map(contour => contour.map(point => ({ x: point.X / SCALE, y: point.Y / SCALE })));
}

function _strokeOperation(points, closed, width, bounds) {
    if (points.length < 2) return '';
    const contours = _strokeContours(points, closed, width);
    if (bounds?.points && _clipContours(contours, bounds, ClipperLib.ClipType.ctDifference).length) {
        return _shapeContourRegion(contours, bounds);
    }
    const start = points[0];
    return `X${_fmt(start.x)}Y${_fmtY(start.y)}D02*\n`
        + [...points.slice(1), ...(closed ? [start] : [])]
            .map(point => `X${_fmt(point.x)}Y${_fmtY(point.y)}D01*\n`).join('');
}

function _circleOperation(geometry, bounds) {
    const { x, y, radius, outerRadius } = geometry.circle;
    const circleContour = diameter => padFlashOutline({ x, y, w: diameter, h: diameter, shape: 'circle' });
    const contours = [circleContour(outerRadius * 2)];
    const innerRadius = radius - geometry.lineWidth / 2;
    if (!geometry.filled && innerRadius > 0) contours.push(circleContour(innerRadius * 2));
    if (bounds?.points && _clipContours(contours, bounds, ClipperLib.ClipType.ctDifference).length) {
        return _shapeContourRegion(contours, bounds);
    }
    if (geometry.filled) return `X${_fmt(x)}Y${_fmtY(y)}D03*\n`;
    const startX = x - radius;
    return `G75*\nX${_fmt(startX)}Y${_fmtY(y)}D02*\nG03*\n`
        + `X${_fmt(startX)}Y${_fmtY(y)}I${_fmt(radius)}J0D01*\nG01*\n`;
}

function _clipContours(contours, bounds, operation = ClipperLib.ClipType.ctIntersection) {
    if (!bounds?.points) return contours;
    const clipper = new ClipperLib.Clipper();
    clipper.AddPaths(contours.filter(contour => contour.length >= 3)
        .map(contour => contour.map(point => ({ X: _fx(point.x), Y: _fx(point.y) }))),
    ClipperLib.PolyType.ptSubject, true);
    clipper.AddPath(bounds.points.map(point => ({ X: _fx(point.x), Y: _fx(point.y) })),
        ClipperLib.PolyType.ptClip, true);
    const result = [];
    clipper.Execute(operation, result, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftNonZero);
    return result.map(contour => contour.map(point => ({ x: point.X / SCALE, y: point.Y / SCALE })));
}

function _shapeContourRegion(contours, bounds) {
    contours = _clipContours(contours, bounds);
    return regionFillContours(contours).map(contour => {
        let body = 'G36*\n';
        const start = contour[0];
        body += `X${_fmt(start.x)}Y${_fmtY(start.y)}D02*\n`;
        for (const point of [...contour.slice(1), start]) {
            body += `X${_fmt(point.x)}Y${_fmtY(point.y)}D01*\n`;
        }
        return body + 'G37*\n';
    }).join('');
}

/**
 * Build all gerber/drill files for the current board state.
 *
 * @param {object} opts
 * @param {Map<string, object>} opts.placements   componentId → placement
 * @param {Array<object>} opts.tracks             Track instances
 * @param {Array<object>} opts.vias               Via instances
 * @param {number} opts.boardWidth                mm
 * @param {number} opts.boardHeight               mm
 * @param {number} [opts.boardRadius=0]           corner radius, mm
 * @param {number} [opts.boardX=0]                bottom-left X of board, mm
 * @param {number} [opts.boardY=0]                bottom-left Y of board, mm
 * @returns {Map<string, string>} filename → file contents
 */
export function exportGerbers(opts) {
    const {
        placements, tracks = [], vias = [],
        boardWidth, boardHeight, boardRadius = 0,
        boardX = 0, boardY = 0,
        texts = [], fills = [], boardShapes = [],
    } = opts;
    const circles = boardShapes.filter((shape) => shape?.kind === 'circle');

    // Caller's boardX/boardY describe the Y-up bottom-left corner of the
    // board. Internal data is SVG-Y-down, so for clipping we shift the
    // rectangle into that space. The outline file is emitted in Y-up
    // (the natural gerber convention) so it keeps the caller's bounds.
    const clipBounds = {
        x: boardX,
        y: -(boardY + boardHeight),
        w: boardWidth, h: boardHeight,
    };
    const outlineBounds = {
        x: boardX, y: boardY,
        w: boardWidth, h: boardHeight,
        r: boardRadius || 0,
    };
    if (getBoardOutline(opts)) Object.assign(clipBounds, boardBoundary(opts));
    else if (boardWidth > 0 && boardHeight > 0) {
        const legacy = rectangleBoardOutline(boardWidth, boardHeight, boardRadius);
        legacy.points = legacy.points.map(point => ({ x: point.x + boardX, y: point.y - boardY }));
        Object.assign(clipBounds, boardBoundary({ boardShapes: [legacy] }));
    }
    const files = new Map([
        ['board.gtl', _buildCopper(placements, tracks, vias, 'top-copper', clipBounds, texts, fills, circles, boardShapes)],
        ['board.gbl', _buildCopper(placements, tracks, vias, 'bottom-copper', clipBounds, texts, fills, circles, boardShapes)],
        ['board.gts', _buildMask(placements, vias, 'top', clipBounds, boardShapes)],
        ['board.gbs', _buildMask(placements, vias, 'bottom', clipBounds, boardShapes)],
        ['board.gtp', _buildPaste(placements, 'top', clipBounds)],
        ['board.gbp', _buildPaste(placements, 'bottom', clipBounds)],
        ['board.gto', _buildSilk(placements, 'top', clipBounds, texts, boardShapes)],
        ['board.gbo', _buildSilk(placements, 'bottom', clipBounds, texts, boardShapes)],
        ['board.gko', _buildOutline(outlineBounds, boardShapes, clipBounds)],
        // Plated through-holes (pads, vias, and Hole-layer circles) and
        // non-plated holes go in separate Excellon files so fabs (JLCPCB,
        // etc.) can tell them apart — they key off the -PTH / -NPTH suffix.
        ['board-PTH.drl', _buildDrill(_collectPlatedDrills(placements, vias, boardShapes), clipBounds)],
    ]);
    // Only emit the NPTH file when there are non-plated holes — an empty
    // drill file trips up some fab pre-checks.
    const npth = _collectNonPlatedDrills(boardShapes, placements, clipBounds);
    if (npth.length) files.set('board-NPTH.drl', _buildDrill(npth, clipBounds, true));
    return files;
}

/* ──────────────────────────── board clipping ──────────────────────────── */

/** Point inside or on the board boundary. */
function _inBoard(x, y, b) {
    if (b?.points) return ClipperLib.Clipper.PointInPolygon({ X: _fx(x), Y: _fx(y) },
        b.points.map(point => ({ X: _fx(point.x), Y: _fx(point.y) }))) !== 0;
    if (!b || !b.w || !b.h) return true;
    const x0 = b.x || 0, y0 = b.y || 0;
    return x >= x0 && x <= x0 + b.w && y >= y0 && y <= y0 + b.h;
}

/* ──────────────────────────── coords ──────────────────────────── */

const _fx = (mm) => Math.round(mm * SCALE);
const _fmt = (mm) => String(_fx(mm));
/** Y-axis emitter: negates because the app stores Y-down but gerber is Y-up. */
const _fmtY = (mm) => String(_fx(-mm));

/* ──────────────────────────── copper layers ──────────────────────────── */

/**
 * Build the world-space point transform for a placement's pose, matching
 * applyPlacementPose exactly: a local offset (dx,dy) is mirrored (user flip
 * XOR bottom side), rotated by the placement angle and translated to the
 * placement position. Footprint geometry is authored in local mm and oriented
 * purely by this transform, so every pad/silk point must pass through it —
 * otherwise a rotated or flipped part exports at its un-posed position.
 * @param {object} pl
 * @returns {(dx:number, dy:number) => {x:number, y:number}}
 */
function _poseXform(pl) {
    return placementPose(pl).xf;
}

function _buildCopper(placements, tracks, vias, layerId, bounds, texts = [], fills = [], circles = [], boardShapes = []) {
    const isTop = layerId === 'top-copper';
    // Pads use the footprint/autorouter convention: 'top'|'bottom'|'both'.
    // Tracks use SVG-layer-id form: 'top-copper'|'bottom-copper'.
    const padSide = isTop ? 'top' : 'bottom';
    /** @type {Map<string, number>} apertureKey → D-code */
    const apertures = new Map();
    let nextD = 10;

    const apKey = (kind, ...vals) => `${kind}:${vals.map((v) => v.toFixed?.(4) ?? v).join('x')}`;
    const getAp = (key, def) => {
        let d = apertures.get(key);
        if (d == null) { d = nextD++; apertures.set(key, d); }
        return d;
    };

    // Collect all draws first, then emit apertures + draws.
    /** @type {Array<{d:number, op:string}>} */
    const ops = [];

    // Pads on this layer (and on 'both').
    for (const flash of resolvePadFlashes(placements, { side: padSide })) {
        ops.push(padOperation(flash, getAp, bounds));
    }

    // Vias (drawn as circular flashes on both copper layers).
    for (const v of vias) {
        ops.push(padOperation({ x: v.x, y: v.y, w: v.diameter, h: v.diameter, shape: 'circle' }, getAp, bounds));
    }

    // Tracks on this layer.
    for (const t of tracks) {
        if (!t.edges?.size) continue;
        for (const { start: a, end: b, layer: edgeLayer, width: w } of resolveTrackSegments(t)) {
            if (edgeLayer !== layerId) continue;
            // Aperture is per-edge: each segment may have its own width.
            const d = getAp(apKey('C', w || 0.2));
            ops.push({ d, op: _strokeOperation([a, b], false, w || 0.2, bounds).trimEnd() });
        }
    }

    // Layer-change nodes are not flashed here. Vias are exclusively
    // standalone `Via` objects; tracks contribute only segment copper.

    // Free-standing text annotations placed on this copper layer.
    for (const t of texts) {
        if (t.layer !== layerId) continue;
        const sw = Number.isFinite(t.strokeWidth) && t.strokeWidth > 0 ? t.strokeWidth : 0.15;
        const key = apKey('C', sw);
        const d = getAp(key);
        const segs = pcbTextSegments(t);
        for (const [a, b] of segs) {
            ops.push({ d, op: _strokeOperation([a, b], false, sw, bounds).trimEnd() });
        }
    }

    // User-drawn circles. Added copper (mode 'add') flashes/strokes dark on
    // its own layer; copper removals (mode 'remove-copper'|'remove-copper-mask')
    // and hole-layer circles (which drill through the whole board) clear the
    // copper beneath them. Clears are collected separately and emitted in
    // clear polarity AFTER every dark draw so they carve whatever is below.
    /** @type {Array<{d:number, op:string}>} */
    const clearCircleOps = [];
    for (const c of circles) {
        if (!c) continue;
        const isHole = c.layer === 'hole';
        const geometry = resolveBoardShapeGeometry(c);
        const rad = geometry.filled ? geometry.circle.outerRadius : geometry.circle.radius;
        if (rad <= 0) continue;
        const onThisLayer = c.layer === layerId;
        if (!isHole && !onThisLayer) continue;
        const mode = geometry.copperMode;
        const cutsCopper = isHole ||
            (onThisLayer && (mode === 'remove-copper' || mode === 'remove-copper-mask'));
        if (cutsCopper || (onThisLayer && mode === 'add')) {
            const d = getAp(apKey('C', geometry.filled ? rad * 2 : geometry.lineWidth));
            (cutsCopper ? clearCircleOps : ops).push({ d, op: _circleOperation(geometry, bounds).trimEnd() });
        }
    }

    // User-drawn board shapes on this copper layer. Filled shapes use G36
    // regions; unfilled shapes use their configured stroke width.
    const shapeRegion = (outline) => _shapeContourRegion([outline], bounds);
    let darkShapeRegions = '';
    let clearShapeRegions = '';
    /** @type {Array<{d:number, op:string}>} */
    const clearShapeStrokeOps = [];
    for (const s of boardShapes) {
        if (s?.kind === 'circle') continue;
        if (!s) continue;
        const isHole = s.layer === 'hole';
        const geometry = resolveBoardShapeGeometry(s);
        const o = geometry.path;
        if (o.length < (geometry.filled ? 3 : 2)) continue;
        const onThisLayer = s.layer === layerId;
        if (!isHole && !onThisLayer) continue;
        const mode = geometry.copperMode;
        const cutsCopper = isHole ||
            (onThisLayer && (mode === 'remove-copper' || mode === 'remove-copper-mask'));
        if (geometry.physicalContours) {
            const region = _shapeContourRegion(geometry.physicalContours, bounds);
            if (cutsCopper) clearShapeRegions += region;
            else if (onThisLayer && mode === 'add') darkShapeRegions += region;
            continue;
        }
        const d = getAp(apKey('C', geometry.lineWidth));
        const op = _strokeOperation(o, geometry.pathClosed, geometry.lineWidth, bounds).trimEnd();
        if (!geometry.filled) {
            const strokeOps = geometry.strokeSegments?.length
                ? geometry.strokeSegments.map((segment) => ({
                    d: getAp(apKey('C', segment.lineWidth)),
                    op: _strokeOperation([segment.start, segment.end], false, segment.lineWidth, bounds).trimEnd(),
                }))
                : [{ d, op }];
            if (cutsCopper) clearShapeStrokeOps.push(...strokeOps);
            else if (onThisLayer && mode === 'add') ops.push(...strokeOps);
        } else if (cutsCopper) {
            clearShapeRegions += shapeRegion(o);
            clearShapeStrokeOps.push({ d, op });
        } else if (onThisLayer && mode === 'add') {
            darkShapeRegions += shapeRegion(o);
            ops.push({ d, op });
        }
    }

    // Emit file.
    let out = `G04 ClearPCB ${isTop ? 'Top' : 'Bottom'} Copper*\n` + FORMAT;
    out += '%LPD*%\n';
    for (const [key, code] of apertures) {
        out += `%ADD${code}${_apertureBody(key)}*%\n`;
    }
    // Pour regions omit their holes without clearing previously emitted islands.
    // Pads, tracks and vias are added afterward; explicit cutouts are applied last.
    out += _buildFillRegions(fills, layerId, bounds);
    out += '%LPD*%\n';
    let currentD = -1;
    for (const { d, op } of ops) {
        if (d !== currentD) { out += `D${d}*\n`; currentD = d; }
        out += op + '\n';
    }
    // Added-copper board-shape regions fill in dark polarity alongside the
    // copper above.
    if (darkShapeRegions) out += darkShapeRegions;
    // Copper-removal and hole circles: flash in clear polarity so they cut
    // the dark copper (pads, tracks, vias, pours, added circles) above.
    if (clearCircleOps.length || clearShapeStrokeOps.length || clearShapeRegions) {
        out += '%LPC*%\n';
        currentD = -1;
        for (const { d, op } of clearCircleOps) {
            if (d !== currentD) { out += `D${d}*\n`; currentD = d; }
            out += op + '\n';
        }
        for (const { d, op } of clearShapeStrokeOps) {
            if (d !== currentD) { out += `D${d}*\n`; currentD = d; }
            out += op + '\n';
        }
        if (clearShapeRegions) out += clearShapeRegions;
        out += '%LPD*%\n';
    }
    out += 'M02*\n';
    return out;
}

/**
 * Emit copper-pour polygons for `layerId` as gerber G36/G37 regions. Each
 * pour's last-computed geometry is a list of ExPolygons {outer, holes} in
 * world mm (SVG-Y-down). Hole-bearing polygons are triangulated into dark
 * regions so their holes cannot erase other islands. Returns '' for no fills.
 */
function _buildFillRegions(fills, layerId, bounds) {
    if (!Array.isArray(fills) || !fills.length) return '';
    let out = '';
    for (const f of fills) {
        if (f.layer !== layerId) continue;
        if (f.visible === false) continue;
        const polys = f._computed;
        if (!Array.isArray(polys) || !polys.length) continue;
        for (const poly of polys) {
            out += '%LPD*%\n';
            out += _shapeContourRegion([poly.outer || [], ...(poly.holes || [])], bounds);
        }
    }
    return out;
}


function _apertureBody(key) {
    // key formats: "C:0.6000", "R:1.0000x2.0000", "O:1.0000x2.0000"
    const [kind, dims] = key.split(':');
    const parts = dims.split('x').map(parseFloat);
    if (kind === 'C') return `C,${parts[0]}`;
    if (kind === 'R') return `R,${parts[0]}X${parts[1]}`;
    if (kind === 'O') return `O,${parts[0]}X${parts[1]}`;
    return `C,${parts[0]}`;
}

/* ──────────────────────────── pad-shape gerber helper ──────────────────────────── */

/**
 * Emit a positive-aperture gerber that flashes pad-shaped openings.
 * Used by both soldermask (every pad on this side, inflated by
 * `expansion`) and paste (SMD pads on this side, optionally shrunk).
 *
 * @param {Map<string, object>} placements
 * @param {Array<object>} vias
 * @param {'top'|'bottom'} side
 * @param {object} bounds  board clipping boundary (SVG-Y-down)
 * @param {object} opts
 * @param {number}  opts.expansion          mm added to each side of the pad
 * @param {boolean} opts.includeThruHole    include drilled (THT) pads
 * @param {boolean} opts.includeVias        include standalone vias
 * @param {boolean} opts.includeSmd         include SMD (non-drilled) pads
 * @param {string}  opts.title              human-readable header text
 */
function _buildPadLayer(placements, vias, side, bounds, opts) {
    const {
        expansion = 0,
        includeThruHole = true,
        includeVias = true,
        includeSmd = true,
        respectPaste = false,
        respectMask = false,
        pasteApertures = false,
        shapeOpenings = [],
        title = 'Pad Layer',
    } = opts;
    /** @type {Map<string, number>} apertureKey → D-code */
    const apertures = new Map();
    let nextD = 10;
    const apKey = (kind, ...vals) => `${kind}:${vals.map((v) => v.toFixed?.(4) ?? v).join('x')}`;
    const getAp = (key) => {
        let d = apertures.get(key);
        if (d == null) { d = nextD++; apertures.set(key, d); }
        return d;
    };
    /** @type {Array<{d:number, op:string}>} */
    const ops = [];

    for (const flash of resolvePadFlashes(placements, { side, includeThruHole, includeSmd, expansion })) {
        // A copper pad only contributes to the paste/mask layer it actually
        // lists. e.g. a QFN exposed pad is copper+mask but NOT paste (it is
        // windowpaned by separate apertures) — full-area paste there would
        // bridge solder.
        if (respectPaste && flash.paste === false) continue;
        if (respectMask && flash.mask === false) continue;
        ops.push(padOperation(flash, getAp, bounds));
    }

    // Standalone paste apertures (no copper) — windowpane stencil openings.
    if (pasteApertures) {
        for (const flash of resolvePadFlashes(placements, { side, source: 'paste', expansion })) {
            ops.push(padOperation(flash, getAp, bounds));
        }
    }

    if (includeVias) {
        for (const v of vias) {
            const dia = (v.diameter || 0.6) + 2 * expansion;
            if (dia <= 0) continue;
            ops.push(padOperation({ x: v.x, y: v.y, w: dia, h: dia, shape: 'circle' }, getAp, bounds));
        }
    }

    let shapeRegions = '';
    for (const opening of shapeOpenings) {
        const geometry = opening?.geometry;
        if (!geometry) continue;
        if (geometry.physicalContours) {
            shapeRegions += _shapeContourRegion(geometry.physicalContours, bounds);
            continue;
        }
        if (geometry.circle) {
            const d = getAp(apKey('C', geometry.filled ? geometry.circle.outerRadius * 2 : geometry.lineWidth));
            ops.push({ d, op: _circleOperation(geometry, bounds).trimEnd() });
            continue;
        }
        if (geometry.path.length < (geometry.filled ? 3 : 2)) continue;
        if (geometry.filled) {
            shapeRegions += _shapeContourRegion([geometry.path], bounds);
        }
        if (!geometry.filled && geometry.strokeSegments?.length) {
            for (const segment of geometry.strokeSegments) {
                const d = getAp(apKey('C', segment.lineWidth));
                const op = _strokeOperation([segment.start, segment.end], false, segment.lineWidth, bounds).trimEnd();
                ops.push({ d, op });
            }
        } else {
            const d = getAp(apKey('C', geometry.lineWidth));
            const op = _strokeOperation(geometry.path, geometry.pathClosed, geometry.lineWidth, bounds).trimEnd();
            ops.push({ d, op });
        }
    }

    let out = `G04 ClearPCB ${title}*\n` + FORMAT + '%LPD*%\n';
    for (const [key, code] of apertures) {
        out += `%ADD${code}${_apertureBody(key)}*%\n`;
    }
    let currentD = -1;
    for (const { d, op } of ops) {
        if (d !== currentD) { out += `D${d}*\n`; currentD = d; }
        out += op + '\n';
    }
    out += shapeRegions;
    out += 'M02*\n';
    return out;
}

/* ──────────────────────────── soldermask ──────────────────────────── */

function _buildMask(placements, vias, side, bounds, boardShapes = []) {
    // User-drawn soldermask openings: circles on this side's mask layer,
    // copper circles flagged to also open mask (remove-solder-mask /
    // remove-copper-mask), and hole-layer circles (a bare drilled hole has
    // no mask in the bore). Each opens at its exact drawn diameter.
    const maskLayer = `${side}-mask`;
    const copperLayer = `${side}-copper`;
    const shapeOpenings = [];
    for (const shape of boardShapes) {
        if (!shape || shape.type === 'fill') continue;
        const geometry = resolveBoardShapeGeometry(shape);
        const mode = geometry.copperMode;
        const forceFilled = shape.layer === maskLayer || shape.layer === 'hole';
        const opens = forceFilled
            || (shape.layer === copperLayer && (mode === 'remove-solder-mask' || mode === 'remove-copper-mask'));
        if (opens) shapeOpenings.push({
            geometry,
        });
    }
    return _buildPadLayer(placements, vias, side, bounds, {
        expansion: MASK_EXPANSION,
        includeThruHole: true,
        includeSmd: true,
        includeVias: !TENT_VIAS,
        respectMask: true,
        shapeOpenings,
        title: side === 'top' ? 'Top Soldermask' : 'Bottom Soldermask',
    });
}

/* ──────────────────────────── solder paste ──────────────────────────── */

function _buildPaste(placements, side, bounds) {
    // Paste stencil only opens for SMD pads. Through-hole pads and vias
    // get no paste (they're soldered after reflow, or tented). Copper pads
    // without a paste layer (windowpaned exposed pads) are skipped; their
    // stencil is supplied by standalone paste apertures instead.
    return _buildPadLayer(placements, [], side, bounds, {
        expansion: 0,
        includeThruHole: false,
        includeSmd: true,
        includeVias: false,
        respectPaste: true,
        pasteApertures: true,
        title: side === 'top' ? 'Top Paste' : 'Bottom Paste',
    });
}

/* ──────────────────────────── silkscreen ──────────────────────────── */

function _buildSilk(placements, side, bounds, texts = [], boardShapes = []) {
    // Component silk: footprint silk shapes (lines / circles / paths)
    // plus a small reference designator near each component origin.
    // `side` is 'top' or 'bottom'.
    const wantLayer = side === 'bottom' ? 'bottom-silk' : 'top-silk';
    const title = side === 'bottom' ? 'Bottom Silk' : 'Top Silk';
    let out = `G04 ClearPCB ${title}*\n` + FORMAT + '%LPD*%\n';
    // Default aperture for ref-designator strokes.
    out += '%ADD10C,0.15*%\nD10*\n';
    let currentApertureW = 0.15;
    /** @returns {number} next aperture code starting at 11. */
    const apertures = new Map(); // strokeWidth -> code
    let nextCode = 11;
    const useAperture = (w) => {
        const key = w.toFixed(4);
        let code = apertures.get(key);
        let header = '';
        if (code === undefined) {
            code = nextCode++;
            apertures.set(key, code);
            header = `%ADD${code}C,${w.toFixed(4)}*%\n`;
        }
        let sel = '';
        if (w !== currentApertureW) {
            sel = `D${code}*\n`;
            currentApertureW = w;
        }
        return header + sel;
    };

    const emitSeg = (a, b) => {
        return _strokeOperation([a, b], false, currentApertureW, bounds);
    };

    let body = '';
    for (const [, pl] of placements) {
        // ── Component silk shapes (resolved into posed, renderer-neutral
        // descriptors). Called per-placement so the aperture/D-code stream
        // keeps the same emission order as the reference designator below.
        for (const sk of resolveSilk(new Map([[0, pl]]), side)) {
            const head = useAperture(sk.width);
            if (head) body += head;
            if (sk.kind === 'line') {
                body += emitSeg({ x: sk.x1, y: sk.y1 }, { x: sk.x2, y: sk.y2 });
            } else if (sk.kind === 'circle') {
                // Approximate the circle with a 32-segment polyline around its
                // posed centre (the ring is rotation-invariant).
                const N = 32;
                // Solid silk circles (e.g. polarity dots) fill as a region so
                // the fabricated silkscreen is filled, not just an outline.
                if (sk.filled) {
                    body += _shapeContourRegion([Array.from({ length: N }, (_, index) => {
                        const angle = index / N * Math.PI * 2;
                        return { x: sk.cx + sk.r * Math.cos(angle), y: sk.cy + sk.r * Math.sin(angle) };
                    })], bounds);
                }
                let px = sk.cx + sk.r, py = sk.cy;
                for (let i = 1; i <= N; i++) {
                    const t = (i / N) * Math.PI * 2;
                    const nx = sk.cx + sk.r * Math.cos(t), ny = sk.cy + sk.r * Math.sin(t);
                    body += emitSeg({ x: px, y: py }, { x: nx, y: ny });
                    px = nx; py = ny;
                }
            } else if (sk.kind === 'path') {
                // Filled silk paths (e.g. pin-1 triangles) fill as regions so
                // they are solid on the fabricated silkscreen, not hollow.
                if (sk.filled) {
                    body += _shapeContourRegion(sk.polys, bounds);
                }
                for (const poly of sk.polys) {
                    for (let i = 1; i < poly.length; i++) {
                        body += emitSeg(poly[i - 1], poly[i]);
                    }
                }
            }
        }

        const refSide = pl.side === 'bottom' ? 'bottom' : 'top';
        if (refSide !== side) continue;
        const reference = resolveReferenceText(pl);
        if (!reference) continue;
        const head = useAperture(reference.strokeWidth);
        if (head) body += head;
        for (const poly of reference.polylines) {
            for (let index = 1; index < poly.length; index++) body += emitSeg(poly[index - 1], poly[index]);
        }
    }

    // Free-standing board shapes (rect/polygon/arc) on this silk side.
    for (const s of boardShapes) {
        if (!s || s.layer !== wantLayer) continue;
        const geometry = resolveBoardShapeGeometry(s);
        if (geometry.circle) {
            const { outerRadius } = geometry.circle;
            body += useAperture(geometry.filled ? outerRadius * 2 : geometry.lineWidth);
            body += _circleOperation(geometry, bounds);
            continue;
        }
        const o = geometry.path;
        if (o.length < 2) continue;
        const head = useAperture(geometry.filled ? 0.06 : geometry.lineWidth);
        if (head) body += head;
        if (geometry.physicalContours) {
            body += _shapeContourRegion(geometry.physicalContours, bounds);
            continue;
        }
        if (!geometry.filled && geometry.strokeSegments.length) {
            for (const segment of geometry.strokeSegments) {
                body += useAperture(segment.lineWidth);
                body += emitSeg(segment.start, segment.end);
            }
            continue;
        }
        if (geometry.filled && o.length >= 3) {
            body += _shapeContourRegion([o], bounds);
        }
        for (let i = 1; i < o.length; i++) body += emitSeg(o[i - 1], o[i]);
        if (geometry.pathClosed) body += emitSeg(o[o.length - 1], o[0]);
    }

    // Free-standing text annotations on this silk side.
    for (const t of texts) {
        if (t.layer !== wantLayer) continue;
        const sw = Number.isFinite(t.strokeWidth) && t.strokeWidth > 0 ? t.strokeWidth : 0.15;
        const head = useAperture(sw);
        if (head) body += head;
        for (const [a, b] of pcbTextSegments(t)) {
            body += emitSeg(a, b);
        }
    }

    out += body + 'M02*\n';
    return out;
}

/* ──────────────────────────── board outline ──────────────────────────── */

function _buildOutline(b, boardShapes = [], bounds) {
    const w = b.w, h = b.h;
    const r = b.r || 0;
    const x0 = b.x || 0, y0 = b.y || 0;
    const x1 = x0 + w, y1 = y0 + h;
    let out = 'G04 ClearPCB Board Outline*\n' + FORMAT + '%LPD*%\n';
    out += '%ADD10C,0.1*%\nD10*\n';
    const rad = Math.min(r, w / 2, h / 2);
    const outline = getBoardOutline({ boardShapes });
    if (outline?.kind === 'circle') {
        out += `G75*\nX${_fmt(outline.x - outline.radius)}Y${_fmtY(outline.y)}D02*\nG03*\n`;
        out += `X${_fmt(outline.x - outline.radius)}Y${_fmtY(outline.y)}I${_fmt(outline.radius)}J0D01*\nG01*\n`;
    } else if (outline) {
        const points = boardBoundary({ boardShapes }).points;
        out += `X${_fmt(points[0].x)}Y${_fmtY(points[0].y)}D02*\n`;
        for (const point of [...points.slice(1), points[0]]) out += `X${_fmt(point.x)}Y${_fmtY(point.y)}D01*\n`;
    } else if (rad <= 0) {
        out += `X${_fmt(x0)}Y${_fmt(y0)}D02*\n`;
        out += `X${_fmt(x1)}Y${_fmt(y0)}D01*\n`;
        out += `X${_fmt(x1)}Y${_fmt(y1)}D01*\n`;
        out += `X${_fmt(x0)}Y${_fmt(y1)}D01*\n`;
        out += `X${_fmt(x0)}Y${_fmt(y0)}D01*\n`;
    } else {
        // Rounded rectangle: straight edges + arc corners (G75 + G03).
        out += 'G75*\n';
        out += `X${_fmt(x0 + rad)}Y${_fmt(y0)}D02*\n`;
        out += `X${_fmt(x1 - rad)}Y${_fmt(y0)}D01*\n`;
        out += 'G03*\n';
        out += `X${_fmt(x1)}Y${_fmt(y0 + rad)}I${_fmt(0)}J${_fmt(rad)}D01*\n`;
        out += 'G01*\n';
        out += `X${_fmt(x1)}Y${_fmt(y1 - rad)}D01*\n`;
        out += 'G03*\n';
        out += `X${_fmt(x1 - rad)}Y${_fmt(y1)}I${_fmt(-rad)}J${_fmt(0)}D01*\n`;
        out += 'G01*\n';
        out += `X${_fmt(x0 + rad)}Y${_fmt(y1)}D01*\n`;
        out += 'G03*\n';
        out += `X${_fmt(x0)}Y${_fmt(y1 - rad)}I${_fmt(0)}J${_fmt(-rad)}D01*\n`;
        out += 'G01*\n';
        out += `X${_fmt(x0)}Y${_fmt(y0 + rad)}D01*\n`;
        out += 'G03*\n';
        out += `X${_fmt(x0 + rad)}Y${_fmt(y0)}I${_fmt(rad)}J${_fmt(0)}D01*\n`;
        out += 'G01*\n';
    }
    // Free-standing board shapes on the HOLE layer are interior cutouts: draw
    // each as a closed contour. Shape outlines are in SVG-Y-down internal
    // coords, so flip Y into the outline file's Y-up frame (y_up = -y_int).
    const cutoutPaths = [];
    let crossingCutout = false;
    const includeCutout = contours => {
        if (!bounds?.points) return true;
        if (!_clipContours(contours, bounds).length) return false;
        if (_clipContours(contours, bounds, ClipperLib.ClipType.ctDifference).length) crossingCutout = true;
        const union = new ClipperLib.Clipper();
        union.AddPaths(contours.map(contour => contour.map(point => ({ X: _fx(point.x), Y: _fx(point.y) }))),
            ClipperLib.PolyType.ptSubject, true);
        const paths = [];
        union.Execute(ClipperLib.ClipType.ctUnion, paths,
            ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
        cutoutPaths.push(...paths);
        return true;
    };
    for (const s of boardShapes) {
        if (!s || s.layer !== 'hole') continue;
        const geometry = resolveBoardShapeGeometry(s);
        if (geometry.circle) {
            const { x, y, outerRadius: radius } = geometry.circle;
            if (radius <= 0) continue;
            if (!includeCutout([padFlashOutline({ x, y, w: radius * 2, h: radius * 2, shape: 'circle' })])) continue;
            const startX = x - radius;
            out += 'G75*\n';
            out += `X${_fmt(startX)}Y${_fmt(-y)}D02*\n`;
            out += 'G03*\n';
            out += `X${_fmt(startX)}Y${_fmt(-y)}I${_fmt(radius)}J0D01*\n`;
            out += 'G01*\n';
            continue;
        }
        let contours = geometry.filled ? boardShapeFilledRemovalOutlines(s) : geometry.physicalContours;
        if (!contours) {
            const strokes = geometry.strokeSegments.length
                ? geometry.strokeSegments.map(segment => ({ points: [segment.start, segment.end], width: segment.lineWidth }))
                : [{ points: geometry.centerline, width: geometry.lineWidth }];
            const paths = [];
            for (const stroke of strokes) {
                const offset = new ClipperLib.ClipperOffset(10, 0.001 * SCALE);
                offset.AddPath(stroke.points.map(point => ({ X: _fx(point.x), Y: _fx(point.y) })),
                    ClipperLib.JoinType.jtRound, geometry.centerlineClosed
                        ? ClipperLib.EndType.etClosedLine : ClipperLib.EndType.etOpenRound);
                const expanded = [];
                offset.Execute(expanded, stroke.width * SCALE / 2);
                paths.push(...expanded);
            }
            const union = new ClipperLib.Clipper();
            union.AddPaths(paths, ClipperLib.PolyType.ptSubject, true);
            const merged = [];
            union.Execute(ClipperLib.ClipType.ctUnion, merged,
                ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
            contours = merged.map(path => path.map(point => ({ x: point.X / SCALE, y: point.Y / SCALE })));
        }
        if (!includeCutout(contours)) continue;
        for (const contour of contours) {
            if (contour.length < 3) continue;
            out += `X${_fmt(contour[0].x)}Y${_fmtY(contour[0].y)}D02*\n`;
            for (const point of [...contour.slice(1), contour[0]]) {
                out += `X${_fmt(point.x)}Y${_fmtY(point.y)}D01*\n`;
            }
        }
    }
    if (crossingCutout) {
        const clipper = new ClipperLib.Clipper();
        clipper.AddPath(bounds.points.map(point => ({ X: _fx(point.x), Y: _fx(point.y) })),
            ClipperLib.PolyType.ptSubject, true);
        clipper.AddPaths(cutoutPaths, ClipperLib.PolyType.ptClip, true);
        const contours = [];
        clipper.Execute(ClipperLib.ClipType.ctDifference, contours,
            ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
        out = 'G04 ClearPCB Board Outline*\n' + FORMAT + '%LPD*%\n%ADD10C,0.1*%\nD10*\n';
        for (const contour of contours) {
            if (contour.length < 3) continue;
            const start = contour[0];
            out += `X${start.X}Y${-start.Y}D02*\n`;
            for (const point of [...contour.slice(1), start]) out += `X${point.X}Y${-point.Y}D01*\n`;
        }
    }
    out += 'M02*\n';
    return out;
}

/* ──────────────────────────── drill ──────────────────────────── */

/** Collect plated drills: through-hole pads, vias, and plated Hole-layer shapes. */
function _collectPlatedDrills(placements, vias, boardShapes = []) {
    const out = [];
    // Through-hole pad drills (round + oval slot), posed via the shared resolver.
    for (const drill of resolvePlacementDrills(placements)) {
        if (!drill.plated) continue;
        if (drill.slot) {
            out.push({ dia: drill.dia, x: drill.x, y: drill.y, x2: drill.slot.x2, y2: drill.slot.y2 });
        } else {
            out.push({ dia: drill.dia, x: drill.x, y: drill.y });
        }
    }
    for (const v of vias) {
        if (v.drill > 0) out.push({ dia: v.drill, x: v.x, y: v.y });
    }
    for (const circle of boardShapes) {
        if (circle?.kind !== 'circle') continue;
        if (circle?.layer !== 'hole' || !circle.plated) continue;
        const dia = 2 * (Number(circle.radius) || 0);
        if (dia > 0) out.push({ dia, x: circle.x, y: circle.y });
    }
    out.push(..._collectBoardShapeSlots(boardShapes, true));
    return out;
}

/** Collect non-plated drills: Hole-layer shapes and footprint mounting holes. */
function _collectNonPlatedDrills(boardShapes = [], placements = new Map(), bounds) {
    const out = [];
    // Hole-layer circles drill through the board unless explicitly plated.
    for (const c of boardShapes) {
        if (c?.kind !== 'circle') continue;
        if (!c || c.layer !== 'hole' || c.plated) continue;
        const dia = 2 * (Number(c.radius) || 0);
        if (dia <= 0) continue;
        const contour = padFlashOutline({ x: c.x, y: c.y, w: dia, h: dia, shape: 'circle' });
        if (bounds?.points && _clipContours([contour], bounds, ClipperLib.ClipType.ctDifference).length) continue;
        out.push({ dia, x: c.x, y: c.y });
    }
    // Footprint mechanical / mounting holes (posed 'hole'-layer silk circles),
    // resolved alongside pad drills by the shared resolver.
    for (const drill of resolvePlacementDrills(placements)) {
        if (drill.plated) continue;
        out.push({ dia: drill.dia, x: drill.x, y: drill.y });
    }
    out.push(..._collectBoardShapeSlots(boardShapes, false));
    return out;
}

/** Convert each segment of a Hole-layer Line into a round-ended routed slot. */
function _collectBoardShapeSlots(boardShapes, plated) {
    const slots = [];
    for (const shape of boardShapes) {
        if (!shape || shape.kind !== 'line' || shape.layer !== 'hole' || !!shape.plated !== plated) continue;
        const geometry = resolveBoardShapeGeometry(shape);
        const segments = geometry.strokeSegments.length ? geometry.strokeSegments
            : geometry.centerline.slice(1).map((end, index) => ({
                start: geometry.centerline[index], end, lineWidth: geometry.lineWidth,
            }));
        for (const { start, end, lineWidth } of segments) {
            if (Math.hypot(end.x - start.x, end.y - start.y) <= 1e-9) continue;
            slots.push({
                dia: lineWidth,
                x: start.x,
                y: start.y,
                x2: end.x,
                y2: end.y,
            });
        }
    }
    return slots;
}

/**
 * Build an Excellon drill file from a flat list of {dia, x, y} drills.
 * @param {Array<{dia:number,x:number,y:number}>} drills
 * @param {object} bounds   board clip bounds
 * @param {boolean} [nonPlated]  annotate the header as non-plated
 */
function _buildDrill(drills, bounds, nonPlated = false) {
    /** @type {Map<number, Array<{x:number,y:number}>>} drill mm → positions */
    const tools = new Map();
    for (const d of drills) {
        if (!d.dia || d.dia <= 0) continue;
        if (!_inBoard(d.x, d.y, bounds)) continue;
        const isSlot = Number.isFinite(d.x2) && Number.isFinite(d.y2);
        if (isSlot && !_inBoard(d.x2, d.y2, bounds)) continue;
        const key = Math.round(d.dia * 1000) / 1000;
        let list = tools.get(key);
        if (!list) { list = []; tools.set(key, list); }
        list.push(isSlot ? { x: d.x, y: d.y, x2: d.x2, y2: d.y2 } : { x: d.x, y: d.y });
    }

    // Header. Use decimal coordinates (universally supported); declare
    // METRIC with leading-zero suppression as a sensible default. Gerber X2
    // attributes (the `; #@! ` comment form) tag the file's plating so
    // compliant viewers/fabs classify the holes; the -PTH / -NPTH filename
    // suffix is the fallback for tools that ignore attributes.
    const plating = nonPlated ? 'NonPlated' : 'Plated';
    const tag = nonPlated ? 'NPTH' : 'PTH';
    const aperFn = nonPlated ? 'MechanicalDrill' : 'ComponentDrill';
    let out = 'M48\n; ClearPCB Excellon drill\n';
    out += `; #@! TF.FileFunction,${plating},1,2,${tag}\n`;
    out += '; #@! TF.FilePolarity,Positive\n';
    out += `; TYPE=${nonPlated ? 'NON_PLATED' : 'PLATED'}\n`;
    out += 'FMAT,2\nMETRIC,LZ\n';
    const sorted = [...tools.keys()].sort((a, b) => a - b);
    sorted.forEach((dia, i) => {
        // Aperture function classifies the drill (component vs mechanical).
        out += `; #@! TA.AperFunction,${aperFn}\n`;
        out += `T${i + 1}C${dia.toFixed(3)}\n`;
    });
    out += '%\nG90\nG05\n';
    sorted.forEach((dia, i) => {
        out += `T${i + 1}\n`;
        for (const h of tools.get(dia)) {
            // Excellon uses Y-up like gerber; flip from our SVG-Y-down data.
            if (Number.isFinite(h.x2) && Number.isFinite(h.y2)) {
                // Slot: G85 canned routed slot from start to end coordinate.
                out += `X${h.x.toFixed(3)}Y${(-h.y).toFixed(3)}G85X${h.x2.toFixed(3)}Y${(-h.y2).toFixed(3)}\n`;
            } else {
                out += `X${h.x.toFixed(3)}Y${(-h.y).toFixed(3)}\n`;
            }
        }
    });
    out += 'T0\nM30\n';
    return out;
}

/* ──────────────────────────── zip writer ──────────────────────────── */

/**
 * Build a store-only (no compression) ZIP from a Map of filename → string.
 * Returns a Blob suitable for `URL.createObjectURL`.
 *
 * Implements just the subset of the ZIP spec needed for a flat archive of
 * small text files: local file headers, central directory, EOCD. No
 * extra fields, no UTF-8 flag (filenames here are ASCII).
 *
 * @param {Map<string, string>} files
 * @returns {Blob}
 */
export function buildZip(files) {
    const encoder = new TextEncoder();
    /** @type {Uint8Array[]} */
    const chunks = [];
    const central = [];
    let offset = 0;

    const u16 = (n) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
    const u32 = (n) => new Uint8Array([
        n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff,
    ]);
    const concat = (arrs) => {
        const len = arrs.reduce((s, a) => s + a.length, 0);
        const out = new Uint8Array(len);
        let p = 0;
        for (const a of arrs) { out.set(a, p); p += a.length; }
        return out;
    };

    for (const [name, content] of files) {
        const nameBytes = encoder.encode(name);
        const dataBytes = encoder.encode(content);
        const crc = _crc32(dataBytes);

        // Local file header.
        const lfh = concat([
            u32(0x04034b50),    // signature
            u16(20),            // version needed
            u16(0),             // flags
            u16(0),             // compression: store
            u16(0), u16(0),     // mod time, mod date
            u32(crc),
            u32(dataBytes.length), // compressed
            u32(dataBytes.length), // uncompressed
            u16(nameBytes.length),
            u16(0),             // extra field length
            nameBytes,
            dataBytes,
        ]);
        chunks.push(lfh);

        // Central directory entry.
        central.push(concat([
            u32(0x02014b50),
            u16(20), u16(20),   // version made by, version needed
            u16(0), u16(0),
            u16(0), u16(0),
            u32(crc),
            u32(dataBytes.length),
            u32(dataBytes.length),
            u16(nameBytes.length),
            u16(0), u16(0),     // extra, comment
            u16(0), u16(0),     // disk, internal attrs
            u32(0),             // external attrs
            u32(offset),        // local header offset
            nameBytes,
        ]));
        offset += lfh.length;
    }

    const centralBytes = concat(central);
    const centralOffset = offset;
    chunks.push(centralBytes);

    const eocd = concat([
        u32(0x06054b50),
        u16(0), u16(0),
        u16(files.size), u16(files.size),
        u32(centralBytes.length),
        u32(centralOffset),
        u16(0),
    ]);
    chunks.push(eocd);

    const blob = new Blob(chunks, { type: 'application/zip' });
    return blob;
}

const _CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        t[i] = c >>> 0;
    }
    return t;
})();

function _crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        c = _CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}
