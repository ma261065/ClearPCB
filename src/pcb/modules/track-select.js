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

import { removeTrackElements, removeViaElements, renderTrack } from './track-render.js';
import { reconcileRatsnest, collectBondedCopper } from './track-draw.js';
import { hitTestTrackEdge, deleteTrackSegment, hitTestTrackNode, splitTrackNodeAndDrag, deleteTrackNode, reconcileCopperRegion } from './track-drag.js';
import {
    RemoveTrackCommand,
    RemoveViaCommand,
    RemoveHoleCommand,
    AddTrackCommand,
    AddViaCommand,
    CompoundCommand,
    ModifyTrackCommand,
    ModifyTrackGraphCommand,
    ModifyViaCommand,
    ModifyHoleCommand,
} from './track-commands.js';
import { PCB_LAYERS, isLayerLocked, isViaLocked, isLayerVisible, isViaVisible } from './layers.js';
import { showAlert } from '../../ui/modules/modal.js';

const NS = 'http://www.w3.org/2000/svg';
const HALO_CLASS = 'pcb-track-selection';
const HOVER_CLASS = 'pcb-track-hover';

/** Halo stroke colour — translucent white overlays the trace so the
 *  underlying copper colour still reads through. Kept low-opacity so a
 *  selected trace only brightens slightly and its layer colour (top vs
 *  bottom) stays clearly distinguishable. */
const HALO_COLOR = '#ffffff';
const HALO_OPACITY_SELECTED = 0.55;
const HALO_OPACITY_HOVER = 0.6;

/** Pixel tolerance for hit-testing tracks (converted to world units). */
const HIT_TOL_PX = 6;

/* ──────────────────────────── hit testing ──────────────────────────── */

/**
 * Find the topmost track/via under `worldPos` (vias preferred).
 * @returns {{type:'track', track:object}|{type:'via', via:object}|{type:'hole', hole:object}|null}
 */
export function hitTestTrack(app, worldPos, pxTol = HIT_TOL_PX) {
    const scale = app.viewport?.scale || 1;
    const worldTol = pxTol / scale;

    // Vias first (smaller targets, should win over coincident traces).
    // Skip them entirely when the via layers are locked or hidden.
    if (!isViaLocked() && isViaVisible()) {
        for (let i = app.vias.length - 1; i >= 0; i--) {
            const v = app.vias[i];
            const r = (v.diameter || 0.6) / 2 + worldTol;
            if (Math.hypot(v.x - worldPos.x, v.y - worldPos.y) <= r) {
                return { type: 'via', via: v };
            }
        }
    }

    // Standalone non-plated holes (also small targets on the hole layer).
    // Skip them when the hole layer is locked (read-only) or hidden.
    if (!isLayerLocked('hole') && isLayerVisible('hole')) {
        for (let i = (app.holes?.length || 0) - 1; i >= 0; i--) {
            const h = app.holes[i];
            const r = (h.diameter || 0.8) / 2 + worldTol;
            if (Math.hypot(h.x - worldPos.x, h.y - worldPos.y) <= r) {
                return { type: 'hole', hole: h };
            }
        }
    }

    // Tracks: distance to any segment within (width/2 + tol). Width is
    // per-edge, so resolve it inside the segment loop. Locked- or hidden-layer
    // tracks are not hit-testable.
    for (let i = app.tracks.length - 1; i >= 0; i--) {
        const t = app.tracks[i];
        if (isLayerLocked(t.layer) || !isLayerVisible(t.layer)) continue;
        for (const [eid, e] of t.edges) {
            const a = t.nodes.get(e.from);
            const b = t.nodes.get(e.to);
            if (!a || !b) continue;
            const ew = t.getEdgeWidth ? t.getEdgeWidth(eid) : t.width;
            const half = (ew || 0.2) / 2 + worldTol;
            if (_pointSegDist(worldPos, a, b) <= half) {
                return { type: 'track', track: t };
            }
        }
    }
    return null;
}

/**
 * Hit-test a world position against LOCKED tracks/vias only — the mirror of
 * hitTestTrack, which deliberately ignores them. Used to detect when a user
 * clicks something that's locked so we can explain why it can't be selected.
 * @param {object} app
 * @param {{x:number,y:number}} worldPos
 * @param {number} [pxTol]
 * @returns {{type:'via'|'track', layerId:string}|null}
 */
export function hitTestLockedTrack(app, worldPos, pxTol = HIT_TOL_PX) {
    const scale = app.viewport?.scale || 1;
    const worldTol = pxTol / scale;

    if (isViaLocked() && isViaVisible()) {
        for (let i = app.vias.length - 1; i >= 0; i--) {
            const v = app.vias[i];
            const r = (v.diameter || 0.6) / 2 + worldTol;
            if (Math.hypot(v.x - worldPos.x, v.y - worldPos.y) <= r) {
                return { type: 'via', layerId: v.layer || 'top-copper' };
            }
        }
    }

    for (let i = app.tracks.length - 1; i >= 0; i--) {
        const t = app.tracks[i];
        if (!isLayerLocked(t.layer) || !isLayerVisible(t.layer)) continue;
        for (const [eid, e] of t.edges) {
            const a = t.nodes.get(e.from);
            const b = t.nodes.get(e.to);
            if (!a || !b) continue;
            const ew = t.getEdgeWidth ? t.getEdgeWidth(eid) : t.width;
            const half = (ew || 0.2) / 2 + worldTol;
            if (_pointSegDist(worldPos, a, b) <= half) {
                return { type: 'track', layerId: t.layer };
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
 * @param {{type:'track', track:object}|{type:'via', via:object}|{type:'hole', hole:object}|null} hit
 */
export function selectTrackOrVia(app, hit) {
    clearTrackSelection(app);
    // Clear any hover halo for the now-selected item so the two highlights
    // don't stack.
    _removeHalos(app, HOVER_CLASS);
    app._hoveredTrackOrVia = null;
    if (!hit) {
        app._clearProperties?.();
        app._syncClipboardButtons?.();
        return;
    }
    if (hit.type === 'track') {
        app._selectedTrack = hit.track;
        _setTrackLabelsVisible(hit.track, false);
        _drawTrackHalo(app, hit.track);
        _showTrackProperties(app, hit.track);
    } else if (hit.type === 'hole') {
        app._selectedHole = hit.hole;
        _drawHoleHalo(app, hit.hole);
        _showHoleProperties(app, hit.hole);
    } else {
        app._selectedVia = hit.via;
        _drawViaHalo(app, hit.via);
        _showViaProperties(app, hit.via);
    }
    app._syncClipboardButtons?.();
}

/**
 * Select a single segment (one edge) of a track — the "second click"
 * refinement after the whole track is already selected. Keeps
 * `_selectedTrack` set so the existing drag/hover suppression still
 * applies, and records the focused edge in `_selectedSegment`.
 *
 * @param {object} app
 * @param {object} track
 * @param {string} edgeId
 */
export function selectTrackSegment(app, track, edgeId) {
    clearTrackSelection(app);
    _removeHalos(app, HOVER_CLASS);
    app._hoveredTrackOrVia = null;
    if (!track || !track.edges?.has(edgeId)) {
        // Edge vanished (e.g. merged away) — fall back to whole-track select.
        if (track) selectTrackOrVia(app, { type: 'track', track });
        return;
    }
    app._selectedTrack = track;
    app._selectedSegment = { track, edgeId };
    _setTrackLabelsVisible(track, false);
    _drawSegmentHalo(app, track, edgeId);
    _showTrackSegmentProperties(app, track, edgeId);
    app._syncClipboardButtons?.();
}

/** Show/hide a track's net-name labels without a full re-render. */
function _setTrackLabelsVisible(track, visible) {
    const els = track?._svgElements;
    if (!els) return;
    let found = false;
    for (const el of els) {
        if (el.getAttribute?.('class') === 'pcb-track-label') {
            el.style.display = visible ? '' : 'none';
            found = true;
        }
    }
    return found;
}

/** Remove any track/via selection halos and clear stored references. */
export function clearTrackSelection(app) {
    const prev = app._selectedTrack;
    app._selectedTrack = null;
    app._selectedVia = null;
    app._selectedHole = null;
    app._selectedSegment = null;
    _removeHalos(app, HALO_CLASS);
    if (prev) {
        // Bring the net labels back. They were hidden via display toggling,
        // but a re-render while selected may have dropped them entirely
        // (hideNetLabel) — in that case re-render now to rebuild them.
        const restored = _setTrackLabelsVisible(prev, true);
        if (!restored) {
            renderTrack(prev, (id) => app._getLayerGroup(id), {
                viaDiameter: app._getRoutingParams?.()?.viaDiameter,
                viaDrill: app._getRoutingParams?.()?.viaDrill,
            });
        }
    }
    app._syncClipboardButtons?.();
}

/**
 * Re-draw the selection halo for the currently-selected track/via.
 * Call this after the underlying track has been re-rendered (e.g.
 * during a vertex drag) so the halo follows the new geometry.
 */
export function refreshTrackSelectionHalo(app) {
    _removeHalos(app, HALO_CLASS);
    if (app._selectedSegment && app._selectedTrack) {
        _drawSegmentHalo(app, app._selectedSegment.track, app._selectedSegment.edgeId);
    } else if (app._selectedTrack) _drawTrackHalo(app, app._selectedTrack, HALO_CLASS, HALO_OPACITY_SELECTED);
    else if (app._selectedVia) _drawViaHalo(app, app._selectedVia, HALO_CLASS, HALO_OPACITY_SELECTED);
    else if (app._selectedHole) _drawHoleHalo(app, app._selectedHole, HALO_CLASS, HALO_OPACITY_SELECTED);
}

/**
 * Set the currently-hovered track/via highlight. Pass `null` to clear.
 * No-op when the same object is already selected (the selection halo
 * already covers it).
 */
export function setHoverHighlight(app, hit) {
    // While a track is selected, suppress the whole-net hover highlight so
    // the selection stays the sole focus.
    if (app._selectedTrack) {
        if (app._hoveredTrackOrVia !== null) {
            app._hoveredTrackOrVia = null;
            _removeHalos(app, HOVER_CLASS);
        }
        return;
    }
    const key = hit
        ? (hit.type === 'track' ? hit.track
            : hit.type === 'via' ? hit.via
            : hit.type === 'hole' ? hit.hole
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
    } else if (hit.type === 'hole' && hit.hole !== app._selectedHole) {
        _drawHoleHalo(app, hit.hole, HOVER_CLASS, HALO_OPACITY_HOVER);
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
    // The pad's rendered group is rotated by the placement angle (and mirrored
    // for flips / bottom side). `pos` is the already-transformed world centre,
    // but a rect/oval drawn axis-aligned would point the wrong way under
    // rotation — rotate the highlight about its centre to match. A symmetric
    // shape's mirror is visually identical to a rotation, so the angle alone
    // (sign irrelevant for the centred box) keeps it aligned with the pad.
    const rot = pl.rotation || 0;
    const rotAttr = rot ? `rotate(${rot} ${pos.x} ${pos.y})` : '';
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
            if (rotAttr) el.setAttribute('transform', rotAttr);
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

/* ── Public halo helpers (used by box-select multi-selection) ── */

/** Draw a selection halo over a track using the given CSS class. */
export function drawTrackHalo(app, track, cls, opacity = HALO_OPACITY_SELECTED) {
    _drawTrackHalo(app, track, cls, opacity);
}

/** Draw a selection halo over a via using the given CSS class. */
export function drawViaHalo(app, via, cls, opacity = HALO_OPACITY_SELECTED) {
    _drawViaHalo(app, via, cls, opacity);
}

/** Draw a selection halo over a hole using the given CSS class. */
export function drawHoleHalo(app, hole, cls, opacity = HALO_OPACITY_SELECTED) {
    _drawHoleHalo(app, hole, cls, opacity);
}

/** Remove every halo with the given CSS class from all layers. */
export function removeHalosByClass(app, cls) {
    _removeHalos(app, cls);
}

/**
 * Delete the currently selected track or via, then reconcile ratlines
 * and update the properties panel.
 */
export function deleteSelectedTrack(app) {
    // A single highlighted segment deletes just that edge (the rest of the
    // track survives as its remaining connected pieces). `_selectedSegment`
    // keeps `_selectedTrack` set too, so check the segment refinement first.
    if (app._selectedSegment && app._selectedTrack) {
        const { track, edgeId } = app._selectedSegment;
        deleteTrackSegmentAt(app, track, edgeId);
        return;
    }
    if (app._selectedTrack) {
        const t = app._selectedTrack;
        clearTrackSelection(app);
        app.history?.execute(new RemoveTrackCommand(app, t));
    } else if (app._selectedVia) {
        const v = app._selectedVia;
        clearTrackSelection(app);
        app.history?.execute(new RemoveViaCommand(app, v));
    } else if (app._selectedHole) {
        const h = app._selectedHole;
        clearTrackSelection(app);
        app.history?.execute(new RemoveHoleCommand(app, h));
    }
}

/**
 * Delete a single segment (edge) of `track`, replacing it with the
 * remaining connected pieces. Runs as one undoable compound command.
 */
export function deleteTrackSegmentAt(app, track, edgeId) {
    if (!track || !edgeId) return;
    const parts = deleteTrackSegment(track, edgeId);
    clearTrackSelection(app);
    const cmds = [new RemoveTrackCommand(app, track)];
    for (const part of parts) cmds.push(new AddTrackCommand(app, part));
    app.history?.execute(new CompoundCommand(cmds));
}

/* ─────────────────────────── context menu ─────────────────────────── */

const CTX_MENU_STYLE = 'position:fixed;z-index:10000;background:#2b2b2b;border:1px solid #555;border-radius:4px;padding:2px 0;box-shadow:0 2px 8px rgba(0,0,0,0.4);min-width:120px;';
const CTX_ITEM_STYLE = 'padding:6px 16px;color:#eee;cursor:pointer;font:13px/1.4 system-ui,sans-serif;white-space:nowrap;';

/** Remove any open PCB context menu and its dismiss listeners. */
export function dismissTrackContextMenu() {
    const menu = document.getElementById('pcbTrackContextMenu');
    if (!menu) return;
    const h = /** @type {any} */ (menu)._dismiss;
    if (h) {
        document.removeEventListener('mousedown', h.dismiss, { capture: true });
        document.removeEventListener('keydown', h.onKey, { capture: true });
    }
    menu.remove();
}

/**
 * Show a right-click context menu for the given track/via hit at the
 * screen position. Selects the item first so the action targets it.
 * Intended for the select tool only (caller enforces that).
 *
 * @param {object} app
 * @param {{type:'track', track:object}|{type:'via', via:object}|{type:'hole', hole:object}} hit
 * @param {number} clientX
 * @param {number} clientY
 * @param {{x:number,y:number}} [worldPos] - cursor position, used to
 *   target a specific segment for "Delete segment".
 */
export function showTrackContextMenu(app, hit, clientX, clientY, worldPos) {
    dismissTrackContextMenu();
    // Make the right-clicked item the current selection so the action
    // operates on it (and the user sees what they're about to act on).
    selectTrackOrVia(app, hit);

    const label = hit.type === 'via' ? 'Delete via'
        : hit.type === 'hole' ? 'Delete hole'
        : 'Delete track';
    const items = [];
    // Node-targeted actions (Split / Delete Node) when right-clicking on
    // a track vertex — mirrors the schematic wire anchor context menu.
    let nodeId = null;
    if (hit.type === 'track' && worldPos) {
        nodeId = hitTestTrackNode(app, hit.track, worldPos);
    }
    if (nodeId) {
        // Right-click landed on a vertex: show ONLY the node actions.
        const track = hit.track;
        const deg = track.degree(nodeId);
        if (deg === 2) {
            items.push({
                text: 'Split',
                onClick: () => splitTrackNodeAndDrag(app, track, nodeId),
            });
        }
        if (track.edges.size > 1 && (deg === 1 || deg === 2)) {
            items.push({
                text: 'Delete Node',
                onClick: () => deleteTrackNode(app, track, nodeId),
            });
        }
        // Fall back to whole-track deletion if no node action applies
        // (e.g. a single-segment track has only degree-1 endpoints).
        if (items.length === 0) {
            items.push({ text: label, onClick: () => deleteSelectedTrack(app) });
        }
    } else {
        // Offer single-segment deletion when right-clicking on a track edge.
        if (hit.type === 'track' && worldPos) {
            const edgeHit = hitTestTrackEdge(app, hit.track, worldPos);
            if (edgeHit && hit.track.edges.size > 1) {
                items.push({
                    text: 'Delete segment',
                    onClick: () => deleteTrackSegmentAt(app, hit.track, edgeHit.edgeId),
                });
            }
        }
        items.push({ text: label, onClick: () => deleteSelectedTrack(app) });
    }

    const menu = document.createElement('div');
    menu.id = 'pcbTrackContextMenu';
    menu.style.cssText = `${CTX_MENU_STYLE}left:${clientX}px;top:${clientY}px;`;
    for (const item of items) {
        const el = document.createElement('div');
        el.textContent = item.text;
        el.style.cssText = CTX_ITEM_STYLE;
        el.addEventListener('mouseenter', () => { el.style.background = '#3a3a3a'; });
        el.addEventListener('mouseleave', () => { el.style.background = ''; });
        el.addEventListener('click', () => {
            dismissTrackContextMenu();
            item.onClick();
        });
        menu.appendChild(el);
    }
    menu.addEventListener('contextmenu', (e) => e.preventDefault());
    document.body.appendChild(menu);

    const dismiss = (e) => {
        if (!menu.contains(/** @type {Node|null} */ (e.target))) dismissTrackContextMenu();
    };
    const onKey = (e) => {
        if (e.key === 'Escape') dismissTrackContextMenu();
    };
    setTimeout(() => {
        document.addEventListener('mousedown', dismiss, { capture: true });
        document.addEventListener('keydown', onKey, { capture: true });
    }, 0);
    /** @type {any} */ (menu)._dismiss = { dismiss, onKey };
    return menu;
}

/* ──────────────────────────── halos ──────────────────────────── */

function _drawTrackHalo(app, track, cls = HALO_CLASS, opacity = HALO_OPACITY_SELECTED) {
    // Lay a translucent white overlay along each layer-run, at the same
    // width as the trace itself, so it brightens the copper in place
    // instead of producing an outer glow that lags behind moves.
    const runs = _buildRuns(track);
    for (const run of runs) {
        const parent = app._getLayerGroup(run.layer);
        if (!parent) continue;
        const poly = document.createElementNS(NS, 'polyline');
        poly.setAttribute('class', cls);
        poly.setAttribute('points', run.points.map((p) => `${p.x},${p.y}`).join(' '));
        poly.setAttribute('fill', 'none');
        poly.setAttribute('stroke', HALO_COLOR);
        poly.setAttribute('stroke-width', String(run.width));
        poly.setAttribute('stroke-linecap', 'round');
        poly.setAttribute('stroke-linejoin', 'round');
        poly.setAttribute('stroke-opacity', String(opacity));
        poly.setAttribute('pointer-events', 'none');
        parent.appendChild(poly);
    }
    _drawPadHighlights(app, track, cls, opacity);
    // Draw draggable node handles only for the SELECTION halo (not hover),
    // so the user can see the vertices they can grab.
    if (cls === HALO_CLASS) _drawNodeHandles(app, track, cls);
}

/**
 * Draw the selection halo for a single track edge (segment selection).
 * Overlays just that one edge plus handles at its two endpoints.
 */
function _drawSegmentHalo(app, track, edgeId, cls = HALO_CLASS, opacity = HALO_OPACITY_SELECTED) {
    const e = track.edges?.get(edgeId);
    if (!e) return;
    const a = track.nodes.get(e.from);
    const b = track.nodes.get(e.to);
    if (!a || !b) return;
    const layerId = track.getEdgeLayer(edgeId) || 'top-copper';
    const parent = app._getLayerGroup(layerId);
    if (parent) {
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('class', cls);
        line.setAttribute('x1', String(a.x));
        line.setAttribute('y1', String(a.y));
        line.setAttribute('x2', String(b.x));
        line.setAttribute('y2', String(b.y));
        line.setAttribute('stroke', HALO_COLOR);
        line.setAttribute('stroke-width', String(track.getEdgeWidth(edgeId) || 0.2));
        line.setAttribute('stroke-linecap', 'round');
        line.setAttribute('stroke-opacity', String(opacity));
        line.setAttribute('pointer-events', 'none');
        parent.appendChild(line);
    }
    _drawPadHighlights(app, track, cls, opacity);
    if (cls === HALO_CLASS) _drawNodeHandles(app, track, cls);
}

/**
 * Draw a small square handle at each Track node so the user can see the
 * draggable vertices. Handles are sized in screen pixels (constant on
 * screen regardless of zoom) and rendered on the node's own layer.
 */
function _drawNodeHandles(app, track, cls) {
    if (!track.nodes?.size) return;
    const scale = app.viewport?.scale || 1;
    // Constant ~7px on-screen handle; clamp so it never dwarfs a thin trace.
    const sizePx = 7;
    const half = (sizePx / scale) / 2;
    const strokePx = 1.25;
    // Draw on the dedicated top-most overlay so handles sit above all
    // copper AND any via (hole layer) that covers the node they mark.
    const parent = app._getLayerGroup('selection-overlay');
    if (!parent) return;
    for (const [, n] of track.nodes) {
        const r = document.createElementNS(NS, 'rect');
        r.setAttribute('class', cls);
        r.setAttribute('x', String(n.x - half));
        r.setAttribute('y', String(n.y - half));
        r.setAttribute('width', String(half * 2));
        r.setAttribute('height', String(half * 2));
        r.setAttribute('fill', HALO_COLOR);
        r.setAttribute('fill-opacity', '0.9');
        r.setAttribute('stroke', '#000');
        r.setAttribute('stroke-opacity', '0.5');
        r.setAttribute('stroke-width', String(strokePx / scale));
        r.setAttribute('pointer-events', 'none');
        parent.appendChild(r);
    }
    _drawMidpointHandles(app, track, cls, parent, scale);
}

/**
 * Draw an insertion handle at the midpoint of each segment, styled to
 * match the schematic Wire's midpoint anchor exactly: a white circle with
 * a blue stroke and a blue "+" sign (see core/ui-helpers buildPointAnchorsGroup).
 * Grabbing one inserts a new vertex and drags it. Sized in screen pixels
 * so it stays constant on screen regardless of zoom.
 */
function _drawMidpointHandles(app, track, cls, parent, scale) {
    if (!track.edges?.size) return;
    const midR = 5.5 / scale;
    const strokeW = 1 / scale;
    const plusLen = midR * 1.1;
    const MID_COLOR = '#1565c0';
    for (const [, e] of track.edges) {
        const a = track.nodes.get(e.from);
        const b = track.nodes.get(e.to);
        if (!a || !b) continue;
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('class', cls);
        g.setAttribute('pointer-events', 'none');

        const circle = document.createElementNS(NS, 'circle');
        circle.setAttribute('cx', String(cx));
        circle.setAttribute('cy', String(cy));
        circle.setAttribute('r', String(midR));
        circle.setAttribute('fill', '#fff');
        circle.setAttribute('stroke', MID_COLOR);
        circle.setAttribute('stroke-width', String(strokeW));
        g.appendChild(circle);

        for (const [x1, y1, x2, y2] of [
            [cx - plusLen, cy, cx + plusLen, cy],
            [cx, cy - plusLen, cx, cy + plusLen],
        ]) {
            const ln = document.createElementNS(NS, 'line');
            ln.setAttribute('x1', String(x1));
            ln.setAttribute('y1', String(y1));
            ln.setAttribute('x2', String(x2));
            ln.setAttribute('y2', String(y2));
            ln.setAttribute('stroke', MID_COLOR);
            ln.setAttribute('stroke-width', String(strokeW * 1.5));
            ln.setAttribute('stroke-linecap', 'round');
            g.appendChild(ln);
        }
        parent.appendChild(g);
    }
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
 * Draw a hole highlight with an inscribed "X" cross so the drilled centre is
 * unmistakable. The visual state is derived from `cls`:
 *   - hover  → just the X (the bore stays open)
 *   - select → the X plus a filled disc
 */
function _drawHoleHalo(app, hole, cls = HALO_CLASS, opacity = HALO_OPACITY_SELECTED) {
    const layer = app._getLayerGroup('hole');
    if (!layer) return;
    const dia = hole.diameter || 0.8;
    const r = dia / 2;
    const selected = cls !== HOVER_CLASS;
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', cls);
    g.setAttribute('pointer-events', 'none');

    if (selected) {
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', String(hole.x));
        c.setAttribute('cy', String(hole.y));
        c.setAttribute('r', String(r));
        c.setAttribute('fill', HALO_COLOR);
        c.setAttribute('fill-opacity', String(opacity));
        c.setAttribute('stroke', 'none');
        g.appendChild(c);
    }

    // Inscribed X: arms reach the disc edge (45° offsets).
    const d = r * Math.SQRT1_2;
    const sw = Math.max(0.03, dia * 0.07);
    const arms = [
        [hole.x - d, hole.y - d, hole.x + d, hole.y + d],
        [hole.x - d, hole.y + d, hole.x + d, hole.y - d],
    ];
    for (const [x1, y1, x2, y2] of arms) {
        const ln = document.createElementNS(NS, 'line');
        ln.setAttribute('x1', String(x1));
        ln.setAttribute('y1', String(y1));
        ln.setAttribute('x2', String(x2));
        ln.setAttribute('y2', String(y2));
        ln.setAttribute('stroke', HALO_COLOR);
        ln.setAttribute('stroke-width', String(sw));
        ln.setAttribute('stroke-linecap', 'round');
        g.appendChild(ln);
    }
    layer.appendChild(g);
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

    // Start from endpoint (degree-1) nodes first, then any remaining nodes.
    // A chain that passes THROUGH a degree-2 node must render as ONE
    // continuous run; starting at that interior node instead would split it
    // into two runs meeting there, doubling the round line-caps into a
    // visible "join" blob in the halo (this is exactly the ordering used by
    // track-render._buildLayerRuns, which this is meant to mirror).
    const startOrder = [];
    for (const [nid, list] of adj) if (list.length === 1) startOrder.push(nid);
    for (const nid of adj.keys()) if (!startOrder.includes(nid)) startOrder.push(nid);

    // Walk from each end / branch node along same-layer paths.
    for (const startNid of startOrder) {
        for (const { other, eid } of adj.get(startNid)) {
            if (usedEdges.has(eid)) continue;
            const layer = track.getEdgeLayer(eid);
            const width = track.getEdgeWidth(eid);
            const points = [track.nodes.get(startNid), track.nodes.get(other)];
            usedEdges.add(eid);
            // Extend forward while next edge shares the layer AND width and
            // the current end has exactly two edges (no branch).
            let prev = startNid, cur = other;
            while (true) {
                const next = (adj.get(cur) || []).find(
                    (n) => !usedEdges.has(n.eid)
                        && track.getEdgeLayer(n.eid) === layer
                        && track.getEdgeWidth(n.eid) === width
                        && n.other !== prev,
                );
                if (!next) break;
                if ((adj.get(cur) || []).length !== 2) break;
                usedEdges.add(next.eid);
                points.push(track.nodes.get(next.other));
                prev = cur;
                cur = next.other;
            }
            runs.push({ layer, width, points });
        }
    }
    return runs;
}

/* ──────────────────────────── properties panel ──────────────────────────── */

function _showTrackProperties(app, track) {
    const items = app._pcbPropsItems?.() || document.getElementById('pcbPropsItems');
    if (!items) return;
    app._setPcbPropsTitle?.('Track');
    const layers = new Set();
    for (const eid of track.edges.keys()) layers.add(track.getEdgeLayer(eid));
    const mixed = layers.size > 1;
    const currentLayer = mixed ? '' : (layers.values().next().value || track.layer || 'top-copper');
    const layerOpts = PCB_LAYERS.map(
        (l) => `<option value="${l.id}"${l.id === currentLayer ? ' selected' : ''}>${_escape(l.name)}</option>`
    ).join('');
    const mixedOpt = mixed ? `<option value="" selected>Multiple</option>` : '';
    items.innerHTML = `
        <div class="prop-row"><label>Net</label><input type="text" id="pcbPropTrackNet" value="${_escape(track.net || '')}" placeholder="(unassigned)"></div>
        <div class="prop-row"><label>Layer</label><select id="pcbPropTrackLayer">${mixedOpt}${layerOpts}</select></div>
        <div class="prop-row"><label>Width (mm)</label><input type="number" id="pcbPropTrackWidth" value="${track.width}" min="0.05" step="0.05"></div>
    `;
    // Apply a width to the whole track: the track-wide default AND every
    // edge (render/export read per-edge widths).
    const applyWidthAll = (w) => {
        track.width = w;
        for (const eid of track.edges.keys()) track.setEdgeAttr(eid, 'width', w);
    };
    const wEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropTrackWidth'));
    const baseline = { width: track.width, net: track.net || '' };
    wEl?.addEventListener('input', () => {
        const v = parseFloat(wEl.value);
        if (!Number.isFinite(v) || v <= 0) return;
        // Live preview — mutate directly so the user sees the change
        // immediately. The committed value lands on the history stack
        // when the input loses focus or 'change' fires.
        applyWidthAll(v);
        import('./track-render.js').then(({ renderTrack }) => {
            renderTrack(track, (id) => app._getLayerGroup(id), {
                viaDiameter: app._getRoutingParams?.()?.viaDiameter,
                viaDrill: app._getRoutingParams?.()?.viaDrill,
            });
            clearTrackSelection(app);
            app._selectedTrack = track;
            _drawTrackHalo(app, track);
            app._refreshClearanceHalos?.();
        });
    });
    wEl?.addEventListener('change', () => {
        const v = parseFloat(wEl.value);
        if (!Number.isFinite(v) || v <= 0) return;
        if (v === baseline.width) return;
        // Roll back the live-preview mutation, then commit a graph snapshot
        // so per-edge widths are captured for undo/redo.
        applyWidthAll(baseline.width);
        const before = track.captureState();
        applyWidthAll(v);
        const after = track.captureState();
        track.applyState(before);
        app.history?.execute(new ModifyTrackGraphCommand(app, track, before, after));
        baseline.width = v;
    });
    const netEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropTrackNet'));
    netEl?.addEventListener('change', () => {
        const v = netEl.value.trim();
        if (v === baseline.net) return;
        if (_applyNetToBondedCopper(app, { track }, v)) {
            baseline.net = v;
        } else {
            netEl.value = baseline.net; // refused — restore the field
        }
    });
    const layerEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbPropTrackLayer'));
    layerEl?.addEventListener('change', () => {
        const v = layerEl.value;
        if (!v) return; // the "Multiple" placeholder
        const before = track.captureState();
        // Move every edge of this track onto the chosen layer, then
        // re-normalise the whole bonded copper region into the canonical
        // via/node model. This mirrors the segment-layer handler: moving a
        // track onto a different layer than its neighbours inserts boundary
        // vias; moving it BACK onto a neighbour's layer fuses the tracks and
        // removes the now-superfluous vias.
        track.layer = v;
        for (const eid of track.edges.keys()) track.setEdgeAttr(eid, 'layer', v);
        const region = reconcileCopperRegion(app, track);
        // Restore the seed so its RemoveTrackCommand captures clean undo.
        track.applyState(before);
        // Drop the selection FIRST, while the original tracks are still
        // present and rendered (see the segment handler for why).
        clearTrackSelection(app);
        const cmds = [];
        for (const t of region.removeTracks) cmds.push(new RemoveTrackCommand(app, t));
        for (const vv of region.removeVias) cmds.push(new RemoveViaCommand(app, vv));
        for (const t of region.addTracks) cmds.push(new AddTrackCommand(app, t));
        for (const vv of region.addVias) cmds.push(new AddViaCommand(app, vv));
        if (cmds.length) app.history?.execute(new CompoundCommand(cmds));
        reconcileRatsnest(app);
        app._setActiveRibbonTab?.('pcb-properties');
    });
    app._setActiveRibbonTab?.('pcb-properties');
}

/**
 * Properties panel for a single selected track segment (one edge). The
 * Net is track-wide; the Layer and Width retarget only this edge so a
 * single segment can hop layers and change width independently.
 */
function _showTrackSegmentProperties(app, track, edgeId) {
    const items = app._pcbPropsItems?.() || document.getElementById('pcbPropsItems');
    if (!items) return;
    app._setPcbPropsTitle?.('Track Segment');
    const currentLayer = track.getEdgeLayer(edgeId) || 'top-copper';
    const segWidth = track.getEdgeWidth(edgeId);
    const layerOpts = PCB_LAYERS.map(
        (l) => `<option value="${l.id}"${l.id === currentLayer ? ' selected' : ''}>${_escape(l.name)}</option>`
    ).join('');
    items.innerHTML = `
        <div class="prop-row"><label>Net</label><input type="text" id="pcbPropTrackNet" value="${_escape(track.net || '')}" placeholder="(unassigned)"></div>
        <div class="prop-row"><label>Layer</label><select id="pcbPropSegLayer">${layerOpts}</select></div>
        <div class="prop-row"><label>Width (mm)</label><input type="number" id="pcbPropTrackWidth" value="${segWidth}" min="0.05" step="0.05"></div>
    `;
    const baseline = { width: segWidth, net: track.net || '' };
    const wEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropTrackWidth'));
    wEl?.addEventListener('input', () => {
        const v = parseFloat(wEl.value);
        if (!Number.isFinite(v) || v <= 0) return;
        // Live preview — set just this edge's width.
        track.setEdgeAttr(edgeId, 'width', v);
        import('./track-render.js').then(({ renderTrack }) => {
            renderTrack(track, (id) => app._getLayerGroup(id), {
                viaDiameter: app._getRoutingParams?.()?.viaDiameter,
                viaDrill: app._getRoutingParams?.()?.viaDrill,
            });
            refreshTrackSelectionHalo(app);
            app._refreshClearanceHalos?.();
        });
    });
    wEl?.addEventListener('change', () => {
        const v = parseFloat(wEl.value);
        if (!Number.isFinite(v) || v <= 0 || v === baseline.width) return;
        // Roll back the live preview, then commit a graph snapshot so the
        // per-edge width change is captured for undo/redo.
        track.setEdgeAttr(edgeId, 'width', baseline.width);
        const before = track.captureState();
        track.setEdgeAttr(edgeId, 'width', v);
        const after = track.captureState();
        track.applyState(before);
        app.history?.execute(new ModifyTrackGraphCommand(app, track, before, after));
        baseline.width = v;
    });
    const netEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropTrackNet'));
    netEl?.addEventListener('change', () => {
        const v = netEl.value.trim();
        if (v === baseline.net) return;
        if (_applyNetToBondedCopper(app, { track }, v)) {
            baseline.net = v;
        } else {
            netEl.value = baseline.net;
        }
    });
    const layerEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('pcbPropSegLayer'));
    layerEl?.addEventListener('change', () => {
        const v = layerEl.value;
        if (!v) return;
        const before = track.captureState();
        track.setEdgeAttr(edgeId, 'layer', v);
        // Re-normalise the whole bonded copper region into the canonical
        // via/node model. This handles BOTH directions: a layer JUMP splits
        // the track and adds boundary vias; moving a segment BACK onto a
        // neighbour's layer fuses the tracks again and removes the now
        // superfluous via.
        const region = reconcileCopperRegion(app, track);
        // Restore the seed so its RemoveTrackCommand captures clean undo.
        track.applyState(before);
        // Drop the selection FIRST, while the original tracks are still
        // present and rendered. clearTrackSelection re-renders a selected
        // track whose labels can't be restored — and once RemoveTrackCommand
        // has stripped the original's SVG elements that re-render would
        // resurrect it as an orphan (a stale polyline). Clearing here avoids
        // that.
        clearTrackSelection(app);
        const cmds = [];
        for (const t of region.removeTracks) cmds.push(new RemoveTrackCommand(app, t));
        for (const vv of region.removeVias) cmds.push(new RemoveViaCommand(app, vv));
        for (const t of region.addTracks) cmds.push(new AddTrackCommand(app, t));
        for (const vv of region.addVias) cmds.push(new AddViaCommand(app, vv));
        if (cmds.length) app.history?.execute(new CompoundCommand(cmds));
        reconcileRatsnest(app);
        app._setActiveRibbonTab?.('pcb-properties');
    });
    app._setActiveRibbonTab?.('pcb-properties');
}

/**
 * Set net `v` on every track + via physically bonded to the seed copper
 * (one undoable compound command). Refuses with a dialog if the bonded
 * region touches a pad whose schematic-assigned net differs from `v`
 * (the schematic is authoritative — rename it there instead).
 *
 * @returns {boolean} true if applied (or a no-op), false if refused.
 */
function _applyNetToBondedCopper(app, seed, v) {
    const group = collectBondedCopper(app, seed);
    // Authoritative pad-net guard: if the bonded copper reaches a pad, that
    // pad's schematic net is the truth; renaming the copper to something
    // else would contradict it.
    const padNets = [...group.padNets].filter(Boolean);
    const conflict = padNets.find((pn) => pn !== v);
    if (conflict !== undefined) {
        showAlert(
            `This copper is connected to a pad on net "${conflict}" (assigned by the schematic). ` +
            `Rename the net in the schematic instead of editing the track.`,
            { title: 'Net Assigned by Schematic' }
        );
        return false;
    }
    const cmds = [];
    for (const t of group.tracks) {
        if ((t.net || '') !== v) cmds.push(new ModifyTrackCommand(app, t, { net: t.net || '' }, { net: v }));
    }
    for (const vi of group.vias) {
        if ((vi.net || '') !== v) cmds.push(new ModifyViaCommand(app, vi, { net: vi.net || '' }, { net: v }));
    }
    if (cmds.length) {
        app.history?.execute(cmds.length === 1 ? cmds[0] : new CompoundCommand(cmds));
    }
    return true;
}

function _showViaProperties(app, via) {
    const items = app._pcbPropsItems?.() || document.getElementById('pcbPropsItems');
    if (!items) return;
    app._setPcbPropsTitle?.('Via');
    items.innerHTML = `
        <div class="prop-row"><label>Net</label><input type="text" id="pcbPropViaNet" value="${_escape(via.net || '')}" placeholder="(unassigned)"></div>
        <div class="prop-row"><label>Diameter (mm)</label><input type="number" id="pcbPropViaDia" value="${via.diameter}" min="0.1" step="0.05"></div>
        <div class="prop-row"><label>Drill (mm)</label><input type="number" id="pcbPropViaDrill" value="${via.drill}" min="0.05" step="0.05"></div>
    `;
    const reRender = () => import('./track-render.js').then(({ renderVia }) => {
        renderVia(via, (id) => app._getLayerGroup(id));
        clearTrackSelection(app);
        app._selectedVia = via;
        _drawViaHalo(app, via);
    });
    const baseline = { diameter: via.diameter, drill: via.drill, net: via.net || '' };
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
    const netEl = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbPropViaNet'));
    netEl?.addEventListener('change', () => {
        const v = netEl.value.trim();
        if (v === baseline.net) return;
        if (_applyNetToBondedCopper(app, { via }, v)) {
            baseline.net = v;
        } else {
            netEl.value = baseline.net; // refused — restore the field
        }
    });
    app._setActiveRibbonTab?.('pcb-properties');
}

function _showHoleProperties(app, hole) {
    const items = app._pcbPropsItems?.() || document.getElementById('pcbPropsItems');
    if (!items) return;
    app._setPcbPropsTitle?.('Hole');
    items.innerHTML = `
        <div class="prop-row"><label>Diameter (mm)</label><input type="number" id="pcbPropHoleDia" value="${hole.diameter}" min="0.1" step="0.05"></div>
        <div class="prop-row"><label>Plated</label><input type="checkbox" id="pcbPropHolePlated" ${hole.plated ? 'checked' : ''}></div>
    `;
    const reRender = () => import('./track-render.js').then(({ renderHole }) => {
        renderHole(hole, (id) => app._getLayerGroup(id));
        clearTrackSelection(app);
        app._selectedHole = hole;
        _drawHoleHalo(app, hole);
    });
    const baseline = { diameter: hole.diameter };
    const diaEl = document.getElementById('pcbPropHoleDia');
    diaEl?.addEventListener('input', (e) => {
        const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
        if (Number.isFinite(v) && v > 0) { hole.diameter = v; reRender(); }
    });
    diaEl?.addEventListener('change', (e) => {
        const v = parseFloat(/** @type {HTMLInputElement} */ (e.target).value);
        if (!Number.isFinite(v) || v <= 0 || v === baseline.diameter) return;
        const before = { diameter: baseline.diameter };
        const after = { diameter: v };
        hole.diameter = baseline.diameter;
        app.history?.execute(new ModifyHoleCommand(app, hole, before, after));
        baseline.diameter = v;
    });
    const platedEl = document.getElementById('pcbPropHolePlated');
    platedEl?.addEventListener('change', (e) => {
        const checked = /** @type {HTMLInputElement} */ (e.target).checked;
        if (checked === hole.plated) return;
        const before = { plated: hole.plated };
        const after = { plated: checked };
        app.history?.execute(new ModifyHoleCommand(app, hole, before, after));
    });
    app._setActiveRibbonTab?.('pcb-properties');
}

function _escape(s) {
    return String(s).replace(/[&<>"]/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
}
