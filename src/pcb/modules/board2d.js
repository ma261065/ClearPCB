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

// Palette mirrors the 3D viewer (board3d.js) so the two previews match.
const COL = {
    bg: 'rgb(74,76,79)',          // panel grey (3D clear colour)
    board: 'rgb(10,130,50)',      // solder-mask green
    boardEdge: 'rgb(190,192,122)',// bare FR4 edge
    trackTop: 'rgb(26,165,70)',   // top trace under mask
    trackBottom: 'rgb(16,142,58)',// bottom trace under mask
    pad: 'rgb(201,164,74)',       // gold
    via: 'rgb(184,134,11)',       // gold barrel
    hole: 'rgb(12,12,16)',        // drilled hole
    silk: 'rgb(228,228,228)',     // white silkscreen
};

// Footprint silk authored on one side moves to the opposite side when the
// component is placed on the bottom (matches the editor's FP_LAYER_FLIP).
const FLIP_SILK = { 'top-silk': 'bottom-silk', 'bottom-silk': 'top-silk' };

/**
 * Footprint-local → world transform for a placement's pose: mirror (about the
 * footprint origin) then rotate then translate. Matches `applyPlacementPose`
 * and the editor's SVG group transform `translate … rotate … scale(-1,1)`, so
 * pads/silk land exactly where the 2D editor and 3D view draw them.
 * @param {{x?:number,y?:number,rotation?:number,mirror?:boolean,side?:string}} pl
 */
function _placementPose(pl) {
    const rad = ((pl.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    // A user flip (mirror) and a bottom-side placement each mirror the
    // footprint; together they cancel out.
    const mx = ((!!pl.mirror) !== (pl.side === 'bottom')) ? -1 : 1;
    const ox = pl.x || 0, oy = pl.y || 0;
    return {
        rad,
        /** @param {number} lx @param {number} ly */
        xf(lx, ly) {
            const x = lx * mx;
            return { x: ox + x * cos - ly * sin, y: oy + x * sin + ly * cos };
        },
    };
}

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

    dispose() {
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
        const dpr = (cv.ownerDocument?.defaultView || window).devicePixelRatio || 1;
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
        this._drawCopper(ctx);
        this._drawHoles(ctx);
        this._drawSilk(ctx);
        ctx.restore();
    }

    /** Rounded board substrate with a bare-FR4 edge stroke. */
    _drawBoard(ctx) {
        const b = this._boardRect();
        this._roundRectPath(ctx, b.x, b.y, b.w, b.h, b.r);
        ctx.fillStyle = COL.board;
        ctx.fill();
        ctx.lineWidth = Math.max(0.15, 4 / this.scale) * 0.05;
        ctx.strokeStyle = COL.boardEdge;
        ctx.lineWidth = 0.2;
        ctx.stroke();
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

    /** Copper for the active side: tracks, pad flashes and via barrels. */
    _drawCopper(ctx) {
        const d = this.data;
        const top = this.side === 'top';
        const padSide = top ? 'top' : 'bottom';
        const copperLayer = top ? 'top-copper' : 'bottom-copper';

        // Copper pours first (under tracks/pads), drawn from their computed
        // polygon geometry (outer ring with holes punched, even-odd fill).
        ctx.fillStyle = top ? COL.trackTop : COL.trackBottom;
        for (const fill of (d.fills || [])) {
            if (fill?.visible === false) continue;
            if (fill?.layer !== copperLayer) continue;
            const polys = fill?._computed;
            if (!Array.isArray(polys) || polys.length === 0) continue;
            ctx.beginPath();
            for (const ex of polys) {
                const outer = ex.outer || [];
                if (outer.length < 3) continue;
                ctx.moveTo(outer[0].x, outer[0].y);
                for (let i = 1; i < outer.length; i++) ctx.lineTo(outer[i].x, outer[i].y);
                ctx.closePath();
                for (const h of (ex.holes || [])) {
                    if (h.length < 3) continue;
                    ctx.moveTo(h[0].x, h[0].y);
                    for (let i = 1; i < h.length; i++) ctx.lineTo(h[i].x, h[i].y);
                    ctx.closePath();
                }
            }
            ctx.fill('evenodd');
        }

        // Tracks (per-edge layer + width), drawn as stroked segments.
        ctx.strokeStyle = top ? COL.trackTop : COL.trackBottom;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const t of (d.tracks || [])) {
            if (!t.edges?.size) continue;
            for (const [eid, e] of t.edges) {
                const layer = t.getEdgeLayer ? t.getEdgeLayer(eid) : t.layer;
                if (layer !== copperLayer) continue;
                const a = t.nodes.get(e.from);
                const bb = t.nodes.get(e.to);
                if (!a || !bb) continue;
                const w = (t.getEdgeWidth ? t.getEdgeWidth(eid) : t.width) || 0.2;
                ctx.lineWidth = w;
                ctx.beginPath();
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(bb.x, bb.y);
                ctx.stroke();
            }
        }

        // Pads on this side (and 'both'), flashed at each offset position.
        // Each footprint is posed (rotated + mirrored) before flashing so the
        // pads track the component's orientation, exactly as the editor / 3D.
        ctx.fillStyle = COL.pad;
        for (const [, pl] of (d.placements || [])) {
            if (!pl?.padOffsets) continue;
            const pose = _placementPose(pl);
            for (const off of pl.padOffsets) {
                const layer = off.layer || 'top';
                if (layer !== 'both' && layer !== padSide) continue;
                const p = pose.xf(off.dx, off.dy);
                this._fillPad(ctx, p.x, p.y, off.width || 1.2, off.height || 1.2,
                    off.shape || 'rect', pose.rad);
            }
        }

        // Vias appear on both copper layers.
        ctx.fillStyle = COL.via;
        for (const v of (d.vias || [])) {
            const ro = (v.diameter || 0.6) / 2;
            ctx.beginPath();
            ctx.arc(v.x, v.y, ro, 0, Math.PI * 2);
            ctx.fill();
        }
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

    /** Drilled holes (THT pad drills, via drills) punched as dark discs. */
    _drawHoles(ctx) {
        const d = this.data;
        ctx.fillStyle = COL.hole;
        for (const [, pl] of (d.placements || [])) {
            if (!pl?.padOffsets) continue;
            const pose = _placementPose(pl);
            for (const off of pl.padOffsets) {
                const drill = off.drill || 0;
                if (drill <= 0) continue;
                const p = pose.xf(off.dx, off.dy);
                ctx.beginPath();
                ctx.arc(p.x, p.y, drill / 2, 0, Math.PI * 2);
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
    }

    /** Silkscreen for the active side: shapes, ref designators, free text. */
    _drawSilk(ctx) {
        const d = this.data;
        const top = this.side === 'top';
        const wantLayer = top ? 'top-silk' : 'bottom-silk';
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

        for (const [, pl] of (d.placements || [])) {
            const pose = _placementPose(pl);
            // Silk authored on one side moves to the other when the part is on
            // the bottom; the part's pose mirrors/rotates the geometry too.
            const bottom = pl.side === 'bottom';
            for (const s of (pl.silks || [])) {
                const layer = bottom ? (FLIP_SILK[s.layer] || s.layer) : s.layer;
                if (layer !== wantLayer) continue;
                const sw = Number.isFinite(s.strokeWidth) && s.strokeWidth > 0 ? s.strokeWidth : 0.12;
                if (s.type === 'line') {
                    stroke([[pose.xf(s.x1, s.y1), pose.xf(s.x2, s.y2)]], sw);
                } else if (s.type === 'circle') {
                    const c = pose.xf(s.cx, s.cy);
                    ctx.lineWidth = sw;
                    ctx.beginPath();
                    ctx.arc(c.x, c.y, s.r, 0, Math.PI * 2);
                    ctx.stroke();
                } else if (s.type === 'path') {
                    const polys = _flattenPath(s.d);
                    const segs = [];
                    for (const poly of polys) {
                        for (let i = 1; i < poly.length; i++) {
                            segs.push([
                                pose.xf(poly[i - 1].x, poly[i - 1].y),
                                pose.xf(poly[i].x, poly[i].y),
                            ]);
                        }
                    }
                    if (segs.length) stroke(segs, sw);
                }
            }

            // Reference designator: it lives on the component's silk side and
            // is posed with the footprint, so on the bottom view it reads the
            // right way round (the board-flip mirror un-mirrors it). Pad pin
            // numbers are not drawn here, matching the fabricated silkscreen.
            const refLayer = bottom ? 'bottom-silk' : 'top-silk';
            if (refLayer !== wantLayer) continue;
            if (pl.refVisible === false) continue;
            const ref = pl.reference;
            if (!ref) continue;
            const size = 0.9;
            const ob = pl.bounds;
            const labelW = measureText(ref, size);
            const cx = ob ? ob.x + ob.width / 2 : 0;
            const lx = cx - labelW / 2;
            const ly = ob ? ob.y - 0.8 : -2;
            const strokes = stringToPolylines(ref, lx, ly, size, false);
            // Counter-mirror the reference about its own centre when the
            // footprint is user-flipped, exactly as the SVG editor does, so its
            // net handedness reflects only the board side: readable on top even
            // after an H/V flip, mirrored on the bottom.
            const cm = (px) => (pl.mirror ? 2 * cx - px : px);
            const segs = [];
            for (const seg of strokes) {
                for (let i = 1; i < seg.length; i++) {
                    segs.push([
                        pose.xf(cm(seg[i - 1].x), seg[i - 1].y),
                        pose.xf(cm(seg[i].x), seg[i].y),
                    ]);
                }
            }
            if (segs.length) stroke(segs, 0.15);
        }

        // Free-standing text on this silk side.
        for (const t of (d.texts || [])) {
            if (t.layer !== wantLayer) continue;
            const sw = Number.isFinite(t.strokeWidth) && t.strokeWidth > 0 ? t.strokeWidth : 0.15;
            stroke(_textSegments(t), sw);
        }
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

/**
 * Flatten a simple SVG path string into polylines (mm). Supports M/L/H/V/Z and
 * cubic/quadratic beziers. Mirrors gerber.js `_flattenPath`.
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
        const tk = tokens[i++];
        if (/[a-zA-Z]/.test(tk) === false) i--;
        const cmd = /[a-zA-Z]/.test(tk) ? tk : 'L';
        const rel = cmd === cmd.toLowerCase() && cmd !== 'Z' && cmd !== 'z';
        const c = cmd.toUpperCase();
        if (c === 'M') {
            if (poly.length) { polys.push(poly); poly = []; }
            const nx = num(), ny = num();
            x = rel ? x + nx : nx; y = rel ? y + ny : ny;
            sx = x; sy = y; push();
            while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) {
                const lx = num(), ly = num();
                x = rel ? x + lx : lx; y = rel ? y + ly : ly; push();
            }
        } else if (c === 'L') {
            while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) {
                const lx = num(), ly = num();
                x = rel ? x + lx : lx; y = rel ? y + ly : ly; push();
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
                const cx1 = x + 2 / 3 * (x1 - x), cy1 = y + 2 / 3 * (y1 - y);
                const cx2 = nx + 2 / 3 * (x1 - nx), cy2 = ny + 2 / 3 * (y1 - ny);
                _flattenBezier(poly, x, y, cx1, cy1, cx2, cy2, nx, ny, 16);
                x = nx; y = ny;
            }
        } else {
            while (i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) i++;
        }
    }
    if (poly.length) polys.push(poly);
    return polys;
}

function _flattenBezier(poly, x0, y0, x1, y1, x2, y2, x3, y3, steps) {
    for (let s = 1; s <= steps; s++) {
        const t = s / steps, u = 1 - t;
        const bx = u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3;
        const by = u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3;
        poly.push({ x: bx, y: by });
    }
}
