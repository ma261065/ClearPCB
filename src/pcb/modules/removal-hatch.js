import { normalizeShapeCopperMode } from '../../shared/pcb/board-shape-geometry.js';

/*
 * Copper-removal hatching: removal shapes are filled with an SVG hatch pattern coloured
 * by removal mode, so anything stacked above the shape's layer (holes, silk) covers the
 * hatch. The patterns live in the editor's <defs>, one per mode, and are sized in board
 * millimetres, so the hatch zooms with the board. Exports strip it: it is an on-screen aid.
 */

const HATCH_COLORS = {
    'remove-copper': '#5f6770',
    'remove-solder-mask': '#8a6923',
    'remove-copper-mask': '#7c3b4c',
};

/** Hatch tile side, lines per tile and line width, in board millimetres (lines 0.6 mm apart). */
const HATCH_TILE_MM = 1.8;
const HATCH_LINES_PER_TILE = 3;
const HATCH_LINE_MM = 0.1;

const HATCH_ID_PREFIX = 'pcb-removal-hatch-';

/** The <pattern> element per removal mode, per editor. */
const hatchPatterns = new WeakMap();

/**
 * Tile lines: a square grid for mask removal, a diagonal cross for copper, single
 * diagonals for copper and mask. Lines on tile edges are drawn on both opposite edges
 * so their halves join into full-width lines across tiles.
 */
function hatchTilePath(mode) {
    const t = HATCH_TILE_MM;
    const step = t / HATCH_LINES_PER_TILE;
    const offsets = (from) => Array.from({ length: Math.round((t - from) / step) + 1 }, (_, i) => +(from + i * step).toFixed(4));
    const d = [];
    if (mode === 'remove-solder-mask') {
        for (const offset of offsets(0)) d.push(`M ${offset} 0 V ${t}`, `M 0 ${offset} H ${t}`);
    } else {
        for (const offset of offsets(-t)) {
            d.push(`M ${offset} 0 L ${+(offset + t).toFixed(4)} ${t}`);
            if (mode === 'remove-copper') d.push(`M ${offset} ${t} L ${+(offset + t).toFixed(4)} 0`);
        }
    }
    return d.join(' ');
}

/**
 * SVG paint for a copper-removal shape of this mode. Returns 'none' for additive
 * copper, or when the editor has no SVG (tests, workers).
 */
export function removalHatchFill(app, copperMode) {
    const mode = normalizeShapeCopperMode(copperMode);
    const color = HATCH_COLORS[mode];
    if (!color) return 'none';
    const defs = app._ensureSvgDefs?.();
    if (!defs) return 'none';
    const id = `${HATCH_ID_PREFIX}${mode}`;
    let patterns = hatchPatterns.get(app);
    if (!patterns) hatchPatterns.set(app, patterns = new Map());
    let pattern = patterns.get(mode);
    if (!pattern || pattern.parentNode !== defs) {
        pattern = defs.querySelector(`#${id}`);
        if (!pattern) {
            const NS = 'http://www.w3.org/2000/svg';
            pattern = document.createElementNS(NS, 'pattern');
            pattern.setAttribute('id', id);
            pattern.setAttribute('patternUnits', 'userSpaceOnUse');
            pattern.setAttribute('width', String(HATCH_TILE_MM));
            pattern.setAttribute('height', String(HATCH_TILE_MM));
            const lines = document.createElementNS(NS, 'path');
            lines.setAttribute('d', hatchTilePath(mode));
            lines.setAttribute('fill', 'none');
            lines.setAttribute('stroke', color);
            lines.setAttribute('stroke-width', String(HATCH_LINE_MM));
            pattern.appendChild(lines);
            defs.appendChild(pattern);
        }
        patterns.set(mode, pattern);
    }
    return `url(#${id})`;
}

/** Unfill hatched removal shapes in an exported SVG copy (attribute and inlined style). */
export function stripRemovalHatches(root) {
    const prefix = `url(#${HATCH_ID_PREFIX}`;
    for (const element of root.querySelectorAll(`[fill^="${prefix}"]`)) {
        if (!element.getAttribute('fill')?.startsWith(prefix)) continue;
        element.setAttribute('fill', 'none');
        if (element.style) element.style.fill = 'none';
    }
}
