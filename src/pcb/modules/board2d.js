/**
 * Flat 2D board preview, rendered to a Canvas2D context.
 *
 * This is the lightweight companion to the 3D viewer (board3d.js): it draws the
 * board exactly the way the Gerber exporter (gerber.js) builds its layers —
 * copper as stroked tracks plus pad/via flashes, silkscreen as stroked
 * lines/circles/paths and reference designators — but straight to screen
 * instead of emitting RS-274X. No WebGL, no component models: it just shows the
 * fabricated board for one side.
 *
 * Coordinates: ClearPCB stores PCB geometry in SVG-Y-down millimetres, the same
 * space the editor uses, so this renderer draws in that space directly. The
 * "bottom" side is mirrored left↔right (a board flipped about its vertical
 * axis), which also mirrors bottom silk so it reads correctly.
 */

import { stringToPolylines, measureText } from './stroke-font.js';
import {
    placementPose as _placementPose,
    resolvePlacementDrills,
    resolvePadFlashes,
    resolveSilk,
} from './board-geometry.js';

// Palette mirrors the 3D viewer (board3d.js) so the two previews match.
const COL = {
    bg: 'rgb(74,76,79)',          // panel grey (3D clear colour)
    rawBoard: 'rgb(64,44,28)',    // bare FR4 substrate (board edge + document cutouts)
    solderMask: '',               // solder-mask coating on board faces
    copper: '',                   // exposed copper tone
    pad: '',                      // gold
    via: '',                      // gold barrel
    silk: '',                     // white silkscreen
};

const SOLDERMASK_BASE_RGB = { r: 34, g: 214, b: 62 };
const LAYER_STYLE = {
    board: _makeLayerStyleHSV(32, 52, 42, 255),
    soldermask: _makeLayerStyleHSV(138, 81, 45, 120),
    tracks: _makeLayerStyleHSV(45, 78, 84, 255),
    vias: _makeLayerStyleHSV(43, 94, 72, 255),
    silkscreen: _makeLayerStyleHSV(0, 0, 100, 255),
    pads: _makeLayerStyleHSV(45, 78, 84, 255),
};
// Toggle solder-mask rendering on board faces.
const SHOW_SOLDERMASK = true;

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
    const v = max;
    return { h: h * 360, s, v };
}

function _hsvToRgb(h, s, v) {
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

function _makeLayerStyle(r, g, b, o) {
    const hsv = _rgbToHsv(r, g, b);
    return { h: hsv.h, s: hsv.s, v: hsv.v, o };
}

// HSV in the panel-slider units (H 0-359, S/V 0-100) plus alpha as a byte
// (0-255). Stored normalised: h degrees, s/v/o in 0-1.
function _makeLayerStyleHSV(h, s, v, oByte) {
    return { h, s: s / 100, v: v / 100, o: oByte / 255 };
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

function _applyLayerColors() {
    const [br, bg, bb] = _hsvToRgb(LAYER_STYLE.board.h, LAYER_STYLE.board.s, LAYER_STYLE.board.v);
    COL.rawBoard = `rgb(${br},${bg},${bb})`;
    const [mr, mg, mb] = _hsvToRgb(LAYER_STYLE.soldermask.h, LAYER_STYLE.soldermask.s, LAYER_STYLE.soldermask.v);
    COL.solderMask = `rgb(${mr},${mg},${mb})`;
    const [tr, tg, tb] = _hsvToRgb(LAYER_STYLE.tracks.h, LAYER_STYLE.tracks.s, LAYER_STYLE.tracks.v);
    COL.copper = `rgb(${tr},${tg},${tb})`;
    const [vr, vg, vb] = _hsvToRgb(LAYER_STYLE.vias.h, LAYER_STYLE.vias.s, LAYER_STYLE.vias.v);
    COL.via = `rgb(${vr},${vg},${vb})`;
    const [sr, sg, sb] = _hsvToRgb(LAYER_STYLE.silkscreen.h, LAYER_STYLE.silkscreen.s, LAYER_STYLE.silkscreen.v);
    COL.silk = `rgb(${sr},${sg},${sb})`;
    const [pr, pg, pb] = _hsvToRgb(LAYER_STYLE.pads.h, LAYER_STYLE.pads.s, LAYER_STYLE.pads.v);
    COL.pad = `rgb(${pr},${pg},${pb})`;
}

function _setSolderMaskGreenness(greenness) {
    const [curR, curG, curB] = _hsvToRgb(
        LAYER_STYLE.soldermask.h,
        LAYER_STYLE.soldermask.s,
        LAYER_STYLE.soldermask.v,
    );
    const g = _clampByte(greenness, curG);
    const t = SOLDERMASK_BASE_RGB.g > 0 ? g / SOLDERMASK_BASE_RGB.g : 0;
    const r = _clampByte(SOLDERMASK_BASE_RGB.r * t, curR);
    const b = _clampByte(SOLDERMASK_BASE_RGB.b * t, curB);
    const hsv = _rgbToHsv(r, g, b);
    LAYER_STYLE.soldermask.h = hsv.h;
    LAYER_STYLE.soldermask.s = hsv.s;
    LAYER_STYLE.soldermask.v = hsv.v;
    _applyLayerColors();
}

export function getBoard2DSolderMaskAppearance() {
    const [, g] = _hsvToRgb(LAYER_STYLE.soldermask.h, LAYER_STYLE.soldermask.s, LAYER_STYLE.soldermask.v);
    return {
        greenness: g,
        opacity: LAYER_STYLE.soldermask.o,
    };
}

export function setBoard2DSolderMaskAppearance({ greenness, opacity } = {}) {
    if (greenness !== undefined) _setSolderMaskGreenness(greenness);
    if (opacity !== undefined) {
        LAYER_STYLE.soldermask.o = _clampAlpha(opacity, LAYER_STYLE.soldermask.o);
        _applyLayerColors();
    }
    return getBoard2DSolderMaskAppearance();
}

export function getBoard2DMetalAppearance() {
    return {
        copperHue: Math.round(LAYER_STYLE.tracks.h),
        padHue: Math.round(LAYER_STYLE.pads.h),
    };
}

export function setBoard2DMetalAppearance({ copperHue, padHue } = {}) {
    if (copperHue !== undefined) LAYER_STYLE.tracks.h = _clampHue(copperHue, LAYER_STYLE.tracks.h);
    if (padHue !== undefined) LAYER_STYLE.pads.h = _clampHue(padHue, LAYER_STYLE.pads.h);
    _applyLayerColors();
    return getBoard2DMetalAppearance();
}

export function getBoard2DLayerStyles() {
    return {
        board: { ...LAYER_STYLE.board },
        soldermask: { ...LAYER_STYLE.soldermask },
        tracks: { ...LAYER_STYLE.tracks },
        vias: { ...LAYER_STYLE.vias },
        silkscreen: { ...LAYER_STYLE.silkscreen },
        pads: { ...LAYER_STYLE.pads },
    };
}

export function setBoard2DLayerStyles(patch = {}) {
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
    return getBoard2DLayerStyles();
}

_applyLayerColors();

export class Board2D {
    /** @param {HTMLCanvasElement} canvas */
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
        /** @type {'top'|'bottom'} */
        this.side = 'top';
        /** Board + geometry inputs (same shape as exportGerbers). */
        this.data = null;
        // View transform (CSS px). screenX = tx + mirror*scale*worldX;
        // screenY = ty + scale*worldY.
        this.scale = 4;
        this.tx = 0;
        this.ty = 0;
        this._needFit = true;

        this._onPointerDown = this._onPointerDown.bind(this);
        this._onPointerMove = this._onPointerMove.bind(this);
        this._onPointerUp = this._onPointerUp.bind(this);
        this._onWheel = this._onWheel.bind(this);
        this._drag = null;
        canvas.addEventListener('pointerdown', this._onPointerDown);
        canvas.addEventListener('wheel', this._onWheel, { passive: false });
        // Re-render when the canvas CSS box changes (window resize, split-divider
        // drag, dock/pop-out). Without this the backing store keeps its old size
        // and the browser stretches the bitmap. A ResizeObserver fires whether
        // docked or torn off, and regardless of which document the canvas is in.
        // (The 3D scene's observer watches the WebGL canvas, which is hidden in
        // 2D mode, so it can't cover this.)
        try {
            this._ro = new ResizeObserver(() => {
                if (this.canvas.clientWidth && this.canvas.clientHeight) this.render();
            });
            this._ro.observe(canvas);
        } catch { this._ro = null; }
    }

    /** @param {object} data Same fields passed to exportGerbers. */
    setData(data) {
        this.data = data;
        this.render();
    }

    /** @param {'top'|'bottom'} side */
    setSide(side) {
        if (side === this.side) return;
        this.side = side;
        this._needFit = true;
        this.render();
    }

    /** @param {{greenness?:number, opacity?:number}} appearance */
    setSolderMaskAppearance(appearance = {}) {
        setBoard2DSolderMaskAppearance(appearance);
        this.render();
    }

    /** @param {{copperHue?:number, padHue?:number}} appearance */
    setMetalAppearance(appearance = {}) {
        setBoard2DMetalAppearance(appearance);
        this.render();
    }

    dispose() {
        try { this._ro?.disconnect(); } catch { /* ignore */ }
        this._ro = null;
        this.canvas.removeEventListener('pointerdown', this._onPointerDown);
        this.canvas.removeEventListener('wheel', this._onWheel);
        const w = this._dragWin;
        w?.removeEventListener('pointermove', this._onPointerMove);
        w?.removeEventListener('pointerup', this._onPointerUp);
    }

    /** Reframe so the whole board fits with a margin, then render. */
    fit() {
        this._needFit = true;
        this.render();
    }

    /** Recompute the backing-store size for the current CSS box, then render. */
    resize() {
        this.render();
    }

    get mirror() { return this.side === 'bottom' ? -1 : 1; }

    _boardRect() {
        const d = this.data || {};
        const h = d.boardHeight || 80;
        // exportGerbers' boardX/boardY are the Y-up bottom-left corner; the rest
        // of the geometry (pads/tracks/vias) is SVG-Y-down, where the board
        // spans y ∈ [-(boardY+h), -boardY]. Match that so everything lines up.
        return {
            x: d.boardX || 0,
            y: -((d.boardY || 0) + h),
            w: d.boardWidth || 100,
            h,
            r: d.boardRadius || 0,
        };
    }

    _fitNow(cssW, cssH) {
        const b = this._boardRect();
        const margin = 20;
        const sx = (cssW - margin * 2) / b.w;
        const sy = (cssH - margin * 2) / b.h;
        this.scale = Math.max(0.05, Math.min(sx, sy));
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        // Centre the board: screen centre maps to board centre (mirror-aware).
        this.tx = cssW / 2 - this.mirror * this.scale * cx;
        this.ty = cssH / 2 - this.scale * cy;
        this._needFit = false;
    }

    /**
     * Lower bound on `scale` (px/mm) for zoom-out: half the scale at which the
     * board just fits the viewport, so it can never shrink to a few pixels.
     */
    _minScale(cssW, cssH) {
        const b = this._boardRect();
        const margin = 20;
        const sx = (cssW - margin * 2) / b.w;
        const sy = (cssH - margin * 2) / b.h;
        const fit = Math.min(sx, sy);
        return Math.max(0.05, fit * 0.12);
    }

    /* ── interaction ──────────────────────────────────────────────────── */

    /** @param {PointerEvent} e */
    _onPointerDown(e) {
        this._drag = { x: e.clientX, y: e.clientY };
        this._dragWin = this.canvas.ownerDocument?.defaultView || window;
        this.canvas.setPointerCapture?.(e.pointerId);
        this._dragWin.addEventListener('pointermove', this._onPointerMove);
        this._dragWin.addEventListener('pointerup', this._onPointerUp);
    }

    /** @param {PointerEvent} e */
    _onPointerMove(e) {
        if (!this._drag) return;
        this.tx += e.clientX - this._drag.x;
        this.ty += e.clientY - this._drag.y;
        this._drag = { x: e.clientX, y: e.clientY };
        this.render();
    }

    /** @param {PointerEvent} e */
    _onPointerUp(e) {
        this._drag = null;
        this.canvas.releasePointerCapture?.(e.pointerId);
        const w = this._dragWin || window;
        w.removeEventListener('pointermove', this._onPointerMove);
        w.removeEventListener('pointerup', this._onPointerUp);
    }

    /** @param {WheelEvent} e */
    _onWheel(e) {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const factor = Math.pow(1.0015, -e.deltaY);
        // Floor the zoom-out so the board can't shrink to a few pixels: never
        // smaller than half the scale at which it just fits the viewport.
        const minScale = this._minScale(rect.width || 1, rect.height || 1);
        const next = Math.max(minScale, Math.min(2000, this.scale * factor));
        const k = next / this.scale;
        // Keep the world point under the cursor fixed while zooming.
        this.tx = px - k * (px - this.tx);
        this.ty = py - k * (py - this.ty);
        this.scale = next;
        this.render();
    }

    /* ── rendering ────────────────────────────────────────────────────── */

    render() {
        const cv = this.canvas;
        const cssW = cv.clientWidth || 1;
        const cssH = cv.clientHeight || 1;
        const baseDpr = (cv.ownerDocument?.defaultView || window).devicePixelRatio || 1;
        // During a high-res capture we supersample by rendering the backing
        // store larger than the CSS box; the extra detail is downfiltered by
        // the PNG encoder so edges, copper and silk read much sharper.
        const dpr = baseDpr * (this._exportScale || 1);
        if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
            cv.width = Math.round(cssW * dpr);
            cv.height = Math.round(cssH * dpr);
        }
        if (this._needFit) this._fitNow(cssW, cssH);

        const ctx = this.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = COL.bg;
        ctx.fillRect(0, 0, cv.width, cv.height);
        if (!this.data) return;

        // World→device: fold the device-pixel-ratio and the left↔right mirror
        // into the transform so all geometry can be drawn in millimetres.
        ctx.setTransform(this.mirror * this.scale * dpr, 0, 0, this.scale * dpr,
            this.tx * dpr, this.ty * dpr);

        this._drawBoard(ctx);
        // Clip everything else to the board outline so copper/holes/silk that
        // spill past the edge (e.g. pads on the rim) are cropped to the board.
        ctx.save();
        const b = this._boardRect();
        this._roundRectPath(ctx, b.x, b.y, b.w, b.h, b.r);
        ctx.clip();
        if (SHOW_SOLDERMASK) this._drawMaskOpenings(ctx);
        this._drawCopper(ctx);
        if (SHOW_SOLDERMASK) this._drawSolderMask(ctx);
        this._drawDocumentCutouts(ctx);
        this._drawSilk(ctx);
        // Holes paint last so a bore/cutout reads as open through every layer —
        // including silk, which is never printed over a drilled hole.
        this._drawHoles(ctx);
        ctx.restore();
    }

    /**
     * Export the current 2D view as a PNG, supersampled for higher quality to
     * match the 3D viewer's Save Image. Temporarily renders the backing store
     * at `scale`× the screen device pixels (capped so it can't exceed the
     * Canvas2D size limit), grabs the blob, then restores the live resolution.
     * @param {(blob: Blob|null) => void} cb
     * @param {number} [scale] Supersample factor over the screen DPR.
     */
    captureBlob(cb, scale = 3) {
        const cv = this.canvas;
        const cssW = cv.clientWidth || 1;
        const cssH = cv.clientHeight || 1;
        const baseDpr = (cv.ownerDocument?.defaultView || window).devicePixelRatio || 1;
        // Keep each dimension within the Canvas2D limit (~8192 in some browsers,
        // 16384 in most); pick the largest supersample that still fits.
        const MAX_DIM = 8192;
        const want = baseDpr * Math.max(1, scale);
        const fit = Math.min(want, MAX_DIM / cssW, MAX_DIM / cssH);
        this._exportScale = Math.max(1, fit / baseDpr);
        try {
            this.render();
            cv.toBlob(cb, 'image/png');
        } finally {
            // Restore the live backing-store resolution.
            this._exportScale = 0;
            this.render();
        }
    }

    /** Rounded board substrate with a bare-FR4 edge stroke. */
    _drawBoard(ctx) {
        const b = this._boardRect();
        this._roundRectPath(ctx, b.x, b.y, b.w, b.h, b.r);
        // Raw substrate base; solder mask is composited later as a topcoat.
        ctx.save();
        ctx.globalAlpha = LAYER_STYLE.board.o;
        ctx.fillStyle = COL.rawBoard;
        ctx.fill();
        ctx.lineWidth = Math.max(0.15, 4 / this.scale) * 0.05;
        ctx.strokeStyle = COL.rawBoard;
        ctx.lineWidth = 0.2;
        ctx.stroke();
        ctx.restore();
    }

    _roundRectPath(ctx, x, y, w, h, r) {
        const rad = Math.max(0, Math.min(r || 0, w / 2, h / 2));
        ctx.beginPath();
        if (rad <= 0) { ctx.rect(x, y, w, h); return; }
        ctx.moveTo(x + rad, y);
        ctx.lineTo(x + w - rad, y);
        ctx.arcTo(x + w, y, x + w, y + rad, rad);
        ctx.lineTo(x + w, y + h - rad);
        ctx.arcTo(x + w, y + h, x + w - rad, y + h, rad);
        ctx.lineTo(x + rad, y + h);
        ctx.arcTo(x, y + h, x, y + h - rad, rad);
        ctx.lineTo(x, y + rad);
        ctx.arcTo(x, y, x + rad, y, rad);
        ctx.closePath();
    }

    /** Solder-mask openings on the active side. Drawn under copper so copper
     * naturally shows only where it exists; elsewhere raw board is visible.
     * Supports legacy mask-layer circles (always filled openings) and copper-
     * layer circles using remove-solder-mask / remove-copper-mask modes. */
    _drawMaskOpenings(ctx) {
        const d = this.data;
        const normalizeCopperMode = (mode) => {
            const m = String(mode || 'add');
            if (m === 'remove-copper' || m === 'remove-solder-mask' || m === 'remove-copper-mask') return m;
            if (m === 'remove') return 'remove-copper-mask';
            if (m === 'remove-mask') return 'remove-solder-mask';
            return 'add';
        };
        ctx.fillStyle = COL.rawBoard;
        ctx.strokeStyle = COL.rawBoard;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const c of (d.circles || [])) {
            if (!c || !(c.radius > 0)) continue;
            const layer = String(c.layer || '');
            if (layer === 'top-mask' || layer === 'bottom-mask') {
                const side = layer === 'bottom-mask' ? 'bottom' : 'top';
                if (side !== this.side) continue;
                // Legacy mask-layer circles are area openings.
                ctx.beginPath();
                ctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
                ctx.fill();
                continue;
            }
            if (layer !== 'top-copper' && layer !== 'bottom-copper') continue;
            const side = layer === 'bottom-copper' ? 'bottom' : 'top';
            if (side !== this.side) continue;
            const mode = normalizeCopperMode(c.copperMode);
            if (mode !== 'remove-solder-mask' && mode !== 'remove-copper-mask') continue;
            const sw = Math.max(0.05, Number(c.lineWidth) || 0.2);
            if (c.filled) {
                ctx.beginPath();
                ctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.lineWidth = sw;
                ctx.beginPath();
                ctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
    }

    /** Solder-mask topcoat for the active side. Painted over copper, then
     * openings are punched out so exposed regions reveal copper/raw board. */
    _drawSolderMask(ctx) {
        const layerCanvas = (ctx.canvas.ownerDocument?.createElement('canvas')) || document.createElement('canvas');
        layerCanvas.width = ctx.canvas.width;
        layerCanvas.height = ctx.canvas.height;
        const mctx = layerCanvas.getContext('2d');
        if (!mctx) return;
        mctx.setTransform(ctx.getTransform());

        const b = this._boardRect();
        mctx.fillStyle = COL.solderMask;
        this._roundRectPath(mctx, b.x, b.y, b.w, b.h, b.r);
        mctx.save();
        mctx.globalAlpha = LAYER_STYLE.soldermask.o;
        mctx.fill();
        mctx.restore();

        mctx.globalCompositeOperation = 'destination-out';
        // _drawMaskOpenings emits opaque strokes/fills; color is irrelevant for
        // destination-out, only alpha matters.
        this._drawMaskOpenings(mctx);
        mctx.globalCompositeOperation = 'source-over';

        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(layerCanvas, 0, 0);
        ctx.restore();
    }

    /** Document-layer circles are board-exposure regions: they remove mask and
     * copper visually by painting raw board after copper, before drilled holes. */
    _drawDocumentCutouts(ctx) {
        const d = this.data;
        ctx.fillStyle = COL.rawBoard;
        ctx.strokeStyle = COL.rawBoard;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const c of (d.circles || [])) {
            if (!c || !(c.radius > 0)) continue;
            const layer = String(c.layer || '');
            if (layer !== 'document' && layer !== 'top-document' && layer !== 'bottom-document') continue;
            const side = layer === 'top-document' ? 'top'
                : layer === 'bottom-document' ? 'bottom'
                    : 'both';
            if (side !== 'both' && side !== this.side) continue;
            const sw = Math.max(0.05, Number(c.lineWidth) || 0.15);
            if (c.filled) {
                ctx.beginPath();
                ctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.lineWidth = sw;
                ctx.beginPath();
                ctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
    }

    /** Copper for the active side: tracks, pad flashes and via barrels. */
    _drawCopper(ctx) {
        const d = this.data;
        const top = this.side === 'top';
        const padSide = top ? 'top' : 'bottom';
        const copperLayer = top ? 'top-copper' : 'bottom-copper';
        const copperCol = COL.copper;

        const normalizeCopperMode = (mode) => {
            const m = String(mode || 'add');
            if (m === 'remove-copper' || m === 'remove-solder-mask' || m === 'remove-copper-mask') return m;
            // Backward compatibility for old saved circles.
            if (m === 'remove') return 'remove-copper-mask';
            if (m === 'remove-mask') return 'remove-solder-mask';
            return 'add';
        };

        // Compose copper into a dedicated transparent layer, subtracting
        // remove-mode circles with destination-out so underlying mask/board
        // naturally shows through where copper is removed.
        const layerCanvas = (ctx.canvas.ownerDocument?.createElement('canvas')) || document.createElement('canvas');
        layerCanvas.width = ctx.canvas.width;
        layerCanvas.height = ctx.canvas.height;
        const cctx = layerCanvas.getContext('2d');
        if (!cctx) return;
        cctx.setTransform(ctx.getTransform());
        cctx.globalAlpha = LAYER_STYLE.tracks.o;

        // Copper pours first (under tracks/pads), drawn from their computed
        // polygon geometry (outer ring with holes punched, even-odd fill).
        cctx.fillStyle = copperCol;
        for (const fill of (d.fills || [])) {
            if (fill?.visible === false) continue;
            if (fill?.layer !== copperLayer) continue;
            const polys = fill?._computed;
            if (!Array.isArray(polys) || polys.length === 0) continue;
            cctx.beginPath();
            for (const ex of polys) {
                const outer = ex.outer || [];
                if (outer.length < 3) continue;
                cctx.moveTo(outer[0].x, outer[0].y);
                for (let i = 1; i < outer.length; i++) cctx.lineTo(outer[i].x, outer[i].y);
                cctx.closePath();
                for (const h of (ex.holes || [])) {
                    if (h.length < 3) continue;
                    cctx.moveTo(h[0].x, h[0].y);
                    for (let i = 1; i < h.length; i++) cctx.lineTo(h[i].x, h[i].y);
                    cctx.closePath();
                }
            }
            cctx.fill('evenodd');
        }

        // Tracks (per-edge layer + width), drawn as stroked segments.
        cctx.strokeStyle = copperCol;
        cctx.lineCap = 'round';
        cctx.lineJoin = 'round';
        for (const t of (d.tracks || [])) {
            if (!t.edges?.size) continue;
            for (const [eid, e] of t.edges) {
                const layer = t.getEdgeLayer ? t.getEdgeLayer(eid) : t.layer;
                if (layer !== copperLayer) continue;
                const a = t.nodes.get(e.from);
                const bb = t.nodes.get(e.to);
                if (!a || !bb) continue;
                const w = (t.getEdgeWidth ? t.getEdgeWidth(eid) : t.width) || 0.2;
                cctx.lineWidth = w;
                cctx.beginPath();
                cctx.moveTo(a.x, a.y);
                cctx.lineTo(bb.x, bb.y);
                cctx.stroke();
            }
        }

        // Pads on this side (and 'both'), flashed at each offset position.
        // Each footprint is posed (rotated + mirrored) before flashing so the
        // pads track the component's orientation, exactly as the editor / 3D.
        cctx.save();
        cctx.globalAlpha = LAYER_STYLE.pads.o;
        cctx.fillStyle = COL.pad;
        for (const flash of resolvePadFlashes(d.placements || new Map(), { side: padSide })) {
            this._fillPad(cctx, flash.x, flash.y, flash.w, flash.h, flash.shape, flash.rad);
        }
        cctx.restore();

        // Vias appear on both copper layers.
        cctx.save();
        cctx.globalAlpha = LAYER_STYLE.vias.o;
        cctx.fillStyle = COL.via;
        for (const v of (d.vias || [])) {
            const ro = (v.diameter || 0.6) / 2;
            cctx.beginPath();
            cctx.arc(v.x, v.y, ro, 0, Math.PI * 2);
            cctx.fill();
        }
        cctx.restore();

        // Add-copper circles.
        for (const c of (d.circles || [])) {
            if (!c || c.layer !== copperLayer || !(c.radius > 0)) continue;
            const mode = normalizeCopperMode(c.copperMode);
            if (mode !== 'add') continue;
            const lw = Math.max(0.05, Number(c.lineWidth) || 0.2);
            if (c.filled) {
                cctx.fillStyle = copperCol;
                cctx.beginPath();
                cctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
                cctx.fill();
            } else {
                cctx.strokeStyle = copperCol;
                cctx.lineWidth = lw;
                cctx.beginPath();
                cctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
                cctx.stroke();
            }
        }

        // Remove-copper circles cut only the copper layer alpha.
        // remove-solder-mask does not alter copper geometry.
        cctx.globalCompositeOperation = 'destination-out';
        cctx.fillStyle = '#000';
        cctx.strokeStyle = '#000';
        cctx.lineCap = 'round';
        cctx.lineJoin = 'round';
        for (const c of (d.circles || [])) {
            if (!c || c.layer !== copperLayer || !(c.radius > 0)) continue;
            const mode = normalizeCopperMode(c.copperMode);
            if (mode !== 'remove-copper' && mode !== 'remove-copper-mask') continue;
            const lw = Math.max(0.05, Number(c.lineWidth) || 0.2);
            if (c.filled) {
                cctx.beginPath();
                cctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
                cctx.fill();
            } else {
                cctx.lineWidth = lw;
                cctx.beginPath();
                cctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
                cctx.stroke();
            }
        }
        cctx.globalCompositeOperation = 'source-over';

        // Blit composed copper layer into the main board pass.
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(layerCanvas, 0, 0);
        ctx.restore();

        // remove-copper-mask is naturally represented by the combination of
        // mask opening (_drawMaskOpenings) and copper subtraction above.
    }

    _padPath(ctx, cx, cy, w, h, shape) {
        ctx.beginPath();
        if (shape === 'ellipse') {
            ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
        } else if (shape === 'oval') {
            const r = Math.min(w, h) / 2;
            this._roundRectPath(ctx, cx - w / 2, cy - h / 2, w, h, r);
        } else {
            ctx.rect(cx - w / 2, cy - h / 2, w, h);
        }
    }

    /** Flash a pad, rotating its shape by the placement angle (so a 90°/270°
     *  part swaps width/height and oblique parts tilt) before filling. */
    _fillPad(ctx, cx, cy, w, h, shape, rad) {
        if (rad) {
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(rad);
            this._padPath(ctx, 0, 0, w, h, shape);
            ctx.fill();
            ctx.restore();
        } else {
            this._padPath(ctx, cx, cy, w, h, shape);
            ctx.fill();
        }
    }

    /** Drilled holes (THT pad drills, via drills) punched through to the
     *  background so the bore reads as an open hole, not a dark disc. */
    _drawHoles(ctx) {
        const d = this.data;
        ctx.fillStyle = COL.bg;
        // Through-hole pad drills (round + oval slot) and footprint mounting
        // holes, posed via the shared resolver. Punch through to background so
        // each bore reads as an open hole, not a dark disc.
        for (const drill of resolvePlacementDrills(d.placements || new Map())) {
            if (drill.slot) {
                // Stadium slot: a round-capped stroke of width = bore diameter
                // traces the slot's long axis between the two cap centres.
                ctx.save();
                ctx.strokeStyle = COL.bg;
                ctx.lineCap = 'round';
                ctx.lineWidth = drill.dia;
                ctx.beginPath();
                ctx.moveTo(drill.x, drill.y);
                ctx.lineTo(drill.slot.x2, drill.slot.y2);
                ctx.stroke();
                ctx.restore();
            } else {
                ctx.beginPath();
                ctx.arc(drill.x, drill.y, drill.dia / 2, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        for (const v of (d.vias || [])) {
            const drill = v.drill || (v.diameter ? v.diameter * 0.5 : 0);
            if (drill <= 0) continue;
            ctx.beginPath();
            ctx.arc(v.x, v.y, drill / 2, 0, Math.PI * 2);
            ctx.fill();
        }
        for (const h of (d.holes || [])) {
            const drill = h.diameter || 0;
            if (drill <= 0) continue;
            ctx.beginPath();
            ctx.arc(h.x, h.y, drill / 2, 0, Math.PI * 2);
            ctx.fillStyle = COL.bg;
            ctx.fill();
        }
        // Free-standing circles on HOLE layer are board cutouts in preview.
        for (const c of (d.circles || [])) {
            if (!c || c.layer !== 'hole' || !(c.radius > 0)) continue;
            ctx.beginPath();
            ctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
            ctx.fillStyle = COL.bg;
            ctx.fill();
        }
        // Free-standing board shapes on HOLE layer are board cutouts too.
        for (const s of (d.boardShapes || [])) {
            if (!s || s.layer !== 'hole') continue;
            const outline = s.outline || [];
            if (outline.length < 3) continue;
            ctx.beginPath();
            ctx.moveTo(outline[0].x, outline[0].y);
            for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i].x, outline[i].y);
            ctx.closePath();
            ctx.fillStyle = COL.bg;
            ctx.fill();
        }
    }

    /** Silkscreen for the active side: shapes, ref designators, free text. */
    _drawSilk(ctx) {
        const d = this.data;
        const top = this.side === 'top';
        const wantLayer = top ? 'top-silk' : 'bottom-silk';
        ctx.save();
        ctx.globalAlpha = LAYER_STYLE.silkscreen.o;
        ctx.strokeStyle = COL.silk;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const stroke = (/** @type {{x:number,y:number}[][]} */ segs, /** @type {number} */ lw) => {
            ctx.lineWidth = lw;
            ctx.beginPath();
            for (const [a, b] of segs) {
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(b.x, b.y);
            }
            ctx.stroke();
        };

        for (const sk of resolveSilk(d.placements || new Map(), this.side)) {
            if (sk.kind === 'line') {
                stroke([[{ x: sk.x1, y: sk.y1 }, { x: sk.x2, y: sk.y2 }]], sk.width);
            } else if (sk.kind === 'circle') {
                ctx.beginPath();
                ctx.arc(sk.cx, sk.cy, sk.r, 0, Math.PI * 2);
                // Solid silk markers (e.g. polarity dots) fill, matching the
                // editor and the fabricated silkscreen.
                if (sk.filled) {
                    ctx.fillStyle = COL.silk;
                    ctx.fill();
                }
                ctx.lineWidth = sk.width;
                ctx.stroke();
            } else if (sk.kind === 'path') {
                // Filled silk paths (e.g. pin-1 triangles) render solid, not
                // just outlined, so the 2D view matches the fab output.
                if (sk.filled) {
                    ctx.fillStyle = COL.silk;
                    ctx.beginPath();
                    for (const poly of sk.polys) {
                        if (!poly.length) continue;
                        ctx.moveTo(poly[0].x, poly[0].y);
                        for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
                        ctx.closePath();
                    }
                    ctx.fill('evenodd');
                }
                const segs = [];
                for (const poly of sk.polys) {
                    for (let i = 1; i < poly.length; i++) segs.push([poly[i - 1], poly[i]]);
                }
                if (segs.length) stroke(segs, sk.width);
            }
        }

        // Free-standing board shapes (rect/polygon/arc) on this silk side.
        for (const s of (d.boardShapes || [])) {
            if (!s || s.layer !== wantLayer) continue;
            const o = s.outline || [];
            if (o.length < 2) continue;
            const lw = Math.max(0.05, Number(s.lineWidth) || 0.2);
            const closed = s.kind !== 'arc';
            if (closed && s.filled && o.length >= 3) {
                ctx.fillStyle = COL.silk;
                ctx.beginPath();
                ctx.moveTo(o[0].x, o[0].y);
                for (let i = 1; i < o.length; i++) ctx.lineTo(o[i].x, o[i].y);
                ctx.closePath();
                ctx.fill();
            }
            ctx.lineWidth = lw;
            ctx.beginPath();
            ctx.moveTo(o[0].x, o[0].y);
            for (let i = 1; i < o.length; i++) ctx.lineTo(o[i].x, o[i].y);
            if (closed) ctx.closePath();
            ctx.stroke();
        }

        // Reference designators are posed per-placement (stroke-font geometry,
        // not part of resolveSilk).
        for (const [, pl] of (d.placements || [])) {
            const pose = _placementPose(pl);
            const bottom = pl.side === 'bottom';

            // Reference designator: it lives on the component's silk side and
            // is posed with the footprint, so on the bottom view it reads the
            // right way round (the board-flip mirror un-mirrors it). Pad pin
            // numbers are not drawn here, matching the fabricated silkscreen.
            const refLayer = bottom ? 'bottom-silk' : 'top-silk';
            if (refLayer !== wantLayer) continue;
            if (pl.refVisible === false) continue;
            const ref = pl.reference;
            if (!ref) continue;
            const size = pl.refSize || 0.9;
            const strokeW = pl.refStrokeWidth || 0.15;
            const ob = pl.outline;
            const labelW = measureText(ref, size);
            const cx = ob ? ob.x + ob.width / 2 : 0;
            const lx = cx - labelW / 2;
            const ly = ob ? ob.y - 0.8 : -2;
            const strokes = stringToPolylines(ref, lx, ly, size, false);
            // Vertical centre of the glyph run (authored-local), used as the
            // rotation pivot when the designator is moved/rotated relative to
            // the part.
            let gMinY = Infinity, gMaxY = -Infinity;
            for (const seg of strokes) {
                for (const p of seg) {
                    if (p.y < gMinY) gMinY = p.y;
                    if (p.y > gMaxY) gMaxY = p.y;
                }
            }
            const cyc = Number.isFinite(gMinY) ? (gMinY + gMaxY) / 2 : ly;
            const rdx = pl.refDx || 0, rdy = pl.refDy || 0;
            const rref = ((pl.refRot || 0) * Math.PI) / 180;
            const cr = Math.cos(rref), sr = Math.sin(rref);
            // Compose exactly as the SVG editor / 3D view:
            //   translate(refDx,refDy) · [counter-mirror about cx] · rotate(refRot,cx,cyc)
            // with the parent footprint pose (mirror·rotate·translate) applied
            // last via pose.xf(). The counter-mirror keeps the glyph run's
            // handedness pinned to the board side after a user flip.
            const refXf = (ax, ay) => {
                let qx = cx + (ax - cx) * cr - (ay - cyc) * sr;
                const qy = cyc + (ax - cx) * sr + (ay - cyc) * cr;
                if (pl.mirror) qx = 2 * cx - qx;   // counter-mirror about cx
                return pose.xf(qx + rdx, qy + rdy);
            };
            const segs = [];
            for (const seg of strokes) {
                for (let i = 1; i < seg.length; i++) {
                    segs.push([
                        refXf(seg[i - 1].x, seg[i - 1].y),
                        refXf(seg[i].x, seg[i].y),
                    ]);
                }
            }
            if (segs.length) stroke(segs, strokeW);
        }

        // Free-standing text on this silk side.
        for (const t of (d.texts || [])) {
            if (t.layer !== wantLayer) continue;
            const sw = Number.isFinite(t.strokeWidth) && t.strokeWidth > 0 ? t.strokeWidth : 0.15;
            stroke(_textSegments(t), sw);
        }

        // Free-standing circles on this side for all non-copper, non-hole,
        // non-mask, non-document layers. Mask circles are composited in
        // _drawMaskOpenings(); document circles in _drawDocumentCutouts().
        for (const c of (d.circles || [])) {
            if (!c || !(c.radius > 0)) continue;
            const layer = String(c.layer || 'top-silk');
            if (layer === 'top-copper' || layer === 'bottom-copper' || layer === 'hole'
            || layer === 'top-mask' || layer === 'bottom-mask'
            || layer === 'document' || layer === 'top-document' || layer === 'bottom-document') continue;
            const sideLayer = layer.startsWith('top-') ? 'top'
                : layer.startsWith('bottom-') ? 'bottom'
                    : 'both';
            if (sideLayer !== 'both' && sideLayer !== this.side) continue;
            const sw = Math.max(0.05, Number(c.lineWidth) || 0.15);
            if (c.filled) {
                ctx.fillStyle = COL.silk;
                ctx.beginPath();
                ctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.strokeStyle = COL.silk;
                ctx.lineWidth = sw;
                ctx.beginPath();
                ctx.arc(c.x, c.y, c.radius, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        ctx.restore();
    }
}

/* ── geometry helpers (ported from gerber.js so both stay in step) ─────── */

/**
 * Free PCB text → world-space segments, applying rotation about its anchor and
 * mirroring bottom-side text. Mirrors gerber.js `_textSegments`.
 * @param {{content:string,x:number,y:number,size:number,rotation:number,layer:string}} t
 * @returns {Array<Array<{x:number,y:number}>>}
 */
function _textSegments(t) {
    const polys = stringToPolylines(t.content, 0, 0, t.size, false);
    const rad = (t.rotation || 0) * Math.PI / 180;
    const cos = Math.cos(-rad), sin = Math.sin(-rad);
    const mirror = typeof t.layer === 'string' && t.layer.startsWith('bottom-') ? -1 : 1;
    const out = /** @type {{x:number,y:number}[][]} */ ([]);
    for (const poly of polys) {
        for (let i = 1; i < poly.length; i++) {
            const a = poly[i - 1], b = poly[i];
            const ax = a.x * mirror, bx = b.x * mirror;
            /** @type {{x:number,y:number}[]} */
            const seg = [
                { x: t.x + ax * cos - a.y * sin, y: t.y + ax * sin + a.y * cos },
                { x: t.x + bx * cos - b.y * sin, y: t.y + bx * sin + b.y * cos },
            ];
            out.push(seg);
        }
    }
    return out;
}
