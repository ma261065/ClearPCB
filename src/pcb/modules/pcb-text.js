/**
 * Free-standing PCB text annotations.
 *
 * Text is rendered as stroked polylines using the shared Hershey font
 * (src/pcb/modules/stroke-font.js), so the editor canvas and Gerber
 * export are visually identical.
 *
 * Each text lives on a single layer (top-silk / bottom-silk /
 * top-copper / bottom-copper). Attributes:
 *   - content      string  the displayed text
 *   - x, y         number  baseline-left in board mm (SVG-Y-down)
 *   - size         number  cap height in mm
 *   - rotation     number  degrees, CCW visually (CW in SVG-Y-down)
 *   - layer        string  one of the layer ids above
 *   - strokeWidth  number  line width in mm
 *
 * `id` is optional; PCBApp assigns one on add if missing.
 */

import { stringToPolylines, measureText } from './stroke-font.js';
import { PCB_LAYERS } from './layers.js';

const NS = 'http://www.w3.org/2000/svg';

/** Layers on which text may be placed. */
export const TEXT_LAYERS = ['top-silk', 'bottom-silk', 'top-copper', 'bottom-copper'];

/** True if the given text layer id is a bottom-side layer. */
export function isBottomLayer(layer) {
    return typeof layer === 'string' && layer.startsWith('bottom-');
}

/** Map a text layer id to a stroke colour (matches the layers panel). */
export function textColorForLayer(layer) {
    const def = PCB_LAYERS.find(l => l.id === layer);
    return def?.color || '#cccccc';
}

/**
 * Create a PCB text object. Missing fields are filled with sensible
 * defaults. Returns a plain object — PCBApp owns the storage.
 *
 * @param {Partial<{id:string, content:string, x:number, y:number,
 *   size:number, rotation:number, layer:string, strokeWidth:number}>} opts
 */
export function createPcbText(opts = {}) {
    return {
        id: opts.id || `text-${Math.random().toString(36).slice(2, 10)}`,
        content: opts.content ?? 'Text',
        x: opts.x ?? 0,
        y: opts.y ?? 0,
        size: opts.size ?? 1.0,
        rotation: opts.rotation ?? 0,
        layer: TEXT_LAYERS.includes(opts.layer) ? opts.layer : 'top-silk',
        strokeWidth: opts.strokeWidth ?? 0.15,
    };
}

/**
 * Build an SVG <g> element for the given text. The group carries
 *  - `data-text-id` for hit-testing
 *  - a `translate(x,y) rotate(-rotation)` transform (negate rotation so
 *    positive degrees rotate visually-CCW in SVG-Y-down space).
 * Caller appends to the layer group.
 *
 * @param {object} text
 * @param {string} [strokeOverride] optional colour override (e.g. selection)
 * @returns {SVGGElement}
 */
export function renderPcbText(text, strokeOverride) {
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'pcb-text');
    g.dataset.textId = text.id;
    // Bottom-layer text is mirrored about its local Y axis so that
    // when the board is flipped to view from the back, the text reads
    // correctly. In the editor's top-down view, bottom text therefore
    // appears mirrored.
    const mirror = isBottomLayer(text.layer) ? -1 : 1;
    g.setAttribute('transform',
        `translate(${text.x},${text.y}) rotate(${-text.rotation}) scale(${mirror},1)`);
    g.setAttribute('fill', 'none');
    g.setAttribute('stroke', strokeOverride || textColorForLayer(text.layer));
    g.setAttribute('stroke-width', String(text.strokeWidth));
    g.setAttribute('stroke-opacity', '0.9');
    g.setAttribute('stroke-linecap', 'round');
    g.setAttribute('stroke-linejoin', 'round');
    g.setAttribute('pointer-events', 'stroke');
    // Text origin: baseline-left at (0,0). We draw at (0, 0) here because
    // the group already translates. SVG-Y-down → yUp=false.
    for (const poly of stringToPolylines(text.content, 0, 0, text.size, false)) {
        if (poly.length < 2) continue;
        const pl = document.createElementNS(NS, 'polyline');
        pl.setAttribute('points', poly.map(p => `${p.x},${p.y}`).join(' '));
        g.appendChild(pl);
    }
    return g;
}

/**
 * Axis-aligned bounding box of `text` in world (SVG-Y-down) coords,
 * accounting for rotation. Returns `{minX, minY, maxX, maxY}` in mm.
 */
export function pcbTextBounds(text) {
    const w = measureText(text.content, text.size);
    const mirror = isBottomLayer(text.layer) ? -1 : 1;
    // Local (unrotated, baseline-left) box. Stroke font ascends from y=0
    // (baseline) to y=-size (cap top) in SVG-Y-down. When mirrored, the
    // box is reflected across the local Y axis: x range [-w, 0] vs [0, w].
    const x0 = mirror === 1 ? 0 : -w;
    const x1 = mirror === 1 ? w : 0;
    const localCorners = [
        [x0, 0],
        [x1, 0],
        [x1, -text.size],
        [x0, -text.size],
    ];
    const rad = -text.rotation * Math.PI / 180; // negate to match render
    const cos = Math.cos(rad), sin = Math.sin(rad);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [lx, ly] of localCorners) {
        const wx = text.x + lx * cos - ly * sin;
        const wy = text.y + lx * sin + ly * cos;
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
    }
    return { minX, minY, maxX, maxY };
}

/**
 * Test whether `(x, y)` (world mm) lies inside the text's rotated
 * bounding box. Used by the select tool for hit-testing.
 *
 * The hit box is padded generously beyond the cap-height box so
 * descenders (g, y, p, …) and a comfortable click target are included.
 */
export function pcbTextHitTest(text, x, y) {
    const w = measureText(text.content, text.size);
    const mirror = isBottomLayer(text.layer) ? -1 : 1;
    // Inverse-rotate the point into the text's local frame, then undo
    // the mirror so we can compare against the un-mirrored [0, w] box.
    const rad = -text.rotation * Math.PI / 180;
    const cos = Math.cos(-rad), sin = Math.sin(-rad);
    const dx = x - text.x, dy = y - text.y;
    const lx = (dx * cos - dy * sin) * mirror;
    const ly = dx * sin + dy * cos;
    // Generous padding so click targets are easy to hit at any zoom:
    // half a cap-height on each side horizontally and above the cap,
    // and 60% below the baseline (covers descenders + slack).
    const padX = text.size * 0.5;
    const padTop = text.size * 0.5;
    const padBot = text.size * 0.6;
    return lx >= -padX && lx <= w + padX
        && ly <= padBot && ly >= -(text.size + padTop);
}

/**
 * Serialise to a JSON-safe plain object. Mirrors the constructor shape.
 */
export function serializePcbText(text) {
    return {
        id: text.id,
        content: text.content,
        x: text.x,
        y: text.y,
        size: text.size,
        rotation: text.rotation,
        layer: text.layer,
        strokeWidth: text.strokeWidth,
    };
}

/**
 * Decompose a copper text into the autorouter's native segment obstacles,
 * one per stroked-glyph line, so the router treats the text as real copper
 * (a keepout) rather than empty space.
 *
 * Each returned obstacle is a `{kind:'segment', x1,y1,x2,y2, width, layer}`
 * descriptor (see CopperObstacle in autorouter-common.js), in world (board
 * mm) coordinates, with `width` = the text stroke width and `layer` in the
 * router's 'top'|'bottom' form.
 *
 * Intended for copper-layer text only; silk text is not copper and should
 * not be passed here.
 *
 * @param {object} text
 * @returns {Array<{kind:'segment',x1:number,y1:number,x2:number,y2:number,width:number,layer:string}>}
 */
export function pcbTextObstacles(text) {
    const routerLayer = isBottomLayer(text.layer) ? 'bottom' : 'top';
    const width = text.strokeWidth > 0 ? text.strokeWidth : 0.15;
    const mirror = isBottomLayer(text.layer) ? -1 : 1;
    const rad = -text.rotation * Math.PI / 180; // negate to match render
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const toWorld = (lx, ly) => ({
        x: text.x + (mirror * lx) * cos - ly * sin,
        y: text.y + (mirror * lx) * sin + ly * cos,
    });
    const segments = [];
    for (const poly of stringToPolylines(text.content, 0, 0, text.size, false)) {
        if (poly.length < 2) continue;
        for (let i = 0; i < poly.length - 1; i++) {
            const a = toWorld(poly[i].x, poly[i].y);
            const b = toWorld(poly[i + 1].x, poly[i + 1].y);
            segments.push({ kind: 'segment', x1: a.x, y1: a.y, x2: b.x, y2: b.y, width, layer: routerLayer });
        }
    }
    return segments;
}
