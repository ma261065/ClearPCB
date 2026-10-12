/**
 * Ratlines: for each net, the shortest set of air wires joining its copper that is not yet
 * connected (reconcileRatsnest, rebuilt after every copper change and for a draw's live
 * preview), and the net guide line that points a track being drawn or dragged at the
 * nearest copper of its net.
 */
import { buildCopperClusters, unionCoincidentClusters } from './copper-connectivity.js';
import { getComputedFill } from './computed-fill-cache.js';
import { deferDerivedUpdate } from '../../core/DerivedUpdates.js';
import { Track } from '../../shapes/track.js';
import { closestPointOnArcEdge } from '../../shapes/arc-edge.js';
import { resolveTrackEdgePaths } from '../../shapes/track-geometry.js';
import { curveRatlineTargets } from '../../shapes/path-geometry.js';
import { copperLayer, resolveCopperPads } from './copper-model.js';
import { boardShapeRatlineTargets, normalizeShapeCopperMode, shapeOutline } from '../../shared/pcb/board-shape-geometry.js';
import { getBoardShapeDrag } from './board-shape-drag.js';
import { resolveTrackContactGeometry, copperContactsTouch, copperRegionShape, pointInCopperRegion } from './track-contact-geometry.js';
import { clearTerminalContactPasses, shapeCopperContains, _clusterCopperContacts } from './track-connections.js';
import { spatialClusterMST } from './cluster-mst.js';
import { spatialPairs } from '../../core/spatial-pairs.js';
import { areDragOverlaysDeferred, isPictureCopperRefreshPending } from './refresh-state.js';
import { peekDrcPresentation, refreshSelectedDrcMarker, setDrcRatlines, storedDrcRatlines } from './drc-state.js';
import { invalidateDrcRefresh } from './drc-refresh.js';
import { getTrackDraw } from './track-draw.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {{failed?: boolean, net: string, x1: number, y1: number, x2: number, y2: number}} Ratline */
/** @typedef {{x: number, y: number}} Point */

const NS = 'http://www.w3.org/2000/svg';

const netGuideLines = new WeakMap();

const netGuideSources = new WeakMap();
/** @param {Point} point */
export const ratlinePointKey = ({ x, y }) => `${Math.round(x * 10000)},${Math.round(y * 10000)}`;

/** True when a Track has rounded corners or arc edges. */
/** @param {Track} track */
function trackHasCurves(track) {
    if (Number(track.cornerRadius) >= 0.01
        || Object.values(track.nodeCornerRadii || {}).some(radius => Number(radius) >= 0.01)) return true;
    for (const edge of track.edges.values()) if (edge.bulge) return true;
    return false;
}

/**
 * Ratline endpoints for a Track cluster, by the same rule as board shapes
 * (boardShapeRatlineTargets): nodes the copper passes through plus a few points
 * along every curve. A rounded corner's node lies off the copper, so curved
 * Tracks use their rendered centreline. Nodes still bond junctions.
 */
/** @param {any} cluster Dynamic copper clusters can represent tracks, pads, vias, or shapes. @param {Map<Track, any>} pathsByTrack */
function trackRatlineTargets(cluster, pathsByTrack) {
    const { track, edgeIds } = cluster;
    if (!edgeIds?.size || !trackHasCurves(track)) return cluster.points;
    let paths = pathsByTrack.get(track);
    if (!paths) pathsByTrack.set(track, paths = resolveTrackEdgePaths(track));
    const targets = [];
    for (const edgeId of edgeIds) {
        const path = paths.get(edgeId);
        if (path?.length) targets.push(...curveRatlineTargets(path));
    }
    return targets.length ? targets : cluster.points;
}

/**
 * Rebuild the ratsnest from net connectivity.
 *
 * The ratsnest is derived purely from net names: unknown pad, Track or Via
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
 * @param {PcbEditor} app
 * @param {{nets?: Set<string>, skipFillRefresh?:boolean}} [opts] - Incremental
 *   mode can restrict ratline work to `nets`. `skipFillRefresh` is used after
 *   a fill recompute to consume its new geometry without scheduling another
 *   fill pass.
 */
export function reconcileRatsnest(app, opts) {
    refreshSelectedDrcMarker(app);
    const shapeDrag = getBoardShapeDrag(app);
    const liveShapeDrag = shapeDrag?.session?.nets && opts?.nets === shapeDrag.session.nets;
    if (isPictureCopperRefreshPending(app) && !liveShapeDrag) return;
    if (deferDerivedUpdate(app, 'ratsnest', () => reconcileRatsnest(app))) return;
    // Incremental net filter: when present, restrict all cluster construction
    // and ratline removal/redraw to this set of nets.
    const onlyNets = opts?.nets instanceof Set ? opts.nets : null;
    // During a live footprint drag the expensive derived overlays (clearance
    // halos and copper pours) are deferred: their transient per-frame state is
    // invisible eye-candy, and re-pouring every fill via polygon clipping (or
    // rebuilding clearance geometry) on each frame is the single biggest cost
    // on boards that have them. _endDrag() forces one full reconcile on drop.
    if (!areDragOverlaysDeferred(app)) {
        if (!opts?.skipFillRefresh && app.refreshFills() === true) return;
    }

    const ratLayer = app.getLayerGroup('ratlines');
    if (!ratLayer) return;
    const ratlines = /** @type {Ratline[]} */ (storedDrcRatlines(app)).filter(line => line.failed || (onlyNets && !onlyNets.has(line.net)));
    const publishRatlines = () => {
        setDrcRatlines(app, ratlines);
        refreshNetGuideLine(app);
        invalidateDrcRefresh(app);
    };

    // Clear previously-generated ratsnest (keep autorouter failed lines).
    for (const el of /** @type {SVGElement[]} */ ([...ratLayer.children])) {
        if (el.classList?.contains('ratsnest-failed')) continue;
        // Incremental mode: keep ratlines for nets we're not recomputing.
        const net = el.dataset?.net;
        if (onlyNets && (!net || !onlyNets.has(net))) continue;
        el.remove();
    }

    const clusters = buildCopperClusters(app, /** @type {null} */ (/** @type {unknown} */ (onlyNets))).filter((cluster) => cluster.net);
    const preview = getTrackDraw(app)?.ratlinePreview;
    if (preview) clusters.push(...buildCopperClusters(preview, /** @type {null} */ (/** @type {unknown} */ (onlyNets))));
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
        clearTerminalContactPasses(app);
        publishRatlines();
        return;
    }

    // ── Union clusters that physically touch (same net, coincident point,
    //    AND layer-compatible: same layer, or one side is an all-layer bond
    //    such as a via or pad). Cross-layer coincidence WITHOUT a bond does
    //    not connect. ──
    const parent = clusters.map((_, i) => i);
    /** @param {number} i */
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    /** @param {number} a @param {number} b */
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
    const trackPaths = new Map();
    for (let i = 0; i < clusters.length; i++) {
        const r = find(i);
        let sn = supernodes.get(r);
        if (!sn) { sn = { net: clusters[i].net, points: [] }; supernodes.set(r, sn); }
        const shape = clusters[i].copperShape;
        // Pour regions (with a source fill) keep their empty target list.
        const targets = clusters[i].kind === 'track' ? trackRatlineTargets(clusters[i], trackPaths)
            : shape && !clusters[i].source ? boardShapeRatlineTargets(shape) : clusters[i].points;
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
            ratlines.push({ net: String(net), x1: edge.x1, y1: edge.y1, x2: edge.x2, y2: edge.y2 });
        }
    }

    // A selected incomplete-connection DRC marker targets one of these
    // derived lines. Re-anchor it after every rebuild, including callers that
    // invoke reconcileRatsnest directly during track/via/group movement.
    publishRatlines();
    peekDrcPresentation(app)?.followRatline();
}

/**
 * Closest pair of points between two point sets. Returns the segment
 * endpoints plus the squared distance.
 * @param {Point[]} A
 * @param {Point[]} B
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
    /** @type {Array<{x1:number,y1:number,x2:number,y2:number}>} */
    const edges = [];
    if (n < 2) return edges;
    const inTree = new Uint8Array(n);
    const best = new Float64Array(n).fill(Infinity);
    /** @type {Array<{x1:number,y1:number,x2:number,y2:number,d2:number} | undefined>} */
    const bestPairs = new Array(n);
    inTree[0] = 1;
    /** @param {number} k */
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

/** Closest point on segment a→b to p, clamped to the segment. */
/** @param {Point} p @param {Point} a @param {Point} b */
function _projectPointOnSegment(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    if (len2 < 1e-12) return { x: a.x, y: a.y };
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return { x: a.x + abx * t, y: a.y + aby * t };
}

/**
 * Find the nearest point of net `net`'s existing copper (pads, vias and
 * tracks) to `from`. This geometry query is independent of the node-based
 * ratline graph used by the displayed routing guide. Already-connected copper is
 * excluded via `excludeTracks`/`excludeVias`/`excludePadKeys` (a precomputed
 * bonded cluster) so the guide never points back at it.
 *
 * @param {Pick<PcbEditor, 'tracks'|'vias'|'pads'|'boardShapes'|'copperFills'|'placements'|'netlist'>} app
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
    /** @param {string} layer */
    const compatible = layer => !opts.layer || copperLayer(layer) === 'all'
        || copperLayer(layer) === opts.layer;
    const EPS2 = 1e-6; // (1e-3 mm)^2
    /** @param {number} x @param {number} y */
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
    /** @param {number} x @param {number} y */
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
            && /** @type {any[]} */ (app.pads || []).some((source) => source.id === pad.padId && source.visible === false)) continue;
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

    /** @param {Point[]} points @param {boolean} [closed] */
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

/** @param {PcbEditor} app */
function refreshNetGuideLine(app) {
    const state = netGuideSources.get(app);
    if (!state) return;
    clearNetGuideLine(app);
    const layer = app.getLayerGroup('ratlines');
    let best = null, bestDistance = Infinity;
    for (const line of /** @type {Iterable<SVGElement>} */ (layer?.children || [])) {
        if (line.dataset?.net !== state.net || !line.classList?.contains('ratsnest-line')
            || line.classList.contains('ratsnest-failed')) continue;
        const from = { x: Number(line.getAttribute('x1')), y: Number(line.getAttribute('y1')) };
        const to = { x: Number(line.getAttribute('x2')), y: Number(line.getAttribute('y2')) };
        for (const point of [from, to]) {
            const key = ratlinePointKey(point);
            if (key !== state.tip && !state.sourceKeys?.has(key) && !state.previewKeys?.has(key)) continue;
            const distance = (point.x - state.from.x) ** 2 + (point.y - state.from.y) ** 2;
            if (distance < bestDistance) {
                bestDistance = distance;
                best = { line, from, to };
            }
        }
    }
    if (best && app.viewport?.svg) {
        showNetGuideLine(app, best.from, best.to);
        netGuideLines.get(app).dataset.net = state.net;
        state.hiddenLine = best.line;
        state.visibility = best.line.style.visibility;
        best.line.style.visibility = 'hidden';
    }
    netGuideSources.set(app, state);
}

/**
 * Promote exactly one real ratline; every other graph edge keeps its own visibility.
 * @param {PcbEditor} app
 * @param {string} net
 * @param {Point} from
 * @param {Set<string>|null} sourceKeys
 * @param {Point[]} [previewPoints]
 */
export function updateNetGuideLine(app, net, from, sourceKeys, previewPoints = []) {
    clearNetGuideLine(app);
    if (!net || !from) return;
    netGuideSources.set(app, {
        net, from, tip: ratlinePointKey(from), sourceKeys,
        previewKeys: new Set(previewPoints.map(ratlinePointKey)),
    });
    refreshNetGuideLine(app);
}

/**
 * Draw the active connection from `from` to `to`, styled like a dashed ratline.
 * Replaces any previous guide. Pass a
 * falsy endpoint, or call `clearNetGuideLine`, to remove it.
 *
 * @param {PcbEditor} app
 * @param {Point|null} from
 * @param {Point|null} to
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
    line.setAttribute('stroke-dasharray', '4 3');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('pointer-events', 'none');
    line.classList.add('net-guide-line');
    // Root SVG so the guide always paints above the copper.
    app.viewport.svg.appendChild(line);
    netGuideLines.set(app, line);
}

/**
 * Remove the net guide line, if present.
 * @param {PcbEditor} app
 */
export function clearNetGuideLine(app) {
    const source = netGuideSources.get(app);
    if (source) {
        if (source.hiddenLine) source.hiddenLine.style.visibility = source.visibility;
        source.hiddenLine = null;
        netGuideSources.delete(app);
    }

    const guide = netGuideLines.get(app);
    if (guide) {
        guide.remove();
        netGuideLines.delete(app);
    }
}

/** @param {PcbEditor} app */
export function getNetGuideLine(app) {
    return netGuideLines.get(app) || null;
}
