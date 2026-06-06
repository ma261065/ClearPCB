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
 *   - Standalone Via shapes always render as <circle> ring + drill.
 *
 * All rendered elements carry data-track-id (or data-via-id) for hit
 * testing and incremental cleanup.
 */

const NS = 'http://www.w3.org/2000/svg';

/** CSS class applied to every Track polyline. */
const TRACK_CLASS = 'pcb-track';

/** CSS class applied to via rings and drills. */
const VIA_CLASS = 'pcb-via';

/**
 * Render a Track into the supplied layer groups, removing any prior
 * SVG it owned. Safe to call repeatedly.
 *
 * @param {object} track - Track instance
 * @param {(layerId: string) => SVGGElement|null} getLayerGroup
 * @param {object} [opts]
 * @param {string} [opts.topColor='#e74c3c']
 * @param {string} [opts.bottomColor='#3498db']
 * @param {string} [opts.viaRingColor='#b8860b']
 * @param {string} [opts.viaDrillColor='#1a1a2e']
 * @param {number} [opts.viaDiameter=0.6] - Default ring diameter (mm)
 *   used for implicit vias (layer-change nodes).
 * @param {number} [opts.viaDrill=0.3] - Default drill diameter (mm).
 */
export function renderTrack(track, getLayerGroup, opts = {}) {
    removeTrackElements(track);

    const topColor = opts.topColor || '#e74c3c';
    const bottomColor = opts.bottomColor || '#3498db';
    const viaRingColor = opts.viaRingColor || '#b8860b';
    const viaDrillColor = opts.viaDrillColor || '#1a1a2e';
    const viaDiameter = Number.isFinite(opts.viaDiameter) && opts.viaDiameter > 0
        ? opts.viaDiameter : 0.6;
    const viaDrill = Number.isFinite(opts.viaDrill) && opts.viaDrill > 0
        ? opts.viaDrill : 0.3;

    if (track.edges.size === 0) return;

    // Build per-layer polyline runs by walking contiguous same-layer paths.
    const runs = _buildLayerRuns(track);

    const created = [];
    for (const run of runs) {
        const layerId = run.layer;
        const parent = getLayerGroup(layerId);
        if (!parent) continue;

        const color = layerId === 'bottom-copper' ? bottomColor : topColor;
        const polyline = document.createElementNS(NS, 'polyline');
        polyline.setAttribute('class', TRACK_CLASS);
        polyline.setAttribute('points', run.points.map(p => `${p.x},${p.y}`).join(' '));
        polyline.setAttribute('fill', 'none');
        polyline.setAttribute('stroke', color);
        polyline.setAttribute('stroke-width', String(track.width));
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
            for (const lbl of _buildNetLabels(run.points, track.net, track.width)) {
                parent.appendChild(lbl);
                lbl.dataset.trackId = track.id;
                created.push(lbl);
            }
        }
    }

    // Layer-change nodes are NOT drawn here. Vias are independent
    // `Via` shapes (see PCBApp.vias / renderVia). A Track that changes
    // layer without a colocated Via simply shows an in-air vertex.

    track._svgElements = created;
}

/**
 * Render a standalone Via on the hole layer.
 *
 * @param {object} via - Via instance
 * @param {(layerId: string) => SVGGElement|null} getLayerGroup
 * @param {object} [opts]
 */
export function renderVia(via, getLayerGroup, opts = {}) {
    removeViaElements(via);

    const holeLayer = getLayerGroup('hole');
    if (!holeLayer) return;

    const ringColor = opts.viaRingColor || '#b8860b';
    const drillColor = opts.viaDrillColor || '#1a1a2e';

    const ring = _makeViaCircle(via.x, via.y, via.diameter / 2, ringColor);
    ring.setAttribute('class', VIA_CLASS);
    ring.setAttribute('fill-opacity', '0.9');
    ring.dataset.viaId = via.id;
    if (via.net) ring.dataset.net = via.net;
    holeLayer.appendChild(ring);

    const drill = _makeViaCircle(via.x, via.y, via.drill / 2, drillColor);
    drill.setAttribute('class', VIA_CLASS);
    drill.dataset.viaId = via.id;
    if (via.net) drill.dataset.net = via.net;
    holeLayer.appendChild(drill);

    via._svgElements = [ring, drill];
}

/** Remove every SVG element this Track previously created. */
export function removeTrackElements(track) {
    if (track._svgElements) {
        for (const el of track._svgElements) el.remove();
        track._svgElements = null;
    }
}

/** Remove every SVG element this Via previously created. */
export function removeViaElements(via) {
    if (via._svgElements) {
        for (const el of via._svgElements) el.remove();
        via._svgElements = null;
    }
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
function _buildLayerRuns(track) {
    const runs = [];
    if (track.edges.size === 0) return runs;

    // Build adjacency: nodeId → [{edgeId, otherNodeId, layer}]
    const adj = new Map();
    for (const nid of track.nodes.keys()) adj.set(nid, []);
    for (const [eid, e] of track.edges) {
        const lyr = track.getEdgeLayer(eid);
        adj.get(e.from)?.push({ edgeId: eid, other: e.to, layer: lyr });
        adj.get(e.to)?.push({ edgeId: eid, other: e.from, layer: lyr });
    }

    const visitedEdges = new Set();

    // Pick a deterministic start order: endpoint nodes (degree 1) first,
    // then any remaining nodes (handles ring topologies).
    const startOrder = [];
    for (const [nid, list] of adj) if (list.length === 1) startOrder.push(nid);
    for (const nid of adj.keys()) if (!startOrder.includes(nid)) startOrder.push(nid);

    for (const startNid of startOrder) {
        // From this start node, follow each unvisited outgoing edge.
        for (const initial of adj.get(startNid) || []) {
            if (visitedEdges.has(initial.edgeId)) continue;

            // Walk a single contiguous same-layer run.
            const points = [];
            const startPt = track.nodes.get(startNid);
            if (!startPt) continue;
            points.push({ x: startPt.x, y: startPt.y });

            let currentNid = startNid;
            let currentLayer = initial.layer;
            let next = initial;

            while (next && !visitedEdges.has(next.edgeId) && next.layer === currentLayer) {
                visitedEdges.add(next.edgeId);
                const np = track.nodes.get(next.other);
                if (!np) break;
                points.push({ x: np.x, y: np.y });
                currentNid = next.other;

                // Find next unvisited edge on the same layer at currentNid
                // (excluding the one we just traversed). For a degree-≥3
                // junction or layer change we stop the run here.
                const candidates = (adj.get(currentNid) || []).filter(
                    a => !visitedEdges.has(a.edgeId) && a.layer === currentLayer
                );
                if (candidates.length === 1) {
                    next = candidates[0];
                } else {
                    next = null;
                }
            }

            if (points.length >= 2) runs.push({ layer: currentLayer, points });
        }
    }

    return runs;
}

function _makeViaCircle(cx, cy, r, fillColor) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', String(cx));
    c.setAttribute('cy', String(cy));
    c.setAttribute('r', String(r));
    c.setAttribute('fill', fillColor);
    c.setAttribute('class', VIA_CLASS);
    return c;
}

/** Spacing between net-name labels along a track run, in mm. */
const LABEL_INTERVAL_MM = 12;

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
    // effectively disappears.
    const fontSize = (trackWidth || 0.2) * 0.7;
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

