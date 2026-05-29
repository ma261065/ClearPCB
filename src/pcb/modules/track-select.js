/**
 * Selection + manipulation of finished Tracks and Vias on the PCB tab.
 *
 * Phase 4 scope:
 *   - Hit-test a world position against existing tracks/vias.
 *   - Select / deselect with a coloured halo overlay.
 *   - Delete the selected object (and trigger ratsnest reconciliation).
 *   - Edit the selected track's width / via's diameter live from the
 *     Properties panel.
 *
 * Out of scope (deferred):
 *   - Vertex/segment dragging.
 *   - Undo/redo (PCBApp has no CommandHistory yet).
 *   - Multi-selection.
 */

import { removeTrackElements, removeViaElements } from './track-render.js';
import { reconcileRatsnest } from './track-draw.js';
import {
    RemoveTrackCommand,
    RemoveViaCommand,
    ModifyTrackCommand,
    ModifyViaCommand,
} from './track-commands.js';

const NS = 'http://www.w3.org/2000/svg';
const HALO_CLASS = 'pcb-track-selection';
const HOVER_CLASS = 'pcb-track-hover';

/** Halo stroke colour — translucent white overlays the trace so the
 *  underlying copper colour still reads through. */
const HALO_COLOR = '#ffffff';
const HALO_OPACITY_SELECTED = 0.85;
const HALO_OPACITY_HOVER = 0.6;

/** Pixel tolerance for hit-testing tracks (converted to world units). */
const HIT_TOL_PX = 6;

/* ──────────────────────────── hit testing ──────────────────────────── */

/**
 * Find the topmost track/via under `worldPos` (vias preferred).
 * @returns {{type:'track', track:object}|{type:'via', via:object}|null}
 */
export function hitTestTrack(app, worldPos, pxTol = HIT_TOL_PX) {
    const scale = app.viewport?.scale || 1;
    const worldTol = pxTol / scale;

    // Vias first (smaller targets, should win over coincident traces).
    for (let i = app.vias.length - 1; i >= 0; i--) {
        const v = app.vias[i];
        const r = (v.diameter || 0.6) / 2 + worldTol;
        if (Math.hypot(v.x - worldPos.x, v.y - worldPos.y) <= r) {
            return { type: 'via', via: v };
        }
    }

    // Tracks: distance to any segment within (width/2 + tol).
    for (let i = app.tracks.length - 1; i >= 0; i--) {
        const t = app.tracks[i];
        const half = (t.width || 0.2) / 2 + worldTol;
        for (const e of t.edges.values()) {
            const a = t.nodes.get(e.from);
            const b = t.nodes.get(e.to);
            if (!a || !b) continue;
            if (_pointSegDist(worldPos, a, b) <= half) {
                return { type: 'track', track: t };
            }
        }
    }
    return null;
}

function _pointSegDist(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const wx = p.x - a.x, wy = p.y - a.y;
    const len2 = vx * vx + vy * vy;
    if (len2 < 1e-12) return Math.hypot(wx, wy);
    let t = (wx * vx + wy * vy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/* ──────────────────────────── selection ──────────────────────────── */

/**
 * Set the current track/via selection. Pass `null` to clear.
 * @param {object} app
 * @param {{type:'track', track:object}|{type:'via', via:object}|null} hit
 */
export function selectTrackOrVia(app, hit) {
    clearTrackSelection(app);
    // Clear any hover halo for the now-selected item so the two highlights
    // don't stack.
    _removeHalos(app, HOVER_CLASS);
    app._hoveredTrackOrVia = null;
    if (!hit) {
        app._clearProperties?.();
        return;
    }
    if (hit.type === 'track') {
        app._selectedTrack = hit.track;
        _drawTrackHalo(app, hit.track);
        _showTrackProperties(app, hit.track);
    } else {
        app._selectedVia = hit.via;
        _drawViaHalo(app, hit.via);
        _showViaProperties(app, hit.via);
    }
}

/** Remove any track/via selection halos and clear stored references. */
export function clearTrackSelection(app) {
    app._selectedTrack = null;
    app._selectedVia = null;
    _removeHalos(app, HALO_CLASS);
}

/**
 * Re-draw the selection halo for the currently-selected track/via.
 * Call this after the underlying track has been re-rendered (e.g.
 * during a vertex drag) so the halo follows the new geometry.
 */
export function refreshTrackSelectionHalo(app) {
    _removeHalos(app, HALO_CLASS);
    if (app._selectedTrack) _drawTrackHalo(app, app._selectedTrack, HALO_CLASS, HALO_OPACITY_SELECTED);
    else if (app._selectedVia) _drawViaHalo(app, app._selectedVia, HALO_CLASS, HALO_OPACITY_SELECTED);
}

/**
 * Set the currently-hovered track/via highlight. Pass `null` to clear.
 * No-op when the same object is already selected (the selection halo
 * already covers it).
 */
export function setHoverHighlight(app, hit) {
    const key = hit
        ? (hit.type === 'track' ? hit.track
            : hit.type === 'via' ? hit.via
            : hit.type === 'pad' ? `pad:${hit.componentId}|${hit.pinNumber}`
            : null)
        : null;
    if (app._hoveredTrackOrVia === key) return;
    app._hoveredTrackOrVia = key;
    _removeHalos(app, HOVER_CLASS);
    if (!hit) return;
    if (hit.type === 'track' || hit.type === 'pad') {
        // Highlight the whole connected copper network reachable from
        // this seed — follows pad↔track links and stitches through any
        // via whose position coincides with a track node (so layer
        // changes and T-junctions all light up together).
        const seed = hit.type === 'track'
            ? { type: 'track', track: hit.track }
            : { type: 'pad', componentId: hit.componentId, pinNumber: hit.pinNumber };
        const net = _collectConnectedNet(app, seed);
        for (const track of net.tracks) {
            if (track === app._selectedTrack) continue;
            _drawTrackHalo(app, track, HOVER_CLASS, HALO_OPACITY_HOVER);
        }
        for (const via of net.vias) {
            if (via === app._selectedVia) continue;
            _drawViaHalo(app, via, HOVER_CLASS, HALO_OPACITY_HOVER);
        }
        for (const padKey of net.pads) {
            const [componentId, pinNumber] = padKey.split('|');
            _drawSinglePadHighlight(app, componentId, pinNumber, HOVER_CLASS, HALO_OPACITY_HOVER);
        }
    } else if (hit.type === 'via' && hit.via !== app._selectedVia) {
        _drawViaHalo(app, hit.via, HOVER_CLASS, HALO_OPACITY_HOVER);
    }
}

/**
 * Walk the connected-copper graph starting from a pad (or track).
 * Edges of connectivity:
 *   - Track ↔ pad via track.padConnections.
 *   - Track ↔ Via when a track node coincides (within 0.01 mm) with
 *     a Via's position. A via stitches together tracks meeting at
 *     its location regardless of layer.
 *   - Pad ↔ pad indirectly through any shared track / via chain.
 *
 * Returns sets of tracks, vias and pad-keys ("componentId|pinNumber")
 * reachable from the seed.
 */
function _collectConnectedNet(app, seed) {
    const tracks = new Set();
    const vias = new Set();
    const pads = new Set();

    // Position lookup for vias (0.01 mm bucket).
    const viaByPos = new Map();
    for (const v of app.vias || []) {
        viaByPos.set(_posKey(v.x, v.y), v);
    }

    // Resolve a net name from the seed. If we have one, pull in every
    // track / via / pad sharing that net name up-front — that catches
    // electrically-equivalent copper that isn't physically touching
    // (e.g. two isolated tracks both labelled VCC, or a pad with no
    // routed copper at all).
    let netName = '';
    if (seed.type === 'track') {
        netName = seed.track.net || '';
    } else if (seed.type === 'pad') {
        netName = _netForPad(app, seed.componentId, seed.pinNumber);
    }

    if (netName) {
        for (const t of app.tracks || []) {
            if (t.net === netName) tracks.add(t);
        }
        for (const v of app.vias || []) {
            if (v.net === netName) vias.add(v);
        }
        // Every pad on this net (from the netlist), whether routed or not.
        const netEntry = (app.netlist || []).find((n) => n.net === netName);
        if (netEntry) {
            for (const pin of netEntry.pins || []) {
                pads.add(`${pin.componentId}|${pin.pinNumber}`);
            }
        }
    }

    // Queue of items to process. Each entry is one of:
    //   { kind:'track', track }
    //   { kind:'via', via }
    //   { kind:'pad', key }   // key = "componentId|pinNumber"
    const queue = [];
    if (seed.type === 'pad') {
        const k = `${seed.componentId}|${seed.pinNumber}`;
        pads.add(k);
        queue.push({ kind: 'pad', key: k });
    } else if (seed.type === 'track') {
        tracks.add(seed.track);
        queue.push({ kind: 'track', track: seed.track });
    }
    // Seed the queue with everything we collected by net name so
    // downstream BFS can still pick up unnamed neighbours (e.g. a stub
    // track with no net assigned that touches a named track).
    for (const t of tracks) queue.push({ kind: 'track', track: t });
    for (const v of vias) queue.push({ kind: 'via', via: v });
    for (const k of pads) queue.push({ kind: 'pad', key: k });

    while (queue.length) {
        const item = queue.shift();
        if (item.kind === 'pad') {
            // Find every track that lists this pad in padConnections.
            const [componentId, pinNumber] = item.key.split('|');
            for (const t of app.tracks || []) {
                if (tracks.has(t)) continue;
                for (const conn of t.padConnections?.values?.() || []) {
                    if (conn.componentId === componentId && conn.pinNumber === pinNumber) {
                        tracks.add(t);
                        queue.push({ kind: 'track', track: t });
                        break;
                    }
                }
            }
        } else if (item.kind === 'track') {
            // Add any pads this track touches.
            for (const conn of item.track.padConnections?.values?.() || []) {
                const k = `${conn.componentId}|${conn.pinNumber}`;
                if (!pads.has(k)) { pads.add(k); queue.push({ kind: 'pad', key: k }); }
            }
            // Add any via whose position coincides with a node on this
            // track — that via stitches us into the opposite layer.
            // Also pick up any *other* track sharing a node at the same
            // position (T-junctions between separate Track objects).
            for (const n of item.track.nodes.values()) {
                const k = _posKey(n.x, n.y);
                const v = viaByPos.get(k);
                if (v && !vias.has(v)) {
                    vias.add(v);
                    queue.push({ kind: 'via', via: v });
                }
                for (const t2 of app.tracks || []) {
                    if (t2 === item.track || tracks.has(t2)) continue;
                    for (const n2 of t2.nodes.values()) {
                        if (_posKey(n2.x, n2.y) === k) {
                            tracks.add(t2);
                            queue.push({ kind: 'track', track: t2 });
                            break;
                        }
                    }
                }
            }
        } else if (item.kind === 'via') {
            // Add any track with a node at this via's position (either layer).
            const k = _posKey(item.via.x, item.via.y);
            for (const t of app.tracks || []) {
                if (tracks.has(t)) continue;
                for (const n of t.nodes.values()) {
                    if (_posKey(n.x, n.y) === k) {
                        tracks.add(t);
                        queue.push({ kind: 'track', track: t });
                        break;
                    }
                }
            }
        }
    }

    return { tracks, vias, pads };
}

function _posKey(x, y) {
    // 0.01 mm bucket — matches the autorouter-adapter's pad lookup.
    return `${Math.round(x * 100)},${Math.round(y * 100)}`;
}

/** Look up the net name a pad belongs to, or '' if unknown. */
function _netForPad(app, componentId, pinNumber) {
    for (const entry of app.netlist || []) {
        for (const pin of entry.pins || []) {
            if (pin.componentId === componentId && pin.pinNumber === pinNumber) {
                return entry.net || '';
            }
        }
    }
    return '';
}

/**
 * Draw a translucent overlay over a single pad (used for pad-hover).
 * Extracted from _drawPadHighlights so we can target one pad without
 * a Track context.
 */
function _drawSinglePadHighlight(app, componentId, pinNumber, cls, opacity) {
    const pl = app.placements?.get(componentId);
    if (!pl) return;
    const off = pl.padOffsets?.find((p) => p.number === pinNumber);
    const pos = pl.pads?.get(pinNumber);
    if (!pos) return;
    const layers = off?.layer === 'bottom-copper'
        ? ['bottom-copper']
        : off?.layer === 'both'
            ? ['top-copper', 'bottom-copper']
            : ['top-copper'];
    const w = off?.width || 1.2;
    const h = off?.height || 1.2;
    const shape = off?.shape || 'rect';
    for (const layerId of layers) {
        const parent = app._getLayerGroup(layerId);
        if (!parent) continue;
        let el;
        if (shape === 'ellipse') {
            el = document.createElementNS(NS, 'circle');
            el.setAttribute('cx', String(pos.x));
            el.setAttribute('cy', String(pos.y));
            el.setAttribute('r', String(Math.max(w, h) / 2));
        } else {
            el = document.createElementNS(NS, 'rect');
            el.setAttribute('x', String(pos.x - w / 2));
            el.setAttribute('y', String(pos.y - h / 2));
            el.setAttribute('width', String(w));
            el.setAttribute('height', String(h));
            if (shape === 'oval') {
                const r = Math.min(w, h) / 2;
                el.setAttribute('rx', String(r));
                el.setAttribute('ry', String(r));
            }
        }
        el.setAttribute('class', cls);
        el.setAttribute('fill', HALO_COLOR);
        el.setAttribute('fill-opacity', String(opacity));
        el.setAttribute('stroke', 'none');
        el.setAttribute('pointer-events', 'none');
        parent.appendChild(el);
    }
}

function _removeHalos(app, cls) {
    if (!app._layerGroups) return;
    for (const g of app._layerGroups.values()) {
        g.querySelectorAll(`.${cls}`).forEach((el) => el.remove());
    }
}

/**
 * Delete the currently selected track or via, then reconcile ratlines
 * and update the properties panel.
 */
export function deleteSelectedTrack(app) {
    if (app._selectedTrack) {
        const t = app._selectedTrack;
        clearTrackSelection(app);
        app.history?.execute(new RemoveTrackCommand(app, t));
    } else if (app._selectedVia) {
        const v = app._selectedVia;
        clearTrackSelection(app);
        app.history?.execute(new RemoveViaCommand(app, v));
    }
}

/* ──────────────────────────── halos ──────────────────────────── */

function _drawTrackHalo(app, track, cls = HALO_CLASS, opacity = HALO_OPACITY_SELECTED) {
    // Lay a translucent white overlay along each layer-run, at the same
    // width as the trace itself, so it brightens the copper in place
    // instead of producing an outer glow that lags behind moves.
    const runs = _buildRuns(track);
    const haloWidth = track.width || 0.2;
    for (const run of runs) {
        const parent = app._getLayerGroup(run.layer);
        if (!parent) continue;
        const poly = document.createElementNS(NS, 'polyline');
        poly.setAttribute('class', cls);
        poly.setAttribute('points', run.points.map((p) => `${p.x},${p.y}`).join(' '));
        poly.setAttribute('fill', 'none');
        poly.setAttribute('stroke', HALO_COLOR);
        poly.setAttribute('stroke-width', String(haloWidth));
        poly.setAttribute('stroke-linecap', 'round');
        poly.setAttribute('stroke-linejoin', 'round');
        poly.setAttribute('stroke-opacity', String(opacity));
        poly.setAttribute('pointer-events', 'none');
        parent.appendChild(poly);
    }
    _drawPadHighlights(app, track, cls, opacity);
}

/**
 * Highlight every pad the track is connected to with the same
 * translucent-white overlay, so the user can see which component pins
 * the trace lands on.
 */
function _drawPadHighlights(app, track, cls, opacity) {
    if (!track.padConnections?.size || !app.placements) return;
    for (const conn of track.padConnections.values()) {
        const pl = app.placements.get(conn.componentId);
        if (!pl) continue;
        const off = pl.padOffsets?.find((p) => p.number === conn.pinNumber);
        const pos = pl.pads?.get(conn.pinNumber);
        if (!pos) continue;
        // Render on whichever copper layer(s) the pad lives on; default
        // to top if the layer info is missing.
        const layers = off?.layer === 'bottom-copper'
            ? ['bottom-copper']
            : off?.layer === 'both'
                ? ['top-copper', 'bottom-copper']
                : ['top-copper'];
        const w = off?.width || 1.2;
        const h = off?.height || 1.2;
        const shape = off?.shape || 'rect';
        for (const layerId of layers) {
            const parent = app._getLayerGroup(layerId);
            if (!parent) continue;
            let el;
            if (shape === 'ellipse') {
                el = document.createElementNS(NS, 'circle');
                el.setAttribute('cx', String(pos.x));
                el.setAttribute('cy', String(pos.y));
                el.setAttribute('r', String(Math.max(w, h) / 2));
            } else {
                el = document.createElementNS(NS, 'rect');
                el.setAttribute('x', String(pos.x - w / 2));
                el.setAttribute('y', String(pos.y - h / 2));
                el.setAttribute('width', String(w));
                el.setAttribute('height', String(h));
                if (shape === 'oval') {
                    const r = Math.min(w, h) / 2;
                    el.setAttribute('rx', String(r));
                    el.setAttribute('ry', String(r));
                }
            }
            el.setAttribute('class', cls);
            el.setAttribute('fill', HALO_COLOR);
            el.setAttribute('fill-opacity', String(opacity));
            el.setAttribute('stroke', 'none');
            el.setAttribute('pointer-events', 'none');
            parent.appendChild(el);
        }
    }
}

function _drawViaHalo(app, via, cls = HALO_CLASS, opacity = HALO_OPACITY_SELECTED) {
    const hole = app._getLayerGroup('hole');
    if (!hole) return;
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', String(via.x));
    c.setAttribute('cy', String(via.y));
    c.setAttribute('r', String(via.diameter / 2));
    c.setAttribute('fill', HALO_COLOR);
    c.setAttribute('fill-opacity', String(opacity));
    c.setAttribute('stroke', 'none');
    c.setAttribute('pointer-events', 'none');
    hole.appendChild(c);
}

/**
 * Build contiguous same-layer point runs for a Track. Mirrors the logic
 * in track-render._buildLayerRuns but kept local to avoid coupling.
 */
function _buildRuns(track) {
    if (track.edges.size === 0) return [];
    // Build adjacency.
    const adj = new Map();
    for (const nid of track.nodes.keys()) adj.set(nid, []);
    for (const [eid, e] of track.edges) {
        adj.get(e.from).push({ other: e.to, eid });
        adj.get(e.to).push({ other: e.from, eid });
    }
    const usedEdges = new Set();
    const runs = [];

    // Walk from each end / branch node along same-layer paths.
    for (const startNid of track.nodes.keys()) {
        for (const { other, eid } of adj.get(startNid)) {
            if (usedEdges.has(eid)) continue;
            const layer = track.edgeLayers.get(eid) || track.layer;
            const points = [track.nodes.get(startNid), track.nodes.get(other)];
            usedEdges.add(eid);
            // Extend forward while next edge shares the layer and the
            // current end has exactly two edges (no branch).
            let prev = startNid, cur = other;
            while (true) {
                const next = (adj.get(cur) || []).find(
                    (n) => !usedEdges.has(n.eid)
                        && (track.edgeLayers.get(n.eid) || track.layer) === layer
                        && n.other !== prev,
                );
                if (!next) break;
                if ((adj.get(cur) || []).length !== 2) break;
                usedEdges.add(next.eid);
                points.push(track.nodes.get(next.other));
                prev = cur;
                cur = next.other;
            }
            runs.push({ layer, points });
        }
    }
    return runs;
}

/* ──────────────────────────── properties panel ──────────────────────────── */

function _showTrackProperties(app, track) {
    const items = document.getElementById('pcbPropsItems');
    if (!items) return;
    const net = track.net || '(unassigned)';
    const layers = new Set(track.edgeLayers.values());
    const layerLabel = layers.size > 1
        ? 'Multiple'
        : (layers.values().next().value === 'bottom-copper' ? 'Bottom Copper' : 'Top Copper');
    items.innerHTML = `
        <div class="prop-row"><label>Type</label><span style="font-size:11px;color:var(--text-primary)">Track</span></div>
        <div class="prop-row"><label>Net</label><span style="font-size:11px;color:var(--text-primary)">${_escape(net)}</span></div>
        <div class="prop-row"><label>Layer</label><span style="font-size:11px;color:var(--text-primary)">${layerLabel}</span></div>
        <div class="prop-row"><label>Width (mm)</label><input type="number" id="pcbPropTrackWidth" value="${track.width}" min="0.05" step="0.05"></div>
    `;
    const wEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropTrackWidth'));
    const baseline = { width: track.width };
    wEl?.addEventListener('input', () => {
        const v = parseFloat(wEl.value);
        if (!Number.isFinite(v) || v <= 0) return;
        // Live preview — mutate directly so the user sees the change
        // immediately. The committed value lands on the history stack
        // when the input loses focus or 'change' fires.
        track.width = v;
        import('./track-render.js').then(({ renderTrack }) => {
            renderTrack(track, (id) => app._getLayerGroup(id), {
                viaDiameter: app._getRoutingParams?.()?.viaDiameter,
                viaDrill: app._getRoutingParams?.()?.viaDrill,
            });
            clearTrackSelection(app);
            app._selectedTrack = track;
            _drawTrackHalo(app, track);
        });
    });
    wEl?.addEventListener('change', () => {
        const v = parseFloat(wEl.value);
        if (!Number.isFinite(v) || v <= 0) return;
        if (v === baseline.width) return;
        // Roll back the live-preview mutation so the command's
        // execute() can apply it cleanly through the history stack.
        track.width = baseline.width;
        app.history?.execute(new ModifyTrackCommand(app, track, { width: baseline.width }, { width: v }));
        baseline.width = v;
    });
    app._setActiveRibbonTab?.('pcb-properties');
}

function _showViaProperties(app, via) {
    const items = document.getElementById('pcbPropsItems');
    if (!items) return;
    items.innerHTML = `
        <div class="prop-row"><label>Type</label><span style="font-size:11px;color:var(--text-primary)">Via</span></div>
        <div class="prop-row"><label>Net</label><span style="font-size:11px;color:var(--text-primary)">${_escape(via.net || '(unassigned)')}</span></div>
        <div class="prop-row"><label>Diameter (mm)</label><input type="number" id="pcbPropViaDia" value="${via.diameter}" min="0.1" step="0.05"></div>
        <div class="prop-row"><label>Drill (mm)</label><input type="number" id="pcbPropViaDrill" value="${via.drill}" min="0.05" step="0.05"></div>
    `;
    const reRender = () => import('./track-render.js').then(({ renderVia }) => {
        renderVia(via, (id) => app._getLayerGroup(id));
        clearTrackSelection(app);
        app._selectedVia = via;
        _drawViaHalo(app, via);
    });
    const baseline = { diameter: via.diameter, drill: via.drill };
    const live = (key) => (e) => {
        const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
        if (Number.isFinite(v) && v > 0) { via[key] = v; reRender(); }
    };
    const commit = (key) => (e) => {
        const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
        if (!Number.isFinite(v) || v <= 0) return;
        if (v === baseline[key]) return;
        const before = { [key]: baseline[key] };
        const after = { [key]: v };
        via[key] = baseline[key];
        app.history?.execute(new ModifyViaCommand(app, via, before, after));
        baseline[key] = v;
    };
    const diaEl = document.getElementById('pcbPropViaDia');
    diaEl?.addEventListener('input', live('diameter'));
    diaEl?.addEventListener('change', commit('diameter'));
    const drlEl = document.getElementById('pcbPropViaDrill');
    drlEl?.addEventListener('input', live('drill'));
    drlEl?.addEventListener('change', commit('drill'));
    app._setActiveRibbonTab?.('pcb-properties');
}

function _escape(s) {
    return String(s).replace(/[&<>"]/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
}
