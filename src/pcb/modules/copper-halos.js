/**
 * Halos on tracks, vias and pads: the selection halo, the hover highlight, and the net
 * highlight that lights every piece of copper on the hovered net.
 */
import { buildTrackLayerRuns } from './track-render.js';
import { displayedVia, canonicalTrack, displayedTrack } from './track-commands.js';
import { PCB_HOVER_HIGHLIGHT_OPACITY, PCB_SELECTION_HIGHLIGHT_OPACITY, isLayerVisible } from './layers.js';
import { setBoardShapeNetHover } from './board-shape-render.js';
import { normalizeShapeCopperMode } from '../../shared/pcb/board-shape-geometry.js';
import { getPcbSelection } from './selection-registry.js';
import { renderPcbSelectionAnchors } from './selection-anchors.js';
import { resolveTrackEdgePaths } from '../../shared/pcb/board-geometry.js';
import { padOutline } from '../../shapes/pad-geometry.js';
import { getPropertyEditor } from './property-editors.js';
import { getSelectedTrack, getSelectedVia, getTrackEdit, trackIsVisible } from './track-select.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../shapes/track.js').Track} Track */
/** @typedef {import('../../shapes/via.js').Via} Via */
/** @typedef {import('../../shapes/pad.js').Pad} Pad */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {{type:'pad', componentId: string, pinNumber: string|number}|{type:'standalone-pad', pad: Pad}|{type:'shape', shape: CopperShape}|TrackViaHit} CopperHoverHit */
/** @typedef {CopperHoverHit|{type: string, componentId: string, pinNumber: string|number}|{type: string, pad: Pad}|{type: string, shape: CopperShape}} PublicCopperHoverHit */
/** @typedef {{id?: string, type?: string, net?: string, layer?: string, copperMode?: string}} CopperShape */
/** @typedef {{kind:'pad', key:string}|{kind:'track', track:Track}|{kind:'via', via:Via}} HoverQueueItem */
/** @typedef {import('./track-select.js').TrackViaHit} TrackViaHit */

const NS = 'http://www.w3.org/2000/svg';

export const HALO_CLASS = 'pcb-track-selection';
const HOVER_CLASS = 'pcb-track-hover';
const VIA_BATCH_HALO_CLASS = 'pcb-box-via-sel';

/** Halo stroke colour — translucent white overlays the track so the
 *  underlying copper colour still reads through. Kept low-opacity so a
 *  selected track only brightens slightly and its layer colour (top vs
 *  bottom) stays clearly distinguishable. */
export const HALO_COLOR = '#ffffff';
const HALO_OPACITY_SELECTED = PCB_SELECTION_HIGHLIGHT_OPACITY;
const HALO_OPACITY_HOVER = PCB_HOVER_HIGHLIGHT_OPACITY;

/**
 * Re-draw the selection halo for the currently-selected track/via.
 * Call this after the underlying track has been re-rendered (e.g.
 * during a vertex drag) so the halo follows the new geometry.
 * @param {PcbEditor} app
 */
export function refreshTrackSelectionHalo(app) {
    removeHalosByClass(app, HALO_CLASS);
    const selectedVias = getPcbSelection(app, 'via');
    if (selectedVias.length > 1) {
        removeHalosByClass(app, VIA_BATCH_HALO_CLASS);
        for (const via of selectedVias) drawViaHalo(app, via, VIA_BATCH_HALO_CLASS, HALO_OPACITY_SELECTED);
        renderPcbSelectionAnchors(app);
        return;
    }
    // A previous batch refresh can leave its Via-specific overlay behind.
    // It is only valid for a multi-selection; otherwise a larger old ring
    // masks the freshly resized single-selection halo when the Via shrinks.
    if (getPcbSelection(app).length === 1) removeHalosByClass(app, VIA_BATCH_HALO_CLASS);
    const selectedTrack = getSelectedTrack(app);
    const selectedVia = getSelectedVia(app);
    const edit = getTrackEdit(app);
    const selectedNode = canonicalTrack(app, selectedTrack) === edit?.track
        && selectedTrack?.nodes.has(edit.nodeId);
    if (edit?.edgeId && canonicalTrack(app, selectedTrack) === edit.track) {
        drawSegmentHalo(app, selectedTrack, edit.edgeId);
    } else if (selectedTrack && !selectedNode) drawTrackHalo(app, selectedTrack, HALO_CLASS, HALO_OPACITY_SELECTED);
    else if (selectedVia) drawViaHalo(app, selectedVia, HALO_CLASS, HALO_OPACITY_SELECTED);
    if (selectedTrack && edit?.track === canonicalTrack(app, selectedTrack)) {
        getPropertyEditor(app, 'track')?.refresh?.();
    }
    renderPcbSelectionAnchors(app);
}

/** What the hover highlight was last drawn for, per editor (a track, via or key). */
const hoverKeys = new WeakMap();

/**
 * Remove the hover highlight and forget what it was drawn for.
 * @param {PcbEditor} app
 */
export function clearHoverHighlight(app) {
    removeHalosByClass(app, HOVER_CLASS);
    hoverKeys.delete(app);
}

/**
 * Set the currently-hovered track/via highlight. Pass `null` to clear.
 * Selected objects keep their selection halo while the rest of the hovered
 * net receives hover halos.
 * @param {PcbEditor} app
 * @param {PublicCopperHoverHit|null} hit
 */
export function setHoverHighlight(app, hit) {
    /** @type {CopperHoverHit|null} */
    let hover = null;
    if (hit?.type === 'track' && 'track' in hit) {
        const track = displayedTrack(app, canonicalTrack(app, hit.track));
        hover = { type: 'track', track };
    } else if (hit?.type === 'via' && 'via' in hit) {
        hover = { type: 'via', via: displayedVia(app, hit.via) };
    } else if (hit?.type === 'pad' && 'componentId' in hit && 'pinNumber' in hit) {
        hover = { type: 'pad', componentId: hit.componentId, pinNumber: hit.pinNumber };
    } else if (hit?.type === 'standalone-pad' && 'pad' in hit) {
        hover = { type: 'standalone-pad', pad: hit.pad };
    } else if (hit?.type === 'shape' && 'shape' in hit) {
        hover = { type: 'shape', shape: hit.shape };
    }
    const selectedTrack = getSelectedTrack(app);
    const selectedVia = getSelectedVia(app);
    const selectedPad = getPcbSelection(app, 'pad')[0] || null;
    const key = hover
        ? (hover.type === 'track' ? hover.track
            : hover.type === 'via' ? hover.via
            : hover.type === 'pad' ? `pad:${hover.componentId}|${hover.pinNumber}`
                : hover.type === 'standalone-pad' ? `standalone-pad:${hover.pad.id}`
                    : hover.type === 'shape' ? `shape:${hover.shape.id}`
            : null)
        : null;
    if ((hoverKeys.get(app) ?? null) === key) return;
    hoverKeys.set(app, key);
    removeHalosByClass(app, HOVER_CLASS);
    if (!hover) {
        setBoardShapeNetHover(app, []);
        return;
    }
    if (hover.type === 'track' || hover.type === 'via'
        || hover.type === 'pad' || hover.type === 'standalone-pad' || hover.type === 'shape') {
        const seed = hover;
        const net = collectHoveredNet(app, seed);
        for (const track of net.tracks) {
            if (track !== selectedTrack) drawTrackHalo(app, track, HOVER_CLASS, HALO_OPACITY_HOVER);
        }
        for (const via of net.vias) {
            if (via !== selectedVia) drawViaHalo(app, via, HOVER_CLASS, HALO_OPACITY_HOVER);
        }
        for (const padKey of net.pads) {
            const [componentId, pinNumber] = padKey.split('|');
            _drawSinglePadHighlight(app, componentId, pinNumber, HOVER_CLASS, HALO_OPACITY_HOVER);
        }
        for (const pad of net.standalonePads) {
            if (pad !== selectedPad) drawStandalonePadHalo(app, pad, HOVER_CLASS, HALO_OPACITY_HOVER);
        }
        setBoardShapeNetHover(app, /** @type {Iterable<import('../../core/pcb-board-shapes.js').BoardShape>} */ (net.shapes));
    }
}

/**
 * The copper a hover over `seed` highlights: everything on its net, plus copper joined
 * to it through shared track nodes, vias at track nodes and pad connections. Tracks are
 * indexed by node position and pad once per walk, so a hover costs linear time on large
 * boards; the walk visits tracks in board order, as a scan would.
 * @param {Pick<PcbEditor, 'tracks'|'vias'|'pads'|'boardShapes'|'netlist'>} app
 * @param {CopperHoverHit} seed
 */
export function collectHoveredNet(app, seed) {
    /** @type {Set<Track>} */
    const tracks = new Set();
    /** @type {Set<Via>} */
    const vias = new Set();
    /** @type {Set<string>} */
    const pads = new Set();
    /** @type {Set<Pad>} */
    const standalonePads = new Set();
    /** @type {Set<CopperShape>} */
    const shapes = new Set();
    /** @type {Map<string, Via>} */
    const viaByPos = new Map();
    for (const via of app.vias || []) viaByPos.set(_posKey(via.x, via.y), via);
    /** @type {Map<string, Track[]>} */
    const tracksByPos = new Map();
    /** @type {Map<string, Track[]>} */
    const tracksByPad = new Map();
    /**
     * @param {Map<string, Track[]>} map
     * @param {string} key
     * @param {Track} track
     */
    const index = (map, key, track) => {
        const list = map.get(key);
        if (!list) map.set(key, [track]);
        else if (list[list.length - 1] !== track) list.push(track);
    };
    for (const track of app.tracks || []) {
        for (const node of track.nodes.values()) index(tracksByPos, _posKey(node.x, node.y), track);
        for (const connection of track.padConnections?.values?.() || []) {
            index(tracksByPad, `${connection.componentId}|${connection.pinNumber}`, track);
        }
    }

    const netName = seed.type === 'track'
        ? seed.track.net || ''
        : seed.type === 'via'
            ? seed.via.net || ''
            : seed.type === 'standalone-pad'
                ? seed.pad.net || ''
                : seed.type === 'shape'
                    ? seed.shape.net || ''
                : _netForPad(app, seed.componentId, seed.pinNumber);
    if (netName) {
        for (const track of app.tracks || []) if (track.net === netName) tracks.add(track);
        for (const via of app.vias || []) if (via.net === netName) vias.add(via);
        for (const pad of app.pads || []) if (pad.net === netName) standalonePads.add(pad);
        for (const shape of app.boardShapes || []) {
            // Pours share the board-shape collection but draw themselves (copper-fill-render.js);
            // drawn as a board shape, a pour would leave a stray ring when it moved.
            if (shape.type === 'fill') continue;
            if (shape.net === netName
                && (shape.layer === 'top-copper' || shape.layer === 'bottom-copper')
                && normalizeShapeCopperMode(shape.copperMode) === 'add') shapes.add(shape);
        }
        const netEntry = (app.netlist || []).find((entry) => entry.net === netName);
        for (const pin of netEntry?.pins || []) pads.add(`${pin.componentId}|${pin.pinNumber}`);
    }

    /** @type {HoverQueueItem[]} */
    const queue = [];
    if (seed.type === 'pad') {
        const key = `${seed.componentId}|${seed.pinNumber}`;
        pads.add(key);
        queue.push({ kind: 'pad', key });
    } else if (seed.type === 'track') {
        tracks.add(seed.track);
        queue.push({ kind: 'track', track: seed.track });
    } else if (seed.type === 'via') {
        vias.add(seed.via);
        queue.push({ kind: 'via', via: seed.via });
    } else if (seed.type === 'shape') {
        shapes.add(seed.shape);
    } else {
        standalonePads.add(seed.pad);
    }
    for (const track of tracks) queue.push({ kind: 'track', track });
    for (const via of vias) queue.push({ kind: 'via', via });
    for (const key of pads) queue.push({ kind: 'pad', key });

    while (queue.length) {
        const item = queue.shift();
        if (!item) continue;
        if (item.kind === 'pad') {
            for (const track of tracksByPad.get(item.key) || []) {
                if (tracks.has(track)) continue;
                tracks.add(track);
                queue.push({ kind: 'track', track });
            }
        } else if (item.kind === 'track') {
            for (const connection of item.track.padConnections?.values?.() || []) {
                const key = `${connection.componentId}|${connection.pinNumber}`;
                if (!pads.has(key)) { pads.add(key); queue.push({ kind: 'pad', key }); }
            }
            for (const node of item.track.nodes.values()) {
                const key = _posKey(node.x, node.y);
                const via = viaByPos.get(key);
                if (via && !vias.has(via)) { vias.add(via); queue.push({ kind: 'via', via }); }
                for (const otherTrack of tracksByPos.get(key) || []) {
                    if (otherTrack === item.track || tracks.has(otherTrack)) continue;
                    tracks.add(otherTrack);
                    queue.push({ kind: 'track', track: otherTrack });
                }
            }
        } else if (item.kind === 'via') {
            for (const track of tracksByPos.get(_posKey(item.via.x, item.via.y)) || []) {
                if (tracks.has(track)) continue;
                tracks.add(track);
                queue.push({ kind: 'track', track });
            }
        }
    }
    return { tracks, vias, pads, standalonePads, shapes };
}

/**
 * @param {number} x
 * @param {number} y
 */
function _posKey(x, y) {
    // 0.01 mm bucket — matches the autorouter-adapter's pad lookup.
    return `${Math.round(x * 100)},${Math.round(y * 100)}`;
}

/**
 * Look up the net name a pad belongs to, or '' if unknown.
 * @param {Pick<PcbEditor, 'netlist'>} app
 * @param {string} componentId
 * @param {string|number} pinNumber
 */
function _netForPad(app, componentId, pinNumber) {
    for (const entry of app.netlist || []) {
        for (const pin of entry.pins || []) {
            if (String(pin.componentId) === String(componentId)
                && String(pin.pinNumber) === String(pinNumber)) {
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
 * @param {PcbEditor} app
 * @param {string} componentId
 * @param {string|number} pinNumber
 * @param {string} cls
 * @param {number} opacity
 */
function _drawSinglePadHighlight(app, componentId, pinNumber, cls, opacity) {
    const pl = app.placements?.get(componentId);
    if (!pl) return;
    const off = pl.padOffsets?.find((p) => String(p.number) === String(pinNumber));
    const padId = off?.padId ?? pinNumber;
    const pos = pl.pads?.get(padId)
        || [...(pl.pads?.entries?.() || [])].find(([id]) => String(id) === String(padId))?.[1];
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
        const parent = app.getLayerGroup(layerId);
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

/**
 * Remove every halo with the given CSS class from all layers.
 * @param {PcbEditor} app
 * @param {string} cls
 */
export function removeHalosByClass(app, cls) {
    const groups = app.existingLayerGroups();
    if (!groups) return;
    for (const g of groups.values()) {
        g.querySelectorAll(`.${cls}`).forEach((el) => el.remove());
    }
}

/* ── Public halo helpers (used by box-select multi-selection) ── */

/**
 * @param {PcbEditor} app
 * @param {Pad} pad
 * @param {string} cls
 * @param {number} [opacity]
 */
export function drawStandalonePadHalo(app, pad, cls, opacity = HALO_OPACITY_SELECTED) {
    const parent = app.getLayerGroup('selection-overlay');
    if (!parent) return;
    const points = padOutline({ ...pad, x: 0, y: 0 });
    const polygon = document.createElementNS(NS, 'polygon');
    polygon.setAttribute('class', cls);
    polygon.setAttribute('points', points.map(point => `${point.x},${point.y}`).join(' '));
    polygon.setAttribute('transform', `translate(${pad.x},${pad.y})`);
    polygon.setAttribute('fill', HALO_COLOR);
    polygon.setAttribute('fill-opacity', String(opacity));
    polygon.setAttribute('stroke', 'none');
    polygon.setAttribute('pointer-events', 'none');
    polygon.dataset.padId = pad.id;
    parent.appendChild(polygon);
}

/* ──────────────────────────── halos ──────────────────────────── */

/**
 * Draw a halo over a track (a selection halo unless another class is given).
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {string} [cls]
 * @param {number} [opacity]
 */
export function drawTrackHalo(app, track, cls = HALO_CLASS, opacity = HALO_OPACITY_SELECTED) {
    if (!trackIsVisible(track)) return;
    const edit = getTrackEdit(app);
    if (getPcbSelection(app).length === 1 && edit?.track === canonicalTrack(app, track)
        && track.nodes.has(edit.nodeId)) return;
    // Lay a translucent white overlay along each layer-run, at the same
    // width as the track itself, so it brightens the copper in place
    // instead of producing an outer glow that lags behind moves.
    const runs = buildTrackLayerRuns(track);
    for (const run of runs) {
        if (!isLayerVisible(run.layer)) continue;
        const parent = app.getLayerGroup(cls === HOVER_CLASS ? run.layer : 'selection-overlay');
        if (!parent) continue;
        const poly = document.createElementNS(NS, 'polyline');
        poly.setAttribute('class', cls);
        poly.setAttribute('points', run.points.map(/** @param {Point} p */ (p) => `${p.x},${p.y}`).join(' '));
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
}

/**
 * Draw the selection halo for a single track edge (segment selection).
 * Overlays just that one edge plus handles at its two endpoints.
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {string} edgeId
 * @param {string} [cls]
 * @param {number} [opacity]
 */
export function drawSegmentHalo(app, track, edgeId, cls = HALO_CLASS, opacity = HALO_OPACITY_SELECTED) {
    const e = track.edges?.get(edgeId);
    if (!e) return;
    const a = track.nodes.get(e.from);
    const b = track.nodes.get(e.to);
    if (!a || !b) return;
    const layerId = track.getEdgeLayer(edgeId) || 'top-copper';
    if (track.visible === false || !isLayerVisible(layerId)) return;
    const parent = app.getLayerGroup(cls === HOVER_CLASS ? layerId : 'selection-overlay');
    if (parent) {
        const line = document.createElementNS(NS, 'polyline');
        line.setAttribute('class', cls);
        line.setAttribute('points', resolveTrackEdgePaths(track).get(edgeId).map(/** @param {Point} point */ (point) => `${point.x},${point.y}`).join(' '));
        line.setAttribute('fill', 'none');
        line.setAttribute('stroke-linejoin', 'round');
        line.setAttribute('stroke', HALO_COLOR);
        line.setAttribute('stroke-width', String(track.getEdgeWidth(edgeId) || 0.2));
        line.setAttribute('stroke-linecap', 'round');
        line.setAttribute('stroke-opacity', String(opacity));
        line.setAttribute('pointer-events', 'none');
        parent.appendChild(line);
    }
    _drawPadHighlights(app, track, cls, opacity);
}

/**
 * Highlight every pad the track is connected to with the same
 * translucent-white overlay, so the user can see which component pins
 * the track lands on.
 * @param {PcbEditor} app
 * @param {Track} track
 * @param {string} cls
 * @param {number} opacity
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
            const parent = app.getLayerGroup(layerId);
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

/**
 * Draw a halo over a via (a selection halo unless another class is given).
 * @param {PcbEditor} app
 * @param {Via} via
 * @param {string} [cls]
 * @param {number} [opacity]
 */
export function drawViaHalo(app, via, cls = HALO_CLASS, opacity = HALO_OPACITY_SELECTED) {
    const layer = app.getLayerGroup('vias');
    if (!layer) return;
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', String(via.x));
    c.setAttribute('cy', String(via.y));
    c.setAttribute('r', String(via.diameter / 2));
    c.setAttribute('fill', HALO_COLOR);
    c.setAttribute('fill-opacity', String(opacity));
    c.setAttribute('stroke', 'none');
    c.setAttribute('pointer-events', 'none');
    layer.appendChild(c);
}

/**
 * Draw a hole highlight with an inscribed "X" cross so the drilled centre is
 * unmistakable. The visual state is derived from `cls`:
 *   - hover  → just the X (the bore stays open)
 *   - select → the X plus a filled disc
 * @param {PcbEditor} app
 * @param {{x: number, y: number, diameter?: number}} hole
 * @param {string} [cls]
 * @param {number} [opacity]
 */
function _drawHoleHalo(app, hole, cls = HALO_CLASS, opacity = HALO_OPACITY_SELECTED) {
    const layer = app.getLayerGroup('hole');
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
