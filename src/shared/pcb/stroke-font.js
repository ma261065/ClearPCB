/**
 * Stroked vector font used for PCB silkscreen text. Each glyph is
 * authored in a 1mm-tall cell with its own proportional width, with
 * Y going up (1 = top of cap). Shared by the editor (so labels
 * render as polylines on screen) and the Gerber exporter, so the
 * on-screen and exported text are visually identical.
 */

import { HERSHEY } from './hershey-data.js';
import { EXTRA_GLYPHS } from './stroke-font-extras.js';

/** @typedef {import('./stroke-font-extras.js').StrokeGlyph} StrokeGlyph */
/** @typedef {import('../../core/geometry.js').Point} Point */

/** @type {Record<string, StrokeGlyph>} Stroked glyph table: { char: { w: cellWidth, s: [stroke,...] } } */
export const GLYPHS = { .../** @type {Record<string, StrokeGlyph>} */ (/** @type {unknown} */ (HERSHEY)), ...EXTRA_GLYPHS };

/** Letter spacing (in glyph cells, multiply by size). Hershey glyphs
 * already include side bearings, so a small extra value gives natural spacing. */
export const TRACKING = 0.05;

/**
 * Measure the rendered width of a string at the given size (mm).
 * @param {string} text
 * @param {number} size
 * @returns {number}
 */
export function measureText(text, size) {
    let w = 0;
    let count = 0;
    for (const ch of text) {
        const g = GLYPHS[ch];
        w += (g ? g.w : 0.6) * size;
        count++;
    }
    if (count > 1) w += TRACKING * size * (count - 1);
    return w;
}

/**
 * Convert a string into a list of polylines in world-mm.
 * Origin `(x, y)` is the left edge / baseline of the text. `y` follows the
 * caller's Y convention: pass `yUp=true` if positive Y goes up (e.g. Gerber),
 * `false` for SVG-Y-down. The result is a list of polylines, each an
 * array of `{x, y}` points in the caller's coordinate system.
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {number} size
 * @param {boolean} [yUp]
 * @returns {Point[][]}
 */
export function stringToPolylines(text, x, y, size, yUp = false) {
    /** @type {Point[][]} */
    const segs = [];
    let cx = x;
    const sy = yUp ? 1 : -1;
    for (const ch of text) {
        const glyph = GLYPHS[ch];
        if (glyph) {
            for (const stroke of glyph.s) {
                segs.push(stroke.map(([gx, gy]) => ({
                    x: cx + gx * size,
                    y: y + sy * gy * size,
                })));
            }
            cx += glyph.w * size + TRACKING * size;
        } else {
            const w = 0.6 * size;
            segs.push([
                { x: cx, y },
                { x: cx + w, y },
                { x: cx + w, y: y + sy * size },
                { x: cx, y: y + sy * size },
                { x: cx, y },
            ]);
            cx += w + TRACKING * size;
        }
    }
    return segs;
}
