/**
 * Where the Track tool's cursor lands: on a pad, a track node or a via (the hard targets),
 * on copper it would touch, or on the grid with axis and 45-degree magnets. Drawing and
 * node drags share these rules, and the snap marker that shows the hard target under the
 * cursor.
 */
import { getComputedFill } from './computed-fill-cache.js';
import { GRID_SNAP_PX, snapToGridLines } from '../../core/grid-snap.js';
import { Track } from '../../shapes/track.js';
import { Via } from '../../shapes/via.js';
import { pointInPolygon, distanceToSegment } from '../../core/geometry.js';
import { padFlashOutline, placementPose } from '../../shared/pcb/board-geometry.js';
import { resolveTrackContactGeometry } from './track-contact-geometry.js';
import { buildBondedClusters, nodeTargetPairs, shapeCopperContains, _clusterCopperContacts } from './track-connections.js';
import { getTrackDraw, getTrackToolLayer, getTrackToolNet } from './track-draw.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {{padTolerance?: number, trackTolerance?: number, excludeTrack?: Track|null, excludePad?: any, layer?: string, excludeNode?: (track: Track, nodeId: string) => boolean, lastPt?: Point|null, net?: string, checkNodeContacts?: boolean}} TrackSnapOptions */
/**
 * @typedef {object} TrackSnap
 * @property {number} x
 * @property {number} y
 * @property {'pad'|'track-node'|'axis'|'grid'|'free'|'via'|string} snapType
 * @property {any} [pad]
 * @property {any} [trackNode]
 */

const TOGGLE_LAYERS = ['top-copper', 'bottom-copper'];

const NS = 'http://www.w3.org/2000/svg';

const trackSnapMarkers = new WeakMap();

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

/* ──────────────────────────── snap helpers ──────────────────────────── */

/**
 * Find the nearest Pad centre. Component Pads require entering their outline;
 * standalone Pads retain their minimum snap radius of `tolerance`.
 * @param {Pick<PcbEditor, 'pads'|'placements'|'netlist'>} app
 * @param {Point} worldPos
 * @param {number} [tolerance]
 * @param {string} [layer]
 * @param {any} [excludePad]
 * @returns {{x:number, y:number, componentId?:string, pinNumber?:string, number?:string, net:string, standalonePad?:object}|null}
 */
export function findNearbyPad(app, worldPos, tolerance = PAD_SNAP_TOL, layer = 'top-copper', excludePad = null) {
    if (!app) return null;
    /** @type {any} */
    let best = null;
    let bestD2 = Infinity;
    for (const [compId, pl] of app.placements || []) {
        if (!pl?.pads) continue;
        const pose = placementPose(pl);
        /** @param {string|number} padId @param {any} pad @param {any} geometry @param {boolean} rotated */
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
 * @param {Pick<PcbEditor, 'tracks'>} app
 * @param {Point} worldPos
 * @param {number} [tolerance]
 * @param {Track|null} [excludeTrack]
 * @returns {{x:number, y:number, track:Track, nodeId:string}|null}
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
 * @param {PcbEditor} app
 * @param {Point} worldPos
 * @param {TrackSnapOptions} [options]
 * @returns {TrackSnap}
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

    const layer = options.layer || getTrackDraw(app)?.currentLayer || getTrackToolLayer(app) || 'top-copper';
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

/**
 * @param {PcbEditor} app
 * @param {Point} worldPos
 * @param {Point|null} [lastPt]
 * @returns {TrackSnap}
 */
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
 * @param {Pick<PcbEditor, 'tracks'>} app
 * @param {Point} worldPos
 * @param {number} tolerance
 * @param {Track|null} excludeTrack
 * @param {string} preferredNet
 * @param {((track: Track, nodeId: string) => boolean)|null} excludeNode
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
/** @param {Point} lastPt @param {Point} target @param {'horizontal'|'vertical'|'diagonal'|string} axis */
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
/** @param {Point} lastPt @param {Point} worldPos @param {number} [diagBand] */
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
 * @param {PcbEditor} app
 * @param {Point} worldPos
 * @param {TrackSnapOptions} [options]
 * @returns {TrackSnap & {contactNets: string[], copperContact: boolean, via?: any, copperShapes?: any[]}}
 */
export function resolveTrackDrawSnap(app, worldPos, options = {}) {
    const snap = resolveTrackSnap(app, worldPos, options);
    const layer = getTrackDraw(app)?.currentLayer || getTrackToolLayer(app) || 'top-copper';
    if (!TOGGLE_LAYERS.includes(layer)) return { ...snap, contactNets: [], copperContact: false };
    const sourceNet = snap.pad?.net || snap.trackNode?.track.net || '';
    // A pour of another net is re-poured with clearance around the new track,
    // so it is not copper the track connects to (matching collectNodeConnections).
    const drawNet = String(options.net || sourceNet || getTrackToolNet(app) || '').trim();
    /** @param {any} shape */
    const foreignFill = (shape) => shape?.type === 'fill' && !!drawNet
        && !!String(shape.net || '').trim() && String(shape.net).trim() !== drawNet;
    const boardShapes = /** @type {any[]} */ (app.boardShapes || []);
    const shapes = boardShapes.filter((shape) => shape.layer === layer && shape.visible !== false
        && !foreignFill(shape));
    const geometry = new Map(shapes.filter((shape) => shape.type !== 'fill')
        .map((shape) => [shape, resolveTrackContactGeometry(shape)]));
    /** @param {Point} point */
    const contactsAt = (point) => shapes.filter((shape) => shape.type === 'fill'
        ? (getComputedFill(shape) || []).some((polygon) => pointInPolygon(point, polygon.outer)
            && !(polygon.holes || []).some((hole) => pointInPolygon(point, hole)))
        : shapeCopperContains(/** @type {import('./track-connections.js').CopperContact} */ (geometry.get(shape)), point));
    const hardSnap = snap.snapType === 'pad' || snap.snapType === 'track-node';
    let target = { x: snap.x, y: snap.y };
    /** @type {Via|null} */
    let via = null;
    /** @type {any[]|null} */
    let contacts = null;
    if (!hardSnap) {
        const tolerance = TRACK_SNAP_SCREEN_PX / (app.viewport?.scale || 1);
        let nearest = Infinity;
        for (const candidate of /** @type {Via[]} */ (app.vias || [])) {
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
    contacts = contacts ?? contactsAt(target);
    const contactShapes = /** @type {any[]} */ (contacts);
    const vias = /** @type {Via[]} */ (app.vias || []).filter((candidate) => candidate.visible !== false
        && Math.hypot(target.x - candidate.x, target.y - candidate.y) <= candidate.diameter / 2);
    const nodeNets = [];
    if (options.checkNodeContacts) {
        const clusters = buildBondedClusters(app, true);
        for (const [, contact] of nodeTargetPairs([{ ...target, layer }], _clusterCopperContacts(app, clusters))) {
            if (foreignFill(contact.shape)) continue;
            nodeNets.push(clusters[contact.index].net);
        }
    }
    const contactNets = [...new Set([sourceNet, ...nodeNets, ...contactShapes.map((shape) => shape.net), ...vias.map((item) => item.net)]
        .map((net) => String(net || '').trim()).filter(Boolean))];
    return {
        ...snap,
        ...target,
        ...(via ? { snapType: 'via', via } : {}),
        contactNets,
        copperShapes: contactShapes,
        copperContact: contactShapes.length > 0 || vias.length > 0,
    };
}

/**
 * Show a yellow target circle at a hard snap point (pad centre or an
 * existing track node), mirroring the schematic editor's snap highlight.
 * Replaces any previous marker. Pass a falsy `pos` (or call
 * `clearTrackSnapMarker`) to remove it.
 *
 * @param {PcbEditor} app
 * @param {Point|null} pos - snap point in world mm
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
    trackSnapMarkers.set(app, dot);
}

/**
 * Remove the yellow snap target circle, if present.
 * @param {PcbEditor} app
 */
export function clearTrackSnapMarker(app) {
    const marker = trackSnapMarkers.get(app);
    if (marker) {
        marker.remove();
        trackSnapMarkers.delete(app);
    }
}

/** @param {PcbEditor} app */
export function hasTrackSnapMarker(app) {
    return trackSnapMarkers.has(app);
}

/** @param {Pick<PcbEditor, 'netlist'>} app @param {string} componentId @param {string} pinNumber */
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
