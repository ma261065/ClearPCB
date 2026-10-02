/**
 * Free-standing PCB text annotations.
 *
 * Text is rendered as stroked polylines using the shared Hershey font
 * (src/shared/pcb/stroke-font.js), so the editor canvas and Gerber
 * export are visually identical.
 *
 * Each text lives on a single layer (top-silk / bottom-silk /
 * top-copper / bottom-copper / top-document / bottom-document). Attributes:
 *   - content      string  the displayed text
 *   - x, y         number  baseline-left in board mm (SVG-Y-down)
 *   - size         number  cap height in mm
 *   - rotation     number  degrees, CCW visually (CW in SVG-Y-down)
 *   - layer        string  one of the layer ids above
 *   - strokeWidth  number  line width in mm
 *   - border       boolean draw a padded rectangular outline
 *
 * Creation assigns an ID if missing; PcbDocument owns the text collection.
 */

import { stringToPolylines, measureText } from '../../shared/pcb/stroke-font.js';
import { PCB_LAYERS } from './layers.js';
export { TEXT_LAYERS, createPcbText, serializePcbText } from '../../core/pcb-text.js';

const NS = 'http://www.w3.org/2000/svg';

/** True if the given text layer id is a bottom-side layer. */
export function isBottomLayer(layer) {
    return typeof layer === 'string' && layer.startsWith('bottom-');
}

/** Map a text layer id to a stroke colour (matches the layers panel). */
export function textColorForLayer(layer) {
    const def = PCB_LAYERS.find(l => l.id === layer);
    return def?.color || '#cccccc';
}

export function pcbTextEditBox(text, content = text.content) {
    const width = measureText(content, text.size);
    const padX = text.size * 0.4;
    const padTop = text.size * 0.5;
    const padBottom = text.size * 1.25;
    return {
        x: -padX,
        y: -text.size - padTop,
        width: width + padX * 2,
        height: text.size + padTop + padBottom,
    };
}

function pcbTextBorderPolyline(text) {
    const box = pcbTextEditBox(text);
    const right = box.x + box.width;
    const bottom = box.y + box.height;
    return [
        { x: box.x, y: box.y },
        { x: right, y: box.y },
        { x: right, y: bottom },
        { x: box.x, y: bottom },
        { x: box.x, y: box.y },
    ];
}

function pcbTextLocalPolylines(text) {
    const polylines = stringToPolylines(text.content, 0, 0, text.size, false);
    if (!text.border) return polylines;
    polylines.unshift(pcbTextBorderPolyline(text));
    return polylines;
}

function pcbTextLocalBounds(text, includeStroke = true) {
    const polylines = pcbTextLocalPolylines(text);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const polyline of polylines) {
        for (const point of polyline) {
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
        }
    }

    if (!Number.isFinite(minX)) {
        const box = pcbTextEditBox(text);
        return {
            minX: box.x,
            minY: box.y,
            maxX: box.x + box.width,
            maxY: box.y + box.height,
        };
    }

    const strokeRadius = includeStroke ? Math.max(0, Number(text.strokeWidth) || 0) / 2 : 0;
    return {
        minX: minX - strokeRadius,
        minY: minY - strokeRadius,
        maxX: maxX + strokeRadius,
        maxY: maxY + strokeRadius,
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
    for (const poly of pcbTextLocalPolylines(text)) {
        if (poly.length < 2) continue;
        const pl = document.createElementNS(NS, 'polyline');
        pl.setAttribute('points', poly.map(p => `${p.x},${p.y}`).join(' '));
        g.appendChild(pl);
    }
    return g;
}

/** Rotated text bounds as a world-space polygon in SVG-Y-down coordinates. */
export function pcbTextOutline(text, includeStroke = true) {
    const mirror = isBottomLayer(text.layer) ? -1 : 1;
    const localBounds = pcbTextLocalBounds(text, includeStroke);
    const x0 = mirror === 1 ? localBounds.minX : -localBounds.maxX;
    const x1 = mirror === 1 ? localBounds.maxX : -localBounds.minX;
    const localCorners = [
        [x0, localBounds.maxY],
        [x1, localBounds.maxY],
        [x1, localBounds.minY],
        [x0, localBounds.minY],
    ];
    const rad = -text.rotation * Math.PI / 180; // negate to match render
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return localCorners.map(([lx, ly]) => ({
        x: text.x + lx * cos - ly * sin,
        y: text.y + lx * sin + ly * cos,
    }));
}

/**
 * Axis-aligned bounding box of `text` in world (SVG-Y-down) coords,
 * accounting for rotation. Returns `{minX, minY, maxX, maxY}` in mm.
 */
export function pcbTextBounds(text) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const point of pcbTextOutline(text)) {
        if (point.x < minX) minX = point.x;
        if (point.x > maxX) maxX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.y > maxY) maxY = point.y;
    }
    return { minX, minY, maxX, maxY };
}

/**
 * Test whether `(x, y)` (world mm) lies inside the text's rotated
 * bounding box. Used by the select tool for hit-testing.
 *
 * The hit box follows the rendered stroke extents, with a small amount
 * of padding so thin glyph strokes remain easy to click.
 */
export function pcbTextHitTest(text, x, y) {
    const mirror = isBottomLayer(text.layer) ? -1 : 1;
    // Inverse-rotate the point into the text's local frame, then undo
    // the mirror so we can compare against the un-mirrored [0, w] box.
    const rad = -text.rotation * Math.PI / 180;
    const cos = Math.cos(-rad), sin = Math.sin(-rad);
    const dx = x - text.x, dy = y - text.y;
    const lx = (dx * cos - dy * sin) * mirror;
    const ly = dx * sin + dy * cos;
    const bounds = pcbTextLocalBounds(text);
    const tolerance = Math.max(text.strokeWidth / 2, text.size * 0.12);
    return lx >= bounds.minX - tolerance && lx <= bounds.maxX + tolerance
        && ly >= bounds.minY - tolerance && ly <= bounds.maxY + tolerance;
}

/** World-space stroke polylines shared by 2D, 3D, Gerber, and hit consumers. */
export function pcbTextPolylines(text) {
    const localPolylines = pcbTextLocalPolylines(text);
    const radians = (-(text.rotation || 0) * Math.PI) / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const mirror = isBottomLayer(text.layer) ? -1 : 1;
    return localPolylines.map((polyline) => polyline.map((point) => {
        const x = point.x * mirror;
        return {
            x: text.x + x * cosine - point.y * sine,
            y: text.y + x * sine + point.y * cosine,
        };
    }));
}

export function pcbTextSegments(text) {
    const segments = [];
    for (const polyline of pcbTextPolylines(text)) {
        for (let index = 1; index < polyline.length; index++) {
            segments.push([polyline[index - 1], polyline[index]]);
        }
    }
    return segments;
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
            segments.push({ kind: /** @type {'segment'} */ ('segment'), x1: a.x, y1: a.y, x2: b.x, y2: b.y, width, layer: routerLayer });
        }
    }
    return segments;
}
