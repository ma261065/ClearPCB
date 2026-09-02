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
import { collinearSnap, pointInPolygon } from '../../core/geometry.js';
import { normalizeShapeCopperMode, shapeOutline } from './board-shapes.js';
import { showAlert } from '../../ui/modules/modal.js';
import { isOverlayVisible } from './layers.js';
import {
    clearAxisGlow,
    makeAxisGlowCenterline,
    makeAxisGlowHalo,
    renderAxisGlow,
    renderAxisGlowTop,
} from './axis-glow.js';

const NS = 'http://www.w3.org/2000/svg';

/** Preview polyline CSS class (cleaned up on finish/cancel). */
const PREVIEW_CLASS = 'pcb-track-preview';

/**
 * Screen-pixel pull radius for the collinear (straight-line) snap applied
 * while dragging a degree-2 waypoint between its two neighbours.
 */
export const COLLINEAR_SNAP_SCREEN_PX = 15;

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

/** Track-node snap tolerance (world mm) — used as the bare default of
 * `findNearbyTrackNode`. `resolveTrackSnap` overrides this with a
 * screen-pixel band (see `TRACK_SNAP_SCREEN_PX`) so the snap feels the
 * same at every zoom instead of grabbing a wide area when zoomed out. */
export const TRACK_SNAP_TOL = 0.5;

/** Track-node snap radius in SCREEN pixels. Converted to world mm via the
 * live viewport scale inside `resolveTrackSnap`, giving a constant, less
 * aggressive feel across zoom levels (mirrors the grid/axis SNAP_PX). */
export const TRACK_SNAP_SCREEN_PX = 8;

/** Layers that the Track tool toggles between when Space is pressed. */
const TOGGLE_LAYERS = ['top-copper', 'bottom-copper'];

/* ──────────────────────────── snap helpers ──────────────────────────── */

/**
 * Find the nearest pad center to `worldPos` within `tolerance`.
 * @returns {{x:number, y:number, componentId:string, pinNumber:string, number:string, net:string}|null}
 */
export function findNearbyPad(app, worldPos, tolerance = PAD_SNAP_TOL) {
    if (!app?.placements) return null;
    const tol2 = tolerance * tolerance;
    let best = null;
    let bestD2 = Infinity;
    for (const [compId, pl] of app.placements) {
        if (!pl?.pads) continue;
        for (const [padId, pad] of pl.pads) {
            const dx = pad.x - worldPos.x;
            const dy = pad.y - worldPos.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2 && d2 <= tol2) {
                bestD2 = d2;
                // pinNumber is the unique pad identity (so a track bonds to
                // THIS physical pad and follows it on drag). `number` is the
                // schematic-facing pad number used for net resolution — they
                // differ only for duplicate-numbered pads (e.g. shell pads).
                best = {
                    x: pad.x, y: pad.y, componentId: compId,
                    pinNumber: String(padId), number: String(pad.number ?? padId),
                    net: '',
                };
            }
        }
    }
    if (!best) return null;
    best.net = _padNet(app, best.componentId, best.number);
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
    // Track-node snap uses a screen-pixel band (constant feel across zoom),
    // not the fixed world tolerance — a 0.5mm world grab is huge when zoomed
    // out. Callers can still force a world value via options.trackTolerance.
    const scale = app.viewport?.scale || 1;
    const trackTol = options.trackTolerance ?? (TRACK_SNAP_SCREEN_PX / scale);
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
export function snapNodeToAxis(pos, neighbours, threshold = Infinity, fallback = pos) {
    // A horizontal segment fixes only y (to a neighbour's y); a vertical
    // segment fixes only x. These constraints are orthogonal, so when the
    // node sits near BOTH at once — the classic case being the pivot of an
    // L-bend, whose two neighbours each want a different axis — we can
    // satisfy both simultaneously and light both segments. Track the best
    // independent x-snap (vertical) and y-snap (horizontal), plus the best
    // joint 45° candidate, then combine when two *different* neighbours
    // supply the two axes.
    //
    // The pull band is measured against `pos` (pass the RAW cursor here so
    // grid quantisation can't defeat an off-grid alignment); axes that don't
    // align fall back to `fallback` (e.g. the grid-snapped position) so grid
    // snapping still applies where no neighbour alignment is found.
    let bestX = null;   // { x, d, i }  vertical snap: x → neighbour.x
    let bestY = null;   // { y, d, i }  horizontal snap: y → neighbour.y
    let bestDiag = null; // { x, y, d } joint 45° snap
    for (let i = 0; i < neighbours.length; i++) {
        const nb = neighbours[i];
        const dV = Math.abs(pos.x - nb.x);            // vertical alignment
        if (dV <= threshold && (!bestX || dV < bestX.d)) bestX = { x: nb.x, d: dV, i };
        const dH = Math.abs(pos.y - nb.y);            // horizontal alignment
        if (dH <= threshold && (!bestY || dH < bestY.d)) bestY = { y: nb.y, d: dH, i };
        const diag = applyAxisConstraint(nb, pos, 'diagonal');
        const dD = Math.hypot(diag.x - pos.x, diag.y - pos.y);
        if (dD <= threshold && (!bestDiag || dD < bestDiag.d)) {
            bestDiag = { x: diag.x, y: diag.y, d: dD };
        }
    }
    // Combined H+V: only when the two axes come from different neighbours
    // (combining x and y from the SAME neighbour would collapse a segment
    // onto that neighbour).
    if (bestX && bestY && bestX.i !== bestY.i) {
        return { x: bestX.x, y: bestY.y };
    }
    // Otherwise take the single smallest nudge among H / V / 45°. The free
    // axis keeps the fallback (grid) coordinate; the aligned axis snaps to
    // the neighbour.
    let best = null;
    let bestDist = Infinity;
    if (bestX && bestX.d < bestDist) { bestDist = bestX.d; best = { x: bestX.x, y: fallback.y }; }
    if (bestY && bestY.d < bestDist) { bestDist = bestY.d; best = { x: fallback.x, y: bestY.y }; }
    if (bestDiag && bestDiag.d < bestDist) { bestDist = bestDiag.d; best = { x: bestDiag.x, y: bestDiag.y }; }
    return best || fallback;
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
    // Inherit the net at draw start from the pad or track node we begin on,
    // so the live net-guide line works for the whole draw (an unassigned
    // track would have nothing to guide toward).
    let net = String(app._trackToolNet || '').trim() || startPad?.net || '';
    let startTrack = null;
    if (snap.snapType === 'track-node' && snap.trackNode) {
        startTrack = snap.trackNode.track;
        if (!net) net = startTrack.net || '';
    }
    const layer = TOGGLE_LAYERS.includes(app._trackToolLayer) ? app._trackToolLayer : 'top-copper';
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
        // Copper this draw is already electrically bonded to (the start
        // track's cluster), so the live net-guide line never points back at
        // it. Computed once here; the in-progress track isn't in app.tracks,
        // so the bonded set can't change mid-draw.
        guideExclude: startTrack ? bondedExclusion(app, startTrack) : null,
        // Via geometry snapshot — captured at draw-start so the preview
        // marker and the eventually-committed Via render at the same size.
        viaDiameter: routeOpts.viaDiameter,
        viaDrill: routeOpts.viaDrill,
    };
    app._trackDraw = ctx;
    app.viewport?.setCrosshair({ x: snap.x, y: snap.y });
    _renderPreview(app, ctx, ctx.points[0]);
    app._showTrackDrawProperties?.();
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

    // Yellow target circle when locked onto a hard snap (pad / track node).
    if (snap.snapType === 'pad' || snap.snapType === 'track-node') {
        showTrackSnapMarker(app, target);
    } else {
        clearTrackSnapMarker(app);
    }

    app.viewport?.setCrosshair(target);
    _renderPreview(app, ctx, target);

    // Live guide from the trailing tip to the nearest existing copper on this
    // track's net that it isn't already connected to. Only shown when the
    // ratlines overlay is HIDDEN — when it's visible the ratsnest already
    // draws this connection, so the guide would just duplicate it.
    if (ctx.net && !isOverlayVisible('ratlines')) {
        const near = nearestPointOnNet(app, ctx.net, target, {
            excludePoints: ctx.points,
            ...(ctx.guideExclude || {}),
        });
        showNetGuideLine(app, near ? target : null, near);
    } else {
        clearNetGuideLine(app);
    }
}

/** Rebuild the active rubber-band preview after a viewport-scale change. */
export function refreshTrackDrawPreview(app) {
    const ctx = app._trackDraw;
    if (!ctx?.snap) return;
    _renderPreview(app, ctx, { x: ctx.snap.x, y: ctx.snap.y });
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

    // Reject a click that lands on a pad or existing track node carrying a
    // DIFFERENT net than the one being drawn. Every pad now has a net (real or
    // a default `<Ref>.<Pin>`), so bonding to a foreign-net target — even just
    // by coincident geometry — would short two nets. Mirror the vertex-drag
    // behaviour: warn and don't place the waypoint.
    if (ctx.net) {
        let foreignNet = '';
        if (snap.snapType === 'pad' && snap.pad) foreignNet = snap.pad.net || '';
        else if (snap.snapType === 'track-node' && snap.trackNode) foreignNet = snap.trackNode.track.net || '';
        if (foreignNet && foreignNet !== ctx.net) {
            showAlert(
                `Cannot connect to net "${foreignNet}" \u2014 this track is already on net "${ctx.net}".`,
                { title: 'Net Conflict' }
            );
            return;
        }
    }

    ctx.points.push({ x: target.x, y: target.y });
    ctx.edgeLayers.push(ctx.currentLayer);

    // Did we hit a pad? If yes, finish (adopt net if we didn't have one).
    if (snap.snapType === 'pad') {
        const pad = snap.pad;
        if (!ctx.net) ctx.net = pad.net || '';
        ctx.endPad = pad;
        finishTrackDraw(app);
        return;
    }

    // Did we hit an existing track node? If yes, finish (adopt net if none).
    if (snap.snapType === 'track-node') {
        const otherNet = snap.trackNode.track.net || '';
        if (!ctx.net) ctx.net = otherNet;
        finishTrackDraw(app);
        return;
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
    // Track tool is still selected — restore its draw settings.
    app._showTrackDrawProperties?.();
}

/**
 * Abort the in-progress track without committing anything.
 */
export function cancelTrackDraw(app) {
    _teardownDraw(app);
    app._showTrackDrawProperties?.();
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
 * @param {{nets?: Set<string>, skipFillRefresh?:boolean}} [opts] - Incremental
 *   mode can restrict ratline work to `nets`. `skipFillRefresh` is used after
 *   a fill recompute to consume its new geometry without scheduling another
 *   fill pass.
 */
export function reconcileRatsnest(app, opts) {
    // Incremental net filter: when present, restrict all cluster construction
    // and ratline removal/redraw to this set of nets.
    const onlyNets = opts?.nets instanceof Set ? opts.nets : null;
    // During a live footprint drag the expensive derived overlays (clearance
    // halos and copper pours) are deferred: their transient per-frame state is
    // invisible eye-candy, and re-pouring every fill via polygon clipping (or
    // rebuilding clearance geometry) on each frame is the single biggest cost
    // on boards that have them. _endDrag() forces one full reconcile on drop.
    if (!app._deferDragOverlays) {
        // The clearance overlay is derived from the rendered trace geometry, so
        // it must be rebuilt whenever the copper changes — exactly the same set
        // of call sites that reconcile the ratsnest (live vertex drag, drag
        // finish, and every track/via command). Keep the two overlays in lock-
        // step here (no-op unless the clearance overlay is currently visible).
        app._refreshClearanceHalos?.();

        // Copper pours are derived from trace/via/pad geometry, so they must be
        // recomputed whenever the copper changes — the same call sites that
        // reconcile the ratsnest. (No-op when there are no fills.)
        if (!opts?.skipFillRefresh) app._refreshFills?.();
    }

    const ratLayer = app._getLayerGroup?.('ratlines');
    if (!ratLayer) return;

    // Clear previously-generated ratsnest (keep autorouter failed lines).
    for (const el of [...ratLayer.children]) {
        if (el.classList?.contains('ratsnest-failed')) continue;
        // Incremental mode: keep ratlines for nets we're not recomputing.
        if (onlyNets && !onlyNets.has(el.dataset?.net)) continue;
        el.remove();
    }

    const posKey = (x, y) => `${Math.round(x * 10000)},${Math.round(y * 10000)}`;

    /** @type {Array<{net:string, layer:string, points:Array<{x:number,y:number}>, segments?:Array<{a:{x:number,y:number},b:{x:number,y:number},radius:number}>, viaRadius?:number}>} */
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
        if (onlyNets && !onlyNets.has(net)) continue;
        const adj = new Map();
        for (const nid of track.nodes.keys()) adj.set(nid, []);
        for (const [eid, e] of track.edges) {
            const layer = track.getEdgeLayer(eid);
            adj.get(e.from)?.push({ to: e.to, layer, edgeId: eid });
            adj.get(e.to)?.push({ to: e.from, layer, edgeId: eid });
        }
        const seen = new Set();
        for (const start of track.nodes.keys()) {
            if (seen.has(start)) continue;
            const points = [];
            const segments = [];
            const componentEdges = new Set();
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
                    componentEdges.add(m.edgeId);
                    stack.push(m.to);
                }
            }
            if (points.length) {
                for (const edgeId of componentEdges) {
                    const edge = track.edges.get(edgeId);
                    const a = edge ? track.nodes.get(edge.from) : null;
                    const b = edge ? track.nodes.get(edge.to) : null;
                    if (!a || !b) continue;
                    const width = track.getEdgeWidth?.(edgeId) || track.width || 0.2;
                    segments.push({ a, b, radius: width / 2 });
                }
                // A clean component is single-layer; if somehow mixed, fall
                // back to 'all' so it bonds freely (no false disconnect).
                const layer = layers.size === 1 ? [...layers][0] : 'all';
                clusters.push({ net, layer, points, segments });
            }
        }
    }

    // ── Vias ── bond every layer at their point.
    for (const via of (app.vias || [])) {
        if (!via.net) continue;
        if (onlyNets && !onlyNets.has(via.net)) continue;
        clusters.push({
            net: via.net,
            layer: 'all',
            points: [{ x: via.x, y: via.y }],
            viaRadius: (via.diameter || 0.6) / 2,
        });
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
            if (onlyNets && !onlyNets.has(net)) continue;
            clusters.push({ net, layer: 'all', points: [{ x: pad.x, y: pad.y }] });
        }
    }

    // ── Additive copper shapes are net-bearing islands on their own layer.
    // Their outline provides point-contact bonding; filled shapes additionally
    // bond copper terminals that lie anywhere inside their area.
    for (const shape of (app.boardShapes || [])) {
        if (shape?.type === 'fill') continue;
        const net = String(shape?.net || '');
        const layer = shape?.layer;
        if (!net || (layer !== 'top-copper' && layer !== 'bottom-copper')) continue;
        if (normalizeShapeCopperMode(shape.copperMode) !== 'add') continue;
        if (onlyNets && !onlyNets.has(net)) continue;
        const points = shapeOutline(shape);
        if (points.length < 2) continue;
        clusters.push({ net, layer, points, copperShape: shape });
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

    // A via bonds wherever its annular copper physically overlaps a same-net
    // trace, even when its centre is not an explicit Track node.
    _unionViaTrackOverlaps(clusters, union, true);

    // Filled copper shape interiors are conductive: join any same-net,
    // layer-compatible terminal that lies in the shape's actual outline.
    for (let i = 0; i < clusters.length; i++) {
        const shape = clusters[i].copperShape;
        if (!shape?.filled) continue;
        const outline = clusters[i].points;
        for (let j = 0; j < clusters.length; j++) {
            if (i === j || clusters[j].net !== clusters[i].net) continue;
            const compatible = clusters[j].layer === 'all' || clusters[j].layer === clusters[i].layer;
            if (compatible && clusters[j].points.some((point) => pointInPolygon(point, outline))) union(i, j);
        }
    }

    // ── Copper-fill bonding ── A poured fill is solid same-net copper, and
    // thermal-reliefs same-net pads, so it electrically joins every same-net,
    // layer-compatible cluster whose point lies within one of its poured
    // islands. Bond all such clusters per island so no ratline is drawn across
    // copper the fill already connects. (Per-island, not per-outline, so a
    // pour split into disjoint islands by other-net copper doesn't falsely
    // bridge them. Holes are ignored: a same-net pad sits inside a clearance
    // hole yet is tied to that island through its thermal spokes.)
    for (const fill of (app.copperFills || [])) {
        const fnet = fill.net || '';
        if (!fnet) continue;
        if (onlyNets && !onlyNets.has(fnet)) continue;
        const polys = fill._computed;
        if (!Array.isArray(polys) || polys.length === 0) continue;
        const compat = (layer) => layer === 'all' || layer === fill.layer;
        for (const poly of polys) {
            const outer = poly.outer;
            if (!outer || outer.length < 3) continue;
            let first = -1;
            for (let i = 0; i < clusters.length; i++) {
                const c = clusters[i];
                if (c.net !== fnet || !compat(c.layer)) continue;
                if (!c.points.some((p) => pointInPolygon(p, outer))) continue;
                if (first === -1) first = i; else union(first, i);
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
        netGroups.get(sn.net)?.push(sn.points);
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

    // A selected incomplete-connection DRC marker targets one of these
    // derived lines. Re-anchor it after every rebuild, including callers that
    // invoke reconcileRatsnest directly during track/via/group movement.
    app._followDRCRatline?.();
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
 * @returns {{tracks:Set<object>, vias:Set<object>, padNets:Set<string>, padKeys:Set<string>}}
 */
export function collectBondedCopper(app, seed) {
    const posKey = (x, y) => `${Math.round(x * 10000)},${Math.round(y * 10000)}`;
    const compatible = (a, b) => a === b || a === 'all' || b === 'all';

    /** @type {Array<{kind:string, layer:string, points:Array<{x,y}>, track?:object, via?:object, padNet?:string, padKey?:string, segments?:Array<{a:{x:number,y:number},b:{x:number,y:number},radius:number}>, viaRadius?:number}>} */
    const clusters = [];

    // Track connected-components (each single-layer per the via/node invariant).
    for (const track of (app.tracks || [])) {
        const adj = new Map();
        for (const nid of track.nodes.keys()) adj.set(nid, []);
        for (const [eid, e] of track.edges) {
            const layer = track.getEdgeLayer(eid);
            adj.get(e.from)?.push({ to: e.to, layer, edgeId: eid });
            adj.get(e.to)?.push({ to: e.from, layer, edgeId: eid });
        }
        const seen = new Set();
        for (const start of track.nodes.keys()) {
            if (seen.has(start)) continue;
            const points = [];
            const segments = [];
            const componentEdges = new Set();
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
                    componentEdges.add(m.edgeId);
                    stack.push(m.to);
                }
            }
            if (!points.length) continue;
            for (const edgeId of componentEdges) {
                const edge = track.edges.get(edgeId);
                const a = edge ? track.nodes.get(edge.from) : null;
                const b = edge ? track.nodes.get(edge.to) : null;
                if (!a || !b) continue;
                const width = track.getEdgeWidth?.(edgeId) || track.width || 0.2;
                segments.push({ a, b, radius: width / 2 });
            }
            const layer = layers.size === 1 ? [...layers][0] : 'all';
            clusters.push({ kind: 'track', layer, points, track, segments });
        }
    }

    // Vias and pads bond every layer at their point.
    for (const via of (app.vias || [])) {
        clusters.push({
            kind: 'via',
            layer: 'all',
            points: [{ x: via.x, y: via.y }],
            via,
            viaRadius: (via.diameter || 0.6) / 2,
        });
    }
    const padNetMap = new Map();
    for (const entry of (app.netlist || [])) {
        for (const pin of entry.pins) padNetMap.set(`${pin.componentId}|${pin.pinNumber}`, entry.net);
    }
    for (const [compId, pl] of (app.placements || [])) {
        if (!pl?.pads) continue;
        for (const [pin, pad] of pl.pads) {
            const net = padNetMap.get(`${compId}|${pin}`);
            clusters.push({ kind: 'pad', layer: 'all', points: [{ x: pad.x, y: pad.y }], padNet: net || '', padKey: `${compId}|${pin}` });
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
    _unionViaTrackOverlaps(clusters, union, false);

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
    const padKeys = new Set();
    for (let i = 0; i < clusters.length; i++) {
        if (!roots.has(find(i))) continue;
        const c = clusters[i];
        if (c.kind === 'track' && c.track) tracks.add(c.track);
        else if (c.kind === 'via' && c.via) vias.add(c.via);
        else if (c.kind === 'pad') {
            if (c.padNet) padNets.add(c.padNet);
            if (c.padKey) padKeys.add(c.padKey);
        }
    }
    return { tracks, vias, padNets, padKeys };
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
    clearTrackSnapMarker(app);
    clearNetGuideLine(app);
    app.viewport?.hideCrosshair();
    app._trackDraw = null;
}

function _clearPreviewElements(ctx) {
    if (!ctx.previewElements) return;
    for (const el of ctx.previewElements) el.remove();
    ctx.previewElements = [];
}

/** Shared Track and generic-shape H/V/45 glow renderer. */
export function renderTrackAxisGlow(app, segments) {
    renderAxisGlow(app, segments);
}

/** Re-render Track-style patterned centerlines after copper redraw. */
export function renderTrackAxisGlowTop(app) {
    renderAxisGlowTop(app);
}

/** Remove shared Track/generic-shape H/V/45 glow overlays. */
export function clearTrackAxisGlow(app) {
    clearAxisGlow(app);
}

/**
 * Show a yellow target circle at a hard snap point (pad centre or an
 * existing track node), mirroring the schematic editor's snap highlight.
 * Replaces any previous marker. Pass a falsy `pos` (or call
 * `clearTrackSnapMarker`) to remove it.
 *
 * @param {object} app
 * @param {{x:number,y:number}|null} pos - snap point in world mm
 */
export function showTrackSnapMarker(app, pos) {
    clearTrackSnapMarker(app);
    if (!pos || !app?.viewport?.svg) return;
    const scale = app.viewport?.scale || 1;
    // Small target dot: a few screen pixels regardless of zoom, with a tiny
    // world floor so it stays visible when zoomed far out. Kept much smaller
    // than the schematic junction dot — PCB tracks are sub-millimetre.
    const screenRadiusPx = 4;
    const minWorldRadius = 0.08;
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', String(pos.x));
    dot.setAttribute('cy', String(pos.y));
    dot.setAttribute('r', String(Math.max(minWorldRadius, screenRadiusPx / scale)));
    dot.setAttribute('fill', '#ffff00');
    dot.setAttribute('stroke', 'none');
    dot.setAttribute('pointer-events', 'none');
    dot.classList.add('track-snap-highlight');
    // Attach to the root SVG so the marker always paints above the copper.
    app.viewport.svg.appendChild(dot);
    app._trackSnapMarker = dot;
}

/** Remove the yellow snap target circle, if present. */
export function clearTrackSnapMarker(app) {
    if (app._trackSnapMarker) {
        app._trackSnapMarker.remove();
        app._trackSnapMarker = null;
    }
}

/** Closest point on segment a→b to p, clamped to the segment. */
function _projectPointOnSegment(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    if (len2 < 1e-12) return { x: a.x, y: a.y };
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return { x: a.x + abx * t, y: a.y + aby * t };
}

/** Spatially join vias to physically-overlapping stroked Track segments. */
function _unionViaTrackOverlaps(clusters, union, requireSameNet) {
    const cellSize = 2;
    const cells = new Map();
    const cellKey = (x, y) => `${x},${y}`;

    for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex++) {
        const cluster = clusters[clusterIndex];
        if (!cluster.segments?.length) continue;
        for (const segment of cluster.segments) {
            const record = { clusterIndex, segment };
            const minX = Math.floor((Math.min(segment.a.x, segment.b.x) - segment.radius) / cellSize);
            const maxX = Math.floor((Math.max(segment.a.x, segment.b.x) + segment.radius) / cellSize);
            const minY = Math.floor((Math.min(segment.a.y, segment.b.y) - segment.radius) / cellSize);
            const maxY = Math.floor((Math.max(segment.a.y, segment.b.y) + segment.radius) / cellSize);
            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) {
                    const key = cellKey(x, y);
                    if (!cells.has(key)) cells.set(key, []);
                    cells.get(key).push(record);
                }
            }
        }
    }

    for (let viaIndex = 0; viaIndex < clusters.length; viaIndex++) {
        const via = clusters[viaIndex];
        if (!Number.isFinite(via.viaRadius)) continue;
        const centre = via.points[0];
        const minX = Math.floor((centre.x - via.viaRadius) / cellSize);
        const maxX = Math.floor((centre.x + via.viaRadius) / cellSize);
        const minY = Math.floor((centre.y - via.viaRadius) / cellSize);
        const maxY = Math.floor((centre.y + via.viaRadius) / cellSize);
        const candidates = new Set();
        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                for (const record of cells.get(cellKey(x, y)) || []) candidates.add(record);
            }
        }
        const bondedClusters = new Set();
        for (const record of candidates) {
            const trackIndex = record.clusterIndex;
            if (bondedClusters.has(trackIndex)) continue;
            const track = clusters[trackIndex];
            if (requireSameNet && via.net !== track.net) continue;
            const nearest = _projectPointOnSegment(centre, record.segment.a, record.segment.b);
            const dx = centre.x - nearest.x;
            const dy = centre.y - nearest.y;
            const reach = via.viaRadius + record.segment.radius;
            if (dx * dx + dy * dy <= reach * reach + 1e-12) {
                union(viaIndex, trackIndex);
                bondedClusters.add(trackIndex);
            }
        }
    }
}

/**
 * Find the nearest point of net `net`'s existing copper (pads, vias and
 * tracks) to `from`. Drives the live guide line drawn from the tip of a track
 * being routed (or a node being dragged) toward the closest place it still
 * needs to connect. Copper the trace is ALREADY electrically connected to is
 * excluded via `excludeTracks`/`excludeVias`/`excludePadKeys` (a precomputed
 * bonded cluster) so the guide never points back at it.
 *
 * @param {object} app - PCBApp
 * @param {string} net - net name to search
 * @param {{x:number,y:number}} from - reference point (the live tip / node)
 * @param {object} [opts]
 * @param {Set<object>} [opts.excludeTracks] - Tracks to skip entirely.
 * @param {Set<object>} [opts.excludeVias] - Vias to skip entirely.
 * @param {Set<string>} [opts.excludePadKeys] - `componentId|pinNumber` keys to
 *   skip entirely.
 * @param {Array<{x:number,y:number}>} [opts.excludePoints] - candidate points
 *   coincident (within ~1µm) with any of these are skipped, so the guide
 *   never points back at the source pad / waypoints just placed.
 * @returns {{x:number,y:number}|null}
 */
export function nearestPointOnNet(app, net, from, opts = {}) {
    if (!net || !from) return null;
    const excludeTracks = opts.excludeTracks || null;
    const excludeVias = opts.excludeVias || null;
    const excludePadKeys = opts.excludePadKeys || null;
    const excludePoints = opts.excludePoints || null;
    const EPS2 = 1e-6; // (1e-3 mm)^2
    const skip = (x, y) => {
        if (!excludePoints) return false;
        for (const q of excludePoints) {
            const dx = x - q.x, dy = y - q.y;
            if (dx * dx + dy * dy <= EPS2) return true;
        }
        return false;
    };
    let best = null;
    let bestD2 = Infinity;
    const consider = (x, y) => {
        if (skip(x, y)) return;
        const dx = x - from.x, dy = y - from.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; best = { x, y }; }
    };

    // Pads on the net (schematic netlist ∩ placed footprint pad positions).
    const padKeys = new Set();
    for (const entry of (app.netlist || [])) {
        if (entry?.net !== net || !entry.pins) continue;
        for (const pin of entry.pins) padKeys.add(`${pin.componentId}|${pin.pinNumber}`);
    }
    if (padKeys.size) {
        for (const [compId, pl] of (app.placements || [])) {
            if (!pl?.pads) continue;
            for (const [pin, pad] of pl.pads) {
                const key = `${compId}|${pin}`;
                if (!padKeys.has(key)) continue;
                if (excludePadKeys && excludePadKeys.has(key)) continue;
                consider(pad.x, pad.y);
            }
        }
    }

    // Vias on the net.
    for (const v of (app.vias || [])) {
        if (v.net !== net) continue;
        if (excludeVias && excludeVias.has(v)) continue;
        consider(v.x, v.y);
    }

    // Tracks on the net: every node plus the nearest point on each segment.
    for (const track of (app.tracks || [])) {
        if (track.net !== net) continue;
        if (excludeTracks && excludeTracks.has(track)) continue;
        for (const [, p] of track.nodes) consider(p.x, p.y);
        for (const [, e] of track.edges) {
            const a = track.nodes.get(e.from);
            const b = track.nodes.get(e.to);
            if (!a || !b) continue;
            const proj = _projectPointOnSegment(from, a, b);
            consider(proj.x, proj.y);
        }
    }

    return best;
}

/**
 * Precompute the copper a trace seeded on `seedTrack` is already bonded to,
 * shaped for `nearestPointOnNet`'s exclusion options. Returns null when there
 * is no seed track. Computed once at draw/drag start and reused per frame.
 *
 * @param {object} app
 * @param {object|null} seedTrack
 * @returns {{excludeTracks:Set<object>, excludeVias:Set<object>, excludePadKeys:Set<string>}|null}
 */
export function bondedExclusion(app, seedTrack) {
    if (!seedTrack) return null;
    const { tracks, vias, padKeys } = collectBondedCopper(app, { track: seedTrack });
    return { excludeTracks: tracks, excludeVias: vias, excludePadKeys: padKeys };
}

/**
 * Draw a live guide line from `from` to `to` (the nearest existing copper on
 * the active net), styled like a ratline. Replaces any previous guide. Pass a
 * falsy endpoint, or call `clearNetGuideLine`, to remove it.
 *
 * @param {object} app
 * @param {{x:number,y:number}|null} from
 * @param {{x:number,y:number}|null} to
 */
export function showNetGuideLine(app, from, to) {
    clearNetGuideLine(app);
    if (!from || !to || !app?.viewport?.svg) return;
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', String(from.x));
    line.setAttribute('y1', String(from.y));
    line.setAttribute('x2', String(to.x));
    line.setAttribute('y2', String(to.y));
    line.setAttribute('stroke', '#4488ff');
    line.setAttribute('stroke-width', '1');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    line.setAttribute('stroke-opacity', '0.9');
    line.setAttribute('pointer-events', 'none');
    line.classList.add('net-guide-line');
    // Root SVG so the guide always paints above the copper.
    app.viewport.svg.appendChild(line);
    app._netGuideLine = line;
}

/** Remove the net guide line, if present. */
export function clearNetGuideLine(app) {
    if (app._netGuideLine) {
        app._netGuideLine.remove();
        app._netGuideLine = null;
    }
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
        const halo = makeAxisGlowHalo(app, seg, _alignColor(align));
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
        const line = makeAxisGlowCenterline(app, axisGlow.seg, axisGlow.dashKind);
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
 * This is the SINGLE definition of "axis-aligned" shared by the snap and
 * the glow. The snap pins a segment to an EXACT axis (applyAxisConstraint
 * zeroes the minor-axis component), so the tolerance is effectively zero —
 * the classifier returns a kind only for geometry the snap actually
 * produced. The drag glow does not call this directly; the segment model
 * (`_incidentSegments`) calls it once per edge and the glow renders that
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
function _alignColor(kind) {
    // H/V use yellow (solid line); 45° uses magenta (dashed line). Both are
    // separable from the collinear blue under common colour-vision
    // deficiencies, and the line style carries the meaning regardless.
    if (kind === 'h') return '#E69F00';
    if (kind === 'v') return '#E69F00';
    return '#CC79A7'; // 45°
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
            if (i === 0 && ctx.startPad) {
                cur.padConnections.set(curNodeId, {
                    componentId: ctx.startPad.componentId,
                    pinNumber: ctx.startPad.pinNumber,
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
            componentId: ctx.endPad.componentId,
            pinNumber: ctx.endPad.pinNumber,
        });
    }

    const vias = transitions.map((t) => new Via({
        x: t.x, y: t.y, diameter, drill, net,
    }));
    return { tracks, vias };
}

export function _padNet(app, componentId, pinNumber) {
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
 * @property {number} [viaDiameter]
 * @property {number} [viaDrill]
 */
