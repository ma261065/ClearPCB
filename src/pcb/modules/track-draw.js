/**
 * Interactive Track drawing for the PCB editor (Phase 2).
 *
 * Mirrors the schematic Wire drawing flow (src/schematic/modules/wire.js)
 * but operates on Track / Via models living on PCBApp.tracks / PCBApp.vias.
 *
 * Drawing lifecycle, driven from PCBApp's mouse/key handlers:
 *   1. User selects the "track" tool          → currentTool = 'track'
 *   2. First mousedown                        → startTrackDraw(app, snap)
 *   3. mousemove                              → updateTrackDraw(app, world)
 *   4. mousedown                              → addTrackWaypoint(app, snap)
 *      Snapping to a pad on the same net (or any pad if no net yet)
 *      finishes the draw automatically.
 *   5. Space                                  → toggleTrackLayer(app)
 *      Switches the *next* edge's layer; a via is implied at the current
 *      cursor anchor (handled by Track.getImplicitViaNodes during render).
 *   6. Escape / right-click / double-click    → cancelTrackDraw / finishTrackDraw
 *
 * Track storage:
 *   - The in-progress track is held on `app._trackDraw` (a private context
 *     object). The committed Track is pushed onto `app.tracks` and rendered.
 *
 * Snap priority: pad > track node > track segment > grid.
 * Axis lock: H / V / 45° based on dominant cursor axis (with a small
 *   choice zone around the last anchor for re-picking direction).
 */

import { Track } from '../../shapes/track.js';
import { renderTrack } from './track-render.js';

const NS = 'http://www.w3.org/2000/svg';

/** Preview polyline CSS class (cleaned up on finish/cancel). */
const PREVIEW_CLASS = 'pcb-track-preview';

/** Pad snap tolerance (world mm). */
export const PAD_SNAP_TOL = 1.0;

/** Track-node snap tolerance (world mm). */
export const TRACK_SNAP_TOL = 0.5;

/** Layers that the Track tool toggles between when Space is pressed. */
const TOGGLE_LAYERS = ['top-copper', 'bottom-copper'];

/* ──────────────────────────── snap helpers ──────────────────────────── */

/**
 * Find the nearest pad center to `worldPos` within `tolerance`.
 * @returns {{x:number, y:number, componentId:string, pinNumber:string, net:string}|null}
 */
export function findNearbyPad(app, worldPos, tolerance = PAD_SNAP_TOL) {
    if (!app?.placements) return null;
    const tol2 = tolerance * tolerance;
    let best = null;
    let bestD2 = Infinity;
    for (const [compId, pl] of app.placements) {
        if (!pl?.pads) continue;
        for (const [pinNum, pad] of pl.pads) {
            const dx = pad.x - worldPos.x;
            const dy = pad.y - worldPos.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2 && d2 <= tol2) {
                bestD2 = d2;
                best = { x: pad.x, y: pad.y, componentId: compId, pinNumber: String(pinNum) };
            }
        }
    }
    if (!best) return null;
    best.net = _padNet(app, best.componentId, best.pinNumber);
    return best;
}

/**
 * Find the nearest Track node (endpoint or junction) to `worldPos`.
 * @returns {{x:number, y:number, track:object, nodeId:string}|null}
 */
export function findNearbyTrackNode(app, worldPos, tolerance = TRACK_SNAP_TOL, excludeTrack = null) {
    if (!app?.tracks?.length) return null;
    const tol2 = tolerance * tolerance;
    let best = null;
    let bestD2 = Infinity;
    for (const track of app.tracks) {
        if (track === excludeTrack) continue;
        for (const [nid, p] of track.nodes) {
            const dx = p.x - worldPos.x;
            const dy = p.y - worldPos.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2 && d2 <= tol2) {
                bestD2 = d2;
                best = { x: p.x, y: p.y, track, nodeId: nid };
            }
        }
    }
    return best;
}

/**
 * Resolve a snap target for the track tool.
 * @returns {{x:number, y:number, snapType:'pad'|'track-node'|'grid', pad?:object, trackNode?:object}}
 */
export function resolveTrackSnap(app, worldPos, options = {}) {
    const padTol = options.padTolerance ?? PAD_SNAP_TOL;
    const trackTol = options.trackTolerance ?? TRACK_SNAP_TOL;
    const excludeTrack = options.excludeTrack || null;

    const nearPad = findNearbyPad(app, worldPos, padTol);
    if (nearPad) {
        return { x: nearPad.x, y: nearPad.y, snapType: 'pad', pad: nearPad };
    }
    const nearNode = findNearbyTrackNode(app, worldPos, trackTol, excludeTrack);
    if (nearNode) {
        return { x: nearNode.x, y: nearNode.y, snapType: 'track-node', trackNode: nearNode };
    }
    const grid = app.viewport?.getSnappedPosition?.(worldPos) || { x: worldPos.x, y: worldPos.y };
    return { x: grid.x, y: grid.y, snapType: 'grid' };
}

/**
 * Apply the active drawing constraint (H / V / 45°) relative to the last
 * anchor. The dominant axis component is preserved; the minor component is
 * snapped to 0 (axis-aligned) or to ±|dominant| (45°).
 */
export function applyAxisConstraint(lastPt, target, axis) {
    const dx = target.x - lastPt.x;
    const dy = target.y - lastPt.y;
    if (axis === 'horizontal') {
        return { x: target.x, y: lastPt.y };
    }
    if (axis === 'vertical') {
        return { x: lastPt.x, y: target.y };
    }
    // 45°: align minor axis with sign of dominant axis so the segment is
    // exactly diagonal of length |dominant|.
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (adx >= ady) {
        const sy = Math.sign(dy) || 1;
        return { x: target.x, y: lastPt.y + sy * adx };
    } else {
        const sx = Math.sign(dx) || 1;
        return { x: lastPt.x + sx * ady, y: target.y };
    }
}

/**
 * Choose H / V / 45° based on which axis the cursor is moving on.
 * 45° is selected when |dx| and |dy| are within `diagBand` of each other
 * (relative to the larger). Otherwise the dominant axis wins.
 */
function pickAxis(lastPt, worldPos, diagBand = 0.3) {
    const dx = Math.abs(worldPos.x - lastPt.x);
    const dy = Math.abs(worldPos.y - lastPt.y);
    const major = Math.max(dx, dy);
    if (major < 1e-9) return 'horizontal';
    const ratio = Math.min(dx, dy) / major;
    if (ratio >= 1 - diagBand) return 'diagonal';
    return dx >= dy ? 'horizontal' : 'vertical';
}

/* ──────────────────────────── lifecycle ──────────────────────────── */

/**
 * Begin a new track. Resolves snap at the click point and seeds the
 * draw context with the first anchor. If the click landed on a pad,
 * the pad's net is inherited.
 *
 * @param {object} app - PCBApp
 * @param {object} worldPos - Raw cursor world position
 * @returns {object} the draw context (also stored on app._trackDraw)
 */
export function startTrackDraw(app, worldPos) {
    const snap = resolveTrackSnap(app, worldPos);
    const startPad = snap.snapType === 'pad' ? snap.pad : null;
    const net = startPad?.net || '';
    const layer = TOGGLE_LAYERS.includes(app.activeLayer) ? app.activeLayer : 'top-copper';
    const width = _getTrackWidth(app);

    /** @type {TrackDrawContext} */
    const ctx = {
        points: [{ x: snap.x, y: snap.y }],
        edgeLayers: [],                  // edgeLayers[i] = layer for segment points[i]→points[i+1]
        currentLayer: layer,
        width,
        net,
        startPad,
        endPad: null,
        axisLock: null,                  // 'horizontal' | 'vertical' | 'diagonal' | null
        previewElements: [],             // SVG nodes owned by the current preview render
        snap,                            // most recent live snap result
    };
    app._trackDraw = ctx;
    _renderPreview(app, ctx, ctx.points[0]);
    app._showTrackDrawProperties?.(ctx);
    return ctx;
}

/**
 * Live preview update on mousemove. Computes the snapped+constrained
 * target and updates the preview polyline.
 */
export function updateTrackDraw(app, worldPos) {
    const ctx = app._trackDraw;
    if (!ctx) return;

    // Snap raw cursor first (so pads/nodes always win over axis lock).
    const snap = resolveTrackSnap(app, worldPos);
    ctx.snap = snap;

    const last = ctx.points[ctx.points.length - 1];
    let target = { x: snap.x, y: snap.y };

    // If the snap fell back to grid, enforce axis constraint relative to
    // last anchor. Pad/track-node snaps override the lock (you can always
    // hit them).
    if (snap.snapType === 'grid') {
        const axis = pickAxis(last, worldPos);
        ctx.axisLock = axis;
        target = applyAxisConstraint(last, target, axis);
    } else {
        ctx.axisLock = null;
    }

    _renderPreview(app, ctx, target);
}

/**
 * Commit the current preview vertex as a permanent waypoint.
 * If the new vertex lands on a pad (with matching net or no current net),
 * the draw is finished automatically.
 */
export function addTrackWaypoint(app, worldPos) {
    const ctx = app._trackDraw;
    if (!ctx) return;

    const snap = resolveTrackSnap(app, worldPos);
    const last = ctx.points[ctx.points.length - 1];
    let target = { x: snap.x, y: snap.y };
    if (snap.snapType === 'grid') {
        target = applyAxisConstraint(last, target, pickAxis(last, worldPos));
    }

    // Ignore zero-length waypoints (double click on same spot).
    if (Math.hypot(target.x - last.x, target.y - last.y) < 1e-6) {
        // Treat as finish gesture if we already have a usable track.
        if (ctx.points.length >= 2) finishTrackDraw(app);
        return;
    }

    ctx.points.push({ x: target.x, y: target.y });
    ctx.edgeLayers.push(ctx.currentLayer);

    // Did we hit a pad? If yes, finish (adopt net if we didn't have one).
    if (snap.snapType === 'pad') {
        const pad = snap.pad;
        if (!ctx.net) ctx.net = pad.net || '';
        if (!ctx.net || !pad.net || ctx.net === pad.net) {
            ctx.endPad = pad;
            finishTrackDraw(app);
            return;
        }
        // Net mismatch — leave the segment in place and let user retreat.
    }

    // Did we hit an existing same-net track node? If yes, finish.
    if (snap.snapType === 'track-node') {
        const otherNet = snap.trackNode.track.net || '';
        if (!ctx.net || !otherNet || ctx.net === otherNet) {
            if (!ctx.net) ctx.net = otherNet;
            finishTrackDraw(app);
            return;
        }
    }

    _renderPreview(app, ctx, target);
}

/**
 * Toggle the layer used by the *next* segment. The current anchor will
 * become an implicit via (a node where adjacent edge layers differ —
 * Track.getImplicitViaNodes() picks it up at render time).
 */
export function toggleTrackLayer(app) {
    const ctx = app._trackDraw;
    if (!ctx) return;
    const idx = TOGGLE_LAYERS.indexOf(ctx.currentLayer);
    ctx.currentLayer = TOGGLE_LAYERS[(idx + 1) % TOGGLE_LAYERS.length];
    // Re-render preview so the trailing rubber-band uses the new layer's
    // colour and an implicit-via marker appears at the toggle anchor.
    const last = ctx.points[ctx.points.length - 1];
    _renderPreview(app, ctx, ctx.snap ? { x: ctx.snap.x, y: ctx.snap.y } : last);
}

/**
 * Commit the in-progress track to app.tracks and render it. No-op if
 * the track has fewer than two points.
 */
export function finishTrackDraw(app) {
    const ctx = app._trackDraw;
    if (!ctx) return;

    if (ctx.points.length >= 2) {
        const track = _buildTrackFromContext(ctx);
        // If PCBApp provides an undo hook, route the add through it so
        // the track lands on the history stack. Otherwise fall back to
        // a direct push + render.
        if (typeof app._commitTrack === 'function') {
            app._commitTrack(track);
        } else {
            app.tracks.push(track);
            renderTrack(track, (id) => app._getLayerGroup(id), _renderOptsFromApp(app));
            reconcileRatsnest(app);
        }
    }

    _teardownDraw(app);
    app._clearProperties?.();
}

/**
 * Abort the in-progress track without committing anything.
 */
export function cancelTrackDraw(app) {
    _teardownDraw(app);
    app._clearProperties?.();
}

/**
 * Remove the most recently committed waypoint (and its incoming edge).
 * If only the start anchor remains, the whole draw is cancelled.
 */
export function popTrackWaypoint(app) {
    const ctx = app._trackDraw;
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

/**
 * Recompute ratsnest visibility based on current copper connectivity.
 *
 * For each net we union-find the pads using each Track as evidence
 * that all pads it touches are now electrically connected:
 *   - A Track contributes its pad-touching nodes into one set per
 *     connected component of its graph.
 *   - A pad is "touched" if it has a padConnections entry OR if a Track
 *     node coincides with the pad's world position (catches autorouter-
 *     produced tracks which don't set padConnections).
 *
 * Then every ratsnest `<line data-net="X">` is hidden iff its endpoint
 * positions map to pads in the same union-find class.
 */
export function reconcileRatsnest(app) {
    const ratLayer = app._getLayerGroup?.('ratlines');
    if (!ratLayer) return;

    const posKey = (x, y) => `${Math.round(x * 10000)},${Math.round(y * 10000)}`;
    /** @type {Map<string, string>} */
    const padByPos = new Map();
    for (const [compId, pl] of app.placements) {
        if (!pl?.pads) continue;
        for (const [pinNum, pad] of pl.pads) {
            padByPos.set(posKey(pad.x, pad.y), `${compId}|${pinNum}`);
        }
    }

    /** @type {Map<string, Map<string, string>>} */
    const parents = new Map();
    const ensure = (net, k) => {
        if (!parents.has(net)) parents.set(net, new Map());
        const m = parents.get(net);
        if (!m.has(k)) m.set(k, k);
        return m;
    };
    const find = (net, k) => {
        const m = parents.get(net);
        let cur = k;
        while (m.get(cur) !== cur) {
            m.set(cur, m.get(m.get(cur)));
            cur = m.get(cur);
        }
        return cur;
    };
    const union = (net, a, b) => {
        ensure(net, a); ensure(net, b);
        const ra = find(net, a);
        const rb = find(net, b);
        if (ra !== rb) parents.get(net).set(ra, rb);
    };

    for (const track of app.tracks) {
        if (!track?.net) continue;

        // BFS to label each node with its graph component index.
        const compOfNode = new Map();
        const adj = new Map();
        for (const nid of track.nodes.keys()) adj.set(nid, []);
        for (const e of track.edges.values()) {
            adj.get(e.from)?.push(e.to);
            adj.get(e.to)?.push(e.from);
        }
        let compIdx = 0;
        for (const start of track.nodes.keys()) {
            if (compOfNode.has(start)) continue;
            const stack = [start];
            while (stack.length) {
                const n = stack.pop();
                if (compOfNode.has(n)) continue;
                compOfNode.set(n, compIdx);
                for (const m of adj.get(n) || []) stack.push(m);
            }
            compIdx++;
        }

        // Pad keys touched per component.
        /** @type {Map<number, string[]>} */
        const padsByComp = new Map();
        const touch = (c, padKey) => {
            if (!padsByComp.has(c)) padsByComp.set(c, []);
            padsByComp.get(c).push(padKey);
        };
        for (const [nid, conn] of track.padConnections) {
            const c = compOfNode.get(nid);
            if (c != null) touch(c, `${conn.componentId}|${conn.pinNumber}`);
        }
        for (const [nid, p] of track.nodes) {
            const k = padByPos.get(posKey(p.x, p.y));
            if (!k) continue;
            const c = compOfNode.get(nid);
            if (c != null) touch(c, k);
        }

        for (const pads of padsByComp.values()) {
            ensure(track.net, pads[0]);
            for (let i = 1; i < pads.length; i++) union(track.net, pads[0], pads[i]);
        }
    }

    // Toggle ratsnest line visibility. Skip the per-failed-connection
    // lines added by the autorouter — those have their own lifecycle.
    for (const el of ratLayer.querySelectorAll('line.ratsnest-line')) {
        if (el.classList.contains('ratsnest-failed')) continue;
        const net = el.dataset.net || '';
        if (!net) continue;
        const x1 = parseFloat(el.getAttribute('x1'));
        const y1 = parseFloat(el.getAttribute('y1'));
        const x2 = parseFloat(el.getAttribute('x2'));
        const y2 = parseFloat(el.getAttribute('y2'));
        const a = padByPos.get(posKey(x1, y1));
        const b = padByPos.get(posKey(x2, y2));
        const m = parents.get(net);
        const satisfied = !!(a && b && m && m.has(a) && m.has(b) && find(net, a) === find(net, b));
        /** @type {HTMLElement} */ (el).style.display = satisfied ? 'none' : '';
    }
}

/* ────────────────────────── internals ────────────────────────── */

function _teardownDraw(app) {
    const ctx = app._trackDraw;
    if (!ctx) return;
    _clearPreviewElements(ctx);
    app._trackDraw = null;
}

function _clearPreviewElements(ctx) {
    if (!ctx.previewElements) return;
    for (const el of ctx.previewElements) el.remove();
    ctx.previewElements = [];
}

function _renderPreview(app, ctx, livePt) {
    _clearPreviewElements(ctx);

    // Build the full point list: committed points + live cursor.
    // Each segment has its own layer:
    //   segment i (between points[i] and points[i+1]) uses
    //   edgeLayers[i] for i < committed-edges, currentLayer for the
    //   trailing rubber-band.
    const allPts = ctx.points.concat([livePt]);
    if (allPts.length < 2) return;

    const segLayers = ctx.edgeLayers.concat([ctx.currentLayer]);
    const width = String(ctx.width || _getTrackWidth(app));

    // Group contiguous same-layer segments into runs and emit one
    // <polyline> per run — mirrors the final render and gives each
    // copper layer its true colour.
    let runStart = 0;
    for (let i = 1; i <= segLayers.length; i++) {
        if (i === segLayers.length || segLayers[i] !== segLayers[runStart]) {
            const layerId = segLayers[runStart];
            const parent = app._getLayerGroup(layerId);
            if (parent) {
                const poly = document.createElementNS(NS, 'polyline');
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
                ctx.previewElements.push(poly);
            }
            runStart = i;
        }
    }

    // Implicit-via markers: any committed anchor where adjacent committed
    // edges differ in layer, PLUS the trailing anchor if currentLayer
    // differs from the last committed edge's layer.
    const holeLayer = app._getLayerGroup('hole');
    if (holeLayer) {
        const opts = _renderOptsFromApp(app);
        const viaDia = opts.viaDiameter || 0.6;
        const viaDrill = opts.viaDrill || 0.3;
        for (let i = 1; i < segLayers.length; i++) {
            if (segLayers[i] !== segLayers[i - 1]) {
                const p = allPts[i];
                _appendPreviewVia(ctx, holeLayer, p, viaDia, viaDrill);
            }
        }
    }
}

function _appendPreviewVia(ctx, holeLayer, p, viaDia, viaDrill) {
    const ring = document.createElementNS(NS, 'circle');
    ring.setAttribute('class', PREVIEW_CLASS);
    ring.setAttribute('cx', String(p.x));
    ring.setAttribute('cy', String(p.y));
    ring.setAttribute('r', String(viaDia / 2));
    ring.setAttribute('fill', '#b8860b');
    ring.setAttribute('fill-opacity', '0.9');
    ring.setAttribute('pointer-events', 'none');
    holeLayer.appendChild(ring);
    ctx.previewElements.push(ring);

    const drill = document.createElementNS(NS, 'circle');
    drill.setAttribute('class', PREVIEW_CLASS);
    drill.setAttribute('cx', String(p.x));
    drill.setAttribute('cy', String(p.y));
    drill.setAttribute('r', String(viaDrill / 2));
    drill.setAttribute('fill', '#1a1a2e');
    drill.setAttribute('pointer-events', 'none');
    holeLayer.appendChild(drill);
    ctx.previewElements.push(drill);
}

function _buildTrackFromContext(ctx) {
    const track = new Track({
        net: ctx.net || '',
        width: ctx.width || 0.2,
        layer: ctx.edgeLayers[0] || ctx.currentLayer,
    });

    // Build the graph as a simple path: n0 → n1 → … → nN.
    const nodeIds = [];
    for (const p of ctx.points) nodeIds.push(track.addNode(p.x, p.y));
    for (let i = 0; i < nodeIds.length - 1; i++) {
        const eid = track.addEdge(nodeIds[i], nodeIds[i + 1]);
        track.edgeLayers.set(eid, ctx.edgeLayers[i] || ctx.currentLayer);
    }

    // Pad-connection metadata for endpoints.
    if (ctx.startPad) {
        track.padConnections.set(nodeIds[0], {
            componentId: ctx.startPad.componentId,
            pinNumber: ctx.startPad.pinNumber,
        });
    }
    if (ctx.endPad) {
        track.padConnections.set(nodeIds[nodeIds.length - 1], {
            componentId: ctx.endPad.componentId,
            pinNumber: ctx.endPad.pinNumber,
        });
    }
    return track;
}

function _padNet(app, componentId, pinNumber) {
    if (!Array.isArray(app.netlist)) return '';
    for (const entry of app.netlist) {
        if (!entry?.pins) continue;
        for (const pin of entry.pins) {
            if (pin.componentId === componentId && String(pin.pinNumber) === String(pinNumber)) {
                return entry.net || '';
            }
        }
    }
    return '';
}

function _layerColor(layerId) {
    return layerId === 'bottom-copper' ? '#3498db' : '#e74c3c';
}

function _getTrackWidth(app) {
    try {
        return app._getRoutingParams?.()?.trackWidth || 0.2;
    } catch (_) {
        return 0.2;
    }
}

function _renderOptsFromApp(app) {
    const p = app._getRoutingParams?.() || {};
    return {
        viaDiameter: p.viaDiameter,
        viaDrill: p.viaDrill,
    };
}

/**
 * @typedef {object} TrackDrawContext
 * @property {Array<{x:number,y:number}>} points
 * @property {string[]} edgeLayers
 * @property {string} currentLayer
 * @property {number} width
 * @property {string} net
 * @property {object|null} startPad
 * @property {object|null} endPad
 * @property {string|null} axisLock
 * @property {SVGElement[]} previewElements
 * @property {object|null} snap
 */
