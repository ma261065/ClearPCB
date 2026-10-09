/**
 * The Track tool's drawing session: starting a track (on copper or bare board), adding
 * waypoints, switching copper layer, the live preview, and committing the drawn track with
 * a via at each layer change.
 *
 * A press with the Track tool starts the draw (startTrackDraw) and each further press adds
 * a waypoint (addTrackWaypoint); a press that lands on a pad, track or via finishes it.
 * Pointer moves update the preview (updateTrackDraw). Keys (handleTrackDrawKey): Escape
 * cancels, Enter finishes, Space drops a waypoint and switches the next edge's layer.
 * Finishing commits the clicked waypoints; the rubber band to the cursor is dropped.
 *
 * Where the cursor lands is track-snap.js; ratlines and the net guide line are ratsnest.js;
 * the commit's connection rules are track-commit.js.
 */
import { updateCursorCrosshair } from './cursor-state.js';
import { pcbToolBlockNotice } from './tool-lifecycle.js';
import { Track } from '../../shapes/track.js';
import { Via } from '../../shapes/via.js';
import { viaCopperPathD } from './track-render.js';
import { shapeOutline } from '../../shared/pcb/board-shape-geometry.js';
import { bondedExclusion } from './track-connections.js';
import { showAlert } from '../../shared/ui/modal.js';
import { getPcbInteraction, setPcbInteraction } from './pcb-interactions.js';
import { commitDesignValue, renderDesignSettings } from './design-settings.js';
import { commitDrawnTracks } from './track-commit.js';
import { isLayerLocked } from './layers.js';
import {
    clearAxisGlow,
    makeAxisGlowCenterline,
    makeAxisGlowHalo,
    renderAxisGlow,
    renderAxisGlowTop,
} from './axis-glow.js';
import { clearTrackSnapMarker, resolveTrackDrawSnap, showTrackSnapMarker } from './track-snap.js';
import { clearNetGuideLine, ratlinePointKey, reconcileRatsnest, updateNetGuideLine } from './ratsnest.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {ReturnType<import('../../core/PcbDesignSettings.js').PcbDesignSettings['getRoutingParams']>} RoutingParams */
/**
 * @typedef {object} TrackDrawContext
 * @property {Array<{x:number,y:number}>} points
 * @property {string[]} edgeLayers
 * @property {string} currentLayer
 * @property {number} width
 * @property {string} net
 * @property {{componentId?: string, pinNumber?: string, standalonePad?: unknown, id?: string}|null} startPad
 * @property {{componentId?: string, pinNumber?: string, standalonePad?: unknown, id?: string}|null} endPad
 * @property {string|null} axisLock
 * @property {SVGElement[]} previewElements
 * @property {Map<string, SVGElement>} [previewCache]
 * @property {object|null} snap
 * @property {number} [viaDiameter]
 * @property {number} [viaDrill]
 * @property {unknown[]} [endCopperShapes] copper shapes the finished end lands on
 * @property {any} [guideExclude] bonded copper the live net guide must not point back at
 * @property {Set<any>} [guideSourceShapes]
 * @property {Set<string>} [guideSourceKeys]
 * @property {any} [ratlinePreview]
 * @property {string} [ratlinePreviewSignature]
 * @property {string} [ratlinePreviewNet]
 * @property {Set<any>} [guideSourceShapes]
 * @property {Set<string>} [guideSourceKeys]
 */

const NS = 'http://www.w3.org/2000/svg';

/** Preview polyline CSS class (cleaned up on finish/cancel). */
const PREVIEW_CLASS = 'pcb-track-preview';
const trackToolLayers = new WeakMap();
const trackToolNets = new WeakMap();

/** @param {PcbEditor} app */

export function getTrackToolLayer(app) {
    return trackToolLayers.get(app);
}

/** @param {PcbEditor} app @param {string} layer */
export function setTrackToolLayer(app, layer) {
    trackToolLayers.set(app, layer);
}

/** @param {PcbEditor} app */
export function getTrackToolNet(app) {
    return trackToolNets.get(app);
}

/** @param {PcbEditor} app @param {string} net */
export function setTrackToolNet(app, net) {
    trackToolNets.set(app, net);
}

/** Layers that the Track tool toggles between when Space is pressed. */
const TOGGLE_LAYERS = ['top-copper', 'bottom-copper'];

/** @param {string} net @param {string[]} contactNets */
function trackContactConflict(net, contactNets) {
    const nets = [...new Set([net, ...contactNets].filter(Boolean))];
    if (nets.length < 2) return false;
    showAlert(`Cannot connect different nets: ${nets.map((name) => `"${name}"`).join(', ')}.`,
        { title: 'Net Conflict' });
    return true;
}

/**
 * The open track drawing session (with its current `snap`), or null.
 * @param {PcbEditor} app
 */
export function getTrackDraw(app) {
    return getPcbInteraction(app, '_trackDraw');
}

/**
 * Show Track draw defaults and live draw settings in Properties.
 * @param {PcbEditor} app
 */
export function showTrackDrawProperties(app) {
    app.setPcbStatus();
    const ctx = getTrackDraw(app);
    let widthError = '';
    const currentWidth = () => {
        const p = /** @type {Partial<RoutingParams>} */ (app.getRoutingParams() || {});
        const trackWidth = p.trackWidth;
        return ctx?.width || (typeof trackWidth === 'number' && Number.isFinite(trackWidth) && trackWidth > 0 ? trackWidth : 0.2);
    };
    const currentLayer = () => ctx?.currentLayer || (getTrackToolLayer(app) === 'bottom-copper' ? 'bottom-copper' : 'top-copper');
    const currentNet = () => ctx?.net ?? String(getTrackToolNet(app) || '');
    const refresh = () => app.refreshPropertyPanel(describe());
    /** @param {string} next */
    const setNet = next => {
        setTrackToolNet(app, next);
        if (ctx) {
            ctx.net = next;
            const last = ctx.points[ctx.points.length - 1];
            updateTrackDraw(app, ctx.snap ? { x: ctx.snap.x, y: ctx.snap.y } : last);
        }
        refresh();
    };
    /** @param {string} value */
    const setLayer = value => {
        const next = value === 'bottom-copper' ? 'bottom-copper' : 'top-copper';
        if (isLayerLocked(next)) {
            refresh();
            return;
        }
        setTrackToolLayer(app, next);
        if (ctx) ctx.currentLayer = next;
        app.setPcbStatus();
        refresh();
    };
    /** @param {number} value */
    const setWidth = value => {
        const hadError = !!widthError;
        const result = commitDesignValue(app, 'trackWidth', value, 'mm');
        widthError = result.message;
        if (result.message) refresh();
        if (!result.ok) return;
        const next = app.designSettings.values.trackWidth;
        renderDesignSettings(app);
        if (ctx) {
            ctx.width = next;
            const last = ctx.points[ctx.points.length - 1];
            updateTrackDraw(app, ctx.snap ? { x: ctx.snap.x, y: ctx.snap.y } : last);
        }
        if (hadError) refresh();
    };
    /** @returns {import('../../shared/ui/property-fields.js').PropertyPanel} */
    const describe = () => {
        const notice = pcbToolBlockNotice(app, 'track');
        return {
        title: 'New Track',
        actions: notice.actions,
        fields: [
            { key: 'layer', id: 'pcbPropTrackToolLayer', type: 'select', label: 'Layer', value: currentLayer(), warning: notice.warning,
                options: [
                    { value: 'top-copper', label: 'Top Copper', disabled: isLayerLocked('top-copper') },
                    { value: 'bottom-copper', label: 'Bottom Copper', disabled: isLayerLocked('bottom-copper') },
                ], commit: setLayer },
            { key: 'net', id: 'pcbPropTrackToolNet', type: 'net', label: 'Net', value: currentNet(),
                nets: app.netNames(), commit: setNet },
            { key: 'lineWidth', id: 'pcbPropTrackToolWidth', type: 'number', label: 'Width (mm)',
                value: currentWidth(), min: 0.05, step: 0.05, numberFormat: 'precise',
                error: widthError, preview: setWidth, commit: setWidth },
        ],
        };
    };
    app.openPropertyPanel(describe());
}

/**
 * Begin a new track. Resolves snap at the click point and seeds the
 * draw context with the first anchor. If the click landed on a pad,
 * the pad's net is inherited.
 *
 * @param {PcbEditor} app
 * @param {Point} worldPos - Raw cursor world position
 * @returns {TrackDrawContext|null} the draw context
 */
export function startTrackDraw(app, worldPos) {
    const snap = resolveTrackDrawSnap(app, worldPos, { checkNodeContacts: true });
    const startPad = snap.snapType === 'pad' ? snap.pad : null;
    // Inherit the net at draw start from the pad or track node we begin on,
    // so the live net-guide line works for the whole draw (an unassigned
    // track would have nothing to guide toward).
    let net = startPad?.net || String(getTrackToolNet(app) || '').trim();
    let startTrack = null;
    if (snap.trackNode || snap.trackSegment) {
        startTrack = snap.trackNode?.track || snap.trackSegment?.track || null;
        if (!net) net = startTrack.net || '';
    }
    if (trackContactConflict(net, snap.contactNets)) return null;
    if (!net) net = snap.contactNets[0] || '';
    const layer = TOGGLE_LAYERS.includes(getTrackToolLayer(app)) ? getTrackToolLayer(app) : 'top-copper';
    const width = _getTrackWidth(app);
    const routeOpts = _renderOptsFromApp(app);

    const terminalSeed = snap.via ? { via: snap.via }
        : startPad ? { padKey: startPad.standalonePad
            ? `null|${startPad.standalonePad.id}` : `${startPad.componentId}|${startPad.pinNumber}` } : null;
    /** @type {TrackDrawContext} */
    const ctx = {
        points: [{ x: snap.x, y: snap.y }],
        edgeLayers: [],                  // edgeLayers[i] = layer for segment points[i]→points[i+1]
        currentLayer: layer,
        width,
        net,
        startPad,
        endPad: null,
        endCopperShapes: [],
        axisLock: null,                  // 'horizontal' | 'vertical' | 'diagonal' | null
        previewElements: [],             // SVG nodes owned by the current preview render
        snap,                            // most recent live snap result
        // Copper this draw is already electrically bonded to (the starting
        // Track, Pad or Via cluster), so the live net-guide line never points back at
        // it. Computed once here; the in-progress track isn't in app.tracks,
        // so the bonded set can't change mid-draw.
        guideExclude: bondedExclusion(
            app,
            /** @type {null} */ (/** @type {unknown} */ (startTrack)),
            /** @type {null} */ (/** @type {unknown} */ (terminalSeed)),
        ),
        guideSourceShapes: new Set(snap.copperShapes || []),
        guideSourceKeys: new Set(),
        // Via geometry snapshot — captured at draw-start so the preview
        // marker and the eventually-committed Via render at the same size.
        viaDiameter: routeOpts.viaDiameter,
        viaDrill: routeOpts.viaDrill,
    };
    ctx.guideSourceKeys = new Set(ctx.guideExclude?.ratlinePointKeys);
    ctx.guideSourceKeys.add(ratlinePointKey(ctx.points[0]));
    for (const shape of ctx.guideSourceShapes || []) {
        for (const point of shapeOutline(shape)) ctx.guideSourceKeys.add(ratlinePointKey(point));
    }
    setPcbInteraction(app, '_trackDraw', ctx);
    app.viewport?.setCrosshair({ x: snap.x, y: snap.y });
    _renderPreview(app, ctx, ctx.points[0]);
    if (/** @type {Partial<PcbEditor>} */ (app).openPropertyPanel) showTrackDrawProperties(app);
    return ctx;
}

/**
 * Live preview update on mousemove. Computes the snapped+constrained
 * target and updates the preview polyline.
 * @param {PcbEditor} app
 * @param {Point} worldPos
 */
export function updateTrackDraw(app, worldPos) {
    const ctx = getTrackDraw(app);
    if (!ctx) return;

    const last = ctx.points[ctx.points.length - 1];
    const snap = resolveTrackDrawSnap(app, worldPos, { lastPt: last, net: ctx.net });
    ctx.snap = snap;
    ctx.axisLock = null;
    const target = { x: snap.x, y: snap.y };

    // Yellow target circle when locked onto a hard copper target.
    if (snap.snapType === 'pad' || snap.snapType === 'via'
        || snap.snapType === 'track-node' || snap.copperContact) {
        showTrackSnapMarker(app, target);
    } else {
        clearTrackSnapMarker(app);
    }

    app.viewport?.setCrosshair(target);
    _renderPreview(app, ctx, target);

}

/**
 * Rebuild the active rubber-band preview after a viewport-scale change.
 * @param {PcbEditor} app
 */
export function refreshTrackDrawPreview(app) {
    const ctx = getTrackDraw(app);
    if (!ctx?.snap) return;
    _renderPreview(app, ctx, { x: ctx.snap.x, y: ctx.snap.y });
}

/**
 * Commit the current preview vertex as a permanent waypoint.
 * If the new vertex lands on a pad (with matching net or no current net),
 * the draw is finished automatically.
 * @param {PcbEditor} app
 * @param {Point} worldPos
 */
export function addTrackWaypoint(app, worldPos) {
    const ctx = getTrackDraw(app);
    if (!ctx) return;

    const last = ctx.points[ctx.points.length - 1];
    const snap = resolveTrackDrawSnap(app, worldPos, { lastPt: last, net: ctx.net, checkNodeContacts: true });
    const target = { x: snap.x, y: snap.y };

    if (trackContactConflict(ctx.net, snap.contactNets)) return;

    // Ignore zero-length waypoints (double click on same spot).
    if (Math.hypot(target.x - last.x, target.y - last.y) < 1e-6) {
        // Treat as finish gesture if we already have a usable track.
        if (ctx.points.length >= 2) finishTrackDraw(app);
        return;
    }

    const beforeFinish = { net: ctx.net, endPad: ctx.endPad, endCopperShapes: ctx.endCopperShapes };
    if (!ctx.net) ctx.net = snap.contactNets[0] || '';
    ctx.points.push({ x: target.x, y: target.y });
    ctx.edgeLayers.push(ctx.currentLayer);
    const finishAtTarget = () => {
        if (finishTrackDraw(app) !== false) return;
        ctx.points.pop();
        ctx.edgeLayers.pop();
        Object.assign(ctx, beforeFinish);
        _renderPreview(app, ctx, target);
    };

    // Did we hit a pad? If yes, finish (adopt net if we didn't have one).
    if (snap.snapType === 'pad') {
        const pad = snap.pad;
        if (!ctx.net) ctx.net = pad.net || '';
        if (pad.componentId) ctx.endPad = pad;
        finishAtTarget();
        return;
    }

    if (snap.snapType === 'via') {
        const via = snap.via;
        if (!via) return;
        if (!ctx.net) ctx.net = via.net || '';
        finishAtTarget();
        return;
    }

    // Did we hit an existing track node? If yes, finish (adopt net if none).
    if (snap.snapType === 'track-node') {
        const otherNet = snap.trackNode.track.net || '';
        if (!ctx.net) ctx.net = otherNet;
        finishAtTarget();
        return;
    }

    if (snap.copperContact) {
        ctx.endCopperShapes = (snap.copperShapes || [])
            .filter((shape) => !String(shape.net || '').trim());
        finishAtTarget();
        return;
    }

    _renderPreview(app, ctx, target);
}

/**
 * Toggle the layer used by the *next* segment. The current anchor
 * becomes a layer-change node; on finish, the draw is split into
 * separate single-layer Track objects with a standalone `Via` at that
 * node.
 * @param {PcbEditor} app
 */
export function toggleTrackLayer(app) {
    const ctx = getTrackDraw(app);
    if (!ctx) return;
    const idx = TOGGLE_LAYERS.indexOf(ctx.currentLayer);
    ctx.currentLayer = TOGGLE_LAYERS[(idx + 1) % TOGGLE_LAYERS.length];
    app.setPcbStatus();
    // Re-render preview so the trailing rubber-band uses the new layer's
    // colour and an implicit-via marker appears at the toggle anchor.
    const last = ctx.points[ctx.points.length - 1];
    _renderPreview(app, ctx, ctx.snap ? { x: ctx.snap.x, y: ctx.snap.y } : last);
}

/**
 * Commit the in-progress track to app.tracks and render it. No-op if
 * the track has fewer than two points.
 * @param {PcbEditor} app
 */
export function finishTrackDraw(app) {
    const ctx = getTrackDraw(app);
    if (!ctx) return;

    if (ctx.points.length >= 2) {
        // A draw that toggled layers mid-route is split into one
        // single-layer Track object per layer run, joined at each
        // transition by two coincident single-layer nodes plus a
        // standalone Via — the canonical via/node model (the same shape
        // the via tool produces). This keeps every graph node on exactly
        // one copper layer.
        const { tracks, vias: newVias } = _buildTracksFromContext(ctx);
        if (commitDrawnTracks(app, tracks, newVias, ctx.endCopperShapes) === false) return false;
    }

    _teardownDraw(app);
    // Track tool is still selected — restore its draw settings.
    if (/** @type {Partial<PcbEditor>} */ (app).openPropertyPanel) showTrackDrawProperties(app);
    return true;
}

/**
 * Abort the in-progress track without committing anything.
 * @param {PcbEditor} app
 */
export function cancelTrackDraw(app) {
    _teardownDraw(app);
    if (/** @type {Partial<PcbEditor>} */ (app).openPropertyPanel) showTrackDrawProperties(app);
}

/**
 * Abort in-flight track drawing and remove any pre-draw snap affordance.
 * @param {PcbEditor} app
 */
export function cancelTrackDrawing(app) {
    if (getTrackDraw(app)) _teardownDraw(app);
    clearTrackSnapMarker(app);
}

/**
 * Remove the most recently committed waypoint (and its incoming edge).
 * If only the start anchor remains, the whole draw is cancelled.
 * @param {PcbEditor} app
 */
export function popTrackWaypoint(app) {
    const ctx = getTrackDraw(app);
    if (!ctx) return;
    if (ctx.points.length <= 1) {
        cancelTrackDraw(app);
        return;
    }
    ctx.points.pop();
    ctx.edgeLayers.pop();
    // Re-render preview from current cursor (snap may be stale but is fine).
    const last = ctx.points[ctx.points.length - 1];
    const live = ctx.snap ? { x: ctx.snap.x, y: ctx.snap.y } : last;
    _renderPreview(app, ctx, live);
}

/* ────────────────────────── internals ────────────────────────── */

/** @param {PcbEditor} app */
function _teardownDraw(app) {
    const ctx = getTrackDraw(app);
    if (!ctx) return;
    _clearPreviewElements(ctx);
    clearTrackSnapMarker(app);
    clearNetGuideLine(app);
    // The selected tool owns the crosshair, not the discarded drawing.
    if (app.currentTool !== 'track') app.viewport?.hideCrosshair();
    setPcbInteraction(app, '_trackDraw', null);
    if (ctx.ratlinePreview) {
        reconcileRatsnest(app, { nets: new Set([ctx.ratlinePreviewNet]), skipFillRefresh: true });
    }
}

/** @param {TrackDrawContext} ctx @param {boolean} [keepCached] */
function _clearPreviewElements(ctx, keepCached = false) {
    for (const el of ctx.previewElements || []) el.remove();
    ctx.previewElements = [];
    if (!keepCached) {
        for (const element of ctx.previewCache?.values() || []) element.remove();
        ctx.previewCache?.clear();
    }
}

/**
 * Shared Track and generic-shape H/V/45 glow renderer.
 * @param {PcbEditor} app
 * @param {Array<object|import('../../shapes/axis-glow.js').AxisSegment>} segments
 */
export function renderTrackAxisGlow(app, segments) {
    renderAxisGlow(app, segments);
}

/**
 * Re-render Track-style patterned centerlines after copper redraw.
 * @param {PcbEditor} app
 */
export function renderTrackAxisGlowTop(app) {
    renderAxisGlowTop(app);
}

/**
 * Remove shared Track/generic-shape H/V/45 glow overlays.
 * @param {PcbEditor} app
 */
export function clearTrackAxisGlow(app) {
    clearAxisGlow(app);
}

/** @param {PcbEditor} app @param {TrackDrawContext} ctx @param {Point} livePt */
function refreshDrawRatlines(app, ctx, livePt) {
    if (!ctx.net && !ctx.ratlinePreview) return;
    const points = ctx.points.concat([livePt]);
    const signature = JSON.stringify([ctx.net, points, ctx.edgeLayers, ctx.currentLayer,
        ctx.width, ctx.viaDiameter, ctx.viaDrill]);
    if (ctx.ratlinePreviewSignature === signature) return;
    const previousNet = ctx.ratlinePreviewNet;
    ctx.ratlinePreview = _buildTracksFromContext({ ...ctx, points, endPad: null });
    ctx.ratlinePreviewNet = ctx.net;
    ctx.ratlinePreviewSignature = signature;
    updateNetGuideLine(app, ctx.net, livePt, ctx.guideSourceKeys || null, points);
    /** @type {Set<string>} */
    const nets = new Set();
    if (previousNet) nets.add(previousNet);
    if (ctx.net) nets.add(ctx.net);
    reconcileRatsnest(app, { nets, skipFillRefresh: true });
}

/** @param {PcbEditor} app @param {TrackDrawContext} ctx @param {Point} livePt */
function _renderPreview(app, ctx, livePt) {
    _clearPreviewElements(ctx, true);
    const used = new Set();
    ctx.previewCache ??= new Map();

    // Build the full point list: committed points + live cursor.
    // Each segment has its own layer:
    //   segment i (between points[i] and points[i+1]) uses
    //   edgeLayers[i] for i < committed-edges, currentLayer for the
    //   trailing rubber-band.
    const allPts = ctx.points.concat([livePt]);
    if (allPts.length < 2) {
        _clearPreviewElements(ctx);
        return;
    }

    const segLayers = ctx.edgeLayers.concat([ctx.currentLayer]);
    const width = String(ctx.width || _getTrackWidth(app));

    // Axis-alignment highlight: if the trailing rubber-band segment is
    // horizontal, vertical, or exactly 45°, draw a soft colour glow RING
    // under the preview polyline (solid halo, only the outer ring shows) and
    // a thin white patterned centerline on top. H/V = solid, 45° = dashed.
    const axisGlow = (() => {
        const a = allPts[allPts.length - 2];
        const b = allPts[allPts.length - 1];
        const align = _axisAlignment(a, b);
        if (!align) return null;
        const layerId = segLayers[segLayers.length - 1];
        const parent = app.getLayerGroup(layerId);
        if (!parent) return null;
        const dashKind = align === 'd' ? 'dashed' : 'solid';
        const seg = { a, b, width: ctx.width || _getTrackWidth(app) };
        // Solid colour halo UNDER the polyline.
        const halo = makeAxisGlowHalo(app, seg, _alignColor(align),
            _previewElement(ctx, 'axis:halo', 'line', used));
        parent.appendChild(halo);
        return { seg, dashKind, parent };
    })();

    // Group contiguous same-layer segments into runs and emit one
    // <polyline> per run — mirrors the final render and gives each
    // copper layer its true colour.
    let runStart = 0;
    for (let i = 1; i <= segLayers.length; i++) {
        if (i === segLayers.length || segLayers[i] !== segLayers[runStart]) {
            const layerId = segLayers[runStart];
            const parent = app.getLayerGroup(layerId);
            if (parent) {
                const poly = _previewElement(ctx, `run:${runStart}`, 'polyline', used);
                poly.setAttribute('class', PREVIEW_CLASS);
                poly.setAttribute('fill', 'none');
                poly.setAttribute('stroke', _layerColor(layerId));
                poly.setAttribute('stroke-width', width);
                poly.setAttribute('stroke-linecap', 'round');
                poly.setAttribute('stroke-linejoin', 'round');
                poly.setAttribute('stroke-opacity', '0.9');
                poly.setAttribute('pointer-events', 'none');
                const slice = allPts.slice(runStart, i + 1);
                poly.setAttribute('points', slice.map((p) => `${p.x},${p.y}`).join(' '));
                parent.appendChild(poly);
            }
            runStart = i;
        }
    }

    // White patterned centerline ON TOP of the preview polyline.
    if (axisGlow) {
        const line = makeAxisGlowCenterline(app, axisGlow.seg, axisGlow.dashKind,
            _previewElement(ctx, 'axis:centerline', 'line', used));
        axisGlow.parent.appendChild(line);
    }

    // Implicit-via markers: unknown committed anchor where adjacent committed
    // edges differ in layer, PLUS the trailing anchor if currentLayer
    // differs from the last committed edge's layer.
    const viaLayer = app.getLayerGroup('vias');
    if (viaLayer) {
        const opts = _renderOptsFromApp(app);
        const viaDia = opts.viaDiameter || 0.6;
        const viaDrill = opts.viaDrill || 0.3;
        for (let i = 1; i < segLayers.length; i++) {
            if (segLayers[i] !== segLayers[i - 1]) {
                const p = allPts[i];
                _appendPreviewVia(ctx, viaLayer, p, viaDia, viaDrill, i, used);
            }
        }
    }
    for (const [key, element] of /** @type {Map<string, SVGElement>} */ (ctx.previewCache)) {
        if (used.has(key)) continue;
        element.remove();
        ctx.previewCache.delete(key);
    }
    refreshDrawRatlines(app, ctx, livePt);
}

/** @param {TrackDrawContext} ctx @param {string} key @param {string} tag @param {Set<string>} used @returns {any} */
function _previewElement(ctx, key, tag, used) {
    used.add(key);
    const cache = /** @type {Map<string, SVGElement>} */ (ctx.previewCache);
    let element = cache.get(key);
    if (!element) {
        element = document.createElementNS(NS, tag);
        cache.set(key, element);
    }
    return element;
}

/** @param {TrackDrawContext} ctx @param {SVGGElement} viaLayer @param {Point} p @param {number} viaDia @param {number} viaDrill @param {number} index @param {Set<string>} used */
function _appendPreviewVia(ctx, viaLayer, p, viaDia, viaDrill, index, used) {
    const ring = _previewElement(ctx, `via:${index}:ring`, 'path', used);
    ring.setAttribute('class', PREVIEW_CLASS);
    ring.setAttribute('d', viaCopperPathD({
        x: p.x, y: p.y, diameter: viaDia, drill: viaDrill,
    }));
    ring.setAttribute('fill-rule', 'evenodd');
    ring.setAttribute('fill', '#b8860b');
    ring.setAttribute('fill-opacity', '1');
    ring.setAttribute('pointer-events', 'none');
    viaLayer.appendChild(ring);
}

/**
 * Classify a segment as horizontal, vertical, or diagonal (45°), or
 * return null if it isn't axis-aligned within tolerance.
 *
 * This is the SINGLE definition of "axis-aligned" shared by the snap and
 * the glow. The snap pins a segment to an EXACT axis (applyAxisConstraint
 * zeroes the minor-axis component), so the tolerance is effectively zero —
 * the classifier returns a kind only for geometry the snap actually
 * produced. The drag glow does not call this directly; the segment model
 * (`incidentSegments`) calls it once per edge and the glow renders that
 * decision, so the two can never disagree.
 *
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @returns {'h'|'v'|'d'|null}
 */
export function _axisAlignment(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return null;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    // The snap pins a segment to an EXACT axis (applyAxisConstraint zeroes
    // the minor axis), so the glow only needs to recognise exact alignment.
    // A tight tolerance keeps the glow in lock-step with the snap — a wider
    // angular tolerance would light segments that are close but never snapped
    // (the snap pull is a screen-pixel distance, not a fixed angle).
    const TOL = 1e-4;
    if (ady / len < TOL) return 'h';
    if (adx / len < TOL) return 'v';
    if (Math.abs(adx - ady) / len < TOL) return 'd';
    return null;
}

/** Highlight glow colour per alignment kind (Okabe–Ito colourblind-safe). */
/** @param {string} kind */
function _alignColor(kind) {
    // H/V use yellow (solid line); 45° uses magenta (dashed line). Both are
    // separable from the collinear blue under common colour-vision
    // deficiencies, and the line style carries the meaning regardless.
    if (kind === 'h') return '#E69F00';
    if (kind === 'v') return '#E69F00';
    return '#CC79A7'; // 45°
}

/**
 * Build the committed Track object(s) and any layer-transition Vias from
 * a finished draw context.
 *
 * The drawn path is a simple polyline n0 → n1 → … → nN with a layer per
 * segment. Wherever two consecutive segments use different copper layers
 * the path is cut into separate single-layer Track objects: the previous
 * run ends on a node at the transition point and the next run starts on a
 * *second, coincident* node at the same point. A standalone Via is emitted
 * there. This is the canonical via/node model — every node belongs to
 * exactly one layer, and a layer change is always two coincident
 * single-layer nodes plus a via (matching the via tool's split path).
 *
 * @param {TrackDrawContext} ctx - draw context
 * @returns {{ tracks: Track[], vias: Via[] }}
 */
function _buildTracksFromContext(ctx) {
    const net = ctx.net || '';
    const width = ctx.width || 0.2;
    const pts = ctx.points;
    const segLayers = ctx.edgeLayers;
    const viaDiameter = ctx.viaDiameter;
    const viaDrill = ctx.viaDrill;
    const diameter = typeof viaDiameter === 'number' && Number.isFinite(viaDiameter) && viaDiameter > 0
        ? viaDiameter : 0.6;
    const drill = typeof viaDrill === 'number' && Number.isFinite(viaDrill) && viaDrill > 0
        ? viaDrill : 0.3;

    /** @type {Track[]} */
    const tracks = [];
    /** @type {Point[]} */
    const transitions = []; // {x, y} points where the layer changed
    let cur = null;         // current single-layer Track being built
    let curNodeId = '';     // last node id appended to `cur`

    for (let i = 0; i < pts.length - 1; i++) {
        const segLayer = segLayers[i] || ctx.currentLayer;
        const a = pts[i];
        const b = pts[i + 1];
        if (!cur || segLayer !== cur.layer) {
            // Layer run boundary. If a run preceded this one, `a` is a
            // layer-transition point → drop a via and start a fresh,
            // coincident node so the two runs are separate objects.
            if (cur) transitions.push({ x: a.x, y: a.y });
            cur = new Track({ net, width, layer: segLayer });
            curNodeId = cur.addNode(a.x, a.y);
            tracks.push(cur);
            // Start-pad metadata belongs to the very first node.
            if (i === 0 && ctx.startPad?.componentId) {
                cur.padConnections.set(curNodeId, {
                    componentId: ctx.startPad.componentId,
                    pinNumber: /** @type {string|number} */ (ctx.startPad.pinNumber),
                });
            }
        }
        const nextNodeId = cur.addNode(b.x, b.y);
        cur.addEdge(curNodeId, nextNodeId, { layer: segLayer });
        curNodeId = nextNodeId;
    }

    // End-pad metadata belongs to the last node of the last run.
    if (cur && ctx.endPad) {
        cur.padConnections.set(curNodeId, {
            componentId: /** @type {string} */ (ctx.endPad.componentId),
            pinNumber: /** @type {string|number} */ (ctx.endPad.pinNumber),
        });
    }

    const vias = transitions.map((t) => new Via({
        x: t.x, y: t.y, diameter, drill, net,
    }));
    return { tracks, vias };
}

/** @param {string} layerId */
function _layerColor(layerId) {
    return layerId === 'bottom-copper' ? '#3498db' : '#e74c3c';
}

/** @param {PcbEditor} app */
function _getTrackWidth(app) {
    try {
        return app.getRoutingParams()?.trackWidth || 0.2;
    } catch (_) {
        return 0.2;
    }
}

/** @param {PcbEditor} app */
function _renderOptsFromApp(app) {
    const p = /** @type {Partial<RoutingParams>} */ (app.getRoutingParams() || {});
    return {
        viaDiameter: p.viaDiameter,
        viaDrill: p.viaDrill,
    };
}

/**
 * Keys while a track is being drawn: Escape cancels, Enter finishes, Space drops a
 * waypoint at the snap point and switches copper layer. Other keys are not consumed.
 * @param {PcbEditor} app
 * @param {KeyboardEvent} e
 * @returns {boolean|null} null when no track is being drawn, else whether the key was consumed.
 */
export function handleTrackDrawKey(app, e) {
    const draw = getTrackDraw(app);
    if (!draw) return null;
    if (e.key === 'Escape') {
        cancelTrackDraw(app);
        return true;
    }
    if (e.key === 'Enter') {
        finishTrackDraw(app);
        return true;
    }
    if (e.code === 'Space' || e.key === ' ') {
        const snap = draw.snap;
        if (snap) addTrackWaypoint(app, { x: snap.x, y: snap.y });
        if (getTrackDraw(app)) toggleTrackLayer(app);
        return true;
    }
    return false;
}

/**
 * A primary press with the Track tool: start a track, or add its next waypoint.
 * @param {PcbEditor} app
 * @param {Point} worldPos
 */
export function pressTrackTool(app, worldPos) {
    if (getTrackDraw(app)) addTrackWaypoint(app, worldPos);
    else startTrackDraw(app, worldPos);
}

/**
 * Pointer movement with the Track tool before a press: the crosshair sits on the snap
 * point, and a marker shows the copper the first press would start from, using the same
 * hard targets as the route itself so that press cannot snap elsewhere.
 * @param {PcbEditor} app
 * @param {MouseEvent} e
 */
export function hoverTrackTool(app, e) {
    const snap = resolveTrackDrawSnap(app, app.screenToWorld(e), {});
    updateCursorCrosshair(app, { x: snap.x, y: snap.y });
    if (snap.snapType === 'pad' || snap.snapType === 'via' || snap.snapType === 'track-node') {
        showTrackSnapMarker(app, { x: snap.x, y: snap.y });
    } else {
        clearTrackSnapMarker(app);
    }
}
