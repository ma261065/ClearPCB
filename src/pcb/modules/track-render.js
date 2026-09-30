/**
 * Track rendering for the PCB editor
 *
 * Renders Track and Via shapes into PCB layer groups as SVG elements.
 * Each Track is split into per-layer polylines so that edges on different
 * copper layers (separated by implicit vias) appear on their respective
 * layer groups with the correct colour.
 *
 * Rendering strategy:
 *   - A Track with all edges on one layer ⇒ one <polyline> on that layer
 *     (single stroke, single clearance halo).
 *   - A Track that spans two layers ⇒ one <polyline> per contiguous run
 *     of same-layer edges. The implicit-via nodes (where layers change)
 *     are rendered as <circle> ring + drill on the hole layer.
 *   - Standalone Via shapes render as an opaque annular <path> with an open bore.
 *
 * All rendered elements carry data-track-id (or data-via-id) for hit
 * testing and incremental cleanup.
 */

import { resolveTrackEdgePaths } from './board-geometry.js';
import { renderDrillBore } from './drill-bore.js';

const NS = 'http://www.w3.org/2000/svg';

/** CSS class applied to every Track polyline. */
const TRACK_CLASS = 'pcb-track';

/** CSS class applied to via rings and drills. */
const VIA_CLASS = 'pcb-via';

/** @type {WeakMap<object, SVGElement[]>} */
const trackElements = new WeakMap();
/** @type {WeakMap<object, SVGElement[]>} */
const viaElements = new WeakMap();

/**
 * Render a Track into the supplied layer groups, removing any prior
 * SVG it owned. Safe to call repeatedly.
 *
 * @param {object} track - Track instance
 * @param {(layerId: string) => SVGGElement|null} getLayerGroup
 * @param {object} [opts]
 * @param {string} [opts.topColor='#e74c3c']
 * @param {string} [opts.bottomColor='#2479b5']
 */
export function renderTrack(track, getLayerGroup, opts = {}) {
    removeTrackElements(track);

    const topColor = opts.topColor || '#e74c3c';
    const bottomColor = opts.bottomColor || '#2479b5';

    if (track.edges.size === 0) return;

    // Build per-layer polyline runs by walking contiguous same-layer paths.
    const runs = buildTrackLayerRuns(track);

    const created = [];
    for (const run of runs) {
        const layerId = run.layer;
        const parent = getLayerGroup(layerId);
        if (!parent) continue;
        const labelParent = getLayerGroup(`${layerId}-track-labels`) || parent;

        const color = layerId === 'bottom-copper' ? bottomColor : topColor;
        const polyline = document.createElementNS(NS, 'polyline');
        polyline.setAttribute('class', TRACK_CLASS);
        polyline.setAttribute('points', run.points.map(p => `${p.x},${p.y}`).join(' '));
        polyline.setAttribute('fill', 'none');
        polyline.setAttribute('stroke', color);
        polyline.setAttribute('stroke-width', String(run.width));
        polyline.setAttribute('stroke-linecap', 'round');
        polyline.setAttribute('stroke-linejoin', 'round');
        polyline.setAttribute('stroke-opacity', '0.9');
        polyline.dataset.trackId = track.id;
        if (track.net) polyline.dataset.net = track.net;
        polyline.dataset.layer = layerId;
        parent.appendChild(polyline);
        created.push(polyline);

        // Net-name labels along the run.
        if (track.net && !opts.hideNetLabel) {
            for (const lbl of _buildNetLabels(run.points, track.net, run.width)) {
                labelParent.appendChild(lbl);
                lbl.dataset.trackId = track.id;
                created.push(lbl);
            }
        }
    }

    // Layer-change nodes are NOT drawn here. Vias are independent
    // `Via` shapes (see PCBApp.vias / renderVia). A Track that changes
    // layer without a colocated Via simply shows an in-air vertex.

    trackElements.set(track, created);
}

/**
 * Render a standalone Via on the hole layer.
 *
 * @param {object} via - Via instance
 * @param {(layerId: string) => SVGGElement|null} getLayerGroup
 * @param {object} [opts]
 */
export function viaCopperPathD(via) {
    const outerRadius = via.diameter / 2;
    const drillRadius = Number.isFinite(via.drill) ? Math.max(0, via.drill / 2) : 0;
    let path = `M${via.x + outerRadius},${via.y}`
        + `A${outerRadius},${outerRadius} 0 1 0 ${via.x - outerRadius},${via.y}`
        + `A${outerRadius},${outerRadius} 0 1 0 ${via.x + outerRadius},${via.y}Z`;
    if (drillRadius > 0) {
        path += `M${via.x + drillRadius},${via.y}`
            + `A${drillRadius},${drillRadius} 0 1 0 ${via.x - drillRadius},${via.y}`
            + `A${drillRadius},${drillRadius} 0 1 0 ${via.x + drillRadius},${via.y}Z`;
    }
    return path;
}

export function renderVia(via, getLayerGroup, opts = {}) {
    removeViaElements(via);

    const viaLayer = getLayerGroup('vias');
    if (!viaLayer) return;

    const ringColor = opts.viaRingColor || '#b8860b';
    const ring = document.createElementNS(NS, 'path');
    ring.setAttribute('d', viaCopperPathD(via));
    ring.setAttribute('fill', ringColor);
    ring.setAttribute('fill-rule', 'evenodd');
    ring.setAttribute('class', VIA_CLASS);
    ring.setAttribute('fill-opacity', '1');
    ring.setAttribute('data-via-x', String(via.x));
    ring.setAttribute('data-via-y', String(via.y));
    ring.setAttribute('data-via-radius', String(via.diameter / 2));
    ring.dataset.viaId = via.id;
    if (via.net) ring.dataset.net = via.net;
    viaLayer.appendChild(ring);

    const created = [ring];
    const drill = renderDrillBore(via, viaLayer, `${VIA_CLASS} pcb-via-drill`, 'via');
    if (drill) created.push(drill);

    viaElements.set(via, created);
}

/** Remove every SVG element this Track previously created. */
export function removeTrackElements(track) {
    for (const el of trackElements.get(track) || []) el.remove();
    trackElements.delete(track);
}

/** Whether this track has a registered render, including an empty hidden-layer render. */
export function hasTrackElements(track) {
    return trackElements.has(track);
}

/** Remove every SVG element this Via previously created. */
export function removeViaElements(via) {
    for (const el of viaElements.get(via) || []) el.remove();
    viaElements.delete(via);
}

/** Show/hide existing net labels; false tells selection to rebuild omitted labels. */
export function setTrackLabelsVisible(track, visible) {
    let found = false;
    for (const el of trackElements.get(track) || []) {
        if (el.getAttribute('class') === 'pcb-track-label') {
            el.style.display = visible ? '' : 'none';
            found = true;
        }
    }
    return found;
}

/* ──────────────────────────── internals ──────────────────────────── */

/**
 * Walk the Track graph and yield contiguous same-layer runs as
 * {layer, points[]} so each run can become a single polyline.
 *
 * For Phase 1 the autorouter emits one Track per (net, layer) so every
 * Track has exactly one run. The general algorithm below still works
 * for Phase 2 multi-layer Tracks: it walks the graph from each
 * degree-≤1 endpoint, breaking runs at any node whose adjacent edges
 * change layer.
 */
export function buildTrackLayerRuns(track) {
    const runs = [];
    if (track.edges.size === 0) return runs;
    const paths = resolveTrackEdgePaths(track);

    // Build adjacency: nodeId → [{edgeId, otherNodeId, layer, width}]
    const adj = new Map();
    for (const nid of track.nodes.keys()) adj.set(nid, []);
    for (const [eid, e] of track.edges) {
        const lyr = track.getEdgeLayer(eid);
        const w = track.getEdgeWidth(eid);
        adj.get(e.from)?.push({ edgeId: eid, other: e.to, layer: lyr, width: w });
        adj.get(e.to)?.push({ edgeId: eid, other: e.from, layer: lyr, width: w });
    }

    const visitedEdges = new Set();

    // Pick a deterministic start order: endpoint nodes (degree 1) first,
    // then any remaining nodes (handles ring topologies).
    const startOrder = [];
    for (const [nid, list] of adj) if (list.length === 1) startOrder.push(nid);
    for (const [nid, list] of adj) if (list.length !== 1) startOrder.push(nid);

    for (const startNid of startOrder) {
        // From this start node, follow each unvisited outgoing edge.
        for (const initial of adj.get(startNid) || []) {
            if (visitedEdges.has(initial.edgeId)) continue;

            // Walk a single contiguous same-layer, same-width run.
            const points = [];
            const startPt = track.nodes.get(startNid);
            if (!startPt) continue;

            let currentNid = startNid;
            let currentLayer = initial.layer;
            let currentWidth = initial.width;
            let next = initial;

            while (next && !visitedEdges.has(next.edgeId)
                && next.layer === currentLayer && next.width === currentWidth) {
                visitedEdges.add(next.edgeId);
                const np = track.nodes.get(next.other);
                if (!np) break;
                const path = paths.get(next.edgeId);
                if (!path) break;
                const oriented = track.edges.get(next.edgeId).from === currentNid ? path : [...path].reverse();
                points.push(...(points.length ? oriented.slice(1) : oriented));
                currentNid = next.other;

                // Find next unvisited edge on the same layer AND width at
                // currentNid (excluding the one we just traversed). For a
                // degree-≥3 junction, layer change, or width change we stop
                // the run here.
                const candidates = (adj.get(currentNid) || []).filter(
                    a => !visitedEdges.has(a.edgeId)
                        && a.layer === currentLayer && a.width === currentWidth
                );
                if (candidates.length === 1) {
                    next = candidates[0];
                } else {
                    next = null;
                }
            }

            if (points.length >= 2) runs.push({ layer: currentLayer, width: currentWidth, points });
        }
    }

    return runs;
}

/** Spacing between net-name labels along a track run, in mm. */
const LABEL_INTERVAL_MM = 12;

/** Upper bound on the net-label font (mm) so fat traces don't get huge text. */
const MAX_LABEL_FONT_MM = 0.4;

/**
 * Build a single rotated net-name `<text>` element centred on (x, y).
 * @param {number} x
 * @param {number} y
 * @param {number} angle - degrees, already clamped upright
 * @param {number} fontSize - mm
 * @param {string} netName
 * @returns {SVGTextElement}
 */
function _makeNetLabel(x, y, angle, fontSize, netName) {
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', String(x));
    text.setAttribute('y', String(y));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('font-size', String(fontSize));
    text.setAttribute('font-family', 'sans-serif');
    text.setAttribute('fill', '#ffffff');
    text.setAttribute('fill-opacity', '0.9');
    text.setAttribute('pointer-events', 'none');
    text.setAttribute('transform', `rotate(${angle.toFixed(2)} ${x} ${y})`);
    text.setAttribute('class', 'pcb-track-label');
    text.textContent = netName;
    return text;
}

/**
 * Generate `<text>` elements with the net name placed along the polyline
 * `points`. Each label is rotated to its segment direction, kept upright
 * (no upside-down text), and scaled relative to the track width so it sits
 * visually on the trace.
 *
 * Labels are placed *per straight segment* and constrained so the whole
 * rotated string fits between the segment's endpoints — they never cross a
 * bend or overhang a corner into empty space. Segments too short to host
 * the text get no label.
 *
 * @param {Array<{x:number,y:number}>} points
 * @param {string} netName
 * @param {number} trackWidth - in mm
 * @returns {SVGTextElement[]}
 */
function _buildNetLabels(points, netName, trackWidth) {
    const labels = [];
    if (!netName || points.length < 2) return labels;

    // Font sized just inside the track width so the label reads as "on" the
    // copper. At low zoom the on-screen text shrinks below readable size and
    // effectively disappears. The size scales down with the track width but is
    // capped so fat traces (power/ground pours) don't get oversized labels.
    const fontSize = Math.min((trackWidth || 0.2) * 0.7, MAX_LABEL_FONT_MM);
    // Approximate rendered length of the string along its baseline
    // (~0.62 em per average sans-serif glyph), plus a small margin so glyphs
    // never reach a bend.
    const textLen = netName.length * fontSize * 0.62;
    const minSeg = textLen + fontSize * 0.6;

    for (let i = 0; i < points.length - 1; i++) {
        const a = points[i];
        const b = points[i + 1];
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        // Skip segments too short to host the whole label without overhanging
        // the bend at either end.
        if (segLen < minSeg) continue;

        const ux = (b.x - a.x) / segLen;
        const uy = (b.y - a.y) / segLen;

        // Angle of the segment in degrees; keep text upright.
        let angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
        if (angle > 90) angle -= 180;
        else if (angle < -90) angle += 180;

        // The label centre may range over [textLen/2, segLen - textLen/2] so
        // the full string stays within the segment.
        const usable = segLen - textLen;
        const n = Math.max(1, Math.floor(segLen / LABEL_INTERVAL_MM));
        for (let k = 0; k < n; k++) {
            const frac = n === 1 ? 0.5 : k / (n - 1);
            const d = textLen / 2 + usable * frac;
            const x = a.x + ux * d;
            const y = a.y + uy * d;
            labels.push(_makeNetLabel(x, y, angle, fontSize, netName));
        }
    }
    return labels;
}
