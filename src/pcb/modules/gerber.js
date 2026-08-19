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
 *   - board-outline.gko (rectangular / rounded board boundary)
 *   - board-PTH.drl     (Excellon plated through-holes: pads, vias, plated holes)
 *   - board-NPTH.drl    (Excellon non-plated holes: mounting/tooling — when present)
 *
 * Coordinate system: ClearPCB stores PCB geometry in SVG-Y-down
 * millimetres (positive Y points down on screen). Gerber files use
 * Y-up, so this exporter negates every Y value at emission time and
 * shifts the clip rectangle into the input (Y-down) space.
 *
 * The output uses fixed-point 4.6 (four integer digits, six fractional)
 * which is the modern standard for sub-micron precision in mm.
 */

import { stringToPolylines, measureText } from './stroke-font.js';
import {
    orthoSwap as _orthoSwap,
    resolvePlacementDrills,
    resolvePadFlashes,
    resolveSilk,
    MASK_EXPANSION,
    TENT_VIAS,
} from './board-geometry.js';
import { resolveBoardShapeGeometry } from './board-shapes.js';
import { pcbTextSegments } from './pcb-text.js';

const FORMAT = '%FSLAX46Y46*%\n%MOMM*%\n';
const SCALE = 1e6; // 4.6 fixed-point: multiply mm by 10^6


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
    const files = new Map([
        ['board.gtl', _buildCopper(placements, tracks, vias, 'top-copper', clipBounds, texts, fills, circles, boardShapes)],
        ['board.gbl', _buildCopper(placements, tracks, vias, 'bottom-copper', clipBounds, texts, fills, circles, boardShapes)],
        ['board.gts', _buildMask(placements, vias, 'top', clipBounds, boardShapes)],
        ['board.gbs', _buildMask(placements, vias, 'bottom', clipBounds, boardShapes)],
        ['board.gtp', _buildPaste(placements, 'top', clipBounds)],
        ['board.gbp', _buildPaste(placements, 'bottom', clipBounds)],
        ['board.gto', _buildSilk(placements, 'top', clipBounds, texts, boardShapes)],
        ['board.gbo', _buildSilk(placements, 'bottom', clipBounds, texts, boardShapes)],
        ['board.gko', _buildOutline(outlineBounds, boardShapes)],
        // Plated through-holes (pads, vias, and Hole-layer circles) and
        // non-plated holes go in separate Excellon files so fabs (JLCPCB,
        // etc.) can tell them apart — they key off the -PTH / -NPTH suffix.
        ['board-PTH.drl', _buildDrill(_collectPlatedDrills(placements, vias, circles), clipBounds)],
    ]);
    // Only emit the NPTH file when there are non-plated holes — an empty
    // drill file trips up some fab pre-checks.
    const npth = _collectNonPlatedDrills(circles, placements);
    if (npth.length) files.set('board-NPTH.drl', _buildDrill(npth, clipBounds, true));
    return files;
}

/* ──────────────────────────── board clipping ──────────────────────────── */

/** Point inside the board outline (rectangle, ignoring rounded corners). */
function _inBoard(x, y, b) {
    if (!b || !b.w || !b.h) return true;
    const x0 = b.x || 0, y0 = b.y || 0;
    return x >= x0 && x <= x0 + b.w && y >= y0 && y <= y0 + b.h;
}

/**
 * Liang–Barsky segment clip against the board rectangle
 * [b.x, b.y] – [b.x+w, b.y+h]. Returns null if the segment lies entirely
 * outside, otherwise the clipped endpoints. Rounded corners are ignored —
 * the outline gerber defines the actual cut, so a tiny corner overrun is
 * harmless.
 */
function _clipSegment(x1, y1, x2, y2, b) {
    if (!b || !b.w || !b.h) return [x1, y1, x2, y2];
    const x0 = b.x || 0, y0 = b.y || 0;
    const xMax = x0 + b.w, yMax = y0 + b.h;
    let t0 = 0, t1 = 1;
    const dx = x2 - x1, dy = y2 - y1;
    const p = [-dx, dx, -dy, dy];
    const q = [x1 - x0, xMax - x1, y1 - y0, yMax - y1];
    for (let i = 0; i < 4; i++) {
        if (p[i] === 0) {
            if (q[i] < 0) return null;
        } else {
            const t = q[i] / p[i];
            if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
            else          { if (t < t0) return null; if (t < t1) t1 = t; }
        }
    }
    return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
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
        if (!_inBoard(flash.x, flash.y, bounds)) continue;
        let w = flash.w;
        let h = flash.h;
        if (_orthoSwap(flash.rotation)) { const t = w; w = h; h = t; }
        let key;
        if (flash.shape === 'ellipse') {
            key = apKey('C', Math.max(w, h));
        } else if (flash.shape === 'oval') {
            key = apKey('O', w, h);
        } else {
            key = apKey('R', w, h);
        }
        const d = getAp(key);
        ops.push({ d, op: `X${_fmt(flash.x)}Y${_fmtY(flash.y)}D03*` });
    }

    // Vias (drawn as circular flashes on both copper layers).
    for (const v of vias) {
        if (!_inBoard(v.x, v.y, bounds)) continue;
        const key = apKey('C', v.diameter);
        const d = getAp(key);
        ops.push({ d, op: `X${_fmt(v.x)}Y${_fmtY(v.y)}D03*` });
    }

    // Tracks on this layer.
    for (const t of tracks) {
        if (!t.edges?.size) continue;
        for (const [eid, e] of t.edges) {
            const edgeLayer = t.getEdgeLayer ? t.getEdgeLayer(eid) : (t.layer);
            if (edgeLayer !== layerId) continue;
            const a = t.nodes.get(e.from);
            const b = t.nodes.get(e.to);
            if (!a || !b) continue;
            const clipped = _clipSegment(a.x, a.y, b.x, b.y, bounds);
            if (!clipped) continue;
            // Aperture is per-edge: each segment may have its own width.
            const w = t.getEdgeWidth ? t.getEdgeWidth(eid) : t.width;
            const d = getAp(apKey('C', w || 0.2));
            ops.push({ d, op: `X${_fmt(clipped[0])}Y${_fmtY(clipped[1])}D02*` });
            ops.push({ d, op: `X${_fmt(clipped[2])}Y${_fmtY(clipped[3])}D01*` });
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
            const clipped = _clipSegment(a.x, a.y, b.x, b.y, bounds);
            if (!clipped) continue;
            ops.push({ d, op: `X${_fmt(clipped[0])}Y${_fmtY(clipped[1])}D02*` });
            ops.push({ d, op: `X${_fmt(clipped[2])}Y${_fmtY(clipped[3])}D01*` });
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
        if (!_inBoard(c.x, c.y, bounds)) continue;
        const onThisLayer = c.layer === layerId;
        if (!isHole && !onThisLayer) continue;
        const mode = geometry.copperMode;
        const cutsCopper = isHole ||
            (onThisLayer && (mode === 'remove-copper' || mode === 'remove-copper-mask'));
        if (cutsCopper) {
            if (geometry.filled) {
                const d = getAp(apKey('C', rad * 2));
                clearCircleOps.push({ d, op: `X${_fmt(c.x)}Y${_fmtY(c.y)}D03*` });
            } else {
                const d = getAp(apKey('C', geometry.lineWidth));
                const sx = c.x - rad;
                const arc = `G75*\n`
                    + `X${_fmt(sx)}Y${_fmtY(c.y)}D02*\n`
                    + `G03*\n`
                    + `X${_fmt(sx)}Y${_fmtY(c.y)}I${_fx(rad)}J0D01*\n`
                    + `G01*`;
                clearCircleOps.push({ d, op: arc });
            }
        } else if (onThisLayer && mode === 'add') {
            if (geometry.filled) {
                // Solid disc: flash a circular aperture.
                const d = getAp(apKey('C', rad * 2));
                ops.push({ d, op: `X${_fmt(c.x)}Y${_fmtY(c.y)}D03*` });
            } else {
                // Ring: stroke the outline with a full-circle arc (G75/G03).
                const d = getAp(apKey('C', geometry.lineWidth));
                const sx = c.x - rad;
                const arc = `G75*\n`
                    + `X${_fmt(sx)}Y${_fmtY(c.y)}D02*\n`
                    + `G03*\n`
                    + `X${_fmt(sx)}Y${_fmtY(c.y)}I${_fx(rad)}J0D01*\n`
                    + `G01*`;
                ops.push({ d, op: arc });
            }
        }
    }

    // User-drawn board shapes on this copper layer. Filled shapes use G36
    // regions; unfilled shapes use their configured stroke width.
    const shapeRegion = (o) => {
        if (!o || o.length < 3) return '';
        let s = 'G36*\n';
        s += `X${_fmt(o[0].x)}Y${_fmtY(o[0].y)}D02*\n`;
        for (let i = 1; i < o.length; i++) {
            s += `X${_fmt(o[i].x)}Y${_fmtY(o[i].y)}D01*\n`;
        }
        s += 'G37*\n';
        return s;
    };
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
        if (!geometry.filled) {
            const d = getAp(apKey('C', geometry.lineWidth));
            const op = `X${_fmt(o[0].x)}Y${_fmtY(o[0].y)}D02*\n`
            + o.slice(1).map((point) => `X${_fmt(point.x)}Y${_fmtY(point.y)}D01*`).join('\n')
            + (geometry.centerlineClosed ? `\nX${_fmt(o[0].x)}Y${_fmtY(o[0].y)}D01*` : '');
            if (cutsCopper) clearShapeStrokeOps.push({ d, op });
            else if (onThisLayer && mode === 'add') ops.push({ d, op });
        } else if (cutsCopper) clearShapeRegions += shapeRegion(o);
        else if (onThisLayer && mode === 'add') darkShapeRegions += shapeRegion(o);
    }

    // Emit file.
    let out = `G04 ClearPCB ${isTop ? 'Top' : 'Bottom'} Copper*\n` + FORMAT;
    out += '%LPD*%\n';
    for (const [key, code] of apertures) {
        out += `%ADD${code}${_apertureBody(key)}*%\n`;
    }
    // Copper pours: emit BEFORE the pad/track/via flashes so the cleared
    // gaps (holes = obstacle + clearance) are carved first and the dark
    // flashes that follow restore the obstacle copper, leaving the annular
    // clearance ring intact. Regions don't use apertures (G36 fill mode).
    out += _buildFillRegions(fills, layerId);
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
 * world mm (SVG-Y-down). Outer contours fill in dark polarity (LPD); holes
 * clear in LPC. Returns '' when there is nothing to emit.
 */
function _buildFillRegions(fills, layerId) {
    if (!Array.isArray(fills) || !fills.length) return '';
    const ringD = (ring, op) => {
        if (!ring || ring.length < 3) return '';
        let s = 'G36*\n';
        s += `X${_fmt(ring[0].x)}Y${_fmtY(ring[0].y)}D02*\n`;
        for (let i = 1; i < ring.length; i++) {
            s += `X${_fmt(ring[i].x)}Y${_fmtY(ring[i].y)}D01*\n`;
        }
        s += 'G37*\n';
        return s;
    };
    let out = '';
    for (const f of fills) {
        if (f.layer !== layerId) continue;
        if (f.visible === false) continue;
        const polys = f._computed;
        if (!Array.isArray(polys) || !polys.length) continue;
        for (const poly of polys) {
            out += '%LPD*%\n';
            out += ringD(poly.outer);
            if (Array.isArray(poly.holes) && poly.holes.length) {
                out += '%LPC*%\n';
                for (const hole of poly.holes) out += ringD(hole);
            }
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
 * @param {object} bounds  clip rect (SVG-Y-down)
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
        if (!_inBoard(flash.x, flash.y, bounds)) continue;
        let w = flash.w;
        let h = flash.h;
        if (_orthoSwap(flash.rotation)) { const t = w; w = h; h = t; }
        let key;
        if (flash.shape === 'ellipse') {
            key = apKey('C', Math.max(w, h));
        } else if (flash.shape === 'oval') {
            key = apKey('O', w, h);
        } else {
            key = apKey('R', w, h);
        }
        const d = getAp(key);
        ops.push({ d, op: `X${_fmt(flash.x)}Y${_fmtY(flash.y)}D03*` });
    }

    // Standalone paste apertures (no copper) — windowpane stencil openings.
    if (pasteApertures) {
        for (const flash of resolvePadFlashes(placements, { side, source: 'paste', expansion })) {
            if (!_inBoard(flash.x, flash.y, bounds)) continue;
            let w = flash.w;
            let h = flash.h;
            if (_orthoSwap(flash.rotation)) { const t = w; w = h; h = t; }
            let key;
            if (flash.shape === 'ellipse') {
                key = apKey('C', Math.max(w, h));
            } else if (flash.shape === 'oval') {
                key = apKey('O', w, h);
            } else {
                key = apKey('R', w, h);
            }
            const d = getAp(key);
            ops.push({ d, op: `X${_fmt(flash.x)}Y${_fmtY(flash.y)}D03*` });
        }
    }

    if (includeVias) {
        for (const v of vias) {
            if (!_inBoard(v.x, v.y, bounds)) continue;
            const dia = (v.diameter || 0.6) + 2 * expansion;
            if (dia <= 0) continue;
            const key = apKey('C', dia);
            const d = getAp(key);
            ops.push({ d, op: `X${_fmt(v.x)}Y${_fmtY(v.y)}D03*` });
        }
    }

    let shapeRegions = '';
    for (const opening of shapeOpenings) {
        const geometry = opening?.geometry;
        if (!geometry) continue;
        if (geometry.circle) {
            if (!_inBoard(geometry.circle.x, geometry.circle.y, bounds)) continue;
            if (geometry.filled) {
                const d = getAp(apKey('C', geometry.circle.outerRadius * 2));
                ops.push({ d, op: `X${_fmt(geometry.circle.x)}Y${_fmtY(geometry.circle.y)}D03*` });
            } else {
                const d = getAp(apKey('C', geometry.lineWidth));
                const startX = geometry.circle.x - geometry.circle.radius;
                ops.push({ d, op: `G75*\n`
                    + `X${_fmt(startX)}Y${_fmtY(geometry.circle.y)}D02*\n`
                    + `G03*\n`
                    + `X${_fmt(startX)}Y${_fmtY(geometry.circle.y)}I${_fx(geometry.circle.radius)}J0D01*\n`
                    + 'G01*' });
            }
            continue;
        }
        if (geometry.path.length < (geometry.filled ? 3 : 2)) continue;
        if (geometry.filled) {
            shapeRegions += 'G36*\n';
            shapeRegions += `X${_fmt(geometry.path[0].x)}Y${_fmtY(geometry.path[0].y)}D02*\n`;
            for (const point of geometry.path.slice(1)) {
                shapeRegions += `X${_fmt(point.x)}Y${_fmtY(point.y)}D01*\n`;
            }
            shapeRegions += 'G37*\n';
        } else {
            const d = getAp(apKey('C', geometry.lineWidth));
            let op = `X${_fmt(geometry.path[0].x)}Y${_fmtY(geometry.path[0].y)}D02*\n`;
            op += geometry.path.slice(1)
                .map((point) => `X${_fmt(point.x)}Y${_fmtY(point.y)}D01*`)
                .join('\n');
            if (geometry.centerlineClosed) {
                op += `\nX${_fmt(geometry.path[0].x)}Y${_fmtY(geometry.path[0].y)}D01*`;
            }
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
        const clipped = _clipSegment(a.x, a.y, b.x, b.y, bounds);
        if (!clipped) return '';
        return `X${_fmt(clipped[0])}Y${_fmtY(clipped[1])}D02*\n`
             + `X${_fmt(clipped[2])}Y${_fmtY(clipped[3])}D01*\n`;
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
                    let ring = 'G36*\n';
                    ring += `X${_fmt(sk.cx + sk.r)}Y${_fmtY(sk.cy)}D02*\n`;
                    for (let i = 1; i <= N; i++) {
                        const t = (i / N) * Math.PI * 2;
                        ring += `X${_fmt(sk.cx + sk.r * Math.cos(t))}Y${_fmtY(sk.cy + sk.r * Math.sin(t))}D01*\n`;
                    }
                    ring += 'G37*\n';
                    body += ring;
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
                    for (const poly of sk.polys) {
                        if (poly.length < 3) continue;
                        let ring = 'G36*\n';
                        ring += `X${_fmt(poly[0].x)}Y${_fmtY(poly[0].y)}D02*\n`;
                        for (let i = 1; i < poly.length; i++) {
                            ring += `X${_fmt(poly[i].x)}Y${_fmtY(poly[i].y)}D01*\n`;
                        }
                        ring += 'G37*\n';
                        body += ring;
                    }
                }
                for (const poly of sk.polys) {
                    for (let i = 1; i < poly.length; i++) {
                        body += emitSeg(poly[i - 1], poly[i]);
                    }
                }
            }
        }

        // ── Reference designator. Emit on the silk side matching the
        // component's placement side, replicating its on-screen size,
        // position, rotation and move offset (see _refSegments).
        const refSide = pl.side === 'bottom' ? 'bottom' : 'top';
        if (refSide !== side) continue;
        if (!_inBoard(pl.x, pl.y, bounds)) continue;
        const refGeom = _refSegments(pl);
        if (!refGeom) continue;
        const head = useAperture(refGeom.strokeWidth);
        if (head) body += head;
        for (const [a, b] of refGeom.segments) {
            body += emitSeg(a, b);
        }
    }

    // Free-standing board shapes (rect/polygon/arc) on this silk side.
    for (const s of boardShapes) {
        if (!s || s.layer !== wantLayer) continue;
        const geometry = resolveBoardShapeGeometry(s);
        const o = geometry.path;
        if (o.length < 2) continue;
        const head = useAperture(geometry.filled ? 0.06 : geometry.lineWidth);
        if (head) body += head;
        if (geometry.filled && o.length >= 3) {
            let ring = 'G36*\n';
            ring += `X${_fmt(o[0].x)}Y${_fmtY(o[0].y)}D02*\n`;
            for (let i = 1; i < o.length; i++) {
                ring += `X${_fmt(o[i].x)}Y${_fmtY(o[i].y)}D01*\n`;
            }
            ring += 'G37*\n';
            body += ring;
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

/**
 * World-space stroke segments for a placement's reference designator,
 * replicating the editor's transform chain so the gerber matches the
 * screen exactly: the footprint pose (translate · rotate · mirror) plus
 * the designator's own move (refDx/refDy), rotation (refRot about its
 * glyph centre), size (refSize) and per-side handedness. Returns null
 * when the designator is hidden or empty.
 *
 * @param {object} pl  placement (see PCBApp.placements entries)
 * @returns {{segments: Array<[{x:number,y:number},{x:number,y:number}]>, strokeWidth:number}|null}
 */
function _refSegments(pl) {
    const ref = pl?.reference;
    if (!ref || pl.refVisible === false) return null;
    const size = Number(pl.refSize) > 0 ? pl.refSize : 0.9;
    const strokeWidth = Number(pl.refStrokeWidth) > 0 ? pl.refStrokeWidth : 0.15;
    // Base layout (footprint-local), identical to renderFootprint/applyRefGeometry:
    // horizontally centred on the outline, baseline just above its top edge.
    const ob = pl.outline;
    const cxRef = ob ? ob.x + ob.width / 2 : 0;
    const outlineY = ob ? ob.y : -2;
    const baseY = outlineY - 0.8;
    const baseX = cxRef - measureText(ref, size) / 2;
    const polys = stringToPolylines(ref, baseX, baseY, size, false);
    if (!polys.length) return null;

    // Glyph bbox vertical centre = the pivot the editor rotates refRot about.
    let minY = Infinity, maxY = -Infinity;
    for (const poly of polys) for (const p of poly) {
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
    }
    const cy = Number.isFinite(minY) ? (minY + maxY) / 2 : baseY - size / 2;

    const dx = pl.refDx || 0, dy = pl.refDy || 0;
    const rr = (pl.refRot || 0) * Math.PI / 180;
    const rc = Math.cos(rr), rs = Math.sin(rr);
    // The ref counter-mirrors only the user flip; the footprint group already
    // applies the full visual mirror (user flip XOR bottom side).
    const flip = !!pl.mirror;
    const mirrored = (!!pl.mirror) !== (pl.side === 'bottom');
    const prot = (pl.rotation || 0) * Math.PI / 180;
    const pc = Math.cos(prot), ps = Math.sin(prot);
    const px = pl.x || 0, py = pl.y || 0;

    const xf = (p) => {
        let x = p.x, y = p.y;
        // 1. rotate(refRot) about the glyph centre (cxRef, cy)
        if (rr) {
            const ox = x - cxRef, oy = y - cy;
            x = cxRef + ox * rc - oy * rs;
            y = cy + ox * rs + oy * rc;
        }
        // 2. counter-mirror about x = cxRef so the ref reads per side
        if (flip) x = 2 * cxRef - x;
        // 3. ref move offset
        x += dx; y += dy;
        // 4. placement mirror
        if (mirrored) x = -x;
        // 5. placement rotation, then 6. placement translation
        return { x: px + x * pc - y * ps, y: py + x * ps + y * pc };
    };

    const segments = [];
    for (const poly of polys) {
        for (let i = 1; i < poly.length; i++) {
            segments.push([xf(poly[i - 1]), xf(poly[i])]);
        }
    }
    return { segments, strokeWidth };
}

/* ──────────────────────────── board outline ──────────────────────────── */

function _buildOutline(b, boardShapes = []) {
    const w = b.w, h = b.h;
    const r = b.r || 0;
    const x0 = b.x || 0, y0 = b.y || 0;
    const x1 = x0 + w, y1 = y0 + h;
    let out = 'G04 ClearPCB Board Outline*\n' + FORMAT + '%LPD*%\n';
    out += '%ADD10C,0.1*%\nD10*\n';
    const rad = Math.min(r, w / 2, h / 2);
    if (rad <= 0) {
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
    for (const s of boardShapes) {
        if (!s || s.layer !== 'hole') continue;
        const o = resolveBoardShapeGeometry(s).path;
        if (o.length < 3) continue;
        out += `X${_fmt(o[0].x)}Y${_fmt(-o[0].y)}D02*\n`;
        for (let i = 1; i < o.length; i++) {
            out += `X${_fmt(o[i].x)}Y${_fmt(-o[i].y)}D01*\n`;
        }
        out += `X${_fmt(o[0].x)}Y${_fmt(-o[0].y)}D01*\n`;
    }
    out += 'M02*\n';
    return out;
}

/* ──────────────────────────── drill ──────────────────────────── */

/** Collect plated drills: through-hole pads, vias, and plated Hole-layer circles. */
function _collectPlatedDrills(placements, vias, circles = []) {
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
    for (const circle of circles) {
        if (circle?.layer !== 'hole' || !circle.plated) continue;
        const dia = 2 * (Number(circle.radius) || 0);
        if (dia > 0) out.push({ dia, x: circle.x, y: circle.y });
    }
    return out;
}

/** Collect non-plated drills: Hole-layer circles and footprint mounting holes. */
function _collectNonPlatedDrills(circles = [], placements = new Map()) {
    const out = [];
    // Hole-layer circles drill through the board unless explicitly plated.
    for (const c of circles) {
        if (!c || c.layer !== 'hole' || c.plated) continue;
        const dia = 2 * (Number(c.radius) || 0);
        if (dia > 0) out.push({ dia, x: c.x, y: c.y });
    }
    // Footprint mechanical / mounting holes (posed 'hole'-layer silk circles),
    // resolved alongside pad drills by the shared resolver.
    for (const drill of resolvePlacementDrills(placements)) {
        if (drill.plated) continue;
        out.push({ dia: drill.dia, x: drill.x, y: drill.y });
    }
    return out;
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
