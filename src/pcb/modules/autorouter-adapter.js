/**
 * Convert autorouter output into Track + Via model objects.
 *
 * The autorouter emits one polyline per (net, layer, connection) plus a
 * parallel array of via positions on each track. For the Phase 1 model:
 *
 *   - Each `track` (one net, one layer, polyline of points) becomes one
 *     single-layer Track. Per-edge layer is set to the track's layer
 *     for every edge.
 *   - Each via in `track.vias` becomes a standalone Via with the track's
 *     net assigned. (Future work: when stitching across layers, detect
 *     pairs of (top-track endpoint, bottom-track endpoint, via at same
 *     position) and merge them into a single multi-layer Track with
 *     an implicit-via node rather than separate Tracks + standalone
 *     Vias.)
 */
import { Track } from '../../shapes/track.js';
import { Via } from '../../shapes/via.js';

/** @typedef {{x: number, y: number}} Point */
/** @typedef {{componentId: string, pinNumber: string|number}} PadRef */
/** @typedef {{net?: string, layer?: string, points?: Point[], vias?: Array<Point & {net?: string}>}} AutorouterTrack */
/** @typedef {{tracks?: AutorouterTrack[], vias?: Array<Point & {net?: string}>}} AutorouterRouteResult */
/** @typedef {{trackWidth?: number, viaDiameter?: number, viaDrill?: number, placements?: Map<string, {pads?: Map<string|number, Point>}>}} AutorouterAdapterOptions */

/**
 * @param {AutorouterRouteResult|null|undefined} routeResult
 * @param {AutorouterAdapterOptions} [opts]
 * @returns {{tracks: Track[], vias: Via[]}}
 */
export function tracksFromAutorouterResult(routeResult, opts = {}) {
    /** @type {Track[]} */
    const tracks = [];
    /** @type {Via[]} */
    const vias = [];

    const optTrackWidth = opts.trackWidth;
    const optViaDiameter = opts.viaDiameter;
    const optViaDrill = opts.viaDrill;
    const trackWidth = typeof optTrackWidth === 'number' && Number.isFinite(optTrackWidth) && optTrackWidth > 0 ? optTrackWidth : 0.2;
    const viaDiameter = typeof optViaDiameter === 'number' && Number.isFinite(optViaDiameter) && optViaDiameter > 0 ? optViaDiameter : 0.6;
    const viaDrill = typeof optViaDrill === 'number' && Number.isFinite(optViaDrill) && optViaDrill > 0 ? optViaDrill : 0.3;

    // Build a position→pad lookup so we can re-attach endpoints to
    // component pads. Keyed by rounded (x,y) to absorb fp arithmetic.
    /** @type {Map<string, PadRef>} */
    const padByPos = new Map();
    if (opts.placements instanceof Map) {
        for (const [componentId, pl] of opts.placements) {
            if (!pl?.pads) continue;
            for (const [pinNumber, pos] of pl.pads) {
                padByPos.set(_posKey(pos.x, pos.y), { componentId, pinNumber });
            }
        }
    } else if (opts.placements !== undefined) {
        // Common mistake: passing a plain object instead of a Map. Without
        // placements, tracks won't link back to component pads — the user
        // will see "orphan" tracks that don't follow component drags.
        console.warn('tracksFromAutorouterResult: opts.placements must be a Map; pads will not link to components');
    }

    const sourceTracks = Array.isArray(routeResult?.tracks) ? routeResult.tracks : [];
    const sourceVias = Array.isArray(routeResult?.vias) ? routeResult.vias : [];

    // Dedupe vias by position (rounded to 4dp) so the per-track .vias arrays
    // and top-level .vias array don't produce duplicates.
    const viaSeen = new Set();
    /** @param {number} x @param {number} y */
    const key = (x, y) => `${Math.round(x * 10000)},${Math.round(y * 10000)}`;

    for (const track of sourceTracks) {
        if (!track || !Array.isArray(track.points) || track.points.length < 2) continue;

        const layerId = track.layer === 'bottom' ? 'bottom-copper' : 'top-copper';
        const modelTrack = _buildSingleLayerTrack({
            net: track.net || '',
            width: trackWidth,
            layer: layerId,
            points: track.points,
            padByPos,
        });
        if (modelTrack) tracks.push(modelTrack);
    }

    // Top-level master via list first (preferred — already deduplicated by
    // the autorouter). Then any per-track vias the adapter sees as a
    // fallback, in case the caller passed a partial result without the
    // top-level array (e.g. incremental progress messages).
    for (const v of sourceVias) {
        const k = key(v.x, v.y);
        if (viaSeen.has(k)) continue;
        viaSeen.add(k);
        vias.push(new Via({
            x: v.x,
            y: v.y,
            diameter: viaDiameter,
            drill: viaDrill,
            net: v.net || '',
        }));
    }
    for (const track of sourceTracks) {
        if (!Array.isArray(track?.vias)) continue;
        for (const v of track.vias) {
            const k = key(v.x, v.y);
            if (viaSeen.has(k)) continue;
            viaSeen.add(k);
            vias.push(new Via({
                x: v.x,
                y: v.y,
                diameter: viaDiameter,
                drill: viaDrill,
                net: track.net || '',
            }));
        }
    }

    return { tracks, vias };
}

/** @param {number} x @param {number} y */
function _posKey(x, y) {
    // 0.01 mm grid — generous enough to absorb router rounding without
    // colliding distinct pads.
    return `${Math.round(x * 100)},${Math.round(y * 100)}`;
}

/**
 * Build a single Track from a polyline. Nodes are issued sequentially
 * n0..n(N-1); edges e0..e(N-2). All edges land on the same layer.
 *
 * @param {{net: string, width: number, layer: string, points: Point[], padByPos: Map<string, PadRef>}} options
 * @returns {Track|null}
 */
function _buildSingleLayerTrack({ net, width, layer, points, padByPos }) {
    if (!Array.isArray(points) || points.length < 2) return null;

    /** @type {Record<string, Point>} */
    const graphNodes = {};
    /** @type {Record<string, {from: string, to: string}>} */
    const graphEdges = {};
    /** @type {Record<string, string>} */
    const edgeLayers = {};
    /** @type {Record<string, PadRef>} */
    const padConnections = {};
    for (let i = 0; i < points.length; i++) {
        graphNodes[`n${i}`] = { x: points[i].x, y: points[i].y };
        if (padByPos) {
            const pad = padByPos.get(_posKey(points[i].x, points[i].y));
            if (pad) padConnections[`n${i}`] = { ...pad };
        }
    }
    for (let i = 0; i < points.length - 1; i++) {
        graphEdges[`e${i}`] = { from: `n${i}`, to: `n${i + 1}` };
        edgeLayers[`e${i}`] = layer;
    }

    return new Track({
        net,
        width,
        layer,
        graphNodes,
        graphEdges,
        edgeLayers,
        padConnections,
    });
}
