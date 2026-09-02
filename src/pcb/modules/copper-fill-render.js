/**
 * Copper-fill rendering.
 *
 * Draws the computed pour geometry (real polygons with holes) for a
 * CopperFill onto its copper layer's fill group, plus a dashed boundary
 * showing the user-authored region outline (so the region stays visible
 * and selectable even where copper has been etched away).
 *
 * The poured copper sits in a dedicated 'top-fill' / 'bottom-fill' layer
 * group that is ordered *below* the matching copper traces/pads, so
 * tracks and pads paint on top of the pour.
 */

import { pcbLayerSelectionColor } from './layers.js';

const NS = 'http://www.w3.org/2000/svg';

/** Map a copper layer id to its fill layer-group id. */
export function fillGroupId(layer) {
    return layer === 'bottom-copper' ? 'bottom-fill' : 'top-fill';
}

/** Fill copper colour for a layer. */
function layerColor(layer) {
    return layer === 'bottom-copper' ? '#3498db' : '#e74c3c';
}

/**
 * Render (or re-render) a copper fill.
 * @param {import('../../shapes/copper-fill.js').CopperFill} fill
 * @param {(id:string)=>SVGGElement} getLayerGroup
 * @param {object} [opts]
 * @param {boolean} [opts.selected]
 * @param {boolean} [opts.visible] - global fill visibility
 * @param {boolean} [opts.outlineOnly] - omit computed copper during live outline edits
 */
export function renderCopperFill(fill, getLayerGroup, opts = {}) {
    removeCopperFillElements(fill, getLayerGroup);
    const visible = opts.visible !== false && fill.visible !== false;
    const group = getLayerGroup(fillGroupId(fill.layer));
    if (!group) return;

    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'pcb-fill');
    g.setAttribute('data-fill-id', fill.id);
    if (!visible) g.setAttribute('display', 'none');

    const color = layerColor(fill.layer);

    // ── Poured copper polygons (outer + holes, even-odd) ──
    const d = opts.outlineOnly ? '' : computedPathD(fill._computed);
    if (d) {
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('class', 'pcb-fill-copper');
        path.setAttribute('d', d);
        path.setAttribute('fill', color);
        path.setAttribute('fill-opacity', '0.45');
        path.setAttribute('fill-rule', 'evenodd');
        path.setAttribute('stroke', 'none');
        path.setAttribute('data-fill-id', fill.id);
        g.appendChild(path);
    }

    // ── Region boundary (dashed) ──
    if (fill.outline && fill.outline.length >= 2) {
        const poly = document.createElementNS(NS, 'polygon');
        poly.setAttribute('class', 'pcb-fill-outline');
        poly.setAttribute('points', fill.outline.map((p) => `${p.x},${p.y}`).join(' '));
        poly.setAttribute('fill', 'none');
        poly.setAttribute('stroke', opts.selected ? pcbLayerSelectionColor(fill.layer) : color);
        poly.setAttribute('stroke-width', opts.selected ? '0.18' : '0.12');
        poly.setAttribute('stroke-dasharray', '0.6,0.4');
        poly.setAttribute('stroke-opacity', opts.selected ? '1' : '0.8');
        poly.setAttribute('data-fill-id', fill.id);
        g.appendChild(poly);
    }

    group.appendChild(g);
}

/** Remove all SVG elements for a fill from its fill group. */
export function removeCopperFillElements(fill, getLayerGroup) {
    // The fill may have changed layer; clear from both fill groups.
    for (const gid of ['top-fill', 'bottom-fill']) {
        const group = getLayerGroup(gid);
        if (!group) continue;
        for (const el of [...group.querySelectorAll(`[data-fill-id="${cssEscape(fill.id)}"]`)]) {
            // Only remove the wrapping <g> (children go with it).
            if (el.parentNode === group) el.remove();
        }
    }
}

/** Build an SVG path `d` from computed ExPolygons (outer + holes). */
function computedPathD(computed) {
    if (!Array.isArray(computed) || computed.length === 0) return '';
    const parts = [];
    for (const ex of computed) {
        if (ex.outer && ex.outer.length >= 3) parts.push(ringToSubpath(ex.outer));
        for (const hole of (ex.holes || [])) {
            if (hole.length >= 3) parts.push(ringToSubpath(hole));
        }
    }
    return parts.join(' ');
}

function ringToSubpath(ring) {
    let s = `M ${fmt(ring[0].x)} ${fmt(ring[0].y)}`;
    for (let i = 1; i < ring.length; i++) s += ` L ${fmt(ring[i].x)} ${fmt(ring[i].y)}`;
    return s + ' Z';
}

function fmt(v) {
    return Math.round(v * 1000) / 1000;
}

function cssEscape(s) {
    return String(s).replace(/["\\]/g, '\\$&');
}
