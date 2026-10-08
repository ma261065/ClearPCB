/**
 * Board, copper and part dimensions for the 3D view, and the layer colours and
 * appearance settings (solder-mask tint, metal hues) its Appearance panel edits.
 * Split from board3d.js; the viewer itself is board3d.js.
 */
import { getBoard2DLayerStyles, setBoard2DLayerStyles } from './board2d.js';

/** Finished board thickness in millimetres (standard 1.6 mm). */
export const BOARD_THICKNESS = 1.6;
export const FILLED_CIRCLE_SEGMENTS = 48;

/** Default body height (mm) for fallback component boxes with no STEP model. */
export const FALLBACK_HEIGHT = 1.2;

/** Colours (0–255 RGB triplets). */
// 3D lights these (ambient + directional + glint, ~1.6× gain on the up-facing
// top), so the BASE greens are set darker than the flat 2D fill they should
// match: lit base ≈ board2d's solderMaskLive / copperUnderMaskLive tones.
export const COLOR_RAW_BOARD = [64, 44, 28];    // bare FR4 substrate (board edges, no mask)
const SOLDERMASK_BASE_RGB = [34, 214, 62];
export const COLOR_SOLDERMASK = [...SOLDERMASK_BASE_RGB]; // solder-mask coating tint (top/bottom faces only)
export const COLOR_FALLBACK = [70, 78, 90];   // generic part
export const COLOR_PAD = [201, 164, 74];      // gold
const COLOR_COPPER = [226, 156, 84];   // exposed copper tone
export const COLOR_COPPER_TOP = COLOR_COPPER;
export const COLOR_COPPER_BOTTOM = COLOR_COPPER;
export const COLOR_VIA = [184, 134, 11];          // gold plated barrel
const COLOR_HOLE = [12, 12, 16];           // dark drilled hole
export const COLOR_SILK = [228, 228, 228];        // white silkscreen

// Toggle solder-mask rendering on board faces.
export const SHOW_SOLDERMASK = true;

function _clampByte(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(255, Math.round(n)));
}

function _clampAlpha(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

function _clampUnit(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

function _clampHue(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(360, Math.round(n)));
}

function _rgbToHsv(r, g, b) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
        else if (max === gn) h = ((bn - rn) / d + 2) / 6;
        else h = ((rn - gn) / d + 4) / 6;
    }
    const s = max === 0 ? 0 : d / max;
    return { h: h * 360, s, v: max };
}

export function hsvToRgb(h, s, v) {
    const hh = (((h % 360) + 360) % 360) / 60;
    const c = v * s;
    const x = c * (1 - Math.abs((hh % 2) - 1));
    const m = v - c;
    let rp = 0, gp = 0, bp = 0;
    if (hh < 1) { rp = c; gp = x; bp = 0; }
    else if (hh < 2) { rp = x; gp = c; bp = 0; }
    else if (hh < 3) { rp = 0; gp = c; bp = x; }
    else if (hh < 4) { rp = 0; gp = x; bp = c; }
    else if (hh < 5) { rp = x; gp = 0; bp = c; }
    else { rp = c; gp = 0; bp = x; }
    return [
        Math.round((rp + m) * 255),
        Math.round((gp + m) * 255),
        Math.round((bp + m) * 255),
    ];
}

function _rgbToHsl(r, g, b) {
    let rn = r / 255;
    let gn = g / 255;
    let bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    switch (max) {
        case rn:
            h = (gn - bn) / d + (gn < bn ? 6 : 0);
            break;
        case gn:
            h = (bn - rn) / d + 2;
            break;
        default:
            h = (rn - gn) / d + 4;
            break;
    }
    return { h: (h / 6) * 360, s, l };
}

function _hslToRgb(h, s, l) {
    let hNorm = ((h % 360) + 360) % 360;
    hNorm /= 360;
    if (s === 0) {
        const v = Math.round(l * 255);
        return [v, v, v];
    }
    const hue2rgb = (p, q, t) => {
        let tt = t;
        if (tt < 0) tt += 1;
        if (tt > 1) tt -= 1;
        if (tt < 1 / 6) return p + (q - p) * 6 * tt;
        if (tt < 1 / 2) return q;
        if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
        return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const r = hue2rgb(p, q, hNorm + 1 / 3);
    const g = hue2rgb(p, q, hNorm);
    const b = hue2rgb(p, q, hNorm - 1 / 3);
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

const _layerStyleInit = getBoard2DLayerStyles();
export const LAYER_STYLE = {
    board: { ..._layerStyleInit.board },
    soldermask: _layerStyleInit.soldermask
        ? { ..._layerStyleInit.soldermask }
        : (() => {
            const hsv = _rgbToHsv(SOLDERMASK_BASE_RGB[0], SOLDERMASK_BASE_RGB[1], SOLDERMASK_BASE_RGB[2]);
            return { h: hsv.h, s: hsv.s, v: hsv.v, o: 0.6 };
        })(),
    tracks: { ..._layerStyleInit.tracks },
    vias: { ..._layerStyleInit.vias },
    silkscreen: { ..._layerStyleInit.silkscreen },
    pads: { ..._layerStyleInit.pads },
};

function getSolderMaskAppearance() {
    const [, g] = hsvToRgb(LAYER_STYLE.soldermask.h, LAYER_STYLE.soldermask.s, LAYER_STYLE.soldermask.v);
    return {
        greenness: g,
        opacity: LAYER_STYLE.soldermask.o,
    };
}

/** @param {{greenness?: number, opacity?: number}} [appearance] */
function setSolderMaskAppearance({ greenness, opacity } = {}) {
    const patch = {};
    if (greenness !== undefined) {
        const [curR, curG, curB] = hsvToRgb(
            LAYER_STYLE.soldermask.h,
            LAYER_STYLE.soldermask.s,
            LAYER_STYLE.soldermask.v,
        );
        const g = _clampByte(greenness, curG);
        const t = SOLDERMASK_BASE_RGB[1] > 0 ? g / SOLDERMASK_BASE_RGB[1] : 0;
        const r = _clampByte(SOLDERMASK_BASE_RGB[0] * t, curR);
        const b = _clampByte(SOLDERMASK_BASE_RGB[2] * t, curB);
        const hsv = _rgbToHsv(r, g, b);
        patch.h = hsv.h;
        patch.s = hsv.s;
        patch.v = hsv.v;
    }
    if (opacity !== undefined) patch.o = _clampAlpha(opacity, LAYER_STYLE.soldermask.o);
    if (Object.keys(patch).length) setLayerStylesAppearance({ soldermask: patch });
    return getSolderMaskAppearance();
}

function _applyLayerColors() {
    const [br, bg, bb] = hsvToRgb(LAYER_STYLE.board.h, LAYER_STYLE.board.s, LAYER_STYLE.board.v);
    COLOR_RAW_BOARD[0] = br;
    COLOR_RAW_BOARD[1] = bg;
    COLOR_RAW_BOARD[2] = bb;
    const [mr, mg, mb] = hsvToRgb(LAYER_STYLE.soldermask.h, LAYER_STYLE.soldermask.s, LAYER_STYLE.soldermask.v);
    COLOR_SOLDERMASK[0] = mr;
    COLOR_SOLDERMASK[1] = mg;
    COLOR_SOLDERMASK[2] = mb;
    const [cr, cg, cb] = hsvToRgb(LAYER_STYLE.tracks.h, LAYER_STYLE.tracks.s, LAYER_STYLE.tracks.v);
    COLOR_COPPER[0] = cr;
    COLOR_COPPER[1] = cg;
    COLOR_COPPER[2] = cb;
    const [vr, vg, vb] = hsvToRgb(LAYER_STYLE.vias.h, LAYER_STYLE.vias.s, LAYER_STYLE.vias.v);
    COLOR_VIA[0] = vr;
    COLOR_VIA[1] = vg;
    COLOR_VIA[2] = vb;
    const [sr, sg, sb] = hsvToRgb(LAYER_STYLE.silkscreen.h, LAYER_STYLE.silkscreen.s, LAYER_STYLE.silkscreen.v);
    COLOR_SILK[0] = sr;
    COLOR_SILK[1] = sg;
    COLOR_SILK[2] = sb;
    const [pr, pg, pb] = hsvToRgb(LAYER_STYLE.pads.h, LAYER_STYLE.pads.s, LAYER_STYLE.pads.v);
    COLOR_PAD[0] = pr;
    COLOR_PAD[1] = pg;
    COLOR_PAD[2] = pb;
}

export function getLayerStylesAppearance() {
    return {
        board: { ...LAYER_STYLE.board },
        soldermask: { ...LAYER_STYLE.soldermask },
        tracks: { ...LAYER_STYLE.tracks },
        vias: { ...LAYER_STYLE.vias },
        silkscreen: { ...LAYER_STYLE.silkscreen },
        pads: { ...LAYER_STYLE.pads },
    };
}

export function setLayerStylesAppearance(patch = {}) {
    for (const key of ['board', 'soldermask', 'tracks', 'vias', 'silkscreen', 'pads']) {
        const next = patch[key];
        if (!next) continue;
        const cur = LAYER_STYLE[key];
        if (next.h !== undefined) cur.h = _clampHue(next.h, cur.h);
        if (next.s !== undefined) cur.s = _clampUnit(next.s, cur.s);
        if (next.v !== undefined) cur.v = _clampUnit(next.v, cur.v);
        if (next.o !== undefined) cur.o = _clampAlpha(next.o, cur.o);
    }
    _applyLayerColors();
    setBoard2DLayerStyles(getLayerStylesAppearance());
    return getLayerStylesAppearance();
}

function getMetalAppearance() {
    return {
        copperHue: Math.round(LAYER_STYLE.tracks.h),
        padHue: Math.round(LAYER_STYLE.pads.h),
    };
}

/** @param {{copperHue?: number, padHue?: number}} [appearance] */
function setMetalAppearance({ copperHue, padHue } = {}) {
    setLayerStylesAppearance({
        tracks: copperHue !== undefined ? { h: copperHue } : undefined,
        pads: padHue !== undefined ? { h: padHue } : undefined,
    });
    return getMetalAppearance();
}

_applyLayerColors();

/** Surface heights (world Y, mm) for the thin layers on each board face. */
export const Y_TOP = BOARD_THICKNESS;             // top copper plane
export const Y_BOT = 0;                           // bottom copper plane
// All thin layers (copper, vias, pads, silk, text) sit EXACTLY on the board
// face — no world-space Y steps. Earlier builds floated each layer a few µm
// proud to dodge z-fighting, but those tiny steps shimmered at distance (the
// projected depth difference falls below depth-buffer precision and the
// coplanar layers flicker) and showed as visible "sides" on pads when zoomed.
// Instead the layers are kept perfectly coplanar and separated purely in the
// DEPTH BUFFER via per-layer polygonOffset (see makeDecalMaterial / the layer
// materials in ThreeScene): the bias is normalized-depth, slope-scaled and
// precision-aware, so it resolves coplanar layers deterministically at every
// camera distance and angle — no shimmer, no steps. Kept at 0 so the old
// `Y ± EPS` call sites collapse to the exact face plane.
export const COPPER_EPS = 0;                       // copper — coplanar with the face
export const PAD_EPS = 0;                          // pads — coplanar (depth bias beats copper)
export const SILK_EPS = 0;                         // silk — coplanar (depth bias beats pads)
export const PAD_BARREL_SEGMENTS = 16;
