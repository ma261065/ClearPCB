import { buildTrackLayerRuns, hasTrackElements, hasViaElements } from './track-render.js';
import { boardShapeClearanceOutlines, pcbTextClearanceOutlines, trackClearanceOutlines } from './copper-fill-geom.js';
import { placementTransform } from './track-commands.js';
import { shouldDeferShapeClearance } from './picture-refresh.js';
import { isPcbPasteActive } from './pcb-paste.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../shapes/track.js').Point} Point */
/** @typedef {import('../../shapes/track.js').Track} Track */
/** @typedef {import('../../shapes/via.js').Via} Via */
/** @typedef {import('../../core/pcb-board-shapes.js').BoardShape} BoardShape */
/** @typedef {import('../../core/pcb-text.js').PcbText} PcbText */
/** @typedef {Point & {layer?: string, width?: number}} TrackRunPoint */
/** @typedef {import('../../shapes/track.js').Track} TrackLike */
/** @typedef {import('../../shapes/via.js').Via} ViaLike */
/** @typedef {Record<string, any> & {id: string, layer: string, content?: string}} ClearanceShape Clearance halos accept board-shape, text, and legacy copper records with module-specific fields. */
/** @typedef {{style: string, artwork: unknown, points: Point[], elements: SVGPolygonElement[]}} ShapeClearanceCacheEntry */
/** @typedef {{cx: number, cy: number, r: number, net?: string}} ViaClearanceSource */
/** @typedef {{element?: SVGCircleElement, sources: Map<string|SVGElement, ViaClearanceSource>}} ViaClearanceEntry */
/** @typedef {{trackElements: Map<string, SVGPolygonElement[]>, viaCache: Map<string, ViaClearanceEntry>, viaKeys: Map<string|SVGElement, string>, clearancesVisible: boolean, boardShapeClearanceCache: Map<string, ShapeClearanceCacheEntry>, padHaloGroups: Map<string, SVGGElement>|null}} ClearanceOverlayState */

/*
 * The clearance overlay: a faint halo at the Clearance distance around every pad,
 * via, track, copper shape and copper text, drawn beneath the copper. Toggled from
 * the Design tab (showClearances); edits refresh only what changed (a dragged track,
 * a moved via or shape). The per-editor overlay state is owned here.
 */

/** @type {WeakMap<PcbEditor, ClearanceOverlayState>} */
const overlayStates = new WeakMap();

/**
 * Halo elements per track id, shared via halos keyed by geometry, and overlay view state.
 * @param {PcbEditor} app
 */
function overlayState(app) {
    let state = overlayStates.get(app);
    if (!state) overlayStates.set(app, state = {
        trackElements: new Map(),
        viaCache: new Map(),
        viaKeys: new Map(),
        clearancesVisible: false,
        boardShapeClearanceCache: new Map(),
        padHaloGroups: null,
    });
    return state;
}

/**
 * The overlay's caches, for tests.
 * @param {PcbEditor} app
 */
export function clearanceOverlayState(app) {
    return overlayState(app);
}

/**
 * Whether the clearance overlay is showing.
 * @param {PcbEditor} app
 */
export function areClearancesVisible(app) {
    return !!overlayState(app).clearancesVisible;
}

/**
 * Cached clearance halo of a board shape or copper text, if any.
 * @param {PcbEditor} app
 * @param {string} id
 */
export function getBoardShapeClearance(app, id) {
    return overlayState(app).boardShapeClearanceCache.get(id);
}

/**
 * Forget a board shape's or text's cached halo (its element is the caller's to remove).
 * @param {PcbEditor} app
 * @param {string} id
 */
export function forgetBoardShapeClearance(app, id) {
    overlayState(app).boardShapeClearanceCache.delete(id);
}

/**
 * The halo group that follows a component's pads during a move, if the overlay is on.
 * @param {PcbEditor} app
 * @param {string} compId
 */
export function getPadHaloGroup(app, compId) {
    return overlayState(app).padHaloGroups?.get(compId);
}

/**
 * Toggle a faint ghost halo showing the clearance band around every
* pad, via, track, and copper/hole shape. The halo width equals the **Clearance** value
 * from the routing tab — i.e. the minimum copper-to-copper gap any
 * other net's copper must keep from this object's edge.
 *
 * Pad shapes (rect / ellipse / oval) are honored. Halos are drawn
 * beneath copper so they don't obscure the board.
 *
 * Wired to the "Clearance" toggle button in the routing tab. Also
 * callable from the console: `bootstrap.pcbApp.showClearances(true|false)`.
 *
 * @param {PcbEditor} app
 * @param {boolean} [show] - explicit on/off; omit to toggle.
 * @param {TrackLike|null} [liveTrack] - update only this track's rendered clearance during a drag.
 */
export function showClearances(app, show, liveTrack = null) {
    const NS = 'http://www.w3.org/2000/svg';
    const HALO_CLASS = 'debug-clearance';
    const OVERLAY_LAYER = 'clearance-overlay';

    const state = overlayState(app);
    const overlay = app.getLayerGroup(OVERLAY_LAYER);
    if (liveTrack) {
        for (const element of state.trackElements.get(liveTrack.id) || []) element.remove();
        state.trackElements.delete(liveTrack.id);
    } else {
        while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
        state.trackElements.clear();
        state.viaCache.clear();
        state.viaKeys.clear();
    }

    if (show === undefined) show = !state.clearancesVisible;
    if (!liveTrack) {
        const shapeIds = new Set([...(app.boardShapes || []), ...(app.texts?.values() || [])].map(shape => shape.id));
        for (const id of state.boardShapeClearanceCache.keys()) {
            if (!shapeIds.has(id)) state.boardShapeClearanceCache.delete(id);
        }
    }
    state.clearancesVisible = !!show;
    if (!state.clearancesVisible) {
        state.boardShapeClearanceCache.clear();
        return;
    }

    const params = app.getRoutingParams();
    const halo = params.clearance;

    const HALO_STROKE = 'rgba(255, 255, 255, 0.55)';
    // Stroke width in CSS pixels (constant on screen at any zoom thanks
    // to vector-effect: non-scaling-stroke). 1px = thin clean line.
    const OUTLINE_W = 1;

    /** @param {SVGElement} el */
    const styleHalo = (el) => {
        el.setAttribute('class', HALO_CLASS);
        el.setAttribute('fill', 'none');
        el.setAttribute('stroke', HALO_STROKE);
        el.setAttribute('stroke-width', String(OUTLINE_W));
        el.setAttribute('vector-effect', 'non-scaling-stroke');
        el.setAttribute('pointer-events', 'none');
    };

    /** @param {string} layerId */
    const isLayerVisible = (layerId) => {
        const g = app.getLayerGroup(layerId);
        return !g || g.style.display !== 'none';
    };
    const topVisible = isLayerVisible('top-copper');
    const bottomVisible = isLayerVisible('bottom-copper');

    // Build a single SVG path representing the Minkowski expansion of a
    // pad shape by `halo`. Returns null if shape unsupported.
    // Geometry is sized exactly to the clearance boundary; the constant-
    // width screen-pixel stroke straddles it.
    /**
     * @param {number} cx
     * @param {number} cy
     * @param {number} w
     * @param {number} h
     * @param {string} shape
     * @returns {SVGCircleElement|SVGEllipseElement|SVGRectElement}
     */
    const padHaloPath = (cx, cy, w, h, shape) => {
        const hw = w / 2, hh = h / 2;
        const grow = halo;
        if (shape === 'ellipse') {
            if (Math.abs(hw - hh) < 1e-9) {
                const r = hw + grow;
                const c = document.createElementNS(NS, 'circle');
                c.setAttribute('cx', String(cx));
                c.setAttribute('cy', String(cy));
                c.setAttribute('r', String(r));
                return c;
            }
            const e = document.createElementNS(NS, 'ellipse');
            e.setAttribute('cx', String(cx));
            e.setAttribute('cy', String(cy));
            e.setAttribute('rx', String(hw + grow));
            e.setAttribute('ry', String(hh + grow));
            return e;
        }
        // 'oval' (stadium) and 'rect' both expand to a rounded rectangle:
        //   oval: corner radius = min(hw, hh) + halo
        //   rect: corner radius = halo (true Minkowski sum with a disk)
        const cornerR = (shape === 'oval' ? Math.min(hw, hh) : 0) + grow;
        const r = document.createElementNS(NS, 'rect');
        r.setAttribute('x', String(cx - hw - grow));
        r.setAttribute('y', String(cy - hh - grow));
        r.setAttribute('width', String(w + grow * 2));
        r.setAttribute('height', String(h + grow * 2));
        r.setAttribute('rx', String(cornerR));
        r.setAttribute('ry', String(cornerR));
        return r;
    };

    // Halos for component pads — wrapped in a per-placement <g> with a
    // translate() transform so they follow the component during drag
    // (the drag handler updates the same transform).
    if (!liveTrack) state.padHaloGroups = new Map();
    const padHaloGroups = state.padHaloGroups;
    for (const [compId, pl] of liveTrack ? [] : app.placements) {
        const grp = document.createElementNS(NS, 'g');
        grp.setAttribute('class', 'halo-comp');
        grp.setAttribute('data-comp-id', compId);
        grp.setAttribute('transform', placementTransform(pl));
        for (const off of (pl.padOffsets || [])) {
            const padLayer = off.layer || 'top';
            // Respect copper-layer visibility. 'both' (through-hole pads)
            // are shown if either copper layer is visible.
            if (padLayer === 'top' && !topVisible) continue;
            if (padLayer === 'bottom' && !bottomVisible) continue;
            if (padLayer === 'both' && !topVisible && !bottomVisible) continue;
            // Coords are pad offsets from the component origin; the
            // wrapping <g> applies pl.x/pl.y as a translate.
            const el = padHaloPath(off.dx, off.dy, off.width || 0, off.height || 0, off.shape || 'rect');
            styleHalo(el);
            grp.appendChild(el);
        }
        overlay.appendChild(grp);
        padHaloGroups?.set(compId, grp);
    }

    /**
     * @param {SVGElement} track
     * @returns {Array<[number, number]>}
     */
    const trackToPoints = (track) => {
        /** @type {Array<[number, number]>} */
        const out = [];
        /**
         * @param {string|null} x
         * @param {string|null} y
         */
        const push = (x, y) => {
            const xn = parseFloat(String(x)), yn = parseFloat(String(y));
            if (Number.isFinite(xn) && Number.isFinite(yn)) out.push([xn, yn]);
        };
        if (track.tagName === 'polyline') {
            const tokens = (track.getAttribute('points') || '').trim().split(/[\s,]+/);
            for (let i = 0; i + 1 < tokens.length; i += 2) push(tokens[i], tokens[i + 1]);
        } else if (track.tagName === 'line') {
            push(track.getAttribute('x1'), track.getAttribute('y1'));
            push(track.getAttribute('x2'), track.getAttribute('y2'));
        }
        // De-dupe consecutive identical points.
        /** @type {Array<[number, number]>} */
        const dedup = [];
        for (const p of out) {
            if (dedup.length === 0 || dedup[dedup.length - 1][0] !== p[0] || dedup[dedup.length - 1][1] !== p[1]) {
                dedup.push(p);
            }
        }
        return dedup;
    };

    const live = liveTrack;
    const liveId = live?.id;
    const liveNet = live?.net;
    /** @type {Array<{layer: string, width: number, points: TrackRunPoint[]}>|null} */
    const liveRuns = live ? (hasTrackElements(live) ? buildTrackLayerRuns(live) : []) : null;
    const layerIds = ['top-copper', 'bottom-copper'];
    for (const layerId of layerIds) {
        if (layerId === 'top-copper' && !topVisible) continue;
        if (layerId === 'bottom-copper' && !bottomVisible) continue;
        // Both the legacy incremental render ('.pcb-routed-track') and
        // the model-driven render ('.pcb-track') are valid track sources.
        /** @type {Array<{points: Array<[number, number]>, width: number, id?: string, net?: string}>} */
        const tracks = liveRuns ? liveRuns.filter(run => run.layer === layerId).map(run => ({
            points: run.points.filter((point, index) => !index
                || point.x !== run.points[index - 1].x || point.y !== run.points[index - 1].y)
                .map(point => /** @type {[number, number]} */ ([point.x, point.y])), width: run.width,
            id: liveId, net: liveNet,
        })) : [.../** @type {NodeListOf<SVGElement>} */ (app.getLayerGroup(layerId).querySelectorAll('.pcb-routed-track, .pcb-track'))]
            .map(track => ({ points: trackToPoints(track), width: parseFloat(String(track.getAttribute('stroke-width'))),
                id: track.dataset?.trackId, net: track.dataset?.net }));
        if (tracks.length === 0) continue;

        for (const track of tracks) {
            const pts = track.points;
            if (pts.length < 2) continue;
            // Each rendered run carries its own stroke-width (tracks can
            // have per-segment widths), so size the halo from THIS track's
            // width rather than the global routing width.
            const sw = track.width;
            const width = Number.isFinite(sw) && sw > 0 ? sw : params.trackWidth;
            for (const poly of trackClearanceOutlines(pts.map(([x, y]) => ({ x, y })), width, halo)) {
                if (poly.length < 3) continue;
                const el = document.createElementNS(NS, 'polygon');
                el.setAttribute('class', HALO_CLASS);
                el.setAttribute('points', poly.map(p => `${p.x.toFixed(4)},${p.y.toFixed(4)}`).join(' '));
                el.setAttribute('fill', 'none');
                el.setAttribute('stroke', HALO_STROKE);
                el.setAttribute('stroke-width', String(OUTLINE_W));
                el.setAttribute('vector-effect', 'non-scaling-stroke');
                el.setAttribute('stroke-linejoin', 'round');
                el.setAttribute('pointer-events', 'none');
                // Tag with the source track's net so a footprint drag can hide
                // the halos of the nets it moves (their tracks shift mid-drag,
                // leaving the deferred halo stranded at the old position).
                const tnet = track.net;
                if (tnet) el.dataset.net = tnet;
                if (track.id) {
                    el.dataset.trackId = track.id;
                    let trackElements = state.trackElements.get(track.id);
                    if (!trackElements) state.trackElements.set(track.id, trackElements = []);
                    trackElements.push(el);
                }
                overlay.appendChild(el);
            }
        }
    }

    if (liveTrack) return;
    for (const shape of app.boardShapes || []) {
        if (shape) refreshBoardShapeClearance(app, shape);
    }
    for (const text of app.texts?.values() || []) refreshBoardShapeClearance(app, text);

    refreshViaClearance(app);
}

/**
 * @param {PcbEditor} app
 * @param {ClearanceShape} shape
 * @param {number} clearance
 * @returns {Point[][]}
 */
export function computeClearanceOutlines(app, shape, clearance) {
    return typeof shape.content === 'string'
        ? pcbTextClearanceOutlines(shape, clearance)
        : boardShapeClearanceOutlines(shape, clearance);
}

/**
 * @param {PcbEditor} app
 * @param {ClearanceShape} shape
 */
export function refreshBoardShapeClearance(app, shape) {
    if (isPcbPasteActive(app)) return;
    if (!areClearancesVisible(app)) return;
    const overlay = app.getLayerGroup('clearance-overlay');
    if (!overlay) return;
    const cache = overlayState(app).boardShapeClearanceCache;
    const previous = cache.get(shape.id);
    if (shouldDeferShapeClearance(app, shape)) {
        for (const element of previous?.elements || []) {
            element.parentNode?.removeChild(element);
        }
        return;
    }
    const clearance = app.getRoutingParams().clearance;
    const layer = app.existingLayerGroups().get(shape.layer);
    const visible = !!layer && layer.style.display !== 'none';
    const isText = typeof shape.content === 'string';
    const points = shape.points || (shape.kind === 'circle' || isText ? [{ x: shape.x, y: shape.y }]
        : shape.kind === 'arc' ? [shape.start, shape.end, shape.bulge] : []);
    const style = JSON.stringify([shape.kind, shape.layer, visible, clearance, shape.net, shape.radius,
        shape.lineWidth, shape.segmentWidths, shape.segmentBulges, shape.filled, shape.copperMode,
        shape.cornerRadius, shape.nodeCornerRadii,
        shape.content, shape.size, shape.strokeWidth, shape.rotation]);
    if (previous && previous.style === style && previous.artwork === shape.artwork
        && points.length && points.length === previous.points.length) {
        const dx = points[0].x - previous.points[0].x;
        const dy = points[0].y - previous.points[0].y;
        if (points.every((/** @type {Point} */ point, /** @type {number} */ index) => Math.abs(point.x - previous.points[index].x - dx) < 1e-9
            && Math.abs(point.y - previous.points[index].y - dy) < 1e-9)) {
            for (const element of previous.elements) {
                element.setAttribute('transform', `translate(${dx} ${dy})`);
                if (element.parentNode !== overlay) overlay.appendChild(element);
            }
            return;
        }
    }
    for (const element of previous?.elements || []) {
        if (element.parentNode === overlay) overlay.removeChild(element);
    }
    /** @type {SVGPolygonElement[]} */
    const elements = [];
    if (visible) for (const outline of computeClearanceOutlines(app, shape, clearance)) {
        const element = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        element.setAttribute('class', 'debug-clearance');
        element.setAttribute('fill', 'none');
        element.setAttribute('stroke', 'rgba(255, 255, 255, 0.55)');
        element.setAttribute('stroke-width', '1');
        element.setAttribute('vector-effect', 'non-scaling-stroke');
        element.setAttribute('pointer-events', 'none');
        element.setAttribute('points', outline.map((/** @type {Point} */ point) => `${point.x},${point.y}`).join(' '));
        element.setAttribute('data-shape-id', shape.id);
        if (shape.net) element.dataset.net = shape.net;
        overlay.appendChild(element);
        elements.push(element);
    }
    cache.set(shape.id, { style, artwork: shape.artwork,
        points: points.map((/** @type {Point} */ point) => ({ x: point.x, y: point.y })), elements });
}

/** @param {PcbEditor} app */
export function refreshClearanceHalos(app) {
    if (areClearancesVisible(app)) showClearances(app, true);
}

/**
 * @param {PcbEditor} app
 * @param {TrackLike} track
 */
export function refreshTrackClearance(app, track) {
    if (areClearancesVisible(app)) showClearances(app, true, track);
}

/**
 * Refresh via halos: just this via's (and whatever shared its halo) when given,
 * otherwise every via.
 * @param {PcbEditor} app
 * @param {ViaLike|null} [via] - a Via, or null for every via
 */
export function refreshViaClearance(app, via = null) {
    if (!areClearancesVisible(app)) return;
    const overlay = app.getLayerGroup('clearance-overlay');
    const layer = app.getLayerGroup('vias');
    if (!overlay) return;
    const state = overlayState(app);
    /** @type {Set<string>} */
    const affected = new Set();
    if (via) {
        const previous = state.viaKeys.get(via.id);
        if (previous != null) {
            state.viaCache.get(previous)?.sources.delete(via.id);
            state.viaKeys.delete(via.id);
            affected.add(previous);
        }
    } else {
        for (const entry of state.viaCache.values()) entry.element?.remove();
        state.viaCache.clear();
        state.viaKeys.clear();
    }
    /**
     * @param {string|SVGElement} id
     * @param {number} cx
     * @param {number} cy
     * @param {number} r
     * @param {string|undefined} net
     */
    const register = (id, cx, cy, r, net) => {
        if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) return;
        const key = `${cx.toFixed(4)},${cy.toFixed(4)}`;
        if (!state.viaCache.has(key)) state.viaCache.set(key, { sources: new Map() });
        const sources = /** @type {ViaClearanceEntry} */ (state.viaCache.get(key)).sources;
        const previous = sources.get(id);
        if (!previous || r > previous.r) sources.set(id, { cx, cy, r, net: net || previous?.net });
        state.viaKeys.set(id, key);
        affected.add(key);
    };
    if (layer && layer.style.display !== 'none') {
        if (via) {
            if (hasViaElements(via)) register(via.id, via.x, via.y, via.diameter / 2, via.net);
        } else for (const rendered of /** @type {NodeListOf<SVGElement>} */ (layer.querySelectorAll('circle.pcb-routed-via, circle.pcb-via, path.pcb-via'))) {
            const path = rendered.localName === 'path';
            register(rendered.dataset?.viaId || rendered,
                parseFloat(String(rendered.getAttribute(path ? 'data-via-x' : 'cx'))),
                parseFloat(String(rendered.getAttribute(path ? 'data-via-y' : 'cy'))),
                parseFloat(String(rendered.getAttribute(path ? 'data-via-radius' : 'r'))), rendered.dataset?.net);
        }
    }
    const clearance = app.getRoutingParams().clearance;
    for (const key of affected) {
        const entry = state.viaCache.get(key);
        if (!entry) continue;
        entry.element?.remove();
        if (!entry.sources.size) {
            state.viaCache.delete(key);
            continue;
        }
        // Coincident vias share the largest ring; moving one must retain any others.
        /** @type {ViaClearanceSource|null} */
        let largest = null, net = '';
        for (const source of entry.sources.values()) {
            if (!largest || source.r > largest.r) {
                largest = source;
                net = source.net || net;
            }
        }
        if (!largest) continue;
        const element = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        element.setAttribute('cx', String(largest.cx));
        element.setAttribute('cy', String(largest.cy));
        element.setAttribute('r', String(largest.r + clearance));
        element.setAttribute('class', 'debug-clearance');
        element.setAttribute('fill', 'none');
        element.setAttribute('stroke', 'rgba(255, 255, 255, 0.55)');
        element.setAttribute('stroke-width', '1');
        element.setAttribute('vector-effect', 'non-scaling-stroke');
        element.setAttribute('pointer-events', 'none');
        if (net) element.dataset.net = net;
        overlay.appendChild(element);
        entry.element = element;
    }
}
