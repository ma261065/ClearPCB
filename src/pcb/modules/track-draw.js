import { buildCopperClusters, unionCoincidentClusters } from './copper-connectivity.js';
import { getComputedFill } from './computed-fill-cache.js';
import { deferDerivedUpdate } from '../../core/DerivedUpdates.js';
import { GRID_SNAP_PX, snapToGridLines } from '../../core/grid-snap.js';
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
import { renderTrack, viaCopperPathD } from './track-render.js';
import { pointInPolygon, distanceToSegment } from '../../core/geometry.js';
import { closestPointOnArcEdge } from '../../shapes/arc-edge.js';
import { copperLayer, resolveCopperPads } from './copper-model.js';
import { padFlashOutline, placementPose, resolveTrackSegments } from './board-geometry.js';
import { snapNodeToAxis, snapNodeToCollinear } from '../../shapes/path-snap.js';
export { snapNodeToAxis, snapNodeToCollinear } from '../../shapes/path-snap.js';
import { normalizeShapeCopperMode, shapeOutline } from './board-shape-geometry.js';
import { renderBoardShape } from './board-shapes.js';
import { resolveTrackContactGeometry, copperShapesTouch, copperContactsTouch, copperRegionShape, copperSegmentShape, copperSegmentContact, resolveTerminalCopperContact, pointInCopperRegion } from './track-contact-geometry.js';
import { spatialClusterMST } from './cluster-mst.js';
import { spatialPairs } from '../../core/spatial-pairs.js';
import { showAlert } from '../../ui/modules/modal.js';
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

/** Minimum standalone Pad snap radius (world mm). */
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
 * Find the nearest Pad centre. Component Pads require entering their outline;
 * standalone Pads retain their minimum snap radius of `tolerance`.
 * @returns {{x:number, y:number, componentId?:string, pinNumber?:string, number?:string, net:string, standalonePad?:object}|null}
 */
export function findNearbyPad(app, worldPos, tolerance = PAD_SNAP_TOL, layer = 'top-copper', excludePad = null) {
    if (!app) return null;
    let best = null;
    let bestD2 = Infinity;
    for (const [compId, pl] of app.placements || []) {
        if (!pl?.pads) continue;
        const pose = placementPose(pl);
        const consider = (padId, pad, geometry, rotated) => {
            const dx = pad.x - worldPos.x;
            const dy = pad.y - worldPos.y;
            const d2 = dx * dx + dy * dy;
            if (d2 >= bestD2) return;
            const point = rotated
                ? { x: dx * pose.cos + dy * pose.sin, y: -dx * pose.sin + dy * pose.cos }
                : { x: dx, y: dy };
            const width = geometry.width || 1.2;
            const height = geometry.height || 1.2;
            if (Math.abs(point.x) > width / 2 || Math.abs(point.y) > height / 2) return;
            const outline = padFlashOutline({ x: 0, y: 0, w: width, h: height, shape: geometry.shape });
            if (pointInPolygon(point, outline) || outline.some((start, index) =>
                distanceToSegment(point, start, outline[(index + 1) % outline.length]) <= 1e-9)) {
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
        };
        if (pl.padOffsets?.length) {
            for (const offset of pl.padOffsets) {
                const padId = offset.padId ?? offset.number;
                const pad = pl.pads.get(padId) || pl.pads.get(String(padId));
                if (pad) consider(padId, pad, offset, true);
            }
        } else {
            for (const [padId, pad] of pl.pads) consider(padId, pad, pad, false);
        }
    }
    for (const pad of app.pads || []) {
        if (pad === excludePad || pad?.visible === false
            || (layer !== 'both' && pad.layers !== 'both' && pad.layers !== layer)) continue;
        const dx = pad.x - worldPos.x;
        const dy = pad.y - worldPos.y;
        const d2 = dx * dx + dy * dy;
        const radius = Math.max(tolerance, Number(pad.width) / 2 || 0, Number(pad.height) / 2 || 0);
        if (d2 < bestD2 && d2 <= radius * radius) {
            bestD2 = d2;
            best = { x: pad.x, y: pad.y, net: String(pad.net || ''), standalonePad: pad };
        }
    }
    if (!best) return null;
    if (best.componentId) best.net = _padNet(app, best.componentId, best.number);
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
 * @param {object} [options.excludePad] - Standalone Pad being dragged.
 * @param {string} [options.layer] - Copper layer, or 'both' for a plated terminal.
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
    if (app.viewport?.shiftHeld) return { x: worldPos.x, y: worldPos.y, snapType: 'free' };
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

    const layer = options.layer || app._trackDraw?.currentLayer || app._trackToolLayer || 'top-copper';
    const nearPad = findNearbyPad(app, worldPos, padTol, layer, options.excludePad);
    if (nearPad) {
        return { x: nearPad.x, y: nearPad.y, snapType: 'pad', pad: nearPad };
    }
    // Prefer same-net track nodes; fall back to any node.
    const nearNode = _findNearbyTrackNodePreferNet(app, worldPos, trackTol, excludeTrack, net, excludeNode);
    if (nearNode) {
        return { x: nearNode.x, y: nearNode.y, snapType: 'track-node', trackNode: nearNode };
    }

    return resolveGridMagnetSnap(app, worldPos, lastPt);
}

export function resolveGridMagnetSnap(app, worldPos, lastPt = null) {
    if (app.viewport?.shiftHeld) return { x: worldPos.x, y: worldPos.y, snapType: 'free' };
    const scale = Math.max(0.01, app.viewport?.scale || 1);

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
    const gridPoint = snapToGridLines(worldPos, gridOn ? gs : 0, scale);

    // Candidate X-snaps
    {
        let bestDx = tol;
        if (gridPoint.snappedX) {
            const gx = gridPoint.x;
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
        if (gridPoint.snappedY) {
            const gy = gridPoint.y;
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
const SNAP_PX = GRID_SNAP_PX;

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
            const dx = p.x - worldPos.x;
            const dy = p.y - worldPos.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > tol2) continue;
            if (excludeNode && excludeNode(track, nid)) continue;
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
/* ──────────────────────────── lifecycle ──────────────────────────── */

function shapeCopperContains(contact, point) {
    const { geometry, bounds } = contact;
    if (point.x < bounds.minX || point.x > bounds.maxX || point.y < bounds.minY || point.y > bounds.maxY) return false;
    if (geometry.copperMode !== 'add') return false;
    if (geometry.circle) {
        const distance = Math.hypot(point.x - geometry.circle.x, point.y - geometry.circle.y);
        return geometry.filled ? distance <= geometry.circle.outerRadius
            : Math.abs(distance - geometry.circle.radius) <= geometry.lineWidth / 2;
    }
    if (geometry.areaOutline && pointInPolygon(point, geometry.areaOutline)) return true;
    if (geometry.strokeSegments.length) {
        return geometry.strokeSegments.some(({ start, end, lineWidth }) =>
            distanceToSegment(point, start, end) <= lineWidth / 2);
    }
    const points = geometry.centerline;
    const count = points.length - (geometry.pathClosed ? 0 : 1);
    for (let index = 0; index < count; index++) {
        if (distanceToSegment(point, points[index], points[(index + 1) % points.length])
            <= geometry.lineWidth / 2) return true;
    }
    return false;
}

export function resolveTrackDrawSnap(app, worldPos, options = {}) {
    const snap = resolveTrackSnap(app, worldPos, options);
    const layer = app._trackDraw?.currentLayer || app._trackToolLayer || 'top-copper';
    if (!TOGGLE_LAYERS.includes(layer)) return { ...snap, contactNets: [], copperContact: false };
    const shapes = (app.boardShapes || []).filter((shape) => shape.layer === layer && shape.visible !== false);
    const geometry = new Map(shapes.filter((shape) => shape.type !== 'fill')
        .map((shape) => [shape, resolveTrackContactGeometry(shape)]));
    const contactsAt = (point) => shapes.filter((shape) => shape.type === 'fill'
        ? (getComputedFill(shape) || []).some((polygon) => pointInPolygon(point, polygon.outer)
            && !(polygon.holes || []).some((hole) => pointInPolygon(point, hole)))
        : shapeCopperContains(geometry.get(shape), point));
    const hardSnap = snap.snapType === 'pad' || snap.snapType === 'track-node';
    let target = { x: snap.x, y: snap.y };
    let via = null;
    let contacts = null;
    if (!hardSnap) {
        const tolerance = TRACK_SNAP_SCREEN_PX / (app.viewport?.scale || 1);
        let nearest = Infinity;
        for (const candidate of app.vias || []) {
            if (candidate.visible === false) continue;
            const distance = Math.hypot(worldPos.x - candidate.x, worldPos.y - candidate.y);
            if (distance <= Math.max(tolerance, candidate.diameter / 2) && distance < nearest) {
                nearest = distance;
                via = candidate;
            }
        }
        if (via) target = { x: via.x, y: via.y };
        else {
            const rawContacts = contactsAt(worldPos);
            if (rawContacts.length || (target.x === worldPos.x && target.y === worldPos.y)) {
                contacts = rawContacts;
                if (rawContacts.length) target = { ...worldPos };
            }
        }
    }
    contacts ??= contactsAt(target);
    const vias = (app.vias || []).filter((candidate) => candidate.visible !== false
        && Math.hypot(target.x - candidate.x, target.y - candidate.y) <= candidate.diameter / 2);
    const sourceNet = snap.pad?.net || snap.trackNode?.track.net || '';
    const contactNets = [...new Set([sourceNet, ...contacts.map((shape) => shape.net), ...vias.map((item) => item.net)]
        .map((net) => String(net || '').trim()).filter(Boolean))];
    return {
        ...snap,
        ...target,
        ...(via ? { snapType: 'via', via } : {}),
        contactNets,
        copperShapes: contacts,
        copperContact: contacts.length > 0 || vias.length > 0,
    };
}

function trackContactConflict(net, contactNets) {
    const nets = [...new Set([net, ...contactNets].filter(Boolean))];
    if (nets.length < 2) return false;
    showAlert(`Cannot connect different nets: ${nets.map((name) => `"${name}"`).join(', ')}.`,
        { title: 'Net Conflict' });
    return true;
}

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
    const snap = resolveTrackDrawSnap(app, worldPos);
    const startPad = snap.snapType === 'pad' ? snap.pad : null;
    // Inherit the net at draw start from the pad or track node we begin on,
    // so the live net-guide line works for the whole draw (an unassigned
    // track would have nothing to guide toward).
    let net = startPad?.net || String(app._trackToolNet || '').trim();
    let startTrack = null;
    if (snap.snapType === 'track-node' && snap.trackNode) {
        startTrack = snap.trackNode.track;
        if (!net) net = startTrack.net || '';
    }
    if (trackContactConflict(net, snap.contactNets)) return null;
    if (!net) net = snap.contactNets[0] || '';
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
        endCopperShapes: [],
        axisLock: null,                  // 'horizontal' | 'vertical' | 'diagonal' | null
        previewElements: [],             // SVG nodes owned by the current preview render
        snap,                            // most recent live snap result
        // Copper this draw is already electrically bonded to (the starting
        // Track, Pad or Via cluster), so the live net-guide line never points back at
        // it. Computed once here; the in-progress track isn't in app.tracks,
        // so the bonded set can't change mid-draw.
        guideExclude: bondedExclusion(app, startTrack, snap.via ? { via: snap.via }
            : startPad ? { padKey: startPad.standalonePad
                ? `null|${startPad.standalonePad.id}` : `${startPad.componentId}|${startPad.pinNumber}` } : null),
        guideSourceShapes: new Set(snap.copperShapes || []),
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

    // Live guide from the trailing tip to the nearest existing copper on this
    // track's net that it isn't already connected to. This moving guide is
    // independent of the static ratsnest overlay.
    if (ctx.net) {
        const near = nearestPointOnNet(app, ctx.net, target, {
            excludePoints: ctx.points,
            ...(ctx.guideExclude || {}),
            excludeShapes: ctx.guideSourceShapes,
            layer: ctx.currentLayer,
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
    const snap = resolveTrackDrawSnap(app, worldPos, { lastPt: last, net: ctx.net });
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
        if (!ctx.net) ctx.net = snap.via.net || '';
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
 */
export function toggleTrackLayer(app) {
    const ctx = app._trackDraw;
    if (!ctx) return;
    const idx = TOGGLE_LAYERS.indexOf(ctx.currentLayer);
    ctx.currentLayer = TOGGLE_LAYERS[(idx + 1) % TOGGLE_LAYERS.length];
    app._setPcbStatus?.();
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
            if (app._commitTracks(tracks, newVias, ctx.endCopperShapes) === false) return false;
        } else {
            for (const shape of ctx.endCopperShapes || []) {
                shape.net = ctx.net;
                if (shape.type === 'fill') app._refreshFills?.();
                else renderBoardShape(app, shape);
            }
            for (const track of tracks) {
                app.tracks.push(track);
                renderTrack(track, (id) => app._getLayerGroup(id), _renderOptsFromApp(app));
            }
            for (const v of newVias) {
                app.vias.push(v);
                // Render lazily to avoid a hard import cycle.
                import('./track-render.js').then(({ renderVia }) => {
                    renderVia(v, (id) => app._getLayerGroup(id));
                    app._refreshClearanceHalos?.();
                });
            }
            app._refreshClearanceHalos?.();
            reconcileRatsnest(app);
        }
    }

    _teardownDraw(app);
    // Track tool is still selected — restore its draw settings.
    app._showTrackDrawProperties?.();
    return true;
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
    const liveShapeDrag = app._shapeDrag?.ratsnestNets && opts?.nets === app._shapeDrag.ratsnestNets;
    if (app._pictureCopperRefreshPending && !liveShapeDrag) return;
    if (deferDerivedUpdate(app, 'ratsnest', () => reconcileRatsnest(app))) return;
    // Incremental net filter: when present, restrict all cluster construction
    // and ratline removal/redraw to this set of nets.
    const onlyNets = opts?.nets instanceof Set ? opts.nets : null;
    // During a live footprint drag the expensive derived overlays (clearance
    // halos and copper pours) are deferred: their transient per-frame state is
    // invisible eye-candy, and re-pouring every fill via polygon clipping (or
    // rebuilding clearance geometry) on each frame is the single biggest cost
    // on boards that have them. _endDrag() forces one full reconcile on drop.
    if (!app._deferDragOverlays) {
        if (!opts?.skipFillRefresh && app._refreshFills?.() === true) return;
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

    const clusters = buildCopperClusters(app, onlyNets).filter((cluster) => cluster.net);
    const terminalCount = clusters.length;

    // ── Additive copper shapes are net-bearing islands on their own layer.
    // Bond by copper contact, not just coincident centres or vertices.
    // Pictures contribute one solid transformed frame, not individual pixels.
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

    for (const fill of app.copperFills || []) {
        const net = fill.net || '';
        if (!net || (onlyNets && !onlyNets.has(net))) continue;
        for (const region of getComputedFill(fill) || []) {
            if (!region.outer || region.outer.length < 3) continue;
            clusters.push({ net, layer: fill.layer, points: [], source: fill,
                copperShape: copperRegionShape(region) });
        }
    }

    if (!clusters.length) {
        terminalContactPasses.delete(app);
        return;
    }

    // ── Union clusters that physically touch (same net, coincident point,
    //    AND layer-compatible: same layer, or one side is an all-layer bond
    //    such as a via or pad). Cross-layer coincidence WITHOUT a bond does
    //    not connect. ──
    const parent = clusters.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

    unionCoincidentClusters(clusters.slice(0, terminalCount), union, true);
    const contacts = _clusterCopperContacts(app, clusters);
    for (const [first, second] of spatialPairs(contacts,
        contact => contact.resolved.bounds, 1e-7)) {
        const a = clusters[first.index], b = clusters[second.index];
        if (a.net !== b.net || find(first.index) === find(second.index)
            || (a.source && a.source === b.source)
            || (first.layer !== 'all' && second.layer !== 'all' && first.layer !== second.layer)) continue;
        if (copperContactsTouch(first.resolved, second.resolved)) union(first.index, second.index);
    }

    // ── Group merged clusters by net ──
    /** @type {Map<number, {net:string, points:Array<{x:number,y:number}>}>} */
    const supernodes = new Map();
    for (let i = 0; i < clusters.length; i++) {
        const r = find(i);
        let sn = supernodes.get(r);
        if (!sn) { sn = { net: clusters[i].net, points: [] }; supernodes.set(r, sn); }
        const shape = clusters[i].copperShape;
        const targets = shape?.kind === 'arc' ? [shape.start, shape.end]
            : ['line', 'polygon'].includes(shape?.kind)
                && Object.values(shape.segmentBulges || {}).some(value => Number(value) !== 0)
                ? shape.points : clusters[i].points;
        for (const point of targets) sn.points.push(point);
    }

    /** @type {Map<string, Array<Array<{x:number,y:number}>>>} */
    const netGroups = new Map();
    for (const sn of supernodes.values()) {
        // Pours bridge existing objects, but are not standalone ratline targets.
        if (!sn.points.length) continue;
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
 * Walk copper reachable from a seed track/via, ignoring Net names.
 * Base connectivity follows layer-compatible junctions and Via/Track overlap.
 * With includeShapes, use the same physical contact geometry as ratlines for
 * all copper types, including Pad rims, curved strokes and pour regions.
 * Drill voids and region holes do not conduct. Cross-layer contact still
 * requires a through Via or Pad.
 *
 * @param {object} app
 * @param {{track?:object, tracks?:Set<object>, via?:object, padKey?:string}} seed
 * @param {{includeShapes?:boolean, newTracks?:Set<object>}} [options]
 *   Include physical shape contacts; new Tracks reserve clearance in foreign-net pours.
 * @returns {{tracks:Set<object>, trackNodes:Map<object,Set<string>>, vias:Set<object>, shapes:Set<object>, padNets:Set<string>, padKeys:Set<string>, padNetByKey:Map<string,string>}}
 */
export function collectBondedCopper(app, seed, { includeShapes = false, newTracks = null } = {}) {
    const clusters = buildCopperClusters(app);
    if (!clusters.length) terminalContactPasses.delete(app);
    if (includeShapes) {
        for (const shape of new Set([...(app.boardShapes || []), ...(app.copperFills || [])])) {
            if (!TOGGLE_LAYERS.includes(shape.layer)
                || (shape.type !== 'fill' && normalizeShapeCopperMode(shape.copperMode) !== 'add')) continue;
            const geometries = shape.type === 'fill'
                ? (getComputedFill(shape) || []).map(copperRegionShape)
                : [shape];
            for (const geometry of geometries) {
                clusters.push({ kind: 'shape', shape, geometry, net: shape.net || '',
                    layer: shape.layer, points: [] });
            }
        }
    }

    // Union-find with layer-aware coincidence (mirrors reconcileRatsnest).
    const parent = clusters.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    unionCoincidentClusters(clusters, union);
    if (!includeShapes) _unionViaTrackOverlaps(clusters, union, false);

    const roots = new Set();
    for (let i = 0; i < clusters.length; i++) {
        const c = clusters[i];
        const seededTrackComponent = (seed.tracks?.has(c.track) || seed.track && c.track === seed.track)
            && (!seed.edgeId || c.edgeIds?.has(seed.edgeId))
            && (!seed.nodeId || c.nodeIds?.has(seed.nodeId));
        if (seededTrackComponent || (seed.via && c.via === seed.via)
            || (seed.padKey && c.padKey === seed.padKey)) {
            roots.add(find(i));
        }
    }
    if (includeShapes && roots.size) {
        const contacts = _clusterCopperContacts(app, clusters).map(contact => ({
            ...contact, root: find(contact.index),
        }));
        const bounds = contact => contact.resolved.bounds;
        const neighbours = new Map();
        const addCandidates = pairs => {
            for (const [first, second] of pairs) {
                if (first.root === second.root
                    || (first.layer !== 'all' && second.layer !== 'all' && first.layer !== second.layer)) continue;
                const fill = first.shape?.type === 'fill' ? first.shape
                    : second.shape?.type === 'fill' ? second.shape : null;
                const track = first.track || second.track;
                // The cached pour predates this route. Repouring will cut
                // clearance around a new foreign-net Track, not bond to it.
                if (fill?.net && newTracks?.has(track) && fill.net !== track.net) continue;
                for (const [from, to] of [[first, second], [second, first]]) {
                    if (!neighbours.has(from.root)) neighbours.set(from.root, []);
                    neighbours.get(from.root).push([from, to]);
                }
            }
        };
        addCandidates(spatialPairs(contacts, bounds, 1e-7));
        // Narrow-phase geometry is needed only for candidates reachable from
        // this route, not for every pair of artwork/fill objects on the board.
        const pending = [...roots];
        for (let index = 0; index < pending.length; index++) {
            for (const [from, to] of neighbours.get(pending[index]) || []) {
                if (roots.has(to.root) || !copperContactsTouch(from.resolved, to.resolved)) continue;
                roots.add(to.root);
                pending.push(to.root);
            }
        }
    }

    const tracks = new Set();
    const trackNodes = new Map();
    const vias = new Set();
    const shapes = new Set();
    const padNets = new Set();
    const padKeys = new Set();
    const padNetByKey = new Map();
    for (let i = 0; i < clusters.length; i++) {
        if (!roots.has(find(i))) continue;
        const c = clusters[i];
        if (c.kind === 'track' && c.track) {
            tracks.add(c.track);
            if (!trackNodes.has(c.track)) trackNodes.set(c.track, new Set());
            for (const nodeId of c.nodeIds) trackNodes.get(c.track).add(nodeId);
        }
        else if (c.kind === 'via' && c.via) vias.add(c.via);
        else if (c.kind === 'shape') shapes.add(c.shape);
        else if (c.kind === 'pad') {
            if (c.padNet) padNets.add(c.padNet);
            if (c.padKey) {
                padKeys.add(c.padKey);
                padNetByKey.set(c.padKey, c.padNet || '');
            }
        }
    }
    return { tracks, trackNodes, vias, shapes, padNets, padKeys, padNetByKey };
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
export function _clusterMST(nodes) {
    if (nodes.length > 128) return spatialClusterMST(nodes);
    const n = nodes.length;
    const edges = [];
    if (n < 2) return edges;
    const inTree = new Uint8Array(n);
    const best = new Float64Array(n).fill(Infinity);
    /** @type {Array<{x1:number,y1:number,x2:number,y2:number,d2:number} | undefined>} */
    const bestPairs = new Array(n);
    inTree[0] = 1;
    const relax = (k) => {
        for (let i = 0; i < n; i++) {
            if (inTree[i]) continue;
            const pair = _closestPair(nodes[k], nodes[i]);
            if (pair.d2 < best[i]) { best[i] = pair.d2; bestPairs[i] = pair; }
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
        const pair = bestPairs[b];
        if (!pair) break;
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

function _clearPreviewElements(ctx, keepCached = false) {
    for (const el of ctx.previewElements || []) el.remove();
    ctx.previewElements = [];
    if (!keepCached) {
        for (const element of ctx.previewCache?.values() || []) element.remove();
        ctx.previewCache?.clear();
    }
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

// Retain only the last contact pass, not deleted terminals or an unbounded geometry history.
const terminalContactPasses = new WeakMap();

/** Shared physical geometry for ratlines and bonded-Net traversal. */
function _clusterCopperContacts(app, clusters) {
    const contacts = [];
    const segments = new Map();
    const model = app.pcbDocument || app;
    const previous = terminalContactPasses.get(app);
    const terminals = new Map();
    clusters.forEach((cluster, index) => {
        const isShape = cluster.kind === 'shape' || !!cluster.copperShape;
        let geometries, terminal;
        if (isShape) geometries = [cluster.geometry || cluster.copperShape];
        else if (cluster.kind === 'via' || cluster.kind === 'pad') {
            const key = cluster.via || cluster.padKey;
            terminal = resolveTerminalCopperContact(cluster,
                previous?.model === model ? previous.terminals.get(key) : undefined);
            terminals.set(key, terminal);
            geometries = [terminal.shape];
        } else {
            if (!segments.has(cluster.track)) segments.set(cluster.track, resolveTrackSegments(cluster.track));
            geometries = segments.get(cluster.track).filter(segment => cluster.edgeIds.has(segment.edgeId))
                .map(copperSegmentShape);
        }
        for (const geometry of geometries) contacts.push({
            index, geometry, track: cluster.track, shape: cluster.shape,
            resolved: terminal ? terminal.resolved
                : geometry.copperSegment ? copperSegmentContact(geometry.copperSegment)
                : resolveTrackContactGeometry(geometry),
            layer: geometry.layer || cluster.layer,
        });
    });
    terminalContactPasses.set(app, { model, terminals });
    return contacts;
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
 * @param {Set<object>} [opts.excludeShapes] - Source copper shapes/fills to skip.
 * @param {string} [opts.layer] - Only target copper reachable on this layer.
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
    const compatible = layer => !opts.layer || copperLayer(layer) === 'all'
        || copperLayer(layer) === opts.layer;
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

    // Use the shared physical-pad model for component and standalone Pads.
    for (const pad of resolveCopperPads(app)) {
        if (pad.net !== net || !compatible(pad.layer)) continue;
        if (excludePadKeys?.has(`${pad.componentId}|${pad.padId}`)) continue;
        if (pad.componentId == null
            && app.pads?.some(source => source.id === pad.padId && source.visible === false)) continue;
        consider(pad.x, pad.y);
    }

    // Vias on the net.
    for (const v of (app.vias || [])) {
        if (v.net !== net || v.visible === false) continue;
        if (excludeVias && excludeVias.has(v)) continue;
        consider(v.x, v.y);
    }

    // Tracks on the net: every node plus the nearest point on each segment.
    for (const track of (app.tracks || [])) {
        if (track.net !== net || track.visible === false) continue;
        if (excludeTracks && excludeTracks.has(track)) continue;
        for (const [edgeId, e] of track.edges) {
            if (!compatible(track.getEdgeLayer(edgeId))) continue;
            const a = track.nodes.get(e.from);
            const b = track.nodes.get(e.to);
            if (!a || !b) continue;
            consider(a.x, a.y);
            consider(b.x, b.y);
            const proj = closestPointOnArcEdge(from, a, b, e.bulge || 0);
            consider(proj.x, proj.y);
        }
    }

    const considerContour = (points, closed = true) => {
        for (let index = 0; index < points.length - (closed ? 0 : 1); index++) {
            const point = _projectPointOnSegment(from, points[index], points[(index + 1) % points.length]);
            consider(point.x, point.y);
        }
    };
    for (const shape of new Set([...(app.boardShapes || []), ...(app.copperFills || [])])) {
        if (shape.net !== net || shape.visible === false || opts.excludeShapes?.has(shape)
            || !['top-copper', 'bottom-copper'].includes(shape.layer) || !compatible(shape.layer)) continue;
        if (shape.type !== 'fill' && normalizeShapeCopperMode(shape.copperMode) !== 'add') continue;
        if (shape.type === 'fill') {
            const regions = getComputedFill(shape) || [];
            for (const region of regions) {
                const holes = region.holes || [];
                if (pointInCopperRegion(from, { outer: region.outer, holes })) consider(from.x, from.y);
                considerContour(region.outer);
                for (const hole of holes) considerContour(hole);
            }
            continue;
        }
        const contact = resolveTrackContactGeometry(shape);
        const geometry = contact.geometry;
        if (shapeCopperContains(contact, from)) consider(from.x, from.y);
        if (geometry.circle) {
            const { x, y, radius } = geometry.circle;
            const angle = Math.atan2(from.y - y, from.x - x);
            consider(x + radius * Math.cos(angle), y + radius * Math.sin(angle));
        } else if (geometry.strokeSegments.length) {
            for (const { start, end } of geometry.strokeSegments) considerContour([start, end], false);
        } else {
            considerContour(geometry.centerline, geometry.pathClosed);
        }
    }
    return best;
}

/**
 * Precompute the copper a trace seeded on `seedTrack` is already bonded to,
 * shaped for `nearestPointOnNet`'s exclusion options. Returns null when there
 * is no seed Track or terminal. Computed once at draw/drag start and reused per frame.
 *
 * @param {object} app
 * @param {object|null} seedTrack
 * @param {object|null} [terminalSeed] - Starting Via or Pad key when not starting on a Track.
 * @returns {{excludeTracks:Set<object>, excludeVias:Set<object>, excludePadKeys:Set<string>}|null}
 */
export function bondedExclusion(app, seedTrack, terminalSeed = null) {
    if (!seedTrack && !terminalSeed) return null;
    const { tracks, vias, padKeys } = collectBondedCopper(app, seedTrack ? { track: seedTrack } : terminalSeed);
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
        const parent = app._getLayerGroup(layerId);
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
            const parent = app._getLayerGroup(layerId);
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

    // Implicit-via markers: any committed anchor where adjacent committed
    // edges differ in layer, PLUS the trailing anchor if currentLayer
    // differs from the last committed edge's layer.
    const viaLayer = app._getLayerGroup('vias');
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
    for (const [key, element] of ctx.previewCache) {
        if (used.has(key)) continue;
        element.remove();
        ctx.previewCache.delete(key);
    }
}

function _previewElement(ctx, key, tag, used) {
    used.add(key);
    let element = ctx.previewCache.get(key);
    if (!element) {
        element = document.createElementNS(NS, tag);
        ctx.previewCache.set(key, element);
    }
    return element;
}

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
            if (i === 0 && ctx.startPad?.componentId) {
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
 * @property {Map<string, SVGElement>} [previewCache]
 * @property {object|null} snap
 * @property {number} [viaDiameter]
 * @property {number} [viaDrill]
 */
