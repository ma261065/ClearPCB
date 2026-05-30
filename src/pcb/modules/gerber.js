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
 *   - drill.drl         (Excellon plated-through holes)
 *
 * Coordinate system: ClearPCB stores PCB geometry in SVG-Y-down
 * millimetres (positive Y points down on screen). Gerber files use
 * Y-up, so this exporter negates every Y value at emission time and
 * shifts the clip rectangle into the input (Y-down) space.
 *
 * The output uses fixed-point 4.6 (four integer digits, six fractional)
 * which is the modern standard for sub-micron precision in mm.
 */

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
    return new Map([
        ['board.gtl', _buildCopper(placements, tracks, vias, 'top-copper', clipBounds)],
        ['board.gbl', _buildCopper(placements, tracks, vias, 'bottom-copper', clipBounds)],
        ['board.gts', _buildMask(placements, vias, 'top', clipBounds)],
        ['board.gbs', _buildMask(placements, vias, 'bottom', clipBounds)],
        ['board.gtp', _buildPaste(placements, 'top', clipBounds)],
        ['board.gbp', _buildPaste(placements, 'bottom', clipBounds)],
        ['board.gto', _buildSilk(placements, clipBounds)],
        ['board.gko', _buildOutline(outlineBounds)],
        ['board.drl', _buildDrill(placements, vias, clipBounds, tracks)],
    ]);
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

function _buildCopper(placements, tracks, vias, layerId, bounds) {
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
            const pos = pl.pads.get(off.number);
            if (!pos) continue;
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
        const key = apKey('C', t.width || 0.2);
        const d = getAp(key);
        for (const [eid, e] of t.edges) {
            const edgeLayer = t.edgeLayers?.get(eid) || t.layer;
            if (edgeLayer !== layerId) continue;
            const a = t.nodes.get(e.from);
            const b = t.nodes.get(e.to);
            if (!a || !b) continue;
            const clipped = _clipSegment(a.x, a.y, b.x, b.y, bounds);
            if (!clipped) continue;
            ops.push({ d, op: `X${_fmt(clipped[0])}Y${_fmtY(clipped[1])}D02*` });
            ops.push({ d, op: `X${_fmt(clipped[2])}Y${_fmtY(clipped[3])}D01*` });
        }
    }

    // Layer-change nodes are not flashed here. Vias are exclusively
    // standalone `Via` objects; tracks contribute only segment copper.

    // Emit file.
    let out = `G04 ClearPCB ${isTop ? 'Top' : 'Bottom'} Copper*\n` + FORMAT;
    out += '%LPD*%\n';
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
            const pos = pl.pads.get(off.number);
            if (!pos) continue;
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
        title: side === 'top' ? 'Top Soldermask' : 'Bottom Soldermask',
    });
}

/* ──────────────────────────── solder paste ──────────────────────────── */

function _buildPaste(placements, side, bounds) {
    // Paste stencil only opens for SMD pads. Through-hole pads and vias
    // get no paste (they're soldered after reflow, or tented).
    return _buildPadLayer(placements, [], side, bounds, {
        expansion: 0,
        includeThruHole: false,
        includeSmd: true,
        includeVias: false,
        title: side === 'top' ? 'Top Paste' : 'Bottom Paste',
    });
}

/* ──────────────────────────── silkscreen ──────────────────────────── */

function _buildSilk(placements, bounds) {
    // Minimal silk: a small reference designator near each component
    // origin. Drawn as a stroked polyline using a thin circular aperture.
    let out = 'G04 ClearPCB Top Silk*\n' + FORMAT + '%LPD*%\n';
    out += '%ADD10C,0.15*%\nD10*\n';
    for (const [, pl] of placements) {
        const ref = pl.reference;
        if (!ref) continue;
        if (!_inBoard(pl.x, pl.y, bounds)) continue;
        // Stroke each glyph as a 1x1.4mm rect outline near the component
        // centre — simplistic but produces visible text on the gerber.
        const strokes = _strokeText(ref, pl.x, pl.y + 2, 1.0);
        for (const seg of strokes) {
            // Clip each polyline segment against the board.
            for (let i = 1; i < seg.length; i++) {
                const a = seg[i - 1], b = seg[i];
                const clipped = _clipSegment(a.x, a.y, b.x, b.y, bounds);
                if (!clipped) continue;
                out += `X${_fmt(clipped[0])}Y${_fmtY(clipped[1])}D02*\n`;
                out += `X${_fmt(clipped[2])}Y${_fmtY(clipped[3])}D01*\n`;
            }
        }
    }
    out += 'M02*\n';
    return out;
}

/**
 * Very simple stroked glyph generator — turns a string into a list of
 * point-polylines suitable for a Gerber pen plotter. Each character is
 * rendered in a `size`-mm cell using a minimal 7-segment-ish font.
 * Falls back to a filled rectangle outline for any glyph not in the
 * font table.
 */
function _strokeText(text, x, y, size) {
    const segs = [];
    const advance = size * 0.8;
    let cx = x;
    for (const ch of text.toUpperCase()) {
        const glyph = _GLYPHS[ch];
        if (glyph) {
            for (const stroke of glyph) {
                segs.push(stroke.map(([gx, gy]) => ({
                    x: cx + gx * size,
                    y: y + gy * size,
                })));
            }
        } else {
            // Box outline as fallback.
            segs.push([
                { x: cx, y },
                { x: cx + advance, y },
                { x: cx + advance, y: y + size },
                { x: cx, y: y + size },
                { x: cx, y },
            ]);
        }
        cx += advance + size * 0.2;
    }
    return segs;
}

/** Minimal stroke font: each glyph is an array of polylines in a unit cell. */
const _GLYPHS = {
    '0': [[[0, 0], [0.6, 0], [0.6, 1], [0, 1], [0, 0]]],
    '1': [[[0.3, 0], [0.3, 1]]],
    '2': [[[0, 1], [0.6, 1], [0.6, 0.5], [0, 0.5], [0, 0], [0.6, 0]]],
    '3': [[[0, 1], [0.6, 1], [0.6, 0], [0, 0]], [[0, 0.5], [0.6, 0.5]]],
    '4': [[[0, 1], [0, 0.5], [0.6, 0.5]], [[0.6, 1], [0.6, 0]]],
    '5': [[[0.6, 1], [0, 1], [0, 0.5], [0.6, 0.5], [0.6, 0], [0, 0]]],
    '6': [[[0.6, 1], [0, 1], [0, 0], [0.6, 0], [0.6, 0.5], [0, 0.5]]],
    '7': [[[0, 1], [0.6, 1], [0.6, 0]]],
    '8': [[[0, 0], [0.6, 0], [0.6, 1], [0, 1], [0, 0]], [[0, 0.5], [0.6, 0.5]]],
    '9': [[[0.6, 0], [0.6, 1], [0, 1], [0, 0.5], [0.6, 0.5]]],
    'A': [[[0, 0], [0, 1], [0.6, 1], [0.6, 0]], [[0, 0.5], [0.6, 0.5]]],
    'B': [[[0, 0], [0, 1], [0.5, 1], [0.6, 0.75], [0.5, 0.5], [0, 0.5], [0.5, 0.5], [0.6, 0.25], [0.5, 0], [0, 0]]],
    'C': [[[0.6, 1], [0, 1], [0, 0], [0.6, 0]]],
    'D': [[[0, 0], [0, 1], [0.4, 1], [0.6, 0.8], [0.6, 0.2], [0.4, 0], [0, 0]]],
    'E': [[[0.6, 1], [0, 1], [0, 0], [0.6, 0]], [[0, 0.5], [0.5, 0.5]]],
    'F': [[[0, 0], [0, 1], [0.6, 1]], [[0, 0.5], [0.5, 0.5]]],
    'G': [[[0.6, 1], [0, 1], [0, 0], [0.6, 0], [0.6, 0.5], [0.3, 0.5]]],
    'H': [[[0, 0], [0, 1]], [[0.6, 0], [0.6, 1]], [[0, 0.5], [0.6, 0.5]]],
    'I': [[[0.3, 0], [0.3, 1]]],
    'J': [[[0.6, 1], [0.6, 0.2], [0.4, 0], [0.2, 0], [0, 0.2]]],
    'K': [[[0, 0], [0, 1]], [[0.6, 1], [0, 0.5], [0.6, 0]]],
    'L': [[[0, 1], [0, 0], [0.6, 0]]],
    'M': [[[0, 0], [0, 1], [0.3, 0.5], [0.6, 1], [0.6, 0]]],
    'N': [[[0, 0], [0, 1], [0.6, 0], [0.6, 1]]],
    'O': [[[0, 0], [0.6, 0], [0.6, 1], [0, 1], [0, 0]]],
    'P': [[[0, 0], [0, 1], [0.6, 1], [0.6, 0.5], [0, 0.5]]],
    'Q': [[[0, 0], [0.6, 0], [0.6, 1], [0, 1], [0, 0]], [[0.4, 0.3], [0.7, 0]]],
    'R': [[[0, 0], [0, 1], [0.6, 1], [0.6, 0.5], [0, 0.5]], [[0.3, 0.5], [0.6, 0]]],
    'S': [[[0.6, 1], [0, 1], [0, 0.5], [0.6, 0.5], [0.6, 0], [0, 0]]],
    'T': [[[0, 1], [0.6, 1]], [[0.3, 1], [0.3, 0]]],
    'U': [[[0, 1], [0, 0], [0.6, 0], [0.6, 1]]],
    'V': [[[0, 1], [0.3, 0], [0.6, 1]]],
    'W': [[[0, 1], [0.15, 0], [0.3, 0.5], [0.45, 0], [0.6, 1]]],
    'X': [[[0, 0], [0.6, 1]], [[0, 1], [0.6, 0]]],
    'Y': [[[0, 1], [0.3, 0.5], [0.6, 1]], [[0.3, 0.5], [0.3, 0]]],
    'Z': [[[0, 1], [0.6, 1], [0, 0], [0.6, 0]]],
};

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

function _buildDrill(placements, vias, bounds, tracks = []) {
    /** @type {Map<number, Array<{x:number,y:number}>>} drill mm → positions */
    const tools = new Map();
    const addHole = (dia, x, y) => {
        if (!dia || dia <= 0) return;
        if (!_inBoard(x, y, bounds)) return;
        const key = Math.round(dia * 1000) / 1000;
        let list = tools.get(key);
        if (!list) { list = []; tools.set(key, list); }
        list.push({ x, y });
    };

    // Through-hole pads — any pad with a positive drill diameter.
    for (const [, pl] of placements) {
        if (!pl?.padOffsets) continue;
        for (const off of pl.padOffsets) {
            if (!(off.drill > 0)) continue;
            const pos = pl.pads.get(off.number);
            if (!pos) continue;
            addHole(off.drill, pos.x, pos.y);
        }
    }
    // Standalone vias.
    for (const v of vias) addHole(v.drill, v.x, v.y);
    // Layer-change nodes do not drill — vias are explicit Via objects.

    // Header. Use decimal coordinates (universally supported); declare
    // METRIC with leading-zero suppression as a sensible default.
    let out = 'M48\n; ClearPCB Excellon drill\nFMAT,2\nMETRIC,LZ\n';
    const sorted = [...tools.keys()].sort((a, b) => a - b);
    sorted.forEach((dia, i) => {
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
