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

import { resolveReferenceText } from '../../shared/pcb/reference-text.js';
import { getBoardOutline, boardBoundary } from '../../shared/pcb/board-outline.js';
import {
    resolvePlacementDrills,
    resolvePadFlashes,
    resolveSilk,
    resolvePadMaskOpenings,
    MASK_EXPANSION,
} from '../../shared/pcb/board-geometry.js';
import { resolveTrackSegments } from '../../shared/pcb/board-geometry.js';
import { boardShapeFilledRemovalOutlines, resolveBoardShapeGeometry } from '../../shared/pcb/board-shape-geometry.js';
import { pcbTextSegments } from './pcb-text.js';
import { drawPictureCached } from '../../shared/pcb/picture-raster.js';
import { paintViewerBackground } from './viewer-background.js';
import { getComputedFill } from './computed-fill-cache.js';

/** @typedef {{x:number,y:number}} Point */
/** @typedef {{x:number,y:number,w:number,h:number,r?:number,points?:Point[]}} BoardBounds */
/** @typedef {{h:number,s:number,v:number,o:number}} LayerStyle */
/** @typedef {'board'|'soldermask'|'tracks'|'vias'|'silkscreen'|'pads'} LayerStyleKey */
/** @typedef {Record<LayerStyleKey, LayerStyle>} LayerStyleMap */
/** @typedef {import('../../shared/pcb/board-shape-geometry.js').ResolvedBoardShapeGeometry} BoardShapeGeometry */
/** @typedef {import('./pcb-editor-api.js').PcbBoard & {fills?: import('../../shapes/copper-fill.js').CopperFill[], boardX?: number, boardY?: number, boardWidth?: number, boardHeight?: number, boardRadius?: number, [key:string]: unknown}} Board2DData */

/** @param {CanvasRenderingContext2D} context @param {BoardShapeGeometry} geometry */
function traceBoardShape(context, geometry) {
    context.beginPath();
    if (geometry.circle) {
        context.arc(geometry.circle.x, geometry.circle.y, geometry.circle.radius, 0, Math.PI * 2);
        return true;
    }
    if (geometry.path.length < 2) return false;
    context.moveTo(geometry.path[0].x, geometry.path[0].y);
    for (let index = 1; index < geometry.path.length; index++) {
        context.lineTo(geometry.path[index].x, geometry.path[index].y);
    }
    if (geometry.pathClosed) context.closePath();
    return true;
}

/** @param {CanvasRenderingContext2D} context @param {BoardShapeGeometry} geometry */
function drawBoardShape(context, geometry) {
    if (geometry.image) {
        drawPictureCached(context, geometry.image);
        return true;
    }
    if (geometry.physicalContours) {
        context.beginPath();
        for (const contour of geometry.physicalContours) {
            if (!contour.length) continue;
            context.moveTo(contour[0].x, contour[0].y);
            for (const point of contour.slice(1)) context.lineTo(point.x, point.y);
            context.closePath();
        }
        context.fill('evenodd');
        return true;
    }
    if (!geometry.filled && geometry.strokeSegments?.length) {
        for (const segment of geometry.strokeSegments) {
            context.beginPath();
            context.moveTo(segment.start.x, segment.start.y);
            context.lineTo(segment.end.x, segment.end.y);
            context.lineWidth = segment.lineWidth;
            context.stroke();
        }
        return true;
    }
    if (!traceBoardShape(context, geometry)) return false;
    if (geometry.filled) context.fill();
    context.lineWidth = geometry.lineWidth;
    context.stroke();
    return true;
}

// Palette mirrors the 3D viewer (board3d.js) so the two previews match.
const COL = {
    rawBoard: 'rgb(64,44,28)',    // bare FR4 substrate (board edge + document cutouts)
    solderMask: '',               // solder-mask coating on board faces
    copper: '',                   // exposed copper tone
    pad: '',                      // gold
    via: '',                      // gold barrel
    silk: '',                     // white silkscreen
};

const SOLDERMASK_BASE_RGB = { r: 34, g: 214, b: 62 };
/** @type {LayerStyleMap} */
const LAYER_STYLE = {
    board: _makeLayerStyleHSV(32, 52, 42, 255),
    soldermask: _makeLayerStyleHSV(138, 81, 45, 192),
    tracks: _makeLayerStyleHSV(45, 78, 84, 255),
    vias: _makeLayerStyleHSV(43, 94, 72, 255),
    silkscreen: _makeLayerStyleHSV(0, 0, 100, 255),
    pads: _makeLayerStyleHSV(45, 78, 84, 255),
};
// Toggle solder-mask rendering on board faces.
const SHOW_SOLDERMASK = true;

/** @param {unknown} v @param {number} fallback */
function _clampByte(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(255, Math.round(n)));
}

/** @param {unknown} v @param {number} fallback */
function _clampAlpha(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

/** @param {unknown} v @param {number} fallback */
function _clampUnit(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(1, n));
}

/** @param {unknown} v @param {number} fallback */
function _clampHue(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(360, Math.round(n)));
}

/** @param {number} r @param {number} g @param {number} b */
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

/** @param {number} r @param {number} g @param {number} b */
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

/** @param {number} h @param {number} s @param {number} v */
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

/** @param {number} r @param {number} g @param {number} b @param {number} o */
function _makeLayerStyle(r, g, b, o) {
    const hsv = _rgbToHsv(r, g, b);
    return { h: hsv.h, s: hsv.s, v: hsv.v, o };
}

// HSV in the panel-slider units (H 0-359, S/V 0-100) plus alpha as a byte
// (0-255). Stored normalised: h degrees, s/v/o in 0-1.
/** @param {number} h @param {number} s @param {number} v @param {number} oByte */
function _makeLayerStyleHSV(h, s, v, oByte) {
    return { h, s: s / 100, v: v / 100, o: oByte / 255 };
}

/** @param {number} h @param {number} s @param {number} l */
function _hslToRgb(h, s, l) {
    let hNorm = ((h % 360) + 360) % 360;
    hNorm /= 360;
    if (s === 0) {
        const v = Math.round(l * 255);
        return [v, v, v];
    }
    /** @param {number} p @param {number} q @param {number} t */
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

/** @param {number} greenness */
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

/** @param {{greenness?: number, opacity?: number}} [appearance] */
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

/** @param {{copperHue?: number, padHue?: number}} [appearance] */
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

/** @param {Partial<LayerStyleMap>} [patch] */
export function setBoard2DLayerStyles(patch = {}) {
    for (const key of /** @type {Array<keyof LayerStyleMap>} */ (['board', 'soldermask', 'tracks', 'vias', 'silkscreen', 'pads'])) {
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
        /** @type {Board2DData|null} */
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
        /** @type {{canvas: HTMLCanvasElement, x: number, y: number, tx: number, ty: number, scale: number, dpr: number, clipped: boolean}|null} */
        this._panRaster = null;
        /** @type {number|null} */
        this._panFrame = null;
        /** @type {number|null} */
        this._zoomTimer = null;
        /** @type {number|null} */
        this._zoomMinScale = null;
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
                const dpr = this.canvas.ownerDocument.defaultView?.devicePixelRatio || 1;
                if (this.canvas.clientWidth && this.canvas.clientHeight &&
                    (this.canvas.width !== Math.round(this.canvas.clientWidth * dpr) ||
                    this.canvas.height !== Math.round(this.canvas.clientHeight * dpr))) this.render();
            });
            this._ro.observe(canvas);
        } catch { this._ro = null; }
    }

    /** @param {Board2DData} data Same fields passed to exportGerbers.
     * @param {'top'|'bottom'} [side]
     */
    setData(data, side = this.side) {
        if (side !== this.side) {
            this.side = side;
            this._needFit = true;
        }
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
        this._cancelPanFrame();
        this._cancelZoomTimer();
        this._panRaster = null;
        this._drag = null;
        try { this._ro?.disconnect(); } catch { /* ignore */ }
        this._ro = null;
        this.canvas.removeEventListener('pointerdown', this._onPointerDown);
        this.canvas.removeEventListener('wheel', this._onWheel);
        const w = this._dragWin;
        w?.removeEventListener('pointermove', this._onPointerMove);
        w?.removeEventListener('pointerup', this._onPointerUp);
        w?.removeEventListener('pointercancel', this._onPointerUp);
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
        const d = /** @type {Partial<Board2DData>} */ (this.data || {});
        if (getBoardOutline(d)) return boardBoundary(d);
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

    /** @param {number} cssW @param {number} cssH */
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
    /** @param {number} cssW @param {number} cssH */
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
        if (e.button !== 0 || this._drag) return;
        this._panRaster ||= this._capturePanRaster();
        this._drag = { x: e.clientX, y: e.clientY };
        this._dragWin = this.canvas.ownerDocument?.defaultView || window;
        this.canvas.setPointerCapture?.(e.pointerId);
        this._dragWin.addEventListener('pointermove', this._onPointerMove);
        this._dragWin.addEventListener('pointerup', this._onPointerUp);
        this._dragWin.addEventListener('pointercancel', this._onPointerUp);
    }

    /** @param {PointerEvent} e */
    _onPointerMove(e) {
        if (!this._drag) return;
        this.tx += e.clientX - this._drag.x;
        this.ty += e.clientY - this._drag.y;
        this._drag = { x: e.clientX, y: e.clientY };
        this._scheduleRasterPaint();
    }

    _scheduleRasterPaint() {
        if (this._panFrame === null) {
            const owner = this.canvas.ownerDocument?.defaultView || window;
            this._panFrame = owner.requestAnimationFrame(() => {
                this._panFrame = null;
                if (this._drag || this._zoomTimer !== null) this._paintPanRaster();
            });
        }
    }

    /** @param {PointerEvent} e */
    _onPointerUp(e) {
        if (!this._drag) return;
        this._cancelPanFrame();
        this._drag = null;
        this.canvas.releasePointerCapture?.(e.pointerId);
        const w = this._dragWin || window;
        w.removeEventListener('pointermove', this._onPointerMove);
        w.removeEventListener('pointerup', this._onPointerUp);
        w.removeEventListener('pointercancel', this._onPointerUp);
        this.render();
    }

    _cancelPanFrame() {
        if (this._panFrame === null) return;
        (this.canvas.ownerDocument?.defaultView || window).cancelAnimationFrame(this._panFrame);
        this._panFrame = null;
    }

    _cancelZoomTimer() {
        if (this._zoomTimer !== null) {
            (this.canvas.ownerDocument?.defaultView || window).clearTimeout(this._zoomTimer);
        }
        this._zoomTimer = null;
        this._zoomMinScale = null;
    }

    /** Capture full board artwork at this zoom, with bounded overscan for exceptionally large views. */
    _capturePanRaster() {
        const owner = this.canvas.ownerDocument || document;
        const dpr = owner.defaultView?.devicePixelRatio || 1;
        const board = this._boardRect();
        const margin = 4 * dpr;
        let y = Math.floor((this.ty + this.scale * board.y) * dpr) - margin;
        const left = this.tx + this.mirror * this.scale * board.x;
        const right = this.tx + this.mirror * this.scale * (board.x + board.w);
        let x = Math.floor(Math.min(left, right) * dpr) - margin;
        let width = Math.ceil(board.w * this.scale * dpr) + margin * 2;
        let height = Math.ceil(board.h * this.scale * dpr) + margin * 2;
        // At extreme zoom, bound the capture to an overscanned viewport.
        const clipped = width > 4096 || height > 4096;
        if (clipped) {
            width = Math.max(this.canvas.width, Math.min(4096, this.canvas.width * 2));
            height = Math.max(this.canvas.height, Math.min(4096, this.canvas.height * 2));
            x = Math.floor((this.canvas.width - width) / 2);
            y = Math.floor((this.canvas.height - height) / 2);
        }
        const canvas = owner.createElement('canvas');
        canvas.width = Math.max(1, width);
        canvas.height = Math.max(1, height);
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Board view navigation requires a 2D canvas.');
        context.setTransform(this.mirror * this.scale * dpr, 0, 0, this.scale * dpr,
            this.tx * dpr - x, this.ty * dpr - y);
        if (this.data) this._paintBoard(context);
        return { canvas, x, y, tx: this.tx, ty: this.ty, scale: this.scale, dpr, clipped };
    }

    _paintPanRaster() {
        let raster = this._panRaster ||= this._capturePanRaster();
        let k = this.scale / raster.scale;
        let x = k * raster.x + (this.tx - k * raster.tx) * raster.dpr;
        let y = k * raster.y + (this.ty - k * raster.ty) * raster.dpr;
        if (raster.clipped && (x > 0 || y > 0 ||
            x + k * raster.canvas.width < this.canvas.width ||
            y + k * raster.canvas.height < this.canvas.height)) {
            raster = this._panRaster = this._capturePanRaster();
            k = 1;
            x = raster.x;
            y = raster.y;
        }
        const ctx = this.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        paintViewerBackground(ctx, this.canvas.width, this.canvas.height);
        ctx.drawImage(raster.canvas, x, y, k * raster.canvas.width, k * raster.canvas.height);
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
        const minScale = this._zoomMinScale ?? this._minScale(rect.width || 1, rect.height || 1);
        const next = Math.max(minScale, Math.min(2000, this.scale * factor));
        if (next === this.scale) return;
        this._panRaster ||= this._capturePanRaster();
        const k = next / this.scale;
        // Keep the world point under the cursor fixed while zooming.
        this.tx = px - k * (px - this.tx);
        this.ty = py - k * (py - this.ty);
        this.scale = next;
        this._cancelZoomTimer();
        this._zoomMinScale = minScale;
        const owner = this.canvas.ownerDocument?.defaultView || window;
        this._zoomTimer = owner.setTimeout(() => {
            this._zoomTimer = null;
            this.render();
        }, 300);
        this._scheduleRasterPaint();
    }

    /* ── rendering ────────────────────────────────────────────────────── */

    render() {
        this._cancelPanFrame();
        this._cancelZoomTimer();
        this._panRaster = null;
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
        ctx.clearRect(0, 0, cv.width, cv.height);
        if (!this.data) {
            paintViewerBackground(ctx, cv.width, cv.height);
            return;
        }

        if (this._exportScale) {
            ctx.setTransform(this.mirror * this.scale * dpr, 0, 0, this.scale * dpr,
                this.tx * dpr, this.ty * dpr);
            this._paintBoard(ctx);
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalCompositeOperation = 'destination-over';
            paintViewerBackground(ctx, cv.width, cv.height);
            ctx.restore();
            return;
        }
        // Keep the transparent artwork from this render: starting navigation
        // must not rebuild the board before its first frame can be displayed.
        this._panRaster = this._capturePanRaster();
        paintViewerBackground(ctx, cv.width, cv.height);
        ctx.drawImage(this._panRaster.canvas, this._panRaster.x, this._panRaster.y);
    }

    /** Paint transparent board artwork, independent of the screen-space background.
     * @param {CanvasRenderingContext2D} ctx
     */
    _paintBoard(ctx) {
        this._drawBoard(ctx);
        // Clip artwork to the board outline so copper/silk that
        // spill past the edge (e.g. pads on the rim) are cropped to the board.
        ctx.save();
        const b = this._boardRect();
        this._boardPath(ctx, b);
        ctx.clip();
        if (SHOW_SOLDERMASK) this._drawMaskOpenings(ctx);
        this._drawCopper(ctx);
        if (SHOW_SOLDERMASK) this._drawSolderMask(ctx);
        this._drawSilk(ctx);
        ctx.restore();
        // Holes paint last so a bore/cutout reads as open through every layer —
        // including silk, which is never printed over a drilled hole.
        this._drawHoles(ctx);
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
    /** @param {CanvasRenderingContext2D} ctx */
    _drawBoard(ctx) {
        const b = this._boardRect();
        this._boardPath(ctx, b);
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

    /** @param {CanvasRenderingContext2D} ctx @param {BoardBounds} bounds */
    _boardPath(ctx, bounds) {
        if (!bounds.points) {
            this._roundRectPath(ctx, bounds.x, bounds.y, bounds.w, bounds.h, bounds.r || 0);
            return;
        }
        ctx.beginPath();
        ctx.moveTo(bounds.points[0].x, bounds.points[0].y);
        for (const point of bounds.points.slice(1)) ctx.lineTo(point.x, point.y);
        ctx.closePath();
    }

    /** @param {CanvasRenderingContext2D} ctx @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r */
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
     * Supports mask-layer circles (always filled openings) and copper-layer
     * circles using remove-solder-mask / remove-copper-mask modes. */
    /** @param {CanvasRenderingContext2D} ctx */
    _drawMaskOpenings(ctx) {
        const d = /** @type {Board2DData} */ (this.data);
        ctx.fillStyle = COL.rawBoard;
        ctx.strokeStyle = COL.rawBoard;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const rawFlash of resolvePadMaskOpenings(d.placements || new Map(), this.side)) {
            const flash = /** @type {{x:number,y:number,w:number,h:number,shape:string,rad:number}} */ (rawFlash);
            this._fillPad(ctx, flash.x, flash.y, flash.w, flash.h, flash.shape, flash.rad);
        }
        const copperLayer = `${this.side}-copper`;
        for (const pad of (d.pads || [])) {
            if (pad.layers !== 'both' && pad.layers !== copperLayer) continue;
            const ratio = ['stadium', 'rectangle', 'oval'].includes(pad.shape) ? pad.ratio || 2 : 1;
            const shape = pad.shape === 'round' ? 'circle'
                : pad.shape === 'oval' ? 'ellipse'
                    : pad.shape === 'stadium' ? 'oval' : 'rect';
            this._fillPad(ctx, pad.x, pad.y,
                pad.size * ratio + 2 * MASK_EXPANSION, pad.size + 2 * MASK_EXPANSION,
                shape, -(pad.rotation || 0) * Math.PI / 180);
        }
        for (const shape of (d.boardShapes || [])) {
            if (!shape || shape.type === 'fill') continue;
            const layer = String(shape.layer || '');
            const isMaskLayer = layer === 'top-mask' || layer === 'bottom-mask';
            const isCopperLayer = layer === 'top-copper' || layer === 'bottom-copper';
            const side = layer === 'bottom-mask' || layer === 'bottom-copper' ? 'bottom' : 'top';
            if ((!isMaskLayer && !isCopperLayer) || side !== this.side) continue;
            const geometry = resolveBoardShapeGeometry(shape);
            const mode = geometry.copperMode;
            if (!isMaskLayer && mode !== 'remove-solder-mask' && mode !== 'remove-copper-mask') continue;
            if (!drawBoardShape(ctx, geometry)) continue;
        }
    }

    /** Solder-mask topcoat for the active side. Painted over copper, then
     * openings are punched out so exposed regions reveal copper/raw board. */
    /** @param {CanvasRenderingContext2D} ctx */
    _drawSolderMask(ctx) {
        const layerCanvas = (ctx.canvas.ownerDocument?.createElement('canvas')) || document.createElement('canvas');
        layerCanvas.width = ctx.canvas.width;
        layerCanvas.height = ctx.canvas.height;
        const mctx = layerCanvas.getContext('2d');
        if (!mctx) return;
        mctx.setTransform(ctx.getTransform());

        const b = this._boardRect();
        mctx.fillStyle = COL.solderMask;
        this._boardPath(mctx, b);
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

    /** Copper for the active side: tracks, pad flashes and via barrels. */
    /** @param {CanvasRenderingContext2D} ctx */
    _drawCopper(ctx) {
        const d = /** @type {Board2DData} */ (this.data);
        const top = this.side === 'top';
        const padSide = top ? 'top' : 'bottom';
        const copperLayer = top ? 'top-copper' : 'bottom-copper';
        const copperCol = COL.copper;

        /** @param {import('../../core/pcb-board-shapes.js').BoardShape} shape @param {BoardShapeGeometry} [geometry] */
        const drawCopperShape = (shape, geometry = resolveBoardShapeGeometry(shape)) => {
            drawBoardShape(cctx, geometry);
        };

        // Compose copper into a dedicated transparent layer, subtracting
        // remove-mode circles with destination-out so underlying mask/board
        // naturally shows through where copper is removed.
        const layerCanvas = (ctx.canvas.ownerDocument?.createElement('canvas')) || document.createElement('canvas');
        layerCanvas.width = ctx.canvas.width;
        layerCanvas.height = ctx.canvas.height;
        const cctx = /** @type {CanvasRenderingContext2D} */ (layerCanvas.getContext('2d'));
        if (!cctx) return;
        cctx.setTransform(ctx.getTransform());
        cctx.globalAlpha = LAYER_STYLE.tracks.o;

        // Copper pours first (under tracks/pads), drawn from their computed
        // polygon geometry (outer ring with holes punched, even-odd fill).
        cctx.fillStyle = copperCol;
        for (const fill of (d.fills || [])) {
            if (fill?.visible === false) continue;
            if (fill?.layer !== copperLayer) continue;
            const polys = getComputedFill(fill);
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
            for (const { start: a, end: bb, layer, width: w } of resolveTrackSegments(t)) {
                if (layer !== copperLayer) continue;
                cctx.lineWidth = w;
                cctx.beginPath();
                cctx.moveTo(a.x, a.y);
                cctx.lineTo(bb.x, bb.y);
                cctx.stroke();
            }
        }

        // Add-copper board shapes and text belong to the same copper surface
        // as tracks. Draw them before pad/via faces, matching the 3D surface
        // order so overlaps do not leave a later-painted seam.
        for (const shape of (d.boardShapes || [])) {
            if (!shape || shape.layer !== copperLayer) continue;
            const geometry = resolveBoardShapeGeometry(shape);
            if (geometry.copperMode !== 'add') continue;
            cctx.fillStyle = copperCol;
            cctx.strokeStyle = copperCol;
            drawCopperShape(shape, geometry);
        }
        cctx.strokeStyle = copperCol;
        cctx.lineCap = 'round';
        cctx.lineJoin = 'round';
        for (const text of (d.texts || [])) {
            if (text.layer !== copperLayer) continue;
            cctx.lineWidth = Number(text.strokeWidth) > 0 ? text.strokeWidth : 0.15;
            cctx.beginPath();
            for (const [start, end] of pcbTextSegments(text)) {
                cctx.moveTo(start.x, start.y);
                cctx.lineTo(end.x, end.y);
            }
            cctx.stroke();
        }

        // Pads on this side (and 'both'), flashed at each offset position.
        // Each footprint is posed (rotated + mirrored) before flashing so the
        // pads track the component's orientation, exactly as the editor / 3D.
        cctx.save();
        cctx.globalAlpha = LAYER_STYLE.pads.o;
        cctx.fillStyle = COL.pad;
        for (const rawFlash of resolvePadFlashes(d.placements || new Map(), { side: padSide })) {
            const flash = /** @type {{x:number,y:number,w:number,h:number,shape:string,rad:number}} */ (rawFlash);
            this._fillPad(cctx, flash.x, flash.y, flash.w, flash.h, flash.shape, flash.rad);
        }
        for (const pad of (d.pads || [])) {
            if (pad.layers !== 'both' && pad.layers !== copperLayer) continue;
            const ratio = ['stadium', 'rectangle', 'oval'].includes(pad.shape) ? pad.ratio || 2 : 1;
            const shape = pad.shape === 'round' ? 'circle'
                : pad.shape === 'oval' ? 'ellipse'
                    : pad.shape === 'stadium' ? 'oval' : 'rect';
            this._fillPad(cctx, pad.x, pad.y, pad.size * ratio, pad.size, shape,
                -(pad.rotation || 0) * Math.PI / 180);
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

        // Remove-copper board shapes cut only the copper layer alpha.
        // remove-solder-mask does not alter copper geometry.
        cctx.globalCompositeOperation = 'destination-out';
        cctx.fillStyle = '#000';
        cctx.strokeStyle = '#000';
        cctx.lineCap = 'round';
        cctx.lineJoin = 'round';
        for (const shape of (d.boardShapes || [])) {
            if (!shape || shape.layer !== copperLayer) continue;
            const geometry = resolveBoardShapeGeometry(shape);
            if (geometry.copperMode !== 'remove-copper' && geometry.copperMode !== 'remove-copper-mask') continue;
            drawCopperShape(shape, geometry);
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

    /** @param {CanvasRenderingContext2D} ctx @param {number} cx @param {number} cy @param {number} w @param {number} h @param {string} shape */
    _padPath(ctx, cx, cy, w, h, shape) {
        ctx.beginPath();
        if (shape === 'circle') {
            ctx.arc(cx, cy, Math.min(w, h) / 2, 0, Math.PI * 2);
        } else if (shape === 'ellipse') {
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
    /** @param {CanvasRenderingContext2D} ctx @param {number} cx @param {number} cy @param {number} w @param {number} h @param {string} shape @param {number} rad */
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
    /** @param {CanvasRenderingContext2D} ctx */
    _drawHoles(ctx) {
        const d = /** @type {Board2DData} */ (this.data);
        ctx.save();
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = '#000';
        // Through-hole pad drills (round + oval slot) and footprint mounting
        // holes, posed via the shared resolver. Punch through to background so
        // each bore reads as an open hole, not a dark disc.
        for (const drill of resolvePlacementDrills(d.placements || new Map())) {
            if (drill.slot) {
                // Stadium slot: a round-capped stroke of width = bore diameter
                // traces the slot's long axis between the two cap centres.
                ctx.save();
                ctx.strokeStyle = '#000';
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
        for (const pad of (d.pads || [])) {
            if (!(pad.drill > 0)) continue;
            ctx.beginPath();
            ctx.arc(pad.x, pad.y, pad.drill / 2, 0, Math.PI * 2);
            ctx.fill();
        }
        // Free-standing board shapes on HOLE layer are board cutouts.
        for (const s of (d.boardShapes || [])) {
            if (!s || s.type === 'fill' || s.layer !== 'hole') continue;
            const geometry = resolveBoardShapeGeometry(s);
            if (geometry.filled) {
                for (const outline of boardShapeFilledRemovalOutlines(s)) {
                    if (!traceBoardShape(ctx, /** @type {BoardShapeGeometry} */ ({ path: outline, pathClosed: true }))) continue;
                    ctx.fill();
                }
            } else {
                ctx.save();
                ctx.strokeStyle = '#000';
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                drawBoardShape(ctx, geometry);
                ctx.restore();
            }
        }
        ctx.restore();
    }

    /** Silkscreen for the active side: shapes, ref designators, free text. */
    /** @param {CanvasRenderingContext2D} ctx */
    _drawSilk(ctx) {
        const d = /** @type {Board2DData} */ (this.data);
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

        for (const rawSk of resolveSilk(d.placements || new Map(), this.side)) {
            const sk = /** @type {import('../../shared/pcb/board-geometry.js').SilkDescriptor} */ (rawSk);
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

        // Free-standing board shapes on this silk side.
        for (const s of (d.boardShapes || [])) {
            if (!s || s.type === 'fill' || s.layer !== wantLayer) continue;
            const geometry = resolveBoardShapeGeometry(s);
            ctx.fillStyle = COL.silk;
            if (!drawBoardShape(ctx, geometry)) continue;
        }

        for (const [, pl] of (d.placements || [])) {
            if ((pl.side === 'bottom' ? 'bottom-silk' : 'top-silk') !== wantLayer) continue;
            const reference = resolveReferenceText(pl);
            if (!reference) continue;
            const segs = [];
            for (const seg of reference.polylines) {
                for (let i = 1; i < seg.length; i++) {
                    segs.push([seg[i - 1], seg[i]]);
                }
            }
            if (segs.length) stroke(segs, reference.strokeWidth);
        }

        // Free-standing text on this silk side.
        for (const t of (d.texts || [])) {
            if (t.layer !== wantLayer) continue;
            const sw = Number.isFinite(t.strokeWidth) && t.strokeWidth > 0 ? t.strokeWidth : 0.15;
            stroke(pcbTextSegments(t), sw);
        }

        ctx.restore();
    }
}
