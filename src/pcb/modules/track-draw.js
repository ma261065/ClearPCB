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
 *      Switches the *next* edge's layer. On finish, a standalone Via
 *      is emitted at each layer-change node and added to app.vias.
 *   6. Escape / double-click                  → finishTrackDraw
 *      Commits whatever waypoints have been clicked so far. The
 *      trailing rubber-band segment (between the last click and the
 *      cursor) is dropped — it was never committed.
 *      Right-click / tool-switch                → cancelTrackDraw
 *      Aborts the whole draw without committing anything.
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
import { Via } from '../../shapes/via.js';
import { renderTrack } from './track-render.js';
import { collinearSnap } from '../../core/geometry.js';

const NS = 'http://www.w3.org/2000/svg';

/** Preview polyline CSS class (cleaned up on finish/cancel). */
const PREVIEW_CLASS = 'pcb-track-preview';

/**
 * Screen-pixel pull radius for the collinear (straight-line) snap applied
 * while dragging a degree-2 waypoint between its two neighbours.
 */
export const COLLINEAR_SNAP_SCREEN_PX = 6;

/**
 * Glow colour shown when two incident segments are collinear (any angle).
 * Okabe–Ito blue — sits on the blue–yellow axis so it stays distinct from
 * the yellow/magenta axis glows for red–green colourblind users. Paired
 * with a DOTTED line style so it never relies on hue alone.
 */
const COLLINEAR_GLOW_COLOR = '#0072B2';

/**
 * Angle tolerance (normalized cross product ≈ sine of the corner angle)
 * for the collinear-pair glow. Matches the on-release merge tolerance
 * (`COLLINEAR_EPSILON` in polyline-graph.js) so the glow lights exactly
 * when releasing would fuse the two segments — important for SEGMENT
 * drags, which translate freely with no collinear snap and so never reach
 * the much tighter precision a node drag's projection snap achieves.
 */
export const COLLINEAR_GLOW_ANGLE_TOL = 0.01;

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
 *
 * Priority (highest first):
 *   1. Pad centre (electrical connection)
 *   2. Track node on the *same net*
 *   3. Track node on any net
 *   4. 45° diagonal line from `options.lastPt`
 *   5. Per-axis snap to grid line or to H/V axis through `options.lastPt`
 *      (X and Y resolved independently — both axes can snap, only one
 *      can snap, or neither)
 *
 * All proximity tests for grid/axis snapping use a screen-pixel
 * tolerance so the feel is constant across zoom levels.
 *
 * @param {object} app
 * @param {{x:number,y:number}} worldPos
 * @param {object} [options]
 * @param {number} [options.padTolerance]
 * @param {number} [options.trackTolerance]
 * @param {object} [options.excludeTrack]
 * @param {(track:object, nodeId:string)=>boolean} [options.excludeNode] -
 *   Predicate returning true for track nodes that should be ignored when
 *   snapping (e.g. the nodes that move in lock-step with a dragged via).
 * @param {{x:number,y:number}} [options.lastPt] - Previous waypoint
 *   (enables H/V/45° axis snapping).
 * @param {string} [options.net] - Net of the in-progress track (used
 *   to bias same-net snapping).
 * @returns {{x:number, y:number, snapType:'pad'|'track-node'|'axis'|'grid'|'free', pad?:object, trackNode?:object}}
 */
export function resolveTrackSnap(app, worldPos, options = {}) {
    const padTol = options.padTolerance ?? PAD_SNAP_TOL;
    const trackTol = options.trackTolerance ?? TRACK_SNAP_TOL;
    const excludeTrack = options.excludeTrack || null;
    const excludeNode = options.excludeNode || null;
    const lastPt = options.lastPt || null;
    const net = options.net || '';

    const nearPad = findNearbyPad(app, worldPos, padTol);
    if (nearPad) {
        return { x: nearPad.x, y: nearPad.y, snapType: 'pad', pad: nearPad };
    }
    // Prefer same-net track nodes; fall back to any node.
    const nearNode = _findNearbyTrackNodePreferNet(app, worldPos, trackTol, excludeTrack, net, excludeNode);
    if (nearNode) {
        return { x: nearNode.x, y: nearNode.y, snapType: 'track-node', trackNode: nearNode };
    }

    // Screen-pixel tolerance for grid / axis snapping.
    const scale = app.viewport?.scale || 1;
    const tol = SNAP_PX / scale;

    // ── 45° diagonal from last anchor (couples both X and Y) ──
    if (lastPt) {
        const dx = worldPos.x - lastPt.x;
        const dy = worldPos.y - lastPt.y;
        // Perpendicular distance to y = lastPt.y ± (x - lastPt.x).
        const d1 = Math.abs(dy - dx) / Math.SQRT2; // slope +1
        const d2 = Math.abs(dy + dx) / Math.SQRT2; // slope -1
        const dMin = Math.min(d1, d2);
        // Only snap to the diagonal when we're clearly off both pure
        // H and pure V axes — otherwise H or V wins (handled below).
        const offH = Math.abs(dy) > tol;
        const offV = Math.abs(dx) > tol;
        if (dMin <= tol && offH && offV) {
            const slope = d1 < d2 ? 1 : -1;
            const t = (dx + slope * dy) / 2;
            return {
                x: lastPt.x + t,
                y: lastPt.y + slope * t,
                snapType: 'axis',
            };
        }
    }

    // ── Per-axis snap: closer of grid-line vs axis-through-lastPt ──
    let sx = worldPos.x;
    let sy = worldPos.y;
    let snappedX = false;
    let snappedY = false;
    // Snap to the *displayed* grid spacing (the adaptive 1-2-5 multiple
    // shown on screen), not the raw base gridSize — otherwise snapping
    // lands on an "invisible" finer grid between the visible lines when
    // zoomed out.
    const gs = app.viewport?.getEffectiveGridSize?.()
        ?? app.viewport?.gridSize ?? 0;
    const gridOn = gs > 0 && app.viewport?.gridVisible !== false;

    // Candidate X-snaps
    {
        let bestDx = tol;
        if (gridOn) {
            const gx = Math.round(worldPos.x / gs) * gs;
            const d = Math.abs(gx - worldPos.x);
            if (d <= bestDx) { bestDx = d; sx = gx; snappedX = true; }
        }
        if (lastPt) {
            const d = Math.abs(lastPt.x - worldPos.x);
            if (d <= bestDx) { bestDx = d; sx = lastPt.x; snappedX = true; }
        }
    }
    // Candidate Y-snaps
    {
        let bestDy = tol;
        if (gridOn) {
            const gy = Math.round(worldPos.y / gs) * gs;
            const d = Math.abs(gy - worldPos.y);
            if (d <= bestDy) { bestDy = d; sy = gy; snappedY = true; }
        }
        if (lastPt) {
            const d = Math.abs(lastPt.y - worldPos.y);
            if (d <= bestDy) { bestDy = d; sy = lastPt.y; snappedY = true; }
        }
    }

    if (snappedX || snappedY) {
        // Mark as 'axis' if any axis component locked to lastPt, else 'grid'.
        const axisHit = lastPt && (sx === lastPt.x || sy === lastPt.y);
        return { x: sx, y: sy, snapType: axisHit ? 'axis' : 'grid' };
    }
    return { x: worldPos.x, y: worldPos.y, snapType: 'free' };
}

/** Screen-pixel tolerance for grid / axis-line snapping. */
const SNAP_PX = 8;

/**
 * Same as findNearbyTrackNode but prefers nodes whose owning Track
 * matches `preferredNet`. A same-net hit beats an other-net hit even
 * if the other-net node is geometrically closer (within tolerance).
 */
function _findNearbyTrackNodePreferNet(app, worldPos, tolerance, excludeTrack, preferredNet, excludeNode) {
    if (!app?.tracks?.length) return null;
    const tol2 = tolerance * tolerance;
    let bestSameNet = null, bestSameD2 = Infinity;
    let bestAny = null, bestAnyD2 = Infinity;
    for (const track of app.tracks) {
        if (track === excludeTrack) continue;
        const sameNet = preferredNet && track.net === preferredNet;
        for (const [nid, p] of track.nodes) {
            if (excludeNode && excludeNode(track, nid)) continue;
            const dx = p.x - worldPos.x;
            const dy = p.y - worldPos.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > tol2) continue;
            if (sameNet) {
                if (d2 < bestSameD2) { bestSameD2 = d2; bestSameNet = { x: p.x, y: p.y, track, nodeId: nid }; }
            } else {
                if (d2 < bestAnyD2) { bestAnyD2 = d2; bestAny = { x: p.x, y: p.y, track, nodeId: nid }; }
            }
        }
    }
    return bestSameNet || bestAny;
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

/**
 * If the dragged node is within `threshold` world units of forming an
 * H / V / 45° segment with any neighbour, snap the node so that segment is
 * exactly aligned. Each neighbour offers three candidate axes (horizontal,
 * vertical, 45°); a candidate qualifies when the node sits within
 * `threshold` of the aligned line, and across all neighbours/axes the one
 * needing the smallest nudge wins. The band is a perpendicular *distance*
 * (so the pull feels the same regardless of segment length), matching the
 * collinear snap band.
 *
 * @param {{x:number,y:number}} pos current dragged-node position
 * @param {Array<{x:number,y:number}>} neighbours positions of adjacent nodes
 * @param {number} [threshold] perpendicular pull distance (world mm); when
 *   omitted, falls back to the legacy angular test (any alignment accepted).
 * @returns {{x:number,y:number}}
 */
export function snapNodeToAxis(pos, neighbours, threshold = Infinity) {
    let best = null;
    let bestDist = Infinity;
    for (const nb of neighbours) {
        for (const axis of ['horizontal', 'vertical', 'diagonal']) {
            const snapped = applyAxisConstraint(nb, pos, axis);
            const d = Math.hypot(snapped.x - pos.x, snapped.y - pos.y);
            if (d <= threshold && d < bestDist) {
                bestDist = d;
                best = snapped;
            }
        }
    }
    return best || pos;
}

/**
 * Straight-line (collinear) snap for a degree-2 waypoint: when the node
 * has exactly two neighbours and sits within `threshold` world units of
 * the line connecting them, project it onto that line so its two incident
 * segments become exactly collinear (a straight run at ANY angle). Returns
 * the projected position, or null when not applicable / out of range.
 *
 * @param {{x:number,y:number}} pos current dragged-node position
 * @param {Array<{x:number,y:number}>} neighbours positions of adjacent nodes
 * @param {number} threshold perpendicular pull distance (world mm)
 * @returns {{x:number,y:number}|null}
 */
export function snapNodeToCollinear(pos, neighbours, threshold) {
    if (neighbours.length !== 2) return null;
    return collinearSnap(neighbours[0], pos, neighbours[1], threshold);
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
    const routeOpts = _renderOptsFromApp(app);

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
        // Via geometry snapshot — captured at draw-start so the preview
        // marker and the eventually-committed Via render at the same size.
        viaDiameter: routeOpts.viaDiameter,
        viaDrill: routeOpts.viaDrill,
    };
    app._trackDraw = ctx;
    _renderPreview(app, ctx, ctx.points[0]);
    app._showTrackDrawToolOptions?.(ctx);
    return ctx;
}

/**
 * Live preview update on mousemove. Computes the snapped+constrained
 * target and updates the preview polyline.
 */
export function updateTrackDraw(app, worldPos) {
    const ctx = app._trackDraw;
    if (!ctx) return;

    const last = ctx.points[ctx.points.length - 1];
    const snap = resolveTrackSnap(app, worldPos, { lastPt: last, net: ctx.net });
    ctx.snap = snap;
    ctx.axisLock = null;
    const target = { x: snap.x, y: snap.y };

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

    const last = ctx.points[ctx.points.length - 1];
    const snap = resolveTrackSnap(app, worldPos, { lastPt: last, net: ctx.net });
    const target = { x: snap.x, y: snap.y };

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
 * Toggle the layer used by the *next* segment. The current anchor
 * becomes a layer-change node; on finish, the draw is split into
 * separate single-layer Track objects with a standalone `Via` at that
 * node.
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
        // A draw that toggled layers mid-route is split into one
        // single-layer Track object per layer run, joined at each
        // transition by two coincident single-layer nodes plus a
        // standalone Via — the canonical via/node model (the same shape
        // the via tool produces). This keeps every graph node on exactly
        // one copper layer.
        const { tracks, vias: newVias } = _buildTracksFromContext(ctx);
        // If PCBApp provides an undo hook, route the add through it so
        // the tracks land on the history stack. Otherwise fall back to
        // a direct push + render.
        if (typeof app._commitTracks === 'function') {
            app._commitTracks(tracks, newVias);
        } else {
            for (const track of tracks) {
                app.tracks.push(track);
                renderTrack(track, (id) => app._getLayerGroup(id), _renderOptsFromApp(app));
            }
            for (const v of newVias) {
                app.vias.push(v);
                // Render lazily to avoid a hard import cycle.
                import('./track-render.js').then(({ renderVia }) => {
                    renderVia(v, (id) => app._getLayerGroup(id));
                });
            }
            reconcileRatsnest(app);
        }
    }

    _teardownDraw(app);
    // Track tool is still selected — show its idle options (width).
    app._showTrackToolOptions?.();
}

/**
 * Abort the in-progress track without committing anything.
 */
export function cancelTrackDraw(app) {
    _teardownDraw(app);
    app._showTrackToolOptions?.();
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
 * Rebuild the ratsnest from net connectivity.
 *
 * The ratsnest is derived purely from net names: any pad, Track or Via
 * that carries a net name is a "terminal" on that net. Terminals are
 * grouped into clusters of physically-connected copper, then for every
 * net with two or more disconnected clusters a minimum-spanning-tree of
 * dashed guide lines is drawn between the nearest points of each cluster.
 *
 * Connectivity rules (all within a single net):
 *   - Each connected component of a Track's graph is one cluster.
 *   - A Via is a cluster (a single point).
 *   - A pad is a cluster (net assigned from the schematic netlist).
 *   - Two clusters merge when any of their points coincide — this is how
 *     a routed Track joins the pads / vias it lands on, removing the rat
 *     line automatically.
 *
 * Autorouter "failed" lines (class `ratsnest-failed`) have their own
 * lifecycle and are left untouched.
 *
 * @param {object} app - PCBApp
 */
export function reconcileRatsnest(app) {
    // The clearance overlay is derived from the rendered trace geometry, so
    // it must be rebuilt whenever the copper changes — exactly the same set
    // of call sites that reconcile the ratsnest (live vertex drag, drag
    // finish, and every track/via command). Keep the two overlays in lock-
    // step here (no-op unless the clearance overlay is currently visible).
    app._refreshClearanceHalos?.();

    const ratLayer = app._getLayerGroup?.('ratlines');
    if (!ratLayer) return;

    // Clear previously-generated ratsnest (keep autorouter failed lines).
    for (const el of [...ratLayer.children]) {
        if (el.classList?.contains('ratsnest-failed')) continue;
        el.remove();
    }

    const posKey = (x, y) => `${Math.round(x * 10000)},${Math.round(y * 10000)}`;

    /** @type {Array<{net:string, layer:string, points:Array<{x:number,y:number}>}>} */
    const clusters = [];

    // ── Tracks: one cluster per connected component ──
    // Each component is single-layer (the via/node invariant keeps the two
    // layers at a via on SEPARATE coincident nodes with no edge between
    // them), so we tag the cluster with that layer. Connectivity across
    // layers then requires an explicit bond (via / pad), not bare
    // coincidence — so deleting a via correctly disconnects the layers.
    for (const track of (app.tracks || [])) {
        const net = track.net || '';
        if (!net) continue;
        const adj = new Map();
        for (const nid of track.nodes.keys()) adj.set(nid, []);
        for (const [eid, e] of track.edges) {
            const layer = track.edgeLayers.get(eid) || track.layer;
            adj.get(e.from)?.push({ to: e.to, layer });
            adj.get(e.to)?.push({ to: e.from, layer });
        }
        const seen = new Set();
        for (const start of track.nodes.keys()) {
            if (seen.has(start)) continue;
            const points = [];
            const layers = new Set();
            const stack = [start];
            while (stack.length) {
                const n = stack.pop();
                if (seen.has(n)) continue;
                seen.add(n);
                const p = track.nodes.get(n);
                if (p) points.push({ x: p.x, y: p.y });
                for (const m of adj.get(n) || []) {
                    layers.add(m.layer);
                    stack.push(m.to);
                }
            }
            if (points.length) {
                // A clean component is single-layer; if somehow mixed, fall
                // back to 'all' so it bonds freely (no false disconnect).
                const layer = layers.size === 1 ? [...layers][0] : 'all';
                clusters.push({ net, layer, points });
            }
        }
    }

    // ── Vias ── bond every layer at their point.
    for (const via of (app.vias || [])) {
        if (!via.net) continue;
        clusters.push({ net: via.net, layer: 'all', points: [{ x: via.x, y: via.y }] });
    }

    // ── Pads (net from the schematic netlist) ── treated as all-layer bonds.
    const padNet = new Map();
    for (const entry of (app.netlist || [])) {
        for (const pin of entry.pins) {
            padNet.set(`${pin.componentId}|${pin.pinNumber}`, entry.net);
        }
    }
    for (const [compId, pl] of (app.placements || [])) {
        if (!pl?.pads) continue;
        for (const [pin, pad] of pl.pads) {
            const net = padNet.get(`${compId}|${pin}`);
            if (!net) continue;
            clusters.push({ net, layer: 'all', points: [{ x: pad.x, y: pad.y }] });
        }
    }

    if (!clusters.length) return;

    // ── Union clusters that physically touch (same net, coincident point,
    //    AND layer-compatible: same layer, or one side is an all-layer bond
    //    such as a via or pad). Cross-layer coincidence WITHOUT a bond does
    //    not connect. ──
    const parent = clusters.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

    const byPos = new Map();
    for (let i = 0; i < clusters.length; i++) {
        for (const p of clusters[i].points) {
            const k = posKey(p.x, p.y);
            if (!byPos.has(k)) byPos.set(k, []);
            byPos.get(k).push(i);
        }
    }
    for (const idxs of byPos.values()) {
        // Within each position, group same-net clusters. An all-layer bond
        // (via/pad) fuses every cluster of that net here; otherwise only
        // clusters sharing the same copper layer fuse.
        const byNet = new Map();
        for (const idx of idxs) {
            const net = clusters[idx].net;
            if (!byNet.has(net)) byNet.set(net, []);
            byNet.get(net).push(idx);
        }
        for (const group of byNet.values()) {
            const hasBond = group.some((idx) => clusters[idx].layer === 'all');
            if (hasBond) {
                for (let j = 1; j < group.length; j++) union(group[0], group[j]);
            } else {
                const firstByLayer = new Map();
                for (const idx of group) {
                    const layer = clusters[idx].layer;
                    if (firstByLayer.has(layer)) union(firstByLayer.get(layer), idx);
                    else firstByLayer.set(layer, idx);
                }
            }
        }
    }

    // ── Group merged clusters by net ──
    /** @type {Map<number, {net:string, points:Array<{x:number,y:number}>}>} */
    const supernodes = new Map();
    for (let i = 0; i < clusters.length; i++) {
        const r = find(i);
        let sn = supernodes.get(r);
        if (!sn) { sn = { net: clusters[i].net, points: [] }; supernodes.set(r, sn); }
        for (const p of clusters[i].points) sn.points.push(p);
    }

    /** @type {Map<string, Array<Array<{x:number,y:number}>>>} */
    const netGroups = new Map();
    for (const sn of supernodes.values()) {
        if (!netGroups.has(sn.net)) netGroups.set(sn.net, []);
        netGroups.get(sn.net).push(sn.points);
    }

    // ── Draw an MST of nearest-point lines for every multi-cluster net ──
    for (const [net, nodes] of netGroups) {
        if (nodes.length < 2) continue;
        const edges = _clusterMST(nodes);
        for (const edge of edges) {
            const line = document.createElementNS(NS, 'line');
            line.setAttribute('x1', String(edge.x1));
            line.setAttribute('y1', String(edge.y1));
            line.setAttribute('x2', String(edge.x2));
            line.setAttribute('y2', String(edge.y2));
            line.setAttribute('stroke', '#4488ff');
            line.setAttribute('stroke-width', '1');
            line.setAttribute('vector-effect', 'non-scaling-stroke');
            line.setAttribute('pointer-events', 'none');
            line.setAttribute('class', 'ratsnest-line');
            line.dataset.net = net;
            ratLayer.appendChild(line);
        }
    }
}

/**
 * Walk the physically-bonded copper reachable from a seed track/via,
 * using the SAME bonding rules as the ratsnest: two pieces connect only
 * where they share a coincident point AND are layer-compatible (same
 * copper layer, or one side is an all-layer bond — a via or pad). A
 * cross-layer coincidence WITHOUT a via/pad does NOT connect (so a
 * deleted via genuinely separates the layers). Net is ignored entirely —
 * this is purely geometric — so it can gather copper that currently
 * carries different (or empty) net names, which is exactly what net
 * propagation needs.
 *
 * @param {object} app
 * @param {{track?:object, via?:object}} seed
 * @returns {{tracks:Set<object>, vias:Set<object>, padNets:Set<string>}}
 */
export function collectBondedCopper(app, seed) {
    const posKey = (x, y) => `${Math.round(x * 10000)},${Math.round(y * 10000)}`;
    const compatible = (a, b) => a === b || a === 'all' || b === 'all';

    /** @type {Array<{kind:string, layer:string, points:Array<{x,y}>, track?:object, via?:object, padNet?:string}>} */
    const clusters = [];

    // Track connected-components (each single-layer per the via/node invariant).
    for (const track of (app.tracks || [])) {
        const adj = new Map();
        for (const nid of track.nodes.keys()) adj.set(nid, []);
        for (const [eid, e] of track.edges) {
            const layer = track.edgeLayers.get(eid) || track.layer;
            adj.get(e.from)?.push({ to: e.to, layer });
            adj.get(e.to)?.push({ to: e.from, layer });
        }
        const seen = new Set();
        for (const start of track.nodes.keys()) {
            if (seen.has(start)) continue;
            const points = [];
            const layers = new Set();
            const stack = [start];
            while (stack.length) {
                const n = stack.pop();
                if (seen.has(n)) continue;
                seen.add(n);
                const p = track.nodes.get(n);
                if (p) points.push({ x: p.x, y: p.y });
                for (const m of adj.get(n) || []) { layers.add(m.layer); stack.push(m.to); }
            }
            if (!points.length) continue;
            const layer = layers.size === 1 ? [...layers][0] : 'all';
            clusters.push({ kind: 'track', layer, points, track });
        }
    }

    // Vias and pads bond every layer at their point.
    for (const via of (app.vias || [])) {
        clusters.push({ kind: 'via', layer: 'all', points: [{ x: via.x, y: via.y }], via });
    }
    const padNetMap = new Map();
    for (const entry of (app.netlist || [])) {
        for (const pin of entry.pins) padNetMap.set(`${pin.componentId}|${pin.pinNumber}`, entry.net);
    }
    for (const [compId, pl] of (app.placements || [])) {
        if (!pl?.pads) continue;
        for (const [pin, pad] of pl.pads) {
            const net = padNetMap.get(`${compId}|${pin}`);
            clusters.push({ kind: 'pad', layer: 'all', points: [{ x: pad.x, y: pad.y }], padNet: net || '' });
        }
    }

    // Union-find with layer-aware coincidence (mirrors reconcileRatsnest).
    const parent = clusters.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    const byPos = new Map();
    for (let i = 0; i < clusters.length; i++) {
        for (const p of clusters[i].points) {
            const k = posKey(p.x, p.y);
            if (!byPos.has(k)) byPos.set(k, []);
            byPos.get(k).push(i);
        }
    }
    for (const idxs of byPos.values()) {
        for (let a = 0; a < idxs.length; a++) {
            for (let b = a + 1; b < idxs.length; b++) {
                if (compatible(clusters[idxs[a]].layer, clusters[idxs[b]].layer)) {
                    union(idxs[a], idxs[b]);
                }
            }
        }
    }

    // Find the root of the seed's cluster(s).
    const roots = new Set();
    for (let i = 0; i < clusters.length; i++) {
        const c = clusters[i];
        if ((seed.track && c.track === seed.track) || (seed.via && c.via === seed.via)) {
            roots.add(find(i));
        }
    }

    const tracks = new Set();
    const vias = new Set();
    const padNets = new Set();
    for (let i = 0; i < clusters.length; i++) {
        if (!roots.has(find(i))) continue;
        const c = clusters[i];
        if (c.kind === 'track' && c.track) tracks.add(c.track);
        else if (c.kind === 'via' && c.via) vias.add(c.via);
        else if (c.kind === 'pad' && c.padNet) padNets.add(c.padNet);
    }
    return { tracks, vias, padNets };
}

/**
 * Closest pair of points between two point sets. Returns the segment
 * endpoints plus the squared distance.
 * @returns {{x1:number,y1:number,x2:number,y2:number,d2:number}}
 */
function _closestPair(A, B) {
    let best = Infinity;
    let r = { x1: A[0].x, y1: A[0].y, x2: B[0].x, y2: B[0].y, d2: Infinity };
    for (const a of A) {
        for (const b of B) {
            const dx = a.x - b.x, dy = a.y - b.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < best) { best = d2; r = { x1: a.x, y1: a.y, x2: b.x, y2: b.y, d2 }; }
        }
    }
    return r;
}

/**
 * Minimum spanning tree over clusters (each a set of candidate points),
 * using the nearest-point distance between clusters. Returns the drawn
 * line segments (closest point of each connected cluster pair).
 * @param {Array<Array<{x:number,y:number}>>} nodes
 * @returns {Array<{x1:number,y1:number,x2:number,y2:number}>}
 */
function _clusterMST(nodes) {
    const n = nodes.length;
    const edges = [];
    if (n < 2) return edges;
    const inTree = new Uint8Array(n);
    const best = new Float64Array(n).fill(Infinity);
    const bestFrom = new Int32Array(n).fill(-1);
    inTree[0] = 1;
    const relax = (k) => {
        for (let i = 0; i < n; i++) {
            if (inTree[i]) continue;
            const d2 = _closestPair(nodes[k], nodes[i]).d2;
            if (d2 < best[i]) { best[i] = d2; bestFrom[i] = k; }
        }
    };
    relax(0);
    for (let iter = 1; iter < n; iter++) {
        let b = -1, bc = Infinity;
        for (let i = 0; i < n; i++) {
            if (!inTree[i] && best[i] < bc) { bc = best[i]; b = i; }
        }
        if (b === -1) break;
        inTree[b] = 1;
        const pair = _closestPair(nodes[bestFrom[b]], nodes[b]);
        edges.push({ x1: pair.x1, y1: pair.y1, x2: pair.x2, y2: pair.y2 });
        relax(b);
    }
    return edges;
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

/**
 * Draw H/V/45° and collinear glow underlays for a set of live segments.
 * Each segment carries a `collinear` flag (set upstream by
 * `_incidentSegments` when it belongs to a degree-2 node whose two edges
 * are collinear — i.e. would fuse on release): those are drawn GREEN.
 * Remaining segments are drawn in their H/V/45° accent colour, or skipped
 * if not axis-aligned. Glow elements are tracked on `app._trackAxisGlow`
 * and replaced on each call — pass an empty array or call
 * `clearTrackAxisGlow` to remove them.
 *
 * @param {object} app
 * @param {Array<{a:{x:number,y:number}, b:{x:number,y:number}, layerId:string, width?:number, collinear?:boolean}>} segments
 */
export function renderTrackAxisGlow(app, segments) {
    clearTrackAxisGlow(app);
    if (!segments || !segments.length) return;
    // Resolve each segment to a colour + dash style and stash it so the
    // matching white centerlines can be drawn ON TOP of the track in a
    // second pass (renderTrackAxisGlowTop), after renderTrack runs.
    const resolved = [];
    const els = [];
    for (const seg of segments) {
        let color;
        if (seg.collinear) {
            color = COLLINEAR_GLOW_COLOR;
        } else if (seg.frozen) {
            // A translated segment can't change its own orientation, so it
            // gets no axis glow on its own — only via a collinear pull above.
            continue;
        } else {
            const align = _axisAlignment(seg.a, seg.b);
            if (!align) continue;
            color = _alignColor(align);
        }
        const dashKind = _glowDashKind(seg);
        const parent = app._getLayerGroup(seg.layerId);
        if (!parent) continue;
        // Solid colour halo UNDER the track — only the outer ring shows, so
        // the track copper keeps its true colour (no tint).
        const halo = _makeGlowHalo(app, seg, color);
        parent.appendChild(halo);
        els.push(halo);
        resolved.push({ seg, dashKind });
    }
    app._trackAxisGlow = els;
    app._axisGlowResolved = resolved;
    // Draw the centerlines now in case the track is already rendered; the
    // standard flow re-draws them after renderTrack via renderTrackAxisGlowTop.
    renderTrackAxisGlowTop(app);
}

/**
 * Second pass: draw the thin white patterned centerlines (solid / dashed /
 * dotted) for the segments resolved by the last `renderTrackAxisGlow`.
 * Call this AFTER `renderTrack` so the centerlines sit on top of the copper.
 */
export function renderTrackAxisGlowTop(app) {
    if (app._trackAxisGlowTop) {
        for (const el of app._trackAxisGlowTop) el.remove();
    }
    const tops = [];
    for (const { seg, dashKind } of (app._axisGlowResolved || [])) {
        const parent = app._getLayerGroup(seg.layerId);
        if (!parent) continue;
        const line = _makeGlowCenterline(app, seg, dashKind);
        parent.appendChild(line);
        tops.push(line);
    }
    app._trackAxisGlowTop = tops;
}

/**
 * Build the solid colour halo (track width + outer ring) for a glow
 * segment. Drawn UNDER the track so only its outer ring is visible.
 */
function _makeGlowHalo(app, seg, color) {
    const scale = app.viewport?.scale || 1;
    const trackW = seg.width || _getTrackWidth(app);
    // Halo extends a fixed screen-pixel ring beyond each track edge, so the
    // glow thickness looks the same at any zoom.
    const ring = 5 / scale;
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('class', PREVIEW_CLASS);
    line.setAttribute('x1', String(seg.a.x));
    line.setAttribute('y1', String(seg.a.y));
    line.setAttribute('x2', String(seg.b.x));
    line.setAttribute('y2', String(seg.b.y));
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', String(trackW + ring * 2));
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-opacity', '0.7');
    line.setAttribute('pointer-events', 'none');
    return line;
}

/**
 * Build the thin white patterned centerline for a glow segment. White (not
 * the halo colour) so the dash/dot gaps read clearly against the halo, and
 * thin enough to sit on the track without tinting it.
 */
function _makeGlowCenterline(app, seg, dashKind) {
    const scale = app.viewport?.scale || 1;
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('class', PREVIEW_CLASS);
    line.setAttribute('x1', String(seg.a.x));
    line.setAttribute('y1', String(seg.a.y));
    line.setAttribute('x2', String(seg.b.x));
    line.setAttribute('y2', String(seg.b.y));
    line.setAttribute('stroke', '#ffffff');
    line.setAttribute('stroke-width', String(1.5 / scale));
    line.setAttribute('stroke-linecap', dashKind === 'dotted' ? 'round' : 'butt');
    _applyGlowDash(app, line, dashKind);
    line.setAttribute('stroke-opacity', '0.95');
    line.setAttribute('pointer-events', 'none');
    return line;
}

/**
 * Apply a dash pattern for the given style. The pattern is sized in fixed
 * SCREEN pixels (converted to world units via the viewport scale) so dashes
 * and dots look the same on screen at any zoom level.
 */
function _applyGlowDash(app, line, dashKind) {
    const scale = app.viewport?.scale || 1;
    const px = (n) => n / scale; // screen px -> world units
    if (dashKind === 'dotted') {
        // Tiny dash + round cap = round dot, spaced 6px.
        line.setAttribute('stroke-dasharray', `${px(0.01)} ${px(6)}`);
    } else if (dashKind === 'dashed') {
        line.setAttribute('stroke-dasharray', `${px(8)} ${px(6)}`);
    } else {
        line.removeAttribute('stroke-dasharray');
    }
}

/** Remove any axis-alignment glow underlays created by `renderTrackAxisGlow`. */
export function clearTrackAxisGlow(app) {
    for (const key of ['_trackAxisGlow', '_trackAxisGlowTop']) {
        const els = app[key];
        if (els) for (const el of els) el.remove();
        app[key] = null;
    }
    app._axisGlowResolved = null;
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
        const parent = app._getLayerGroup(layerId);
        if (!parent) return null;
        const dashKind = align === 'd' ? 'dashed' : 'solid';
        const seg = { a, b, width: ctx.width || _getTrackWidth(app) };
        // Solid colour halo UNDER the polyline.
        const halo = _makeGlowHalo(app, seg, _alignColor(align));
        parent.appendChild(halo);
        ctx.previewElements.push(halo);
        return { seg, dashKind, parent };
    })();

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

    // White patterned centerline ON TOP of the preview polyline.
    if (axisGlow) {
        const line = _makeGlowCenterline(app, axisGlow.seg, axisGlow.dashKind);
        axisGlow.parent.appendChild(line);
        ctx.previewElements.push(line);
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

/**
 * Classify a segment as horizontal, vertical, or diagonal (45°), or
 * return null if it isn't axis-aligned within tolerance.
 *
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @returns {'h'|'v'|'d'|null}
 */
function _axisAlignment(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return null;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    // ~0.5° tolerance on the minor axis (relative to segment length).
    const TOL = 0.01;
    if (ady / len < TOL) return 'h';
    if (adx / len < TOL) return 'v';
    if (Math.abs(adx - ady) / len < TOL) return 'd';
    return null;
}

/** Highlight glow colour per alignment kind (Okabe–Ito colourblind-safe). */
function _alignColor(kind) {
    // H/V use yellow (solid line); 45° uses magenta (dashed line). Both are
    // separable from the collinear blue under common colour-vision
    // deficiencies, and the line style carries the meaning regardless.
    if (kind === 'h') return '#E69F00';
    if (kind === 'v') return '#E69F00';
    return '#CC79A7'; // 45°
}

/** Stroke-dash style per glow kind: solid H/V, dashed 45°, dotted collinear. */
function _glowDashKind(seg) {
    if (seg.collinear) return 'dotted';
    const align = _axisAlignment(seg.a, seg.b);
    if (align === 'd') return 'dashed';
    return 'solid';
}

/**
 * Build standalone Via shapes for each layer-change node in a freshly
 * built Track. Vias are independent objects — once placed they are not
 * coupled to the Track's nodes (dragging a node leaves the via behind).
 *
 * @param {Track} track
 * @param {object} ctx - draw context (for via diameter/drill)
 * @returns {Via[]}
 */
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
 * @param {object} ctx - draw context
 * @returns {{ tracks: Track[], vias: Via[] }}
 */
function _buildTracksFromContext(ctx) {
    const net = ctx.net || '';
    const width = ctx.width || 0.2;
    const pts = ctx.points;
    const segLayers = ctx.edgeLayers;
    const diameter = Number.isFinite(ctx.viaDiameter) && ctx.viaDiameter > 0
        ? ctx.viaDiameter : 0.6;
    const drill = Number.isFinite(ctx.viaDrill) && ctx.viaDrill > 0
        ? ctx.viaDrill : 0.3;

    const tracks = [];
    const transitions = []; // {x, y} points where the layer changed
    let cur = null;         // current single-layer Track being built
    let curNodeId = null;   // last node id appended to `cur`

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
            if (i === 0 && ctx.startPad) {
                cur.padConnections.set(curNodeId, {
                    componentId: ctx.startPad.componentId,
                    pinNumber: ctx.startPad.pinNumber,
                });
            }
        }
        const nextNodeId = cur.addNode(b.x, b.y);
        const eid = cur.addEdge(curNodeId, nextNodeId);
        cur.edgeLayers.set(eid, segLayer);
        curNodeId = nextNodeId;
    }

    // End-pad metadata belongs to the last node of the last run.
    if (cur && ctx.endPad) {
        cur.padConnections.set(curNodeId, {
            componentId: ctx.endPad.componentId,
            pinNumber: ctx.endPad.pinNumber,
        });
    }

    const vias = transitions.map((t) => new Via({
        x: t.x, y: t.y, diameter, drill, net,
    }));
    return { tracks, vias };
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
