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

const FORMAT = '%FSLAX46Y46*%\n%MOMM*%\n';
const SCALE = 1e6; // 4.6 fixed-point: multiply mm by 10^6

/**
 * Soldermask expansion per side (mm). 0.05 mm is the typical board-house
 * default — pads emerge with a 0.1 mm-larger opening so that solder
 * wicks to copper without ever touching the mask edge.
 */
const MASK_EXPANSION = 0.05;

/**
 * Whether to tent vias (no soldermask opening over a via). Tenting is
 * the modern default for hobbyist 2-layer boards: it stops dust /
 * shorts / accidental probing without paying the assembly cost of
 * leaving copper exposed.
 */
const TENT_VIAS = true;

/**
 * Build all gerber/drill files for the current board state.
 *
 * @param {object} opts
 * @param {Map<string, object>} opts.placements   componentId → placement
 * @param {Array<object>} opts.tracks             Track instances
 * @param {Array<object>} opts.vias               Via instances
 * @param {Array<object>} [opts.holes]            standalone NPTH Hole instances
 * @param {number} opts.boardWidth                mm
 * @param {number} opts.boardHeight               mm
 * @param {number} [opts.boardRadius=0]           corner radius, mm
 * @param {number} [opts.boardX=0]                bottom-left X of board, mm
 * @param {number} [opts.boardY=0]                bottom-left Y of board, mm
 * @returns {Map<string, string>} filename → file contents
 */
export function exportGerbers(opts) {
    const {
        placements, tracks = [], vias = [], holes = [],
        boardWidth, boardHeight, boardRadius = 0,
        boardX = 0, boardY = 0,
        texts = [], fills = [],
    } = opts;

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
        ['board.gtl', _buildCopper(placements, tracks, vias, 'top-copper', clipBounds, texts, fills)],
        ['board.gbl', _buildCopper(placements, tracks, vias, 'bottom-copper', clipBounds, texts, fills)],
        ['board.gts', _buildMask(placements, vias, 'top', clipBounds)],
        ['board.gbs', _buildMask(placements, vias, 'bottom', clipBounds)],
        ['board.gtp', _buildPaste(placements, 'top', clipBounds)],
        ['board.gbp', _buildPaste(placements, 'bottom', clipBounds)],
        ['board.gto', _buildSilk(placements, 'top', clipBounds, texts)],
        ['board.gbo', _buildSilk(placements, 'bottom', clipBounds, texts)],
        ['board.gko', _buildOutline(outlineBounds)],
        // Plated through-holes (pads, vias, plated standalone holes) and
        // non-plated holes go in separate Excellon files so fabs (JLCPCB,
        // etc.) can tell them apart — they key off the -PTH / -NPTH suffix.
        ['board-PTH.drl', _buildDrill(_collectPlatedDrills(placements, vias, holes), clipBounds)],
    ]);
    // Only emit the NPTH file when there are non-plated holes — an empty
    // drill file trips up some fab pre-checks.
    const npth = _collectNonPlatedDrills(holes);
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

function _buildCopper(placements, tracks, vias, layerId, bounds, texts = [], fills = []) {
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
    for (const [, pl] of placements) {
        if (!pl?.padOffsets) continue;
        for (const off of pl.padOffsets) {
            const padLayer = off.layer || 'top';
            if (padLayer !== 'both' && padLayer !== padSide) continue;
            // Flash at this offset's OWN position. A footprint may have
            // several pad offsets sharing one pad number (e.g. a thermal
            // pad subdivided into a matrix), so the number-keyed pad map
            // (one entry per number) cannot be used for copper placement.
            const pos = { x: pl.x + off.dx, y: pl.y + off.dy };
            if (!_inBoard(pos.x, pos.y, bounds)) continue;
            const w = off.width || 1.2;
            const h = off.height || 1.2;
            const shape = off.shape || 'rect';
            let key, def;
            if (shape === 'ellipse') {
                key = apKey('C', Math.max(w, h));
            } else if (shape === 'oval') {
                key = apKey('O', w, h);
            } else {
                key = apKey('R', w, h);
            }
            const d = getAp(key);
            ops.push({ d, op: `X${_fmt(pos.x)}Y${_fmtY(pos.y)}D03*` });
        }
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
        const segs = _textSegments(t);
        for (const [a, b] of segs) {
            const clipped = _clipSegment(a.x, a.y, b.x, b.y, bounds);
            if (!clipped) continue;
            ops.push({ d, op: `X${_fmt(clipped[0])}Y${_fmtY(clipped[1])}D02*` });
            ops.push({ d, op: `X${_fmt(clipped[2])}Y${_fmtY(clipped[3])}D01*` });
        }
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

    for (const [, pl] of placements) {
        if (!pl?.padOffsets) continue;
        for (const off of pl.padOffsets) {
            const padLayer = off.layer || 'top';
            if (padLayer !== 'both' && padLayer !== side) continue;
            const isThru = (off.drill || 0) > 0;
            if (isThru && !includeThruHole) continue;
            if (!isThru && !includeSmd) continue;
            // A copper pad only contributes to the paste/mask layer it
            // actually lists. e.g. a QFN exposed pad is copper+mask but NOT
            // paste (it is windowpaned by separate apertures) — full-area
            // paste there would bridge solder.
            if (respectPaste && off.paste === false) continue;
            if (respectMask && off.mask === false) continue;
            // Flash at the offset's own position (see copper loop note):
            // duplicate-numbered offsets must each draw at their own dx/dy.
            const pos = { x: pl.x + off.dx, y: pl.y + off.dy };
            if (!_inBoard(pos.x, pos.y, bounds)) continue;
            const w = (off.width || 1.2) + 2 * expansion;
            const h = (off.height || 1.2) + 2 * expansion;
            if (w <= 0 || h <= 0) continue;
            const shape = off.shape || 'rect';
            let key;
            if (shape === 'ellipse') {
                key = apKey('C', Math.max(w, h));
            } else if (shape === 'oval') {
                key = apKey('O', w, h);
            } else {
                key = apKey('R', w, h);
            }
            const d = getAp(key);
            ops.push({ d, op: `X${_fmt(pos.x)}Y${_fmtY(pos.y)}D03*` });
        }
    }

    // Standalone paste apertures (no copper) — windowpane stencil openings.
    if (pasteApertures) {
        for (const [, pl] of placements) {
            if (!pl?.pasteOffsets) continue;
            for (const off of pl.pasteOffsets) {
                if ((off.side || 'top') !== side) continue;
                const pos = { x: pl.x + off.dx, y: pl.y + off.dy };
                if (!_inBoard(pos.x, pos.y, bounds)) continue;
                const w = (off.width || 1.2) + 2 * expansion;
                const h = (off.height || 1.2) + 2 * expansion;
                if (w <= 0 || h <= 0) continue;
                const shape = off.shape || 'rect';
                let key;
                if (shape === 'ellipse') {
                    key = apKey('C', Math.max(w, h));
                } else if (shape === 'oval') {
                    key = apKey('O', w, h);
                } else {
                    key = apKey('R', w, h);
                }
                const d = getAp(key);
                ops.push({ d, op: `X${_fmt(pos.x)}Y${_fmtY(pos.y)}D03*` });
            }
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

    let out = `G04 ClearPCB ${title}*\n` + FORMAT + '%LPD*%\n';
    for (const [key, code] of apertures) {
        out += `%ADD${code}${_apertureBody(key)}*%\n`;
    }
    let currentD = -1;
    for (const { d, op } of ops) {
        if (d !== currentD) { out += `D${d}*\n`; currentD = d; }
        out += op + '\n';
    }
    out += 'M02*\n';
    return out;
}

/* ──────────────────────────── soldermask ──────────────────────────── */

function _buildMask(placements, vias, side, bounds) {
    return _buildPadLayer(placements, vias, side, bounds, {
        expansion: MASK_EXPANSION,
        includeThruHole: true,
        includeSmd: true,
        includeVias: !TENT_VIAS,
        respectMask: true,
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

function _buildSilk(placements, side, bounds, texts = []) {
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
        // ── Component silk shapes (offsets are in component-local mm).
        for (const s of (pl.silks || [])) {
            if (s.layer !== wantLayer) continue;
            const sw = Number.isFinite(s.strokeWidth) && s.strokeWidth > 0 ? s.strokeWidth : 0.12;
            const head = useAperture(sw);
            if (head) body += head;
            if (s.type === 'line') {
                body += emitSeg(
                    { x: pl.x + s.x1, y: pl.y + s.y1 },
                    { x: pl.x + s.x2, y: pl.y + s.y2 },
                );
            } else if (s.type === 'circle') {
                // Approximate the circle with a 32-segment polyline.
                const N = 32;
                const cx = pl.x + s.cx, cy = pl.y + s.cy;
                let prev = { x: cx + s.r, y: cy };
                for (let i = 1; i <= N; i++) {
                    const t = (i / N) * Math.PI * 2;
                    const next = { x: cx + s.r * Math.cos(t), y: cy + s.r * Math.sin(t) };
                    body += emitSeg(prev, next);
                    prev = next;
                }
            } else if (s.type === 'path') {
                // Flatten the SVG path into polyline segments and emit.
                const polys = _flattenPath(s.d);
                for (const poly of polys) {
                    for (let i = 1; i < poly.length; i++) {
                        body += emitSeg(
                            { x: pl.x + poly[i - 1].x, y: pl.y + poly[i - 1].y },
                            { x: pl.x + poly[i].x,     y: pl.y + poly[i].y },
                        );
                    }
                }
            }
        }

        // ── Reference designator (top side only).
        if (side !== 'top') continue;
        const ref = pl.reference;
        if (!ref) continue;
        if (!_inBoard(pl.x, pl.y, bounds)) continue;
        const head = useAperture(0.15);
        if (head) body += head;
        // Match editor layout: centred horizontally on the outline, sitting
        // just above its top edge. `bounds` here is the component's local
        // courtyard/outline rect; fall back to the placement origin.
        const size = 0.9;
        const ob = pl.bounds;
        const labelW = measureText(ref, size);
        const tx = ob ? pl.x + ob.x + ob.width / 2 - labelW / 2
                      : pl.x - labelW / 2;
        const ty = ob ? pl.y + ob.y - 0.8 : pl.y - 2;
        const strokes = stringToPolylines(ref, tx, ty, size, false);
        for (const seg of strokes) {
            for (let i = 1; i < seg.length; i++) {
                body += emitSeg(seg[i - 1], seg[i]);
            }
        }
    }

    // Free-standing text annotations on this silk side.
    for (const t of texts) {
        if (t.layer !== wantLayer) continue;
        const sw = Number.isFinite(t.strokeWidth) && t.strokeWidth > 0 ? t.strokeWidth : 0.15;
        const head = useAperture(sw);
        if (head) body += head;
        for (const [a, b] of _textSegments(t)) {
            body += emitSeg(a, b);
        }
    }

    out += body + 'M02*\n';
    return out;
}

/**
 * Convert a free-standing PCB text into world-space line segments,
 * applying its rotation about the anchor (x,y). Rotation matches the
 * editor: positive degrees = CCW in SVG-Y-down (i.e. CW in gerber Y-up).
 * @param {{content:string, x:number, y:number, size:number, rotation:number}} t
 * @returns {Array<[{x:number,y:number}, {x:number,y:number}]>}
 */
function _textSegments(t) {
    const polys = stringToPolylines(t.content, 0, 0, t.size, false);
    const rad = (t.rotation || 0) * Math.PI / 180;
    // Editor renders with transform rotate(-rotation) in SVG-Y-down so
    // positive degrees feel CCW visually. Replicate here.
    const cos = Math.cos(-rad), sin = Math.sin(-rad);
    const mirror = typeof t.layer === 'string' && t.layer.startsWith('bottom-') ? -1 : 1;
    const out = [];
    for (const poly of polys) {
        for (let i = 1; i < poly.length; i++) {
            const a = poly[i - 1], b = poly[i];
            const ax = a.x * mirror, bx = b.x * mirror;
            out.push([
                { x: t.x + ax * cos - a.y * sin, y: t.y + ax * sin + a.y * cos },
                { x: t.x + bx * cos - b.y * sin, y: t.y + bx * sin + b.y * cos },
            ]);
        }
    }
    return out;
}

/**
 * Flatten a simple SVG path data string into polylines in mm.
 * Supports M/m, L/l, H/h, V/v, Z/z plus bezier curves approximated
 * with 16 sub-segments. Unknown commands are skipped.
 * @param {string} d
 * @returns {Array<Array<{x:number,y:number}>>}
 */
function _flattenPath(d) {
    if (!d) return [];
    const tokens = d.match(/[a-zA-Z]|-?[0-9]*\.?[0-9]+(?:e[-+]?[0-9]+)?/g) || [];
    const polys = [];
    let poly = [];
    let x = 0, y = 0, sx = 0, sy = 0;
    let i = 0;
    const num = () => parseFloat(tokens[i++]);
    const push = () => { poly.push({ x, y }); };
    while (i < tokens.length) {
        const t = tokens[i++];
        if (/[a-zA-Z]/.test(t) === false) { i--; /* no command — treat as L */ }
        const cmd = /[a-zA-Z]/.test(t) ? t : 'L';
        const rel = cmd === cmd.toLowerCase() && cmd !== 'Z' && cmd !== 'z';
        const c = cmd.toUpperCase();
        if (c === 'M') {
            if (poly.length) { polys.push(poly); poly = []; }
            const nx = num(), ny = num();
            x = rel ? x + nx : nx; y = rel ? y + ny : ny;
            sx = x; sy = y;
            push();
            // Subsequent pairs after M are implicit L.
            while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) {
                const lx = num(), ly = num();
                x = rel ? x + lx : lx; y = rel ? y + ly : ly;
                push();
            }
        } else if (c === 'L') {
            while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) {
                const lx = num(), ly = num();
                x = rel ? x + lx : lx; y = rel ? y + ly : ly;
                push();
            }
        } else if (c === 'H') {
            while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) {
                const lx = num(); x = rel ? x + lx : lx; push();
            }
        } else if (c === 'V') {
            while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) {
                const ly = num(); y = rel ? y + ly : ly; push();
            }
        } else if (c === 'Z') {
            x = sx; y = sy; push();
            polys.push(poly); poly = [];
        } else if (c === 'C') {
            while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) {
                const x1 = (rel ? x : 0) + num(), y1 = (rel ? y : 0) + num();
                const x2 = (rel ? x : 0) + num(), y2 = (rel ? y : 0) + num();
                const nx = (rel ? x : 0) + num(), ny = (rel ? y : 0) + num();
                _flattenBezier(poly, x, y, x1, y1, x2, y2, nx, ny, 16);
                x = nx; y = ny;
            }
        } else if (c === 'Q') {
            while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) {
                const x1 = (rel ? x : 0) + num(), y1 = (rel ? y : 0) + num();
                const nx = (rel ? x : 0) + num(), ny = (rel ? y : 0) + num();
                // Quadratic -> cubic.
                const cx1 = x + 2/3 * (x1 - x), cy1 = y + 2/3 * (y1 - y);
                const cx2 = nx + 2/3 * (x1 - nx), cy2 = ny + 2/3 * (y1 - ny);
                _flattenBezier(poly, x, y, cx1, cy1, cx2, cy2, nx, ny, 16);
                x = nx; y = ny;
            }
        } else {
            // Unsupported (A, S, T): skip its numeric args conservatively.
            while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) i++;
        }
    }
    if (poly.length) polys.push(poly);
    return polys;
}

function _flattenBezier(poly, x0, y0, x1, y1, x2, y2, x3, y3, steps) {
    for (let s = 1; s <= steps; s++) {
        const t = s / steps, u = 1 - t;
        const bx = u*u*u*x0 + 3*u*u*t*x1 + 3*u*t*t*x2 + t*t*t*x3;
        const by = u*u*u*y0 + 3*u*u*t*y1 + 3*u*t*t*y2 + t*t*t*y3;
        poly.push({ x: bx, y: by });
    }
}


/* ──────────────────────────── board outline ──────────────────────────── */

function _buildOutline(b) {
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
    out += 'M02*\n';
    return out;
}

/* ──────────────────────────── drill ──────────────────────────── */

/** Collect plated drills: through-hole pads, vias, and plated holes. */
function _collectPlatedDrills(placements, vias, holes) {
    const out = [];
    for (const [, pl] of placements) {
        if (!pl?.padOffsets) continue;
        for (const off of pl.padOffsets) {
            if (!(off.drill > 0)) continue;
            const pos = pl.pads.get(off.padId);
            if (!pos) continue;
            out.push({ dia: off.drill, x: pos.x, y: pos.y });
        }
    }
    for (const v of vias) {
        if (v.drill > 0) out.push({ dia: v.drill, x: v.x, y: v.y });
    }
    for (const h of holes) {
        if (h.plated && h.diameter > 0) out.push({ dia: h.diameter, x: h.x, y: h.y });
    }
    return out;
}

/** Collect non-plated drills: standalone mounting/tooling holes. */
function _collectNonPlatedDrills(holes) {
    const out = [];
    for (const h of holes) {
        if (!h.plated && h.diameter > 0) out.push({ dia: h.diameter, x: h.x, y: h.y });
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
        const key = Math.round(d.dia * 1000) / 1000;
        let list = tools.get(key);
        if (!list) { list = []; tools.set(key, list); }
        list.push({ x: d.x, y: d.y });
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
            out += `X${h.x.toFixed(3)}Y${(-h.y).toFixed(3)}\n`;
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
