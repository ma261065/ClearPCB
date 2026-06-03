// @ts-nocheck — JSDoc partial types and runtime type narrowing not expressible to TS
import {
    astarProbe,
    astarRoute,
    CongestionGrid,
    fixAngles,
    insertCopperObstacles,
    isValidAngle,
    optimizePath,
    sanitizeAngles,
    simplifyPath,
    SpatialHash
} from './autorouter-common.js';

// ── Main Router ───────────────────────────────────────────────────

/**
 * Route all connections with rip-up-and-reroute.
 *
 * Algorithm (inspired by Freerouting):
 * 1. Route all nets shortest-first
 * 2. For each failed net, find which routed traces block it
 * 3. Rip up the blocking traces
 * 4. Route the previously-failed net
 * 5. Re-route the ripped-up nets
 * 6. Repeat for up to MAX_PASSES
 *
 * @param {RouteInput} input
 * @param {object} [options]
 * @param {function(number, number, string, object=): void} [options.onProgress] - (completed, total, netName, meta)
 * @param {function(Array): void} [options.onNetRouted] - called with trace segments after each net is routed
 * @param {function(object): void} [options.onNetFailed] - called with the connection object when a net fails
 * @param {function(object, object): void} [options.onTrying] - called with (fromPad, toPad) before each routing attempt
 * @param {function(string, number): void} [options.onNetPendingChanged] - called with (netName, pendingConnections)
 * @param {{cancelled: boolean}} [options.cancelToken] - set .cancelled = true to abort
 * @param {number} [options.maxPasses=4] - max rip-up passes for routing
 * @param {object|null} [options.profileOverrides=null] - optional per-phase attempt tuning overrides
 * @returns {Promise<RouteResult>}
 */
export async function routeAll(input, options = {}) {
     const {
        onProgress,
        onNetRouted,
        onNetFailed,
        onConnRipped,
        onTrying,
        onNetPendingChanged,
        cancelToken,
        maxPasses = 4,
        profileOverrides = null,
    } = options;
    /**
     * Yield strategy:
     * - Visible tab (main thread): macrotask yield lets the UI repaint and process clicks.
     * - Hidden/unfocused tab (main thread): skip the yield — setTimeout in a background
     *   page is throttled hard (Chrome's "Intensive Wake Up Throttling" clamps it to 1Hz),
     *   so a setTimeout-based yield would freeze routing for ~1s per call.
     * - Worker context: use a MessageChannel-based yield. This drains the worker's task
     *   queue (so a `cancel` postMessage can be observed) but is NOT subject to the 4ms
     *   nested-setTimeout clamp or to Chrome's intensive throttling on background pages
     *   — both of which were turning maze routing into a 1-3 minute slog on the
     *   GitHub Pages tab when the browser window wasn't in the foreground.
     */
    const yieldToUI = (() => {
        if (typeof document !== 'undefined') {
            return () => {
                if (document.visibilityState === 'visible') {
                    return new Promise(r => setTimeout(r, 0));
                }
                return Promise.resolve();
            };
        }

        // Worker / non-DOM environments: prefer MessageChannel over setTimeout(0).
        // MessageChannel postMessage schedules a task on the worker's task queue with
        // no minimum-delay clamping, so it drains pending messages (e.g. cancel signals)
        // without incurring the 4ms / 1s throttle that setTimeout(0) is subject to.
        if (typeof MessageChannel === 'function') {
            const channel = new MessageChannel();
            const waiters = [];
            channel.port1.onmessage = () => {
                const r = waiters.shift();
                if (r) r();
            };
            return () => new Promise(r => {
                waiters.push(r);
                channel.port2.postMessage(0);
            });
        }

        if (typeof setTimeout === 'function') {
            return () => new Promise(r => setTimeout(r, 0));
        }

        return () => Promise.resolve();
    })();
    // Routing parameters are required — there is no sensible global default
    // for clearance/traceWidth/viaDiameter/gridStep. Callers must supply them
    // (UI provides values from #pcbClearance / #pcbTrackWidth / etc.).
    const requirePositive = (name, value) => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
            throw new Error(`routeAll: input.${name} must be a positive number, got ${value}`);
        }
        return value;
    };
    const traceWidth = requirePositive('traceWidth', input.traceWidth);
    const clearance = requirePositive('clearance', input.clearance);
    const viaDiameter = requirePositive('viaDiameter', input.viaDiameter);
    const gridStep = requirePositive('gridStep', input.gridStep);
    const viaRadius = viaDiameter / 2;
    const halfTrace = traceWidth / 2;
    const totalClear = halfTrace + clearance;
    const MAX_PASSES = Math.max(1, maxPasses | 0);

    const routeBounds = input.bounds &&
        Number.isFinite(input.bounds.minX) &&
        Number.isFinite(input.bounds.minY) &&
        Number.isFinite(input.bounds.maxX) &&
        Number.isFinite(input.bounds.maxY)
        ? input.bounds
        : null;

    const cellSize = Math.max(gridStep * 4, 2.0);

    // Build pad list
    const allPads = [];
    let padId = 0;
    if (input.allObstaclePads) {
        for (const pad of input.allObstaclePads) {
            allPads.push({ ...pad, id: `pad_${padId++}` });
        }
    } else {
        for (const conn of input.connections) {
            for (const pad of conn.pads) {
                allPads.push({ ...pad, id: `pad_${padId++}` });
            }
        }
    }

    // Build net → pad ID mapping
    const layersCompatible = (a, b) => {
        const la = a || 'both';
        const lb = b || 'both';
        return la === 'both' || lb === 'both' || la === lb;
    };

    const findMatchingPad = (cpad, usedIds) => {
        let best = null;
        let bestScore = Infinity;
        for (const pad of allPads) {
            if (usedIds?.has(pad.id)) continue;
            if (Math.abs(pad.x - cpad.x) >= 0.01 || Math.abs(pad.y - cpad.y) >= 0.01) continue;

            const wDiff = Math.abs((pad.width ?? 0) - (cpad.width ?? pad.width ?? 0));
            const hDiff = Math.abs((pad.height ?? 0) - (cpad.height ?? pad.height ?? 0));
            const layerPenalty = layersCompatible(pad.layer, cpad.layer) ? 0 : 10;
            const score = layerPenalty + wDiff + hDiff;
            if (score < bestScore) {
                bestScore = score;
                best = pad;
            }
        }
        return best;
    };

    const netPadIds = new Map();
    // Per-net ordered list of pad-id groups, parallel to conn.pads.
    // Each entry is an Array<string> holding the primary pad id PLUS any
    // alternate pad ids (multi-pad pins, e.g. thermal/centre pads that share
    // a pin number across many physical pads). Used to compute skipIds for
    // an individual sub-route: only the source and destination pad groups
    // of the current segment are skipped, NOT every pad on the net.
    // (Otherwise an A→B route in a 3-pin net A,B,C would treat C as a
    //  source/dest and route straight through it.)
    /** @type {Map<string, Array<Array<string>>>} */
    const netPadIdList = new Map();
    for (const conn of input.connections) {
        /** @type {Array<Array<string>>} */
        const idList = [];
        const used = new Set();
        for (const cpad of conn.pads) {
            const ids = [];
            const primary = findMatchingPad(cpad, used);
            if (primary) { ids.push(primary.id); used.add(primary.id); }
            for (const alt of (cpad.alternates || [])) {
                const found = findMatchingPad(alt, used);
                if (found) { ids.push(found.id); used.add(found.id); }
            }
            idList.push(ids);
        }
        netPadIdList.set(conn.net, idList);
    }

    /**
     * Build a skipIds Set containing the source and destination pad IDs (and
     * any of their multi-pad alternates) for a single sub-route.
     */
    const skipIdsForPair = (netName, fromIdx, toIdx) => {
        const list = netPadIdList.get(netName);
        const ids = new Set();
        if (list) {
            for (const id of (list[fromIdx] || [])) ids.add(id);
            for (const id of (list[toIdx] || [])) ids.add(id);
        }
        return ids;
    };

    // Connection map for quick lookup.
    //
    // For each multi-pad net we attach `conn.edges` — a Euclidean MST
    // over the pads. Each edge is an [a, b] pair of indices into
    // `conn.pads` (and into the parallel `netPadIdList` group array).
    // MST guarantees planar rats-nest topology (no crossing edges in
    // the plane), shorter total length than the legacy nearest-
    // neighbour chain, and natural branching for star-topology nets.
    //
    // `conn.pads` is NOT reordered — callers index it by edge endpoints
    // (edges[k] = [fromIdx, toIdx]), so the input pad order and the
    // parallel netPadIdList stay in lock-step without any permutation
    // bookkeeping.
    const connMap = new Map();
    for (const conn of input.connections) {
        if (conn.pads.length < 2) continue;
        conn.edges = buildMstEdges(conn.pads);
        connMap.set(conn.net, conn);
    }

    /** @type {Map<string, number>} net -> unresolved connection count */
    const netPendingConnections = new Map();
    for (const [netName, conn] of connMap.entries()) {
        netPendingConnections.set(netName, Math.max(0, (conn.pads?.length || 0) - 1));
    }

    const pendingConnectionsTotal = () => {
        let total = 0;
        for (const v of netPendingConnections.values()) total += Math.max(0, v);
        return total;
    };
    /** Total connection count (computed once, never changes) */
    const totalConnectionCount = pendingConnectionsTotal();

    const pendingNetsTotal = () => {
        let total = 0;
        for (const v of netPendingConnections.values()) {
            if (v > 0) total++;
        }
        return total;
    };

    const setNetPendingConnections = (netName, pending) => {
        const safe = Math.max(0, pending | 0);
        if (!netPendingConnections.has(netName)) return;
        if (netPendingConnections.get(netName) === safe) return;
        netPendingConnections.set(netName, safe);
        onNetPendingChanged?.(netName, safe);
    };

    const emitProgress = (done, total, netName, meta = {}) => {
        onProgress?.(done, total, netName, {
            pendingConnections: pendingConnectionsTotal(),
            pendingNets: pendingNetsTotal(),
            ...meta,
        });
    };

    /** Optional route cache reused across rip-up passes. */
    const routeAttemptCache = new Map();
    let obstacleVersion = 0;
    /** Map connection ID -> owning net name (scoped to this routeAll run). */
    const connIdToNet = new Map();

    function makeConnectionId(netName, connectionIndex) {
        return `${netName}:${connectionIndex}`;
    }

    function parseConnectionId(connId) {
        if (typeof connId !== 'string') return null;
        const cut = connId.lastIndexOf(':');
        if (cut <= 0 || cut >= connId.length - 1) return null;
        const netName = connId.slice(0, cut);
        const index = Number(connId.slice(cut + 1));
        if (!Number.isInteger(index) || index < 0) return null;
        return { netName, index };
    }

    function registerConnectionId(connId, netName) {
        if (!connId) return;
        if (!netName) return;
        connIdToNet.set(connId, netName);
    }

    function getConnectionIdsForNet(netName) {
        const netConn = connMap.get(netName);
        if (!netConn || !Array.isArray(netConn.pads) || netConn.pads.length < 2) return [];
        const ids = [];
        for (let i = 0; i < netConn.pads.length - 1; i++) {
            const cid = makeConnectionId(netName, i);
            registerConnectionId(cid, netName);
            ids.push(cid);
        }
        return ids;
    }

    /**
     * Build a fresh obstacle hash and insert all pads.
     */
    function buildObstacles() {
        const obs = new SpatialHash(cellSize);
        for (const pad of allPads) {
            obs.insertPad(pad.x, pad.y, pad.width, pad.height, pad.id, pad.layer || 'both', { shape: pad.shape });
        }
        insertCopperObstacles(obs, input.copperObstacles);
        // Bump the monotonic version so cached failures from a prior
        // build are not silently considered "still valid" against the
        // new obstacle set.
        obstacleVersion++;
        return obs;
    }

    function cloneAstarResult(result) {
        return {
            path: result.path.map(p => ({ x: p.x, y: p.y, layer: p.layer })),
            vias: result.vias.map(v => ({ x: v.x, y: v.y })),
        };
    }

    function isCachedPathStillClear(path, skipIds, skipNet = null) {
        // At a layer transition we only need to verify the via copper
        // itself is clear — the arriving/leaving trace segments are
        // checked by the same-layer branch below. isBlocked(...) adds
        // the foreign obstacle's own half-extent internally, so passing
        // viaRadius+clearance enforces edge-to-edge clearance for the via.
        const viaClear = viaRadius + clearance;
        for (let i = 1; i < path.length; i++) {
            const a = path[i - 1];
            const b = path[i];
            if (a.layer === b.layer) {
                if (obstacles.isSegmentBlocked(a.x, a.y, b.x, b.y, totalClear, skipIds, a.layer, skipNet)) return false;
            } else {
                // Layer transition → via at point `a`; check both layers
                // since the via is plated through.
                if (obstacles.isBlocked(a.x, a.y, viaClear, skipIds, 'top', skipNet)) return false;
                if (obstacles.isBlocked(a.x, a.y, viaClear, skipIds, 'bottom', skipNet)) return false;
            }
        }
        return true;
    }

    function arePathSegmentsClear(pathPoints, layer, skipIds, skipNet = null) {
        if (!Array.isArray(pathPoints) || pathPoints.length < 2) return false;
        for (let i = 1; i < pathPoints.length; i++) {
            const a = pathPoints[i - 1];
            const b = pathPoints[i];
            if (!isValidAngle(a.x, a.y, b.x, b.y)) return false;
            if (obstacles.isSegmentBlocked(a.x, a.y, b.x, b.y, totalClear, skipIds, layer, skipNet)) return false;
        }
        return true;
    }

    function makeAttemptKey(from, to, startLayer, endLayer, step, weight, effortTag = '', costSig = '', skipSig = '') {
        return [
            from.x.toFixed(3), from.y.toFixed(3), from.layer || 'both',
            to.x.toFixed(3), to.y.toFixed(3), to.layer || 'both',
            startLayer, endLayer,
            step.toFixed(3), weight.toFixed(2),
            effortTag,
            costSig,
            skipSig,
            traceWidth.toFixed(3), clearance.toFixed(3),
        ].join('|');
    }

    const DEFAULT_PHASE_PROFILE = {
        id: 'initial',
        attempt1: { stepScale: 1.0, weight: 1.4, maxIter: 100000, stagnationIters: 25000, maxDetourFactor: 2.0, enabled: true, effortTag: 'i-a1', viaCostScale: 1.0, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 1.0 },
        attempt2: { stepScale: 0.5, weight: 1.2, maxIter: 300000, stagnationIters: 60000, maxDetourFactor: 3.0, enabled: true, effortTag: 'i-a2', viaCostScale: 1.0, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 1.0 },
        attempt3: { stepScale: 0.25, weight: 1.0, maxIter: 600000, stagnationIters: 120000, maxDetourFactor: 5.0, enabled: true, effortTag: 'i-a3', viaCostScale: 1.0, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 1.0 },
    };

    const RIPUP_PHASE_PROFILES = {
        1: {
            id: 'ripup-1',
            attempt1: { stepScale: 1.0, weight: 1.5, maxIter: 80000, stagnationIters: 18000, maxDetourFactor: 1.8, enabled: true, effortTag: 'r1-a1', viaCostScale: 1.0, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 1.0 },
            attempt2: { stepScale: 0.5, weight: 1.3, maxIter: 180000, stagnationIters: 35000, maxDetourFactor: 2.3, enabled: true, effortTag: 'r1-a2', viaCostScale: 1.0, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 1.0 },
            attempt3: { stepScale: 0.25, weight: 1.0, maxIter: 0, stagnationIters: 0, maxDetourFactor: 0, enabled: false, effortTag: 'r1-a3', viaCostScale: 1.0, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 1.0 },
        },
        2: {
            id: 'ripup-2',
            attempt1: { stepScale: 1.0, weight: 1.4, maxIter: 110000, stagnationIters: 25000, maxDetourFactor: 2.1, enabled: true, effortTag: 'r2-a1', viaCostScale: 0.9, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 0.9 },
            attempt2: { stepScale: 0.5, weight: 1.2, maxIter: 320000, stagnationIters: 65000, maxDetourFactor: 3.2, enabled: true, effortTag: 'r2-a2', viaCostScale: 0.9, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 0.9 },
            attempt3: { stepScale: 0.25, weight: 1.0, maxIter: 620000, stagnationIters: 125000, maxDetourFactor: 5.2, enabled: true, effortTag: 'r2-a3', viaCostScale: 0.9, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 1.0, congestionPenaltyScale: 1.0, viaCongestionScale: 0.9 },
        },
        3: {
            id: 'ripup-3',
            attempt1: { stepScale: 1.0, weight: 1.35, maxIter: 140000, stagnationIters: 32000, maxDetourFactor: 2.5, enabled: true, effortTag: 'r3-a1', viaCostScale: 0.75, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 0.9, congestionPenaltyScale: 1.0, viaCongestionScale: 0.8 },
            attempt2: { stepScale: 0.5, weight: 1.15, maxIter: 420000, stagnationIters: 85000, maxDetourFactor: 3.8, enabled: true, effortTag: 'r3-a2', viaCostScale: 0.75, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 0.9, congestionPenaltyScale: 1.0, viaCongestionScale: 0.8 },
            attempt3: { stepScale: 0.25, weight: 1.0, maxIter: 850000, stagnationIters: 170000, maxDetourFactor: 6.5, enabled: true, effortTag: 'r3-a3', viaCostScale: 0.75, bendCostScale: 1.0, padDiagCostScale: 1.0, dirPenaltyScale: 0.9, congestionPenaltyScale: 1.0, viaCongestionScale: 0.8 },
        },
        4: {
            id: 'ripup-4',
            attempt1: { stepScale: 1.0, weight: 1.3, maxIter: 180000, stagnationIters: 45000, maxDetourFactor: 3.0, enabled: true, effortTag: 'r4-a1', viaCostScale: 0.6, bendCostScale: 0.9, padDiagCostScale: 0.9, dirPenaltyScale: 0.8, congestionPenaltyScale: 1.0, viaCongestionScale: 0.7 },
            attempt2: { stepScale: 0.5, weight: 1.1, maxIter: 560000, stagnationIters: 120000, maxDetourFactor: 4.8, enabled: true, effortTag: 'r4-a2', viaCostScale: 0.6, bendCostScale: 0.9, padDiagCostScale: 0.9, dirPenaltyScale: 0.8, congestionPenaltyScale: 1.0, viaCongestionScale: 0.7 },
            attempt3: { stepScale: 0.25, weight: 1.0, maxIter: 1100000, stagnationIters: 240000, maxDetourFactor: 8.0, enabled: true, effortTag: 'r4-a3', viaCostScale: 0.6, bendCostScale: 0.9, padDiagCostScale: 0.9, dirPenaltyScale: 0.8, congestionPenaltyScale: 1.0, viaCongestionScale: 0.7 },
        },
    };

    const mergeAttempt = (base, override = null) => {
        if (!override) return { ...base };
        return {
            stepScale: Number.isFinite(override.stepScale) ? override.stepScale : base.stepScale,
            weight: Number.isFinite(override.weight) ? override.weight : base.weight,
            maxIter: Number.isFinite(override.maxIter) ? override.maxIter : base.maxIter,
            stagnationIters: Number.isFinite(override.stagnationIters) ? override.stagnationIters : base.stagnationIters,
            maxDetourFactor: Number.isFinite(override.maxDetourFactor) ? override.maxDetourFactor : base.maxDetourFactor,
            viaCostScale: Number.isFinite(override.viaCostScale) ? override.viaCostScale : base.viaCostScale,
            bendCostScale: Number.isFinite(override.bendCostScale) ? override.bendCostScale : base.bendCostScale,
            padDiagCostScale: Number.isFinite(override.padDiagCostScale) ? override.padDiagCostScale : base.padDiagCostScale,
            dirPenaltyScale: Number.isFinite(override.dirPenaltyScale) ? override.dirPenaltyScale : base.dirPenaltyScale,
            congestionPenaltyScale: Number.isFinite(override.congestionPenaltyScale) ? override.congestionPenaltyScale : base.congestionPenaltyScale,
            viaCongestionScale: Number.isFinite(override.viaCongestionScale) ? override.viaCongestionScale : base.viaCongestionScale,
            enabled: typeof override.enabled === 'boolean' ? override.enabled : base.enabled,
            effortTag: override.effortTag || base.effortTag,
        };
    };

    const mergeProfile = (base, override = null) => {
        if (!override) {
            return {
                id: base.id,
                attempt1: { ...base.attempt1 },
                attempt2: { ...base.attempt2 },
                attempt3: { ...base.attempt3 },
            };
        }
        return {
            id: override.id || base.id,
            attempt1: mergeAttempt(base.attempt1, override.attempt1),
            attempt2: mergeAttempt(base.attempt2, override.attempt2),
            attempt3: mergeAttempt(base.attempt3, override.attempt3),
        };
    };

    const tunedInitialProfile = mergeProfile(DEFAULT_PHASE_PROFILE, profileOverrides?.initial || null);
    const getRipupProfile = (pass) => {
        const base = RIPUP_PHASE_PROFILES[pass] || RIPUP_PHASE_PROFILES[4];
        const override = profileOverrides?.ripup?.[pass] || profileOverrides?.[`ripup${pass}`] || null;
        return mergeProfile(base, override);
    };

    function getCachedAttemptResult(key, skipIds, skipNet = null) {
        const entry = routeAttemptCache.get(key);
        if (!entry) return undefined;
        if (entry.successResult && isCachedPathStillClear(entry.successResult.path, skipIds, skipNet)) {
            return cloneAstarResult(entry.successResult);
        }
        if (entry.lastFailVersion === obstacleVersion) return null;
        return undefined;
    }

    function setCachedAttemptResult(key, result) {
        const entry = routeAttemptCache.get(key) || {};
        if (result) {
            entry.successResult = cloneAstarResult(result);
            entry.lastFailVersion = null;
        } else {
            entry.lastFailVersion = obstacleVersion;
        }
        routeAttemptCache.set(key, entry);
    }

    /**
     * Route a single net. Returns {traces, failedCount}.
     * Bails on first failed connection (ghost traces remain as reservations).
     */
    async function routeNet(conn, obstacles, skipIds, phaseProfile = DEFAULT_PHASE_PROFILE, connIndexBase = 0) {
        const traces = [];
        const totalConns = Math.max(0, conn.pads.length - 1);
        const a1 = phaseProfile.attempt1 || DEFAULT_PHASE_PROFILE.attempt1;
        const a2 = phaseProfile.attempt2 || DEFAULT_PHASE_PROFILE.attempt2;
        const a3 = phaseProfile.attempt3 || DEFAULT_PHASE_PROFILE.attempt3;
        for (let i = 0; i < conn.pads.length - 1; i++) {
            const connId = makeConnectionId(conn.net, connIndexBase + i);
            registerConnectionId(connId, conn.net);
            const from = conn.pads[i];
            const to = conn.pads[i + 1];

            // Determine which layers each pad is on
            const fromLayer = from.layer || 'top';  // 'top', 'bottom', or 'both'
            const toLayer = to.layer || 'top';

            // Find a common layer for direct routing
            const commonLayers = [];
            if ((fromLayer === 'top' || fromLayer === 'both') &&
                (toLayer === 'top' || toLayer === 'both')) commonLayers.push('top');
            if ((fromLayer === 'bottom' || fromLayer === 'both') &&
                (toLayer === 'bottom' || toLayer === 'both')) commonLayers.push('bottom');

            // Try direct line on each common layer
            let routed = false;
            for (const layer of commonLayers) {
                if (isValidAngle(from.x, from.y, to.x, to.y) &&
                    !obstacles.isSegmentBlocked(from.x, from.y, to.x, to.y, totalClear, skipIds, layer, conn.net)) {
                    traces.push({ net: conn.net, points: [
                        { x: from.x, y: from.y, layer },
                        { x: to.x, y: to.y, layer }
                    ], layer, vias: [], connId });
                    obstacles.insert(from.x, from.y, to.x, to.y, halfTrace, conn.net, layer, connId);
                    obstacleVersion++;
                    routed = true;
                    break;
                }
                // Try sanitized 2-segment path (45°+H/V) if direct angle is invalid
                if (!isValidAngle(from.x, from.y, to.x, to.y)) {
                    const cleanPts = sanitizeAngles([
                        { x: from.x, y: from.y, layer },
                        { x: to.x, y: to.y, layer }
                    ]);
                    if (arePathSegmentsClear(cleanPts, layer, skipIds, conn.net)) {
                        traces.push({ net: conn.net, points: cleanPts, layer, vias: [], connId });
                        for (let k = 0; k < cleanPts.length - 1; k++) {
                            obstacles.insert(cleanPts[k].x, cleanPts[k].y, cleanPts[k+1].x, cleanPts[k+1].y, halfTrace, conn.net, layer, connId);
                        }
                        obstacleVersion++;
                        routed = true;
                        break;
                    }
                }
            }
            if (routed) continue;

            // A* with via support — try starting on each viable layer.
            // For long routes (>40mm), also try the opposite layer so A* can
            // route via→bottom→via paths through uncongested space.
            const routeLen = Math.hypot(to.x - from.x, to.y - from.y);
            const nativeLayers = fromLayer === 'both' ? ['top', 'bottom'] : [fromLayer];
            const oppositeLayers = routeLen > 40 ? (fromLayer === 'top' ? ['bottom'] : fromLayer === 'bottom' ? ['top'] : []) : [];
            const startLayers = [...nativeLayers, ...oppositeLayers];
            const endLayer = toLayer;  // pass dest pad layer so A* only accepts valid arrival
            let result = null;

            for (const startLayer of startLayers) {
                if (cancelToken?.cancelled) break;
                // Show the connection being attempted
                onTrying?.(from, to);
                await yieldToUI();

                // Try 1: normal grid — fail fast (100K)
                let lastTryingTick = 0;
                const throttledTryingTick = () => {
                    const now = (typeof performance !== 'undefined' && performance.now)
                        ? performance.now()
                        : Date.now();
                    if (now - lastTryingTick >= 400) {
                        onTrying?.(from, to);
                        lastTryingTick = now;
                    }
                };

                const a1CostSig = [a1.viaCostScale, a1.bendCostScale, a1.padDiagCostScale, a1.dirPenaltyScale, a1.congestionPenaltyScale, a1.viaCongestionScale].map(v => Number(v ?? 1).toFixed(2)).join(':');
                const attempt1Key = makeAttemptKey(from, to, startLayer, endLayer, gridStep * a1.stepScale, a1.weight, a1.effortTag || `${phaseProfile.id}:a1`, a1CostSig, connId);
                const cached1 = getCachedAttemptResult(attempt1Key, skipIds, conn.net);
                if (cached1 !== undefined) {
                    result = cached1;
                } else {
                    result = await astarRoute(
                    from.x, from.y, to.x, to.y,
                    obstacles, skipIds, gridStep * a1.stepScale, traceWidth, clearance,
                    a1.weight, true, startLayer, endLayer,
                    {
                        maxIter: a1.maxIter,
                        stagnationIters: a1.stagnationIters,
                        cancelToken,
                        yieldToUI,
                        onTick: throttledTryingTick,
                        maxDetourFactor: a1.maxDetourFactor,
                        bounds: routeBounds,
                        viaCostScale: a1.viaCostScale,
                        bendCostScale: a1.bendCostScale,
                        padDiagCostScale: a1.padDiagCostScale,
                        dirPenaltyScale: a1.dirPenaltyScale,
                        congestionPenaltyScale: a1.congestionPenaltyScale,
                        viaCongestionScale: a1.viaCongestionScale,
                        congestionGrid: activeCongestionGrid,
                        historyWeight: activeHistoryWeight,
                        routingNet: conn.net,
                        viaRadius,
                        startPad: from,
                        endPad: to,
                    }
                    );
                    setCachedAttemptResult(attempt1Key, result);
                }
                if (result) break;

                onTrying?.(from, to);
                await yieldToUI();
                const a2CostSig = [a2.viaCostScale, a2.bendCostScale, a2.padDiagCostScale, a2.dirPenaltyScale, a2.congestionPenaltyScale, a2.viaCongestionScale].map(v => Number(v ?? 1).toFixed(2)).join(':');
                const attempt2Key = makeAttemptKey(from, to, startLayer, endLayer, gridStep * a2.stepScale, a2.weight, a2.effortTag || `${phaseProfile.id}:a2`, a2CostSig, connId);
                const cached2 = getCachedAttemptResult(attempt2Key, skipIds, conn.net);
                if (cached2 !== undefined) {
                    result = cached2;
                } else {
                    result = await astarRoute(
                    from.x, from.y, to.x, to.y,
                    obstacles, skipIds, gridStep * a2.stepScale, traceWidth, clearance,
                    a2.weight, true, startLayer, endLayer,
                    {
                        maxIter: a2.maxIter,
                        stagnationIters: a2.stagnationIters,
                        cancelToken,
                        yieldToUI,
                        onTick: throttledTryingTick,
                        maxDetourFactor: a2.maxDetourFactor,
                        bounds: routeBounds,
                        viaCostScale: a2.viaCostScale,
                        bendCostScale: a2.bendCostScale,
                        padDiagCostScale: a2.padDiagCostScale,
                        dirPenaltyScale: a2.dirPenaltyScale,
                        congestionPenaltyScale: a2.congestionPenaltyScale,
                        viaCongestionScale: a2.viaCongestionScale,
                        congestionGrid: activeCongestionGrid,
                        historyWeight: activeHistoryWeight,
                        routingNet: conn.net,
                        viaRadius,
                        startPad: from,
                        endPad: to,
                    }
                    );
                    setCachedAttemptResult(attempt2Key, result);
                }
                if (result) break;

                if (!a3.enabled) continue;

                onTrying?.(from, to);
                await yieldToUI();

                // Try 3: finest grid, thorough search (600K)
                const a3CostSig = [a3.viaCostScale, a3.bendCostScale, a3.padDiagCostScale, a3.dirPenaltyScale, a3.congestionPenaltyScale, a3.viaCongestionScale].map(v => Number(v ?? 1).toFixed(2)).join(':');
                const attempt3Key = makeAttemptKey(from, to, startLayer, endLayer, gridStep * a3.stepScale, a3.weight, a3.effortTag || `${phaseProfile.id}:a3`, a3CostSig, connId);
                const cached3 = getCachedAttemptResult(attempt3Key, skipIds, conn.net);
                if (cached3 !== undefined) {
                    result = cached3;
                } else {
                    result = await astarRoute(
                    from.x, from.y, to.x, to.y,
                    obstacles, skipIds, gridStep * a3.stepScale, traceWidth, clearance,
                    a3.weight, true, startLayer, endLayer,
                    {
                        maxIter: a3.maxIter,
                        stagnationIters: a3.stagnationIters,
                        cancelToken,
                        yieldToUI,
                        onTick: throttledTryingTick,
                        maxDetourFactor: a3.maxDetourFactor,
                        bounds: routeBounds,
                        viaCostScale: a3.viaCostScale,
                        bendCostScale: a3.bendCostScale,
                        padDiagCostScale: a3.padDiagCostScale,
                        dirPenaltyScale: a3.dirPenaltyScale,
                        congestionPenaltyScale: a3.congestionPenaltyScale,
                        viaCongestionScale: a3.viaCongestionScale,
                        congestionGrid: activeCongestionGrid,
                        historyWeight: activeHistoryWeight,
                        routingNet: conn.net,
                        viaRadius,
                        startPad: from,
                        endPad: to,
                    }
                    );
                    setCachedAttemptResult(attempt3Key, result);
                }
                if (result) break;
            }

            if (result) {
                const rawSimplified = simplifyPath(result.path, obstacles, skipIds, totalClear, conn.net);
                const fixed = fixAngles(rawSimplified);
                const simplified = fixAngles(optimizePath(fixed, obstacles, skipIds, totalClear, conn.net));
                // Detect vias directly from the simplified path — wherever
                // the layer changes between consecutive points, place a via
                const detectedVias = [];
                for (let s = 1; s < simplified.length; s++) {
                    if (simplified[s].layer !== simplified[s-1].layer) {
                        detectedVias.push({ x: simplified[s].x, y: simplified[s].y });
                    }
                }

                // Split path into strictly single-layer runs and validate
                // EVERY run before inserting anything. If any run would create
                // a foreign-clearance violation, treat the entire connection
                // as failed (atomic: no partial trace insertion).
                const runs = [];
                {
                    let runStart = 0;
                    const collectRun = (runEnd) => {
                        const segPts = simplified.slice(runStart, runEnd + 1);
                        const layer = simplified[runStart].layer || 'top';
                        if (segPts.length < 2) return;
                        const sanitizedPts = sanitizeAngles(segPts);
                        const cleanPts = arePathSegmentsClear(sanitizedPts, layer, skipIds, conn.net)
                            ? sanitizedPts
                            : segPts;
                        runs.push({ cleanPts, layer });
                    };
                    for (let s = 1; s < simplified.length; s++) {
                        if (simplified[s].layer !== simplified[s - 1].layer) {
                            collectRun(s - 1);
                            runStart = s;
                        }
                    }
                    collectRun(simplified.length - 1);
                }

                // Per-segment clearance gate. The simplifier/sanitizer/optimizer
                // can collapse a clear A* path into a long segment that crosses
                // foreign copper. Own-net pads are filtered via skipIds inside
                // isSegmentBlocked, so any failure here is a foreign-obstacle
                // violation and cannot be exempted.
                const allRunsClear = runs.every(({ cleanPts, layer }) => {
                    if (cleanPts.length < 2) return false;
                    for (let i = 1; i < cleanPts.length; i++) {
                        const a = cleanPts[i - 1];
                        const b = cleanPts[i];
                        if (!isValidAngle(a.x, a.y, b.x, b.y)) return false;
                        if (obstacles.isSegmentBlocked(a.x, a.y, b.x, b.y, totalClear, skipIds, layer, conn.net)) return false;
                    }
                    return true;
                });

                if (!allRunsClear) {
                    // Drop this connection — the post-processed path is not
                    // DRC-clean. Surface as a routing failure so rip-up can try.
                    const failedCount = totalConns - i;
                    return { traces, failedCount, firstFailedIndex: i };
                }

                for (const { cleanPts, layer } of runs) {
                    traces.push({ net: conn.net, points: cleanPts, layer, vias: [], connId });
                    for (let k = 0; k < cleanPts.length - 1; k++) {
                        obstacles.insert(cleanPts[k].x, cleanPts[k].y, cleanPts[k+1].x, cleanPts[k+1].y,
                            halfTrace, conn.net, layer, connId);
                    }
                    obstacleVersion++;
                }
                // Attach detected vias to the last trace segment
                if (detectedVias.length > 0 && traces.length > 0) {
                    traces[traces.length - 1].vias = detectedVias;
                }

                // Register vias as obstacles so future nets avoid them.
                // Vias are circular copper, so insert as ellipse with hw==hh
                // (router treats this as exact circle distance, not AABB).
                const viaDia = viaDiameter;
                for (const v of detectedVias) {
                    obstacles.insertPad(v.x, v.y, viaDia, viaDia, conn.net, 'both',
                        { isVia: true, connId, shape: 'ellipse' });
                }
                if (detectedVias.length > 0) obstacleVersion++;
            } else {
                // Failed — earlier connections remain as ghost obstacles (reservation).
                // Count this + all remaining connections as failed.
                const failedCount = totalConns - i;
                return { traces, failedCount, firstFailedIndex: i };
            }
        }
        return { traces, failedCount: 0, firstFailedIndex: -1 };
    }

    // ── Pass 1: Initial routing (hardest nets first) ─────────────
    // Order by netDifficultyScore = manhattan + pinCount + localCrowd, so
    // long / many-pin / congested nets get first pick of routing space
    // before short nets fill up the easy channels.

    const baseObstacles = buildObstacles();

    function netDifficultyScore(conn) {
        const manhattan = netManhattan(conn);
        const pads = conn.pads || [];
        if (!pads.length) return manhattan;
        let localCrowd = 0;
        for (const p of pads) {
            localCrowd += baseObstacles.localDensity(p.x, p.y, null, p.layer || null, 1);
        }
        localCrowd /= pads.length;
        const pinCountPenalty = pads.length * 5;
        return manhattan + pinCountPenalty + localCrowd * Math.max(gridStep, 0.5);
    }

    const scoredNets = [...connMap.values()].map(conn => ({
        conn,
        score: netDifficultyScore(conn),
    }));
    scoredNets.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;  // longest/hardest first
        return String(a.conn.net || '').localeCompare(String(b.conn.net || ''));
    });
    const sorted = scoredNets.map(item => item.conn);

    let obstacles = buildObstacles();
    /** @type {Map<string, Array>} net → traces */
    const routedTraces = new Map();
    /** @type {Array<string>} failed connection IDs (e.g. "Net0005:0") */
    const failedConnIds = [];
    /** Negotiated congestion state — accessed by routeNet closure */
    let activeCongestionGrid = null;
    let activeHistoryWeight = 0;
    let ripupProbeMissCount = 0;
    let ripupConnFallbackCount = 0;
    let ripupCompatibilityFallbackCount = 0;
    let ripupBlockersFromProbeCount = 0;
    let ripupBlockersFromConnFallbackCount = 0;
    let ripupBlockersFromCompatibilityFallbackCount = 0;
    let connectionOnlyRerouteAttempts = 0;
    let connectionOnlyRerouteFallbacksToNet = 0;
    let connectionOnlyFailAstarNoPathCount = 0;
    /** @type {Map<string, number>} */
    const connectionOnlyNoPathByConnId = new Map();
    /** @type {Map<string, Map<string, {count: number, kind: string, net: string|null, connId: string|null, obstacleId: string|null}>>} */
    const connectionOnlyNoPathBlockerByConnId = new Map();

    const recordNoPathBlocker = (failedConnId, blocker) => {
        const b = blocker || { kind: 'unknown', net: null, connId: null, obstacleId: null };
        const sig = `${b.kind}|${b.net || ''}|${b.connId || ''}|${b.obstacleId || ''}`;
        let bucket = connectionOnlyNoPathBlockerByConnId.get(failedConnId);
        if (!bucket) {
            bucket = new Map();
            connectionOnlyNoPathBlockerByConnId.set(failedConnId, bucket);
        }
        const prev = bucket.get(sig);
        if (prev) {
            prev.count++;
        } else {
            bucket.set(sig, {
                count: 1,
                kind: b.kind,
                net: b.net || null,
                connId: b.connId || null,
                obstacleId: b.obstacleId || null,
            });
        }
    };

    const addBlockingConnIds = (targetSet, connIds) => {
        let added = 0;
        for (const cid of connIds) {
            if (!targetSet.has(cid)) {
                targetSet.add(cid);
                added++;
            }
        }
        return added;
    };

    const cloneNetTraces = (netTraces) => netTraces.map(t => ({
        ...t,
        points: (t.points || []).map(p => ({ x: p.x, y: p.y, layer: p.layer })),
        vias: (t.vias || []).map(v => ({ x: v.x, y: v.y })),
    }));

    /** @type {Map<string, Array>} best net → traces snapshot */
    let bestRoutedTraces = new Map();
    let bestRoutedConnCount = 0;

    const captureBestIfImproved = () => {
        // Count actual routed connections by counting unique connIds in routedTraces
        let routedConnCount = 0;
        for (const [, netTraces] of routedTraces) {
            const connIds = new Set();
            for (const t of netTraces) {
                if (t.connId) connIds.add(t.connId);
            }
            routedConnCount += connIds.size;
        }
        if (routedConnCount <= bestRoutedConnCount) return;
        bestRoutedConnCount = routedConnCount;
        bestRoutedTraces = new Map();
        for (const [netName, netTraces] of routedTraces.entries()) {
            bestRoutedTraces.set(netName, cloneNetTraces(netTraces));
        }
    };

    // ── Pass 1: Initial routing (per-connection, hardest first) ──
    // Flatten all nets into individual sub-connections (one per MST edge)
    // and score each one.
    const allConnections = [];
    /** @type {Map<string, {net: string, from: {x:number,y:number}, to: {x:number,y:number}}>} */
    const connIdToPads = new Map();
    for (const conn of sorted) {
        const edges = conn.edges || defaultChainEdges(conn.pads.length);
        for (let ci = 0; ci < edges.length; ci++) {
            const [a, b] = edges[ci];
            const from = conn.pads[a];
            const to = conn.pads[b];
            const manhattan = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
            const localCrowd = (baseObstacles.localDensity(from.x, from.y, null, from.layer || null, 1)
                              + baseObstacles.localDensity(to.x, to.y, null, to.layer || null, 1)) / 2;
            const score = manhattan + localCrowd * Math.max(gridStep, 0.5);
            allConnections.push({ conn, connIdx: ci, fromIdx: a, toIdx: b, from, to, score });
        }
    }
    allConnections.sort((a, b) => {
        if (a.score !== b.score) return b.score - a.score;  // hardest first
        const cmp = String(a.conn.net || '').localeCompare(String(b.conn.net || ''));
        if (cmp !== 0) return cmp;
        return a.connIdx - b.connIdx;
    });
    const totalConns = allConnections.length;
    let completedConns = 0;

    for (const item of allConnections) {
        if (cancelToken?.cancelled) break;
        const { conn, connIdx, fromIdx, toIdx } = item;
        const connId = makeConnectionId(conn.net, connIdx);
        connIdToPads.set(connId, { net: conn.net, from: conn.pads[fromIdx], to: conn.pads[toIdx] });
        emitProgress(completedConns, totalConns, conn.net, { phase: 'initial', pendingConnections: pendingConnectionsTotal() });
        await yieldToUI();

        const skipIds = skipIdsForPair(conn.net, fromIdx, toIdx);
        const miniConn = { net: conn.net, pads: [conn.pads[fromIdx], conn.pads[toIdx]] };
        const result = await routeNet(miniConn, obstacles, skipIds, tunedInitialProfile, connIdx);

        if (result.traces.length > 0) {
            const existing = routedTraces.get(conn.net) || [];
            routedTraces.set(conn.net, existing.concat(result.traces));
            // Decrement pending by 1 for this successful connection
            const prev = netPendingConnections.get(conn.net) || 0;
            setNetPendingConnections(conn.net, Math.max(0, prev - 1));
            captureBestIfImproved();
            onNetRouted?.(result.traces);
        } else {
            failedConnIds.push(makeConnectionId(conn.net, connIdx));
            onNetFailed?.(conn);
        }
        completedConns++;
    }

    // ── Passes 2+: Rip-up-and-reroute ────────────────────────────

    // Build congestion grid from routed traces + failed connection demand
    const rebuildCongestionGrid = () => {
        const cg = new CongestionGrid(gridStep * 4);
        for (const [, netTraces] of routedTraces) {
            for (const t of netTraces) {
                const pts = t.points;
                if (!pts || pts.length < 2) continue;
                for (let i = 0; i < pts.length - 1; i++) {
                    cg.recordSegment(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, t.net);
                }
            }
        }
        // Record demand from failed connections so A* avoids their corridors
        for (const cid of failedConnIds) {
            const parsed = parseConnectionId(cid);
            if (!parsed) continue;
            const conn = connMap.get(parsed.netName);
            if (!conn) continue;
            const edges = conn.edges || defaultChainEdges(conn.pads.length);
            if (parsed.index >= edges.length) continue;
            const [a, b] = edges[parsed.index];
            const from = conn.pads[a];
            const to = conn.pads[b];
            cg.recordDemandLine(from.x, from.y, to.x, to.y, parsed.netName);
        }
        return cg;
    };

    for (let pass = 1; pass <= MAX_PASSES && failedConnIds.length > 0; pass++) {
        if (cancelToken?.cancelled) break;
        const passProfile = getRipupProfile(pass);
        routeAttemptCache.clear();

        // Activate negotiated congestion: increase weight each pass
        activeCongestionGrid = rebuildCongestionGrid();
        activeHistoryWeight = 0.3 * pass;

        const passTotal = Math.max(1, failedConnIds.length);
        let passDone = 0;
        emitProgress(passDone, passTotal, `Rip-up pass ${pass}`, {
            phase: 'ripup',
            ripupDone: passDone,
            ripupTotal: passTotal,
            ripupPass: pass,
            ripupMaxPasses: MAX_PASSES,
            pendingConnections: pendingConnectionsTotal(),
        });
        await yieldToUI();
        const stillFailed = [];
        // Parallel Set tracks membership in O(1); preserves insertion order via the array.
        const stillFailedSet = new Set();
        const addStillFailed = (cid) => {
            if (!stillFailedSet.has(cid)) {
                stillFailedSet.add(cid);
                stillFailed.push(cid);
            }
        };

        for (const failedCid of failedConnIds) {
            if (cancelToken?.cancelled) break;
            const parsed = parseConnectionId(failedCid);
            if (!parsed) continue;
            const { netName: failedNet, index: failedConnIdx } = parsed;
            const conn = connMap.get(failedNet);
            if (!conn) continue;
            const failedEdges = conn.edges || defaultChainEdges(conn.pads.length);
            if (failedConnIdx >= failedEdges.length) continue;
            const [failedFromIdx, failedToIdx] = failedEdges[failedConnIdx];

            emitProgress(passDone, passTotal, `Rip-up ${pass}: ${failedCid}`, {
                phase: 'ripup',
                ripupDone: passDone,
                ripupTotal: passTotal,
                ripupPass: pass,
                ripupMaxPasses: MAX_PASSES,
                pendingConnections: pendingConnectionsTotal(),
            });
            await yieldToUI();

            // Cost-based rip-up: probe only the specific failed connection
            const skipIds = skipIdsForPair(failedNet, failedFromIdx, failedToIdx);
            const blockingConnIds = new Set();

            {
                const from = conn.pads[failedFromIdx];
                const to = conn.pads[failedToIdx];
                const fromLayer = from.layer || 'top';
                const startLayers = fromLayer === 'both' ? ['top', 'bottom'] : [fromLayer];
                const endLayer = to.layer || 'top';

                let bestCrossed = null;
                for (const sl of startLayers) {
                    const crossed = await astarProbe(
                        from.x, from.y, to.x, to.y,
                        obstacles, skipIds, gridStep, traceWidth, clearance,
                        sl, endLayer,
                        { cancelToken, yieldToUI, bounds: routeBounds, routingNet: conn.net }
                    );
                    if (crossed !== null) {
                        if (bestCrossed === null || crossed.size < bestCrossed.size) {
                            bestCrossed = crossed;
                        }
                    }
                }

                if (bestCrossed) {
                    ripupBlockersFromProbeCount += addBlockingConnIds(blockingConnIds, bestCrossed);
                } else {
                    ripupProbeMissCount++;
                    const directConnBlockers = obstacles.findBlockingConnIds(from.x, from.y, to.x, to.y, totalClear, skipIds);
                    if (directConnBlockers.size > 0) {
                        ripupConnFallbackCount++;
                        ripupBlockersFromConnFallbackCount += addBlockingConnIds(blockingConnIds, directConnBlockers);
                    } else {
                        ripupCompatibilityFallbackCount++;
                        const directBlockers = obstacles.findBlockingNets(from.x, from.y, to.x, to.y, totalClear, skipIds);
                        const compatibilityConnIds = new Set();
                        for (const b of directBlockers) {
                            for (const blockerConnId of getConnectionIdsForNet(b)) {
                                compatibilityConnIds.add(blockerConnId);
                            }
                        }
                        ripupBlockersFromCompatibilityFallbackCount += addBlockingConnIds(blockingConnIds, compatibilityConnIds);
                    }
                }
            }

            if (blockingConnIds.size === 0) {
                // No trace obstacles — just pads in the way, can't help
                addStillFailed(failedCid);
                passDone++;
                emitProgress(passDone, passTotal, `Rip-up ${pass}: ${failedCid}`, {
                    phase: 'ripup',
                    ripupDone: passDone,
                    ripupTotal: passTotal,
                    ripupPass: pass,
                    ripupMaxPasses: MAX_PASSES,
                    pendingConnections: pendingConnectionsTotal(),
                });
                continue;
            }

            // Rip only the specific blocking connections
            // Remove only the specific blocking connection obstacles (surgical)
            for (const cid of [...blockingConnIds].sort()) {
                const ownerNet = connIdToNet.get(cid) || parseConnectionId(cid)?.netName || null;
                if (ownerNet && routedTraces.has(ownerNet)) {
                    const existing = routedTraces.get(ownerNet) || [];
                    const hadTrace = existing.some(t => t.connId === cid);
                    routedTraces.set(ownerNet, existing.filter(t => t.connId !== cid));
                    if (hadTrace) {
                        const prev = netPendingConnections.get(ownerNet) || 0;
                        setNetPendingConnections(ownerNet, prev + 1);
                    }
                }
                obstacles.removeConnection(cid);
                obstacleVersion++;
                onConnRipped?.(cid);
            }

            // Route only the specific failed connection (not the full net)
            obstacles.removeConnection(failedCid);
            obstacleVersion++;
            onConnRipped?.(failedCid);
            if (routedTraces.has(failedNet)) {
                const existing = routedTraces.get(failedNet) || [];
                const hadTrace = existing.some(t => t.connId === failedCid);
                const filtered = existing.filter(t => t.connId !== failedCid);
                routedTraces.set(failedNet, filtered);
                if (hadTrace) {
                    const prev = netPendingConnections.get(failedNet) || 0;
                    setNetPendingConnections(failedNet, prev + 1);
                }
            }

            const miniConn = { net: failedNet, pads: [conn.pads[failedFromIdx], conn.pads[failedToIdx]] };
            const result = await routeNet(miniConn, obstacles, skipIds, passProfile, failedConnIdx);
            if (result.traces.length > 0) {
                const existing = routedTraces.get(failedNet) || [];
                routedTraces.set(failedNet, existing.concat(result.traces));
                const prev = netPendingConnections.get(failedNet) || 0;
                setNetPendingConnections(failedNet, Math.max(0, prev - 1));
                onNetRouted?.(result.traces);
            } else {
                addStillFailed(failedCid);
                onNetFailed?.(conn);
            }

            // Re-route ripped connections individually
            for (const cid of [...blockingConnIds].sort()) {
                const cidParsed = parseConnectionId(cid);
                if (!cidParsed) continue;
                const { netName: rn, index: connIdx } = cidParsed;
                const rc = connMap.get(rn);
                if (!rc) continue;
                const rEdges = rc.edges || defaultChainEdges(rc.pads.length);
                if (connIdx >= rEdges.length) continue;
                const [rFromIdx, rToIdx] = rEdges[connIdx];
                const rSkip = skipIdsForPair(rn, rFromIdx, rToIdx);

                connectionOnlyRerouteAttempts++;
                const rMiniConn = { net: rn, pads: [rc.pads[rFromIdx], rc.pads[rToIdx]] };
                const cResult = await routeNet(rMiniConn, obstacles, rSkip, tunedInitialProfile, connIdx);
                if (cResult.traces.length > 0 && cResult.failedCount === 0) {
                    const existing = routedTraces.get(rn) || [];
                    routedTraces.set(rn, existing.concat(cResult.traces));
                    const prev = netPendingConnections.get(rn) || 0;
                    setNetPendingConnections(rn, Math.max(0, prev - 1));
                    captureBestIfImproved();
                    onNetRouted?.(cResult.traces);
                } else {
                    connectionOnlyRerouteFallbacksToNet++;
                    addStillFailed(cid);
                    const fromPad = rc.pads[rFromIdx];
                    const toPad = rc.pads[rToIdx];
                    const probeLayer = fromPad?.layer || 'top';
                    const blocker = (fromPad && toPad)
                        ? obstacles.firstBlockingObstacleForSegment(fromPad.x, fromPad.y, toPad.x, toPad.y, totalClear, rSkip, probeLayer)
                        : null;
                    connectionOnlyFailAstarNoPathCount++;
                    connectionOnlyNoPathByConnId.set(cid, (connectionOnlyNoPathByConnId.get(cid) || 0) + 1);
                    recordNoPathBlocker(cid, blocker);
                }
            }

            // Capture at end of iteration — routedTraces is consistent here
            // (all re-routes done, no pending rips)
            captureBestIfImproved();

            passDone++;
            emitProgress(passDone, passTotal, `Rip-up ${pass}: ${failedCid}`, {
                phase: 'ripup',
                ripupDone: passDone,
                ripupTotal: passTotal,
                ripupPass: pass,
                ripupMaxPasses: MAX_PASSES,
                pendingConnections: pendingConnectionsTotal(),
            });
            await yieldToUI();
        }

        failedConnIds.length = 0;
        failedConnIds.push(...stillFailed);

        if (failedConnIds.length === 0) break;
    }

    // ── Collect results ──────────────────────────────────────────

    const allTraces = [];
    const allVias = [];
    // Pick the state with more routed connections: best snapshot or live state
    const countConnIds = (traceMap) => {
        const ids = new Set();
        for (const [, traces] of traceMap) {
            for (const t of traces) { if (t.connId) ids.add(t.connId); }
        }
        return ids.size;
    };
    const bestCount = bestRoutedTraces.size > 0 ? countConnIds(bestRoutedTraces) : 0;
    const liveCount = countConnIds(routedTraces);
    console.info(`[autorouter] best-state connIds=${bestCount}, live connIds=${liveCount}, bestNets=${bestRoutedTraces.size}, liveNets=${routedTraces.size}`);
    const finalRouted = (bestCount >= liveCount && bestRoutedTraces.size > 0) ? bestRoutedTraces : routedTraces;
    for (const [, netTraces] of finalRouted) {
        for (const t of netTraces) {
            allTraces.push({
                net: t.net,
                points: t.points.map(p => ({ x: p.x, y: p.y })),
                layer: t.layer || 'top',
            });
            if (t.vias) {
                for (const v of t.vias) allVias.push({ net: t.net, ...v });
            }
        }
    }

    const bestFailedNets = [...connMap.keys()].filter(net => !finalRouted.has(net));

    // Count failed connections from actual trace data (not the stale pending counter)
    const finalConnCount = countConnIds(finalRouted);
    const failedConnectionCount = totalConnectionCount - finalConnCount;

    // Build list of failed connection pad pairs for ratsnest display
    const routedConnIds = new Set();
    for (const [, netTraces] of finalRouted) {
        for (const t of netTraces) { if (t.connId) routedConnIds.add(t.connId); }
    }
    const failedConnections = [];
    for (const [cid, pads] of connIdToPads) {
        if (!routedConnIds.has(cid)) {
            failedConnections.push({ net: pads.net, from: { x: pads.from.x, y: pads.from.y }, to: { x: pads.to.x, y: pads.to.y } });
        }
    }

    const connectionOnlyTopNoPathConnIds = [...connectionOnlyNoPathByConnId.entries()]
        .sort((a, b) => {
            if (a[1] !== b[1]) return b[1] - a[1];
            return a[0].localeCompare(b[0]);
        })
        .slice(0, 5)
        .map(([connId, count]) => ({ connId, count }));
    const connectionOnlyTopNoPathBlockers = connectionOnlyTopNoPathConnIds.map(item => {
        const bucket = connectionOnlyNoPathBlockerByConnId.get(item.connId);
        if (!bucket || bucket.size === 0) {
            return {
                connId: item.connId,
                count: item.count,
                blockerClass: 'unknown',
                blockerNet: null,
                blockerConnId: null,
                blockerId: null,
            };
        }
        const top = [...bucket.values()].sort((a, b) => {
            if (a.count !== b.count) return b.count - a.count;
            const aKey = `${a.kind}|${a.net || ''}|${a.connId || ''}|${a.obstacleId || ''}`;
            const bKey = `${b.kind}|${b.net || ''}|${b.connId || ''}|${b.obstacleId || ''}`;
            return aKey.localeCompare(bKey);
        })[0];
        return {
            connId: item.connId,
            count: item.count,
            blockerClass: top.kind,
            blockerNet: top.net,
            blockerConnId: top.connId,
            blockerId: top.obstacleId,
        };
    });
    const connectionOnlyTopNoPathLog = connectionOnlyTopNoPathConnIds.length > 0
        ? connectionOnlyTopNoPathConnIds.map(item => `${item.connId}:${item.count}`).join(',')
        : 'none';
    const connectionOnlyTopNoPathBlockerLog = connectionOnlyTopNoPathBlockers.length > 0
        ? connectionOnlyTopNoPathBlockers
            .map(item => `${item.connId}:${item.blockerClass}:${item.blockerNet || '-'}:${item.blockerConnId || '-'}:${item.blockerId || '-'}`)
            .join(',')
        : 'none';

    console.info(
        `[autorouter] ripup probe misses=${ripupProbeMissCount}, conn-fallbacks=${ripupConnFallbackCount}, net-fallbacks=${ripupCompatibilityFallbackCount}, blockers(probe/conn/net)=${ripupBlockersFromProbeCount}/${ripupBlockersFromConnFallbackCount}/${ripupBlockersFromCompatibilityFallbackCount}, conn-only attempts=${connectionOnlyRerouteAttempts}, conn-only noPath=${connectionOnlyFailAstarNoPathCount}, conn-only top-noPath=${connectionOnlyTopNoPathLog}, conn-only top-noPath-blockers=${connectionOnlyTopNoPathBlockerLog}, conn-only->net-fallbacks=${connectionOnlyRerouteFallbacksToNet}`
    );

    return {
        traces: allTraces,
        failed: bestFailedNets,
        failedConnections,
        failedConnectionCount,
        totalConnectionCount,
        vias: allVias,
        ripupProbeMissCount,
        ripupConnFallbackCount,
        ripupCompatibilityFallbackCount,
        ripupBlockersFromProbeCount,
        ripupBlockersFromConnFallbackCount,
        ripupBlockersFromCompatibilityFallbackCount,
        connectionOnlyRerouteAttempts,
        connectionOnlyRerouteFallbacksToNet,
        connectionOnlyFailAstarNoPathCount,
        connectionOnlyTopNoPathConnIds,
        connectionOnlyTopNoPathBlockers,
    };
}


/**
 * Default chain-shaped edge list for a net of `n` pads:
 * [[0,1], [1,2], …, [n-2, n-1]]. Used as a fallback when conn.edges is
 * absent (e.g. miniConn produced for routeNet) and to give 2-pad nets a
 * canonical single-edge representation.
 */
function defaultChainEdges(n) {
    const out = [];
    for (let i = 0; i < n - 1; i++) out.push([i, i + 1]);
    return out;
}

/**
 * Build a Euclidean Minimum Spanning Tree over `pads` (treating each pad
 * as the point (pad.x, pad.y)) using Prim's algorithm. Returns the MST
 * as an array of `[fromIdx, toIdx]` pairs of length `pads.length - 1`.
 *
 * The MST is the optimal topology for connecting all pads of a single
 * net with minimum total Euclidean length, is provably planar in 2D
 * (no edge crossings), and naturally branches for star-topology nets
 * (e.g. one VCC pad fanning out to many bypass caps) instead of forcing
 * a snake-chain.
 *
 * Edges are emitted in Prim's discovery order, starting from pad 0. For
 * 2-pad nets this returns [[0, 1]] — identical to the legacy chain
 * behaviour, so single-pair nets are byte-for-byte unchanged.
 */
function buildMstEdges(pads) {
    const n = pads.length;
    if (n < 2) return [];
    if (n === 2) return [[0, 1]];
    // Prim's: grow the tree from pad 0, repeatedly add the cheapest edge
    // connecting a tree-node to a non-tree node.
    const inTree = new Uint8Array(n);
    inTree[0] = 1;
    // bestSrc[v] = tree-node currently closest to v; bestDist[v] = that distance.
    const bestSrc = new Int32Array(n);
    const bestDist = new Float64Array(n);
    for (let v = 0; v < n; v++) {
        bestSrc[v] = 0;
        bestDist[v] = (v === 0) ? 0 : Math.hypot(pads[v].x - pads[0].x, pads[v].y - pads[0].y);
    }
    const edges = [];
    for (let added = 1; added < n; added++) {
        // Pick the non-tree node with the smallest bestDist.
        let pick = -1, pickDist = Infinity;
        for (let v = 0; v < n; v++) {
            if (inTree[v]) continue;
            if (bestDist[v] < pickDist) { pickDist = bestDist[v]; pick = v; }
        }
        if (pick < 0) break; // should not happen for finite inputs
        edges.push([bestSrc[pick], pick]);
        inTree[pick] = 1;
        // Relax distances of remaining non-tree nodes against the new tree-node.
        for (let v = 0; v < n; v++) {
            if (inTree[v]) continue;
            const d = Math.hypot(pads[v].x - pads[pick].x, pads[v].y - pads[pick].y);
            if (d < bestDist[v]) { bestDist[v] = d; bestSrc[v] = pick; }
        }
    }
    return edges;
}


/**
 * Manhattan distance for the shortest edge in a net. Uses conn.edges
 * when present (MST), else falls back to the implicit chain ordering.
 */
function netManhattan(conn) {
    if (conn.pads.length < 2) return Infinity;
    const edges = conn.edges || defaultChainEdges(conn.pads.length);
    let min = Infinity;
    for (const [a, b] of edges) {
        const d = Math.abs(conn.pads[a].x - conn.pads[b].x) +
                  Math.abs(conn.pads[a].y - conn.pads[b].y);
        min = Math.min(min, d);
    }
    return min;
}

/**
 * Maze (A* + rip-up) autorouter entrypoint.
 */
export async function routeWithMazeRouter(input, options = {}) {
    return routeAll(input, options);
}
