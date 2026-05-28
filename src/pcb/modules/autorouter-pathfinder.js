// @ts-nocheck — JSDoc partial types and runtime type narrowing not expressible to TS
import {
    astarRoute,
    padPointBlocked,
    padSegmentBlocked,
    PathfinderGrid,
    pointToSegmentDist,
    segmentToSegmentDist,
    simplifyPath,
    SpatialHash
} from './autorouter-common.js';


/**
 * Reorder `conn.pads` in place into a nearest-neighbour chain starting at
 * the pad farthest from the centroid, then greedily walking to the
 * nearest unvisited pad. Returns the permutation array (`orderedIdx[k]`
 * is the original index of the pad now at position `k`), or `null` for
 * trivial nets (< 3 pads).
 *
 * Used by the pathfinder router (NOT by the classic router, which uses
 * `buildMstEdges` for a planar MST topology). MST was tried in the
 * pathfinder and held the test-board.json clean count at 68/76 — the
 * same number as the legacy chain — but produced no measurable gain
 * either way; the chain is kept because changing pathfinder topology
 * affects the negotiated-congestion convergence in ways outside the
 * scope of the user-facing visual-crossing fix.
 *
 * Callers must reorder any parallel arrays (e.g. `netPadIdList`) using
 * the returned permutation.
 */
function nncReorderPads(conn) {
    const pads = conn.pads;
    if (pads.length < 3) return null;

    // Single-start NN chain: pick the pad farthest from the centroid as
    // the start, then grow greedily by nearest neighbour. This is the
    // legacy heuristic that holds the test-board.json baseline at 68/76.
    //
    // (Multi-start variants — try every pad as a start, pick the shortest
    // total — were tried per Petrović et al. EPFL/AMD 2025 and produced
    // 67/76 on test-board.json. Shorter chains fed the negotiated-
    // congestion loop into a slightly worse local optimum, so the
    // single-start chain is retained.)
    let cx = 0, cy = 0;
    for (const p of pads) { cx += p.x; cy += p.y; }
    cx /= pads.length; cy /= pads.length;

    let startIdx = 0, startDist = -Infinity;
    for (let i = 0; i < pads.length; i++) {
        const d = Math.hypot(pads[i].x - cx, pads[i].y - cy);
        if (d > startDist) { startDist = d; startIdx = i; }
    }

    const orderedIdx = [startIdx];
    const used = new Set([startIdx]);
    while (orderedIdx.length < pads.length) {
        const last = pads[orderedIdx[orderedIdx.length - 1]];
        let bestIdx = -1, bestDist = Infinity;
        for (let i = 0; i < pads.length; i++) {
            if (used.has(i)) continue;
            const d = Math.hypot(pads[i].x - last.x, pads[i].y - last.y);
            if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        orderedIdx.push(bestIdx);
        used.add(bestIdx);
    }
    conn.pads = orderedIdx.map(i => pads[i]);
    return orderedIdx;
}


// ─── Pathfinder (negotiated-congestion) router ──────────────────────────

/**
 * Greedy feasibility extraction for Pathfinder output.
 *
 * Given a Map of (connKey → route|null) where routes may overlap, sample
 * each emitted route into fine cells (~traceWidth + clearance in size) and
 * iteratively drop the connection contributing to the most cell conflicts
 * until no cell is shared by two connections.
 *
 * Returns Set<connKey> of dropped connections; caller should null those
 * routes in the map and report them as failed.
 *
 * Cell size is intentionally chosen smaller than the routing grid so that
 * two routes sharing a cell almost certainly violate clearance. This is a
 * Maximum Independent Set approximation (NP-hard); the greedy "drop most-
 * conflicting first" heuristic is standard.
 */
function extractFeasibleSubset(finalRoutes, connList, gridStep, traceWidth, clearance) {
    // Conflict-detection cell. Two routes whose samples land in the same cell
    // are considered conflicting. Choose cellSize so the strictest clearance
    // (via-trace = viaRadius + halfTrace + clearance ≈ 0.4mm by default)
    // fits within (cellSize + some via-rasterization margin).
    const cellSize = Math.max(traceWidth + clearance, gridStep * 0.5);
    // Sample step << cellSize so diagonally-crossing segments are caught.
    // Two perpendicular segments crossing at a cell boundary would otherwise
    // alternate between adjacent cells and miss each other.
    const sampleStep = cellSize / 4;
    // Rasterize via footprints over a 3×3 cell block: the via's clearance
    // requirement (≈ 0.4mm) often spans more than one cell.
    const VIA_RASTER_OFFSETS = [
        [-1, -1], [0, -1], [1, -1],
        [-1,  0], [0,  0], [1,  0],
        [-1,  1], [0,  1], [1,  1],
    ];

    const KEY_OFFSET = 4194304;
    const KEY_Y_STRIDE = 33554432;
    const _key = (x, y, layer) => {
        const cx = Math.floor(x / cellSize);
        const cy = Math.floor(y / cellSize);
        const lbit = (layer === 'bottom' || layer === 1) ? 1 : 0;
        return ((cx + KEY_OFFSET) * KEY_Y_STRIDE) + ((cy + KEY_OFFSET) * 2) + lbit;
    };
    const _keyCell = (cx, cy, layer) => {
        const lbit = (layer === 'bottom' || layer === 1) ? 1 : 0;
        return ((cx + KEY_OFFSET) * KEY_Y_STRIDE) + ((cy + KEY_OFFSET) * 2) + lbit;
    };

    /** @type {Map<number, Set<string>>} cellKey -> Set<connKey> */
    const cellOccupants = new Map();
    /** @type {Map<string, Set<number>>} connKey -> Set<cellKey> */
    const connCells = new Map();

    const addToCell = (cellKey, connKey) => {
        let set = cellOccupants.get(cellKey);
        if (!set) { set = new Set(); cellOccupants.set(cellKey, set); }
        set.add(connKey);
        let cs = connCells.get(connKey);
        if (!cs) { cs = new Set(); connCells.set(connKey, cs); }
        cs.add(cellKey);
    };

    // Sample every emitted connection into cells.
    for (const item of connList) {
        const connKey = `${item.net}:${item.connIdx}`;
        const route = finalRoutes.get(connKey);
        if (!route) continue;
        // Trace segments per layer, sampled densely.
        for (let p = 0; p < route.path.length - 1; p++) {
            const p1 = route.path[p], p2 = route.path[p + 1];
            if (p1.layer !== p2.layer) continue;
            const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
            const steps = Math.max(1, Math.ceil(dist / sampleStep));
            for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                addToCell(_key(p1.x + (p2.x - p1.x) * t, p1.y + (p2.y - p1.y) * t, p1.layer), connKey);
            }
        }
        // Vias occupy a 3×3 cell footprint on BOTH layers to capture the
        // larger via clearance requirement.
        for (const v of route.vias) {
            const cx = Math.floor(v.x / cellSize);
            const cy = Math.floor(v.y / cellSize);
            for (const [dx, dy] of VIA_RASTER_OFFSETS) {
                addToCell(_keyCell(cx + dx, cy + dy, 'top'), connKey);
                addToCell(_keyCell(cx + dx, cy + dy, 'bottom'), connKey);
            }
        }
    }

    /** @type {Set<string>} */
    const dropped = new Set();

    // Greedy loop: find the connection touching the most conflicted cells,
    // drop it, repeat. A "conflict" requires occupants from at least two
    // DIFFERENT nets — two sub-routes of the same multi-pin net legitimately
    // share cells at junction pads and must NOT be counted as conflicts.
    while (true) {
        const conflictCount = new Map();
        let anyConflict = false;
        for (const set of cellOccupants.values()) {
            if (set.size < 2) continue;
            // Check if any two are from different nets.
            let firstNet = null, hasDifferentNet = false;
            for (const ck of set) {
                const n = ck.split(':')[0];
                if (firstNet === null) firstNet = n;
                else if (n !== firstNet) { hasDifferentNet = true; break; }
            }
            if (!hasDifferentNet) continue;
            anyConflict = true;
            for (const ck of set) {
                conflictCount.set(ck, (conflictCount.get(ck) || 0) + 1);
            }
        }
        if (!anyConflict) break;

        // Drop the conn with the highest conflict count. Tiebreak: longer
        // routes (more cells) first — they're more likely to be in conflicts
        // elsewhere too, and dropping them frees more space per drop.
        let worstConn = null, worstCount = 0, worstSize = 0;
        for (const [ck, c] of conflictCount) {
            const size = connCells.get(ck)?.size || 0;
            if (c > worstCount || (c === worstCount && size > worstSize)) {
                worstCount = c; worstSize = size; worstConn = ck;
            }
        }
        if (!worstConn) break;
        dropped.add(worstConn);
        // Remove dropped conn from cell occupancy.
        const cells = connCells.get(worstConn);
        if (cells) {
            for (const cellKey of cells) {
                cellOccupants.get(cellKey)?.delete(worstConn);
            }
            connCells.delete(worstConn);
        }
    }

    return dropped;
}

/**
 * Run the cell-greedy feasibility extraction + hard-obstacle re-route on a
 * candidate snapshot of Pathfinder routes. Returns a new map with the final
 * routes (dropped → re-routed or null), plus stats.
 *
 * Does NOT mutate the input `snapshotRoutes`. Used by routeAllPathfinder's
 * multi-snapshot trial loop to score each candidate.
 */
async function extractAndReroute(snapshotRoutes, connList, allPads, opts) {
    const {
        gridStep, traceWidth, clearance, viaDiameter, cellSize, viaRadius,
        routeBounds, greedyWeight, cancelToken, yieldToUI, padHash, padNetMap,
        emitConnChange, itemByKey,
    } = opts;
    const halfTrace = traceWidth / 2;
    const finalRoutes = new Map(snapshotRoutes);

    // Cell-greedy MIS approximation: drop conflicting connections.
    const droppedConns = extractFeasibleSubset(finalRoutes, connList, gridStep, traceWidth, clearance);
    for (const ck of droppedConns) {
        finalRoutes.set(ck, null);
        // Animate the rip-up to the user. Net lookup via itemByKey (always
        // present when caller threads it in; module-level callers may omit it).
        const it = itemByKey?.get(ck);
        if (emitConnChange && it) emitConnChange(ck, null, [], it.net);
    }

    let rerouteSuccess = 0;
    if (droppedConns.size > 0) {
        const rerouteObs = new SpatialHash(cellSize);
        // Pads (always hard obstacles)
        for (const pad of allPads) {
            rerouteObs.insertPad(pad.x, pad.y, pad.width, pad.height, pad.id, pad.layer || 'both', { shape: pad.shape });
        }
        // KEPT routes' trace segments + vias become hard obstacles for re-route.
        let pfConnId = 0;
        for (const item of connList) {
            const connKey = `${item.net}:${item.connIdx}`;
            if (droppedConns.has(connKey)) continue;
            const route = finalRoutes.get(connKey);
            if (!route) continue;
            const connId = `pf_kept_${pfConnId++}`;
            for (let p = 0; p < route.path.length - 1; p++) {
                const p1 = route.path[p], p2 = route.path[p + 1];
                if (p1.layer === p2.layer) {
                    rerouteObs.insert(p1.x, p1.y, p2.x, p2.y, halfTrace, item.net, p1.layer, connId);
                }
            }
            for (const v of route.vias) {
                rerouteObs.insertPad(v.x, v.y, viaDiameter, viaDiameter, item.net, 'both', { isVia: true, connId, shape: 'ellipse' });
            }
        }

        // Order dropped items shortest-first: easier-to-fit nets succeed first,
        // hardest left to squeeze through whatever channels remain. (Longest-
        // first was tested and is uniformly worse — long routes consume too
        // much channel space, locking out subsequent short ones.)
        const droppedItems = connList.filter(item => droppedConns.has(`${item.net}:${item.connIdx}`));
        droppedItems.sort((a, b) =>
            Math.hypot(a.from.x - a.to.x, a.from.y - a.to.y) -
            Math.hypot(b.from.x - b.to.x, b.from.y - b.to.y));

        for (const item of droppedItems) {
            if (cancelToken?.cancelled) break;
            const connKey = `${item.net}:${item.connIdx}`;
            const result = await astarRouteAnyEndpoint(
                item.from, item.to,
                rerouteObs, item.skipIds, gridStep, traceWidth, clearance,
                greedyWeight, /* allowVias */ true,
                item.startLayer, item.endLayer,
                {
                    cancelToken,
                    yieldToUI,
                    bounds: routeBounds,
                    viaRadius,
                    routingNet: item.net,
                    // No cellCostFn here — pure hard-obstacle A*.
                }
            );
            if (result?.path?.length > 0) {
                finalRoutes.set(connKey, { path: result.path, vias: result.vias || [], net: item.net });
                rerouteSuccess++;
                // Animate the successful re-route.
                if (emitConnChange) emitConnChange(connKey, result.path, result.vias || [], item.net);
                // Add this route to rerouteObs so the next re-route sees it.
                const connId = `pf_reroute_${pfConnId++}`;
                for (let p = 0; p < result.path.length - 1; p++) {
                    const p1 = result.path[p], p2 = result.path[p + 1];
                    if (p1.layer === p2.layer) {
                        rerouteObs.insert(p1.x, p1.y, p2.x, p2.y, halfTrace, item.net, p1.layer, connId);
                    }
                }
                for (const v of result.vias || []) {
                    rerouteObs.insertPad(v.x, v.y, viaDiameter, viaDiameter, item.net, 'both', { isVia: true, connId, shape: 'ellipse' });
                }
            }
            await yieldToUI();
        }
    }

    let routed = 0;
    for (const v of finalRoutes.values()) if (v) routed++;

    // Geometric verification: cell-greedy extraction is approximate (sample
    // grid + via rasterization can miss perpendicular crossings inside one
    // cell, or grid-edge cases where a trace squeezes through a pad row).
    // Drop violators based on exact distance calculations.
    const verifyResult = geometricVerifyAndDrop(finalRoutes, connList, allPads,
        { traceWidth, clearance, viaDiameter, cellSize, padHash, padNetMap, emitConnChange, itemByKey });

    return {
        finalRoutes,
        dropped: droppedConns.size,
        recovered: rerouteSuccess,
        routed,                              // raw post-reroute count (pre-verify)
        cleanRouted: verifyResult.cleanRouted, // post-geometric-verify count
        violators: verifyResult.violators,
    };
}

/**
 * Geometric clearance verification for a set of routed connections.
 *
 * Cell-based feasibility extraction is approximate — two routes whose cell
 * footprints don't overlap can still violate clearance at grid edges (a 3μm
 * sliver inside a dense pad row, a perpendicular crossing inside a single
 * cell). This pass catches those by running an exact distance check against
 * a SpatialHash of all routes' traces + vias + pads.
 *
 * Iteratively drops the worst violator (most conflicting segments+vias)
 * until no violations remain. Same-net traces/vias are exempted (multi-pin
 * nets legitimately share copper). Same-net via-on-pad is allowed.
 *
 * @param {Map<string, {path,vias,net}|null>} finalRoutes — mutated in place;
 *   violators set to null.
 * @returns {{ violators: number, cleanRouted: number }}
 */
function geometricVerifyAndDrop(finalRoutes, connList, allPads, opts) {
    const { traceWidth, clearance, viaDiameter, cellSize, padHash, padNetMap, emitConnChange, itemByKey } = opts;
    const halfTrace = traceWidth / 2;
    const viaRadius = viaDiameter / 2;
    const EPS = 1e-4;

    // Build per-conn data + a SpatialHash of all route traces and vias.
    /** @type {Map<string, {item, route}>} */
    const connData = new Map();
    const routeHash = new SpatialHash(cellSize);
    for (const item of connList) {
        const connKey = `${item.net}:${item.connIdx}`;
        const route = finalRoutes.get(connKey);
        if (!route) continue;
        connData.set(connKey, { item, route });
        for (let p = 0; p < route.path.length - 1; p++) {
            const p1 = route.path[p], p2 = route.path[p + 1];
            if (p1.layer === p2.layer) {
                routeHash.insert(p1.x, p1.y, p2.x, p2.y, halfTrace, item.net, p1.layer, connKey);
            }
        }
        for (const v of route.vias) {
            routeHash.insertPad(v.x, v.y, viaDiameter, viaDiameter, item.net, 'both',
                { isVia: true, connId: connKey, shape: 'ellipse' });
        }
    }

    // Compute violation count for a single connection against the current
    // routeHash + pads. Counts:
    //   - segments crossing another conn's trace/via (different net)
    //   - segments crossing a foreign-net pad (not in own skipIds, not own-net)
    //   - vias crossing another conn's trace/via or a foreign-net pad
    const countViolations = (connKey) => {
        const data = connData.get(connKey);
        if (!data) return 0;
        const { item, route } = data;
        let count = 0;

        // Trace segments
        for (let p = 0; p < route.path.length - 1; p++) {
            const p1 = route.path[p], p2 = route.path[p + 1];
            if (p1.layer !== p2.layer) continue;

            // Trace vs other routes (skip own connKey by using skipIds set
            // containing the connKey; skipNet=net skips other same-net traces).
            const segSkip = new Set();
            segSkip.add(connKey);                  // skip own traces/vias by connKey
            for (const id of item.skipIds) segSkip.add(id); // skip own endpoint pads
            // Custom check: query the routeHash for any obj within halfTrace+clearance
            // of the segment, ignoring own connKey, same-net traces, same-net vias.
            const blockers = collectBlockers(routeHash, p1, p2, halfTrace + clearance, segSkip, p1.layer, item.net);
            count += blockers;

            // Trace vs static pads (other than own endpoints + same-net) — cell-localised.
            count += padHashSegmentViolations(padHash, p1.x, p1.y, p2.x, p2.y, p1.layer,
                halfTrace + clearance - EPS, item.skipIds, padNetMap, item.net);
        }

        // Vias
        for (const via of route.vias) {
            // Via vs other routes (traces + vias, different net)
            const viaSkip = new Set();
            viaSkip.add(connKey);
            for (const id of item.skipIds) viaSkip.add(id);
            const blockers = collectViaBlockers(routeHash, via.x, via.y, viaRadius, halfTrace, clearance, viaSkip, item.net);
            count += blockers;

            // Via vs static pads (own-net via-on-pad allowed; foreign-net hard violation).
            count += padHashViaViolations(padHash, via.x, via.y, viaRadius + clearance - EPS,
                item.skipIds, padNetMap, item.net);
        }

        return count;
    };

    // Iterative drop loop
    let violators = 0;
    while (true) {
        let worst = null, worstCount = 0;
        for (const connKey of connData.keys()) {
            const c = countViolations(connKey);
            if (c > worstCount) { worstCount = c; worst = connKey; }
        }
        if (!worst) break;
        finalRoutes.set(worst, null);
        // Animate the verify-drop too.
        const it = itemByKey?.get(worst);
        if (emitConnChange && it) emitConnChange(worst, null, [], it.net);
        // Remove its traces/vias from the hash so other counts decrease.
        routeHash.removeConnection(worst);
        connData.delete(worst);
        violators++;
    }

    let cleanRouted = 0;
    for (const v of finalRoutes.values()) if (v) cleanRouted++;
    return { violators, cleanRouted };
}

/**
 * Convert a pathfinder A* path into per-layer trace objects suitable for
 * incremental UI rendering (matches the schema used by the classic router's
 * `onNetRouted` payload: `{ net, points, layer, vias, connId }`).
 *
 * The path is split at every layer transition — each contiguous same-layer
 * run becomes one trace. Layer-change points (via locations) are NOT
 * emitted as zero-length segments; they're handled by the via list.
 *
 * @param {Array<{x:number,y:number,layer:string}>} path
 * @param {string} net
 * @param {string} connId
 * @param {Array<{x:number,y:number}>} [vias] - vias to attach (rendered as
 *   separate hole-layer circles; attaching to the first trace is sufficient
 *   because `_renderNetTraces` clears by connId before re-rendering).
 * @returns {Array<{net:string, points:Array<{x:number,y:number}>, layer:string, vias:Array, connId:string}>}
 */
function buildConnTracesFromPath(path, net, connId, vias) {
    const traces = [];
    if (!path || path.length < 2) return traces;
    let segStart = 0;
    for (let i = 1; i <= path.length - 1; i++) {
        const layerChanged = path[i].layer !== path[i - 1].layer;
        const isLast = i === path.length - 1;
        if (layerChanged || isLast) {
            const endIdx = layerChanged ? i - 1 : i;
            if (endIdx > segStart) {
                const points = [];
                for (let k = segStart; k <= endIdx; k++) {
                    points.push({ x: path[k].x, y: path[k].y });
                }
                traces.push({
                    net,
                    points,
                    layer: path[segStart].layer || 'top',
                    vias: [],
                    connId,
                });
            }
            if (layerChanged) segStart = i;
        }
    }
    // Attach all vias to the first trace. The UI's `_renderNetTraces` walks
    // each trace's `vias` array and renders circles into the hole layer; since
    // hole-layer rendering is independent of which trace they're attached to,
    // collapsing them onto the first trace is fine and avoids per-via
    // ownership bookkeeping. `_clearIncrementalConnection(connId)` removes
    // every `.pcb-route-anim[data-connid=connId]` element (polylines + vias)
    // before re-render, so vias correctly disappear on rip-up too.
    if (vias && vias.length && traces.length > 0) {
        traces[0].vias = vias.map(v => ({ x: v.x, y: v.y }));
    }
    return traces;
}

/**
 * Post-finalisation cosmetic pass for the pathfinder. The negotiated-
 * congestion router emits grid-aligned A* paths which often staircase
 * (alternating D and H/V steps) through clear regions. Classical
 * line-of-sight simplification flattens these without changing the set of
 * cells visited materially — provided we also respect every OTHER finalised
 * route's copper, not just pads.
 *
 * Operates per-route: temporarily remove the route from a combined
 * route+pad obstacle view, run `simplifyPath` against the rest, re-insert
 * the (now shorter) path. Layer transitions and vias are preserved as
 * break-points because `simplifyPath` only collapses within a single
 * layer.
 *
 * Geometrically conservative: any candidate straight segment must clear
 * every pad in `padHash` AND every retained segment/via in `routeHash`
 * (same-net via skipNet) — so we can't introduce a new violation. If no
 * straight segment fits, the original staircase is kept.
 *
 * @param {Map<string, {path,vias,net}|null>} finalRoutes
 * @param {Array} connList
 * @param {{traceWidth, clearance, viaDiameter, cellSize, padHash}} opts
 * @returns {{smoothed: number, segmentsRemoved: number}}
 */
function smoothPathfinderRoutes(finalRoutes, connList, opts) {
    const { traceWidth, clearance, viaDiameter, cellSize, padHash } = opts;
    const halfTrace = traceWidth / 2;
    const totalClear = halfTrace + clearance;

    // Build a routeHash mirroring geometricVerifyAndDrop: traces tagged with
    // (net, connId) so we can selectively remove the route being simplified.
    const routeHash = new SpatialHash(cellSize);
    for (const item of connList) {
        const connKey = `${item.net}:${item.connIdx}`;
        const route = finalRoutes.get(connKey);
        if (!route) continue;
        for (let p = 0; p < route.path.length - 1; p++) {
            const p1 = route.path[p], p2 = route.path[p + 1];
            if (p1.layer === p2.layer) {
                routeHash.insert(p1.x, p1.y, p2.x, p2.y, halfTrace, item.net, p1.layer, connKey);
            }
        }
        for (const v of route.vias) {
            routeHash.insertPad(v.x, v.y, viaDiameter, viaDiameter, item.net, 'both',
                { isVia: true, connId: connKey, shape: 'ellipse' });
        }
    }

    // simplifyPath uses obstacles.isOnPad (pad-only heuristic for the
    // no-diagonal-near-pads rule) and obstacles.isSegmentBlocked (full
    // collision check). We delegate isOnPad to padHash and OR-combine the
    // segment check across pad + route hashes.
    const combinedObstacles = {
        isOnPad: (x, y, c) => padHash.isOnPad(x, y, c),
        isSegmentBlocked: (x1, y1, x2, y2, c, skipIds, layer, skipNet) =>
            padHash.isSegmentBlocked(x1, y1, x2, y2, c, skipIds, layer, skipNet)
            || routeHash.isSegmentBlocked(x1, y1, x2, y2, c, skipIds, layer, skipNet),
    };

    let smoothed = 0;
    let segmentsRemoved = 0;

    for (const item of connList) {
        const connKey = `${item.net}:${item.connIdx}`;
        const route = finalRoutes.get(connKey);
        if (!route || route.path.length < 3) continue;

        // Temporarily remove this route from routeHash so the line-of-sight
        // check doesn't conflict with the very segments we're trying to
        // collapse. (Same-net is already exempt via skipNet, but vias are
        // stored as pads which skipNet doesn't filter — pulling the route
        // is simpler than splitting the skip logic.)
        routeHash.removeConnection(connKey);

        const before = route.path.length;
        const simplified = simplifyPath(route.path, combinedObstacles, item.skipIds, totalClear, item.net);

        if (simplified.length < before) {
            route.path = simplified;
            smoothed++;
            segmentsRemoved += (before - simplified.length);
        }

        // Re-insert this route's (possibly-simpler) trace segments. Vias
        // never change in this pass, but they were removed by
        // removeConnection above so re-insert them too.
        for (let p = 0; p < route.path.length - 1; p++) {
            const p1 = route.path[p], p2 = route.path[p + 1];
            if (p1.layer === p2.layer) {
                routeHash.insert(p1.x, p1.y, p2.x, p2.y, halfTrace, item.net, p1.layer, connKey);
            }
        }
        for (const v of route.vias) {
            routeHash.insertPad(v.x, v.y, viaDiameter, viaDiameter, item.net, 'both',
                { isVia: true, connId: connKey, shape: 'ellipse' });
        }
    }

    return { smoothed, segmentsRemoved };
}

/**
 * Helper: count distinct OTHER-net blockers for a segment in the route hash.
 * Skips: own connKey (via skipIds), same-net traces, same-net vias.
 *
 * @param queryClear = halfTrace + clearance (so that obj.hw + queryClear =
 *   halfTrace + halfTrace + clearance = traceWidth + clearance, the
 *   trace-to-trace center-distance threshold).
 *
 * Returns the number of OTHER routes whose copper violates clearance against
 * the segment (each is counted once even if multiple of its segments conflict).
 */
function collectBlockers(routeHash, p1, p2, queryClear, skipIds, layer, ownNet) {
    const ax1 = p1.x, ay1 = p1.y, ax2 = p2.x, ay2 = p2.y;
    const minSX = Math.min(ax1, ax2), maxSX = Math.max(ax1, ax2);
    const minSY = Math.min(ay1, ay2), maxSY = Math.max(ay1, ay2);
    const cxMin = Math.floor((minSX - queryClear) / routeHash.cellSize) - 1;
    const cxMax = Math.floor((maxSX + queryClear) / routeHash.cellSize) + 1;
    const cyMin = Math.floor((minSY - queryClear) / routeHash.cellSize) - 1;
    const cyMax = Math.floor((maxSY + queryClear) / routeHash.cellSize) + 1;
    const blockers = new Set();
    for (let cx = cxMin; cx <= cxMax; cx++) {
        for (let cy = cyMin; cy <= cyMax; cy++) {
            const objs = routeHash.cells.get(routeHash._key(cx, cy));
            if (!objs) continue;
            for (const obj of objs) {
                if (!obj.connId) continue;             // only route-tagged objs (skip pads)
                if (skipIds.has(obj.connId)) continue; // skip own conn
                if (obj.net === ownNet) continue;      // skip same-net
                if (obj.isPad) {
                    // Via (only vias have connId among inserted pads).
                    // Threshold: viaRadius + halfTrace + clearance = obj.hw + queryClear.
                    if (padSegmentBlocked(ax1, ay1, ax2, ay2, obj, queryClear)) {
                        blockers.add(obj.connId);
                    }
                } else {
                    // Trace segment, must be on same layer to interact.
                    if (obj.layer && layer && obj.layer !== layer) continue;
                    // Threshold: traceWidth + clearance = obj.hw + queryClear.
                    const d = segmentToSegmentDist(ax1, ay1, ax2, ay2, obj.x1, obj.y1, obj.x2, obj.y2);
                    if (d < obj.hw + queryClear) blockers.add(obj.connId);
                }
            }
        }
    }
    return blockers.size;
}

/**
 * Helper: count distinct OTHER-net blockers for a via.
 * Returns the number of other routes whose copper violates clearance against
 * this via.
 */
function collectViaBlockers(routeHash, vx, vy, viaRadius, halfTrace, clearance, skipIds, ownNet) {
    const blockers = new Set();
    // Trace-vs-via threshold: viaRadius + halfTrace + clearance
    // Via-vs-via threshold: 2*viaRadius + clearance
    const maxThresh = Math.max(viaRadius + halfTrace + clearance, 2 * viaRadius + clearance);
    const cxMin = Math.floor((vx - maxThresh) / routeHash.cellSize) - 1;
    const cxMax = Math.floor((vx + maxThresh) / routeHash.cellSize) + 1;
    const cyMin = Math.floor((vy - maxThresh) / routeHash.cellSize) - 1;
    const cyMax = Math.floor((vy + maxThresh) / routeHash.cellSize) + 1;
    for (let cx = cxMin; cx <= cxMax; cx++) {
        for (let cy = cyMin; cy <= cyMax; cy++) {
            const objs = routeHash.cells.get(routeHash._key(cx, cy));
            if (!objs) continue;
            for (const obj of objs) {
                if (!obj.connId) continue;
                if (skipIds.has(obj.connId)) continue;
                if (obj.net === ownNet) continue;
                if (obj.isPad) {
                    // Other via: center distance < 2*viaRadius + clearance
                    const d = Math.hypot(vx - obj.cx, vy - obj.cy);
                    if (d < 2 * viaRadius + clearance) blockers.add(obj.connId);
                } else {
                    // Other trace: dist from via center to trace center-line < viaRadius + halfTrace + clearance
                    const d = pointToSegmentDist(vx, vy, obj.x1, obj.y1, obj.x2, obj.y2);
                    if (d < viaRadius + obj.hw + clearance) blockers.add(obj.connId);
                }
            }
        }
    }
    return blockers.size;
}

/**
 * Total per-layer path length of a route (ignores via segments).
 */
function pathLen(route) {
    let len = 0;
    for (let p = 0; p < route.path.length - 1; p++) {
        const p1 = route.path[p], p2 = route.path[p + 1];
        if (p1.layer === p2.layer) len += Math.hypot(p2.x - p1.x, p2.y - p1.y);
    }
    return len;
}

/**
 * Count static-pad violations against a segment using a pads-only SpatialHash.
 * Cell-localised query replaces an O(allPads) linear scan per segment.
 * Same-net pads (per padNetMap) and pads in `skipPadIds` are exempt.
 *
 * @param {SpatialHash} padHash - hash containing pads with connId undefined.
 * @param {number} queryClear - distance threshold (halfTrace + clearance, optionally minus EPS).
 * @param {Set<string>} skipPadIds - pad-instance IDs to skip (own endpoint pads).
 * @param {Map<string, Set<string>>} padNetMap - padId -> nets that use that pad.
 * @param {string} ownNet - net of the routing connection.
 */
function padHashSegmentViolations(padHash, ax1, ay1, ax2, ay2, layer, queryClear, skipPadIds, padNetMap, ownNet) {
    const cs = padHash.cellSize;
    const minSX = Math.min(ax1, ax2), maxSX = Math.max(ax1, ax2);
    const minSY = Math.min(ay1, ay2), maxSY = Math.max(ay1, ay2);
    const cxMin = Math.floor((minSX - queryClear) / cs) - 1;
    const cxMax = Math.floor((maxSX + queryClear) / cs) + 1;
    const cyMin = Math.floor((minSY - queryClear) / cs) - 1;
    const cyMax = Math.floor((maxSY + queryClear) / cs) + 1;
    // A pad spans multiple cells; dedup so we don't count the same pad more than once.
    const seen = new Set();
    let count = 0;
    for (let cx = cxMin; cx <= cxMax; cx++) {
        for (let cy = cyMin; cy <= cyMax; cy++) {
            const objs = padHash.cells.get(padHash._key(cx, cy));
            if (!objs) continue;
            for (const obj of objs) {
                if (!obj.isPad || obj.connId) continue; // static pads only
                if (seen.has(obj)) continue;
                seen.add(obj);
                const padLayer = obj.layer || 'both';
                if (padLayer !== 'both' && padLayer !== layer) continue;
                if (skipPadIds.has(obj.net)) continue;
                const netSet = padNetMap.get(obj.net);
                if (netSet && netSet.has(ownNet)) continue;
                if (padSegmentBlocked(ax1, ay1, ax2, ay2, obj, queryClear)) count++;
            }
        }
    }
    return count;
}

/**
 * Count static-pad violations against a via centre using a pads-only SpatialHash.
 */
function padHashViaViolations(padHash, vx, vy, queryClear, skipPadIds, padNetMap, ownNet) {
    const cs = padHash.cellSize;
    const cxMin = Math.floor((vx - queryClear) / cs) - 1;
    const cxMax = Math.floor((vx + queryClear) / cs) + 1;
    const cyMin = Math.floor((vy - queryClear) / cs) - 1;
    const cyMax = Math.floor((vy + queryClear) / cs) + 1;
    const seen = new Set();
    let count = 0;
    for (let cx = cxMin; cx <= cxMax; cx++) {
        for (let cy = cyMin; cy <= cyMax; cy++) {
            const objs = padHash.cells.get(padHash._key(cx, cy));
            if (!objs) continue;
            for (const obj of objs) {
                if (!obj.isPad || obj.connId) continue;
                if (seen.has(obj)) continue;
                seen.add(obj);
                if (skipPadIds.has(obj.net)) continue;
                const netSet = padNetMap.get(obj.net);
                if (netSet && netSet.has(ownNet)) continue;
                if (padPointBlocked(vx, vy, obj, queryClear)) count++;
            }
        }
    }
    return count;
}

/**
 * Pathfinder helper: run astarRoute and, on failure, retry once with a
 * halved grid step. Single-attempt coarse-grid routing can fail to thread
 * tight pad gaps (e.g. 0.5mm gap on a 0.5mm grid leaves only 1 valid cell
 * per row, often none at all). Classic routeAll has built-in multi-attempt
 * fallback (stepScale 1.0 -> 0.5 -> 0.25) so it handles these cases; the
 * pathfinder per-iter loop / extract / union helpers do not, so we wrap
 * their astarRoute calls in this refinement step.
 *
 * Cost: zero overhead when the coarse attempt succeeds (the common case).
 * Only failures pay the refinement cost.
 */
async function astarRouteWithRefinement(sx, sy, ex, ey, obstacles, skipIds, gridStep, traceWidth, clearance, greedyWeight, allowVias, startLayer, endPadLayer, opts) {
    let r = await astarRoute(sx, sy, ex, ey, obstacles, skipIds, gridStep, traceWidth, clearance, greedyWeight, allowVias, startLayer, endPadLayer, opts);
    if (r?.path?.length > 0) return r;
    if (opts?.cancelToken?.cancelled) return r;
    // One refinement step. Don't refine indefinitely — at some point the
    // failure is real congestion, not grid coarseness.
    if (gridStep > 0.125) {
        r = await astarRoute(sx, sy, ex, ey, obstacles, skipIds, gridStep * 0.5, traceWidth, clearance, greedyWeight, allowVias, startLayer, endPadLayer, opts);
    }
    return r;
}

/**
 * Pathfinder helper: route from any of `fromPad`'s endpoints (primary +
 * alternates) to any of `toPad`'s endpoints. Multi-pad pins (e.g. thermal
 * /centre pads that share a pin number across many physical pads) appear
 * in the connection input with `alternates: [...]`. Reaching ANY of them
 * counts as a successful route.
 *
 * Implementation: enumerate all (start, end) pad-pair candidates, sort by
 * Manhattan distance, and try `astarRouteWithRefinement` on each pair
 * until one succeeds. With Manhattan ordering, the most directly-reachable
 * pair is tried first — typically a corner pad of a thermal cluster rather
 * than a hemmed-in centre pad. Single-pad pins (no alternates) collapse to
 * exactly one call, identical to the previous behaviour.
 *
 * `skipIds` MUST already include every primary + alternate pad id of both
 * endpoints (callers build this via netPadIdList).
 */
async function astarRouteAnyEndpoint(fromPad, toPad, obstacles, skipIds, gridStep, traceWidth, clearance, greedyWeight, allowVias, fromLayer, toLayer, opts) {
    const sList = (fromPad.alternates && fromPad.alternates.length > 0)
        ? [fromPad, ...fromPad.alternates] : [fromPad];
    const eList = (toPad.alternates && toPad.alternates.length > 0)
        ? [toPad, ...toPad.alternates] : [toPad];
    if (sList.length === 1 && eList.length === 1) {
        return await astarRouteWithRefinement(
            fromPad.x, fromPad.y, toPad.x, toPad.y,
            obstacles, skipIds, gridStep, traceWidth, clearance,
            greedyWeight, allowVias, fromLayer, toLayer,
            { ...opts, startPad: fromPad, endPad: toPad }
        );
    }
    /** @type {Array<{s: any, e: any, d: number}>} */
    const pairs = [];
    for (const s of sList) {
        for (const e of eList) {
            pairs.push({ s, e, d: Math.abs(s.x - e.x) + Math.abs(s.y - e.y) });
        }
    }
    pairs.sort((a, b) => a.d - b.d);
    let lastResult = null;
    for (const { s, e } of pairs) {
        if (opts?.cancelToken?.cancelled) return null;
        const sLayer = (s.layer && s.layer !== 'both') ? s.layer : fromLayer;
        const eLayer = (e.layer && e.layer !== 'both') ? e.layer : toLayer;
        const result = await astarRouteWithRefinement(
            s.x, s.y, e.x, e.y,
            obstacles, skipIds, gridStep, traceWidth, clearance,
            greedyWeight, allowVias, sLayer, eLayer,
            { ...opts, startPad: s, endPad: e }
        );
        if (result?.path?.length > 0) return result;
        lastResult = result;
    }
    return lastResult;
}

/**
 * Greedy union-extension across trial results.
 *
 * After the trial loop picks ONE winning trial's clean routes, attempt to
 * extend that set by importing routes from OTHER trials for connections
 * the winner didn't route cleanly. Each candidate route is geometrically
 * checked against the current extended set; only conflict-free imports are
 * added. Each trial's routes are GUARANTEED clean against ITS OWN trial set,
 * but not against a different one — most imports will conflict and be
 * rejected, but a few often slot into "holes" in the winner's set.
 *
 * Mutates `bestRoutes` Map in place (sets connKey → route for added items).
 *
 * @returns {number} count of newly added connections
 */
function unionExtend(bestRoutes, allTrialRoutes, connList, allPads, opts) {
    const { traceWidth, clearance, viaDiameter, cellSize, padHash, padNetMap, emitConnChange, itemByKey: itemByKeyArg } = opts;
    const halfTrace = traceWidth / 2;
    const viaRadius = viaDiameter / 2;
    const EPS = 1e-4;

    // Build SpatialHash of current bestRoutes (route-tagged with connKey).
    const itemByKey = itemByKeyArg || (() => {
        const m = new Map();
        for (const item of connList) m.set(`${item.net}:${item.connIdx}`, item);
        return m;
    })();
    const hash = new SpatialHash(cellSize);
    for (const [connKey, route] of bestRoutes) {
        if (!route) continue;
        const item = itemByKey.get(connKey);
        if (!item) continue;
        for (let p = 0; p < route.path.length - 1; p++) {
            const p1 = route.path[p], p2 = route.path[p + 1];
            if (p1.layer === p2.layer) {
                hash.insert(p1.x, p1.y, p2.x, p2.y, halfTrace, item.net, p1.layer, connKey);
            }
        }
        for (const v of route.vias) {
            hash.insertPad(v.x, v.y, viaDiameter, viaDiameter, item.net, 'both',
                { isVia: true, connId: connKey, shape: 'ellipse' });
        }
    }

    // Check if `route` for `item` is geometrically clean against current hash + pads.
    const isClean = (route, item, connKey) => {
        const skipIds = new Set([connKey]);
        for (const id of item.skipIds) skipIds.add(id);
        // Trace segments
        for (let p = 0; p < route.path.length - 1; p++) {
            const p1 = route.path[p], p2 = route.path[p + 1];
            if (p1.layer !== p2.layer) continue;
            if (collectBlockers(hash, p1, p2, halfTrace + clearance, skipIds, p1.layer, item.net) > 0) return false;
            if (padHashSegmentViolations(padHash, p1.x, p1.y, p2.x, p2.y, p1.layer,
                halfTrace + clearance - EPS, item.skipIds, padNetMap, item.net) > 0) return false;
        }
        // Vias
        for (const via of route.vias) {
            if (collectViaBlockers(hash, via.x, via.y, viaRadius, halfTrace, clearance, skipIds, item.net) > 0) return false;
            if (padHashViaViolations(padHash, via.x, via.y, viaRadius + clearance - EPS,
                item.skipIds, padNetMap, item.net) > 0) return false;
        }
        return true;
    };

    // For each missing conn, try its candidate routes (sorted shortest-first)
    // from all trials. Accept the first clean one.
    let added = 0;
    for (const item of connList) {
        const connKey = `${item.net}:${item.connIdx}`;
        if (bestRoutes.get(connKey)) continue;

        const candidates = [];
        const seen = new Set();
        for (const trialMap of allTrialRoutes) {
            const r = trialMap.get(connKey);
            if (!r) continue;
            // Cheap dedup by endpoint+length+via-count signature
            const sig = `${r.path[0].x},${r.path[0].y}|${r.path[r.path.length - 1].x},${r.path[r.path.length - 1].y}|${r.path.length}|${r.vias.length}`;
            if (seen.has(sig)) continue;
            seen.add(sig);
            candidates.push(r);
        }
        candidates.sort((a, b) => pathLen(a) - pathLen(b));

        for (const route of candidates) {
            if (!isClean(route, item, connKey)) continue;
            bestRoutes.set(connKey, route);
            // Animate union-extend addition.
            if (emitConnChange) emitConnChange(connKey, route.path, route.vias, item.net);
            for (let p = 0; p < route.path.length - 1; p++) {
                const p1 = route.path[p], p2 = route.path[p + 1];
                if (p1.layer === p2.layer) {
                    hash.insert(p1.x, p1.y, p2.x, p2.y, halfTrace, item.net, p1.layer, connKey);
                }
            }
            for (const v of route.vias) {
                hash.insertPad(v.x, v.y, viaDiameter, viaDiameter, item.net, 'both',
                    { isVia: true, connId: connKey, shape: 'ellipse' });
            }
            added++;
            break;
        }
    }
    return added;
}

/**
 * Rip-up swap: break the greedy-union ceiling by trading existing routes
 * for missing-net routes when the trade nets a positive gain.
 *
 * For each missing connection M:
 *   For each candidate route Rm (from any trial that routed M), sorted by
 *   conflict-count ascending:
 *     - Identify the set S of existing routes in bestRoutes that conflict
 *       with Rm. Skip if |S| > MAX_SWAP_DROP, or if Rm conflicts with any
 *       static pad (pads are permanent — can't be swapped).
 *     - Tentatively swap: drop S, add Rm, then A* re-route each displaced
 *       route in S against the new state.
 *     - Net gain = 1 + |recovered| - |S|.  Track best swap across all
 *       (missing, candidate) pairs.
 * Apply the best swap; loop until no positive-gain swap exists.
 *
 * Mutates `bestRoutes` in place. Returns number of nets added (net gain
 * summed across applied swaps).
 */
async function ripUpSwap(bestRoutes, allTrialRoutes, connList, allPads, opts) {
    const {
        gridStep, traceWidth, clearance, viaDiameter, cellSize, viaRadius,
        routeBounds, greedyWeight, cancelToken, yieldToUI, padNetMap,
        emitConnChange, itemByKey: itemByKeyArg,
    } = opts;
    const halfTrace = traceWidth / 2;
    const MAX_SWAP_DROP = 3;
    const MAX_ROUNDS = 10;
    const EPS = 1e-4;

    const itemByKey = itemByKeyArg || (() => {
        const m = new Map();
        for (const item of connList) m.set(`${item.net}:${item.connIdx}`, item);
        return m;
    })();

    // Hash holds pads (no connId) + route segments/vias (tagged by connKey).
    // Pads stay forever; routes are mutated as swaps are evaluated.
    const hash = new SpatialHash(cellSize);
    for (const pad of allPads) {
        hash.insertPad(pad.x, pad.y, pad.width, pad.height, pad.id, pad.layer || 'both', { shape: pad.shape });
    }

    const insertRoute = (route, item, connKey) => {
        for (let p = 0; p < route.path.length - 1; p++) {
            const p1 = route.path[p], p2 = route.path[p + 1];
            if (p1.layer === p2.layer) {
                hash.insert(p1.x, p1.y, p2.x, p2.y, halfTrace, item.net, p1.layer, connKey);
            }
        }
        for (const v of route.vias) {
            hash.insertPad(v.x, v.y, viaDiameter, viaDiameter, item.net, 'both',
                { isVia: true, connId: connKey, shape: 'ellipse' });
        }
    };

    for (const [connKey, route] of bestRoutes) {
        if (!route) continue;
        const item = itemByKey.get(connKey);
        if (!item) continue;
        insertRoute(route, item, connKey);
    }

    // Find conflicts for a candidate route. Returns:
    //   { keys: Set<connKey> of conflicting bestRoutes, hasPadConflict: bool }
    // A pad conflict means the candidate can't ever fit — skip it.
    const findConflicts = (route, item, mKey) => {
        const skipIds = new Set([mKey]);
        for (const id of item.skipIds) skipIds.add(id);
        const conflicts = new Set();
        let hasPadConflict = false;
        const queryClear = halfTrace + clearance;

        // Trace segments
        for (let p = 0; p < route.path.length - 1; p++) {
            if (hasPadConflict) break;
            const p1 = route.path[p], p2 = route.path[p + 1];
            if (p1.layer !== p2.layer) continue;
            const ax1 = p1.x, ay1 = p1.y, ax2 = p2.x, ay2 = p2.y;
            const minSX = Math.min(ax1, ax2), maxSX = Math.max(ax1, ax2);
            const minSY = Math.min(ay1, ay2), maxSY = Math.max(ay1, ay2);
            const cxMin = Math.floor((minSX - queryClear) / hash.cellSize) - 1;
            const cxMax = Math.floor((maxSX + queryClear) / hash.cellSize) + 1;
            const cyMin = Math.floor((minSY - queryClear) / hash.cellSize) - 1;
            const cyMax = Math.floor((maxSY + queryClear) / hash.cellSize) + 1;
            for (let cx = cxMin; cx <= cxMax; cx++) {
                for (let cy = cyMin; cy <= cyMax; cy++) {
                    const objs = hash.cells.get(hash._key(cx, cy));
                    if (!objs) continue;
                    for (const obj of objs) {
                        if (obj.isPad && !obj.connId) {
                            // Static pad
                            const padLayer = obj.layer || 'both';
                            if (padLayer !== 'both' && padLayer !== p1.layer) continue;
                            if (item.skipIds.has(obj.net)) continue; // own endpoint
                            const padNetSet = padNetMap.get(obj.net);
                            if (padNetSet && padNetSet.has(item.net)) continue; // same-net pad
                            if (padSegmentBlocked(ax1, ay1, ax2, ay2, obj, queryClear - EPS)) {
                                hasPadConflict = true;
                            }
                        } else if (obj.connId && !skipIds.has(obj.connId)) {
                            if (obj.net === item.net) continue; // same-net trace/via
                            if (obj.isPad) {
                                // Via in route
                                if (padSegmentBlocked(ax1, ay1, ax2, ay2, obj, queryClear)) {
                                    conflicts.add(obj.connId);
                                }
                            } else {
                                if (obj.layer && obj.layer !== p1.layer) continue;
                                const d = segmentToSegmentDist(ax1, ay1, ax2, ay2, obj.x1, obj.y1, obj.x2, obj.y2);
                                if (d < obj.hw + queryClear) conflicts.add(obj.connId);
                            }
                        }
                    }
                }
            }
        }

        // Vias
        if (!hasPadConflict) {
            for (const via of route.vias) {
                if (hasPadConflict) break;
                const maxThresh = Math.max(viaRadius + halfTrace + clearance, 2 * viaRadius + clearance);
                const cxMin = Math.floor((via.x - maxThresh) / hash.cellSize) - 1;
                const cxMax = Math.floor((via.x + maxThresh) / hash.cellSize) + 1;
                const cyMin = Math.floor((via.y - maxThresh) / hash.cellSize) - 1;
                const cyMax = Math.floor((via.y + maxThresh) / hash.cellSize) + 1;
                for (let cx = cxMin; cx <= cxMax; cx++) {
                    for (let cy = cyMin; cy <= cyMax; cy++) {
                        const objs = hash.cells.get(hash._key(cx, cy));
                        if (!objs) continue;
                        for (const obj of objs) {
                            if (obj.isPad && !obj.connId) {
                                if (item.skipIds.has(obj.net)) continue;
                                const padNetSet = padNetMap.get(obj.net);
                                if (padNetSet && padNetSet.has(item.net)) continue;
                                if (padPointBlocked(via.x, via.y, obj, viaRadius + clearance - EPS)) {
                                    hasPadConflict = true;
                                }
                            } else if (obj.connId && !skipIds.has(obj.connId)) {
                                if (obj.net === item.net) continue;
                                if (obj.isPad) {
                                    const d = Math.hypot(via.x - obj.cx, via.y - obj.cy);
                                    if (d < 2 * viaRadius + clearance) conflicts.add(obj.connId);
                                } else {
                                    const d = pointToSegmentDist(via.x, via.y, obj.x1, obj.y1, obj.x2, obj.y2);
                                    if (d < viaRadius + obj.hw + clearance) conflicts.add(obj.connId);
                                }
                            }
                        }
                    }
                }
            }
        }
        return { keys: conflicts, hasPadConflict };
    };

    const tryReroute = async (item) => {
        if (cancelToken?.cancelled) return null;
        return await astarRouteAnyEndpoint(
            item.from, item.to,
            hash, item.skipIds, gridStep, traceWidth, clearance,
            greedyWeight, true,
            item.startLayer, item.endLayer,
            {
                cancelToken,
                yieldToUI,
                bounds: routeBounds,
                viaRadius,
                routingNet: item.net,
            },
        );
    };

    let totalAdded = 0;
    let round = 0;
    while (true) {
        round++;
        if (round > MAX_ROUNDS) break;
        if (cancelToken?.cancelled) break;

        const missing = connList.filter(item => !bestRoutes.get(`${item.net}:${item.connIdx}`));
        if (missing.length === 0) break;

        /** @type {null | {gain, mItem, mKey, cand, displaced, recovered}} */
        let bestSwap = null;
        outer: for (const mItem of missing) {
            if (cancelToken?.cancelled) break;
            const mKey = `${mItem.net}:${mItem.connIdx}`;

            // Collect candidates from all trials (dedup by signature).
            const seen = new Set();
            const candidates = [];
            for (const trialMap of allTrialRoutes) {
                const r = trialMap.get(mKey);
                if (!r) continue;
                const sig = `${r.path[0].x},${r.path[0].y}|${r.path[r.path.length - 1].x},${r.path[r.path.length - 1].y}|${r.path.length}|${r.vias.length}`;
                if (seen.has(sig)) continue;
                seen.add(sig);
                candidates.push(r);
            }

            // Pre-score: skip pad-conflicting, skip > MAX_SWAP_DROP, sort by conflict count.
            const scored = [];
            for (const cand of candidates) {
                const info = findConflicts(cand, mItem, mKey);
                if (info.hasPadConflict) continue;
                if (info.keys.size > MAX_SWAP_DROP) continue;
                scored.push({ cand, conflicts: info.keys, len: pathLen(cand) });
            }
            scored.sort((a, b) => (a.conflicts.size - b.conflicts.size) || (a.len - b.len));

            for (const sc of scored) {
                if (cancelToken?.cancelled) break outer;
                const { cand, conflicts } = sc;

                if (conflicts.size === 0) {
                    // No-conflict candidate (union-extend should have caught it earlier;
                    // can happen if state changed after a prior swap freed space).
                    bestSwap = { gain: 1, mItem, mKey, cand, displaced: new Map(), recovered: new Map() };
                    break outer;
                }

                // Tentatively swap: remove conflicts from hash, add cand.
                const displaced = new Map();
                for (const ck of conflicts) {
                    displaced.set(ck, bestRoutes.get(ck));
                    hash.removeConnection(ck);
                }
                insertRoute(cand, mItem, mKey);

                // Try to re-route each displaced net.
                const recovered = new Map();
                for (const ck of conflicts) {
                    const origItem = itemByKey.get(ck);
                    if (!origItem) continue;
                    const result = await tryReroute(origItem);
                    if (result?.path?.length > 0) {
                        const r = { path: result.path, vias: result.vias || [], net: origItem.net };
                        recovered.set(ck, r);
                        insertRoute(r, origItem, ck);
                    }
                }
                const gain = 1 - conflicts.size + recovered.size;

                // Roll back tentative state.
                for (const ck of recovered.keys()) hash.removeConnection(ck);
                hash.removeConnection(mKey);
                for (const [ck, route] of displaced) {
                    insertRoute(route, itemByKey.get(ck), ck);
                }

                if (gain > 0 && (!bestSwap || gain > bestSwap.gain)) {
                    bestSwap = { gain, mItem, mKey, cand, displaced, recovered };
                    if (gain >= 2) break outer; // very good, take it now
                }
                await yieldToUI?.();
            }
        }

        if (!bestSwap) break;

        // Apply best swap permanently.
        for (const ck of bestSwap.displaced.keys()) {
            hash.removeConnection(ck);
            bestRoutes.set(ck, null);
            // Animate the displaced route's rip.
            const it = itemByKey.get(ck);
            if (emitConnChange && it) emitConnChange(ck, null, [], it.net);
        }
        insertRoute(bestSwap.cand, bestSwap.mItem, bestSwap.mKey);
        bestRoutes.set(bestSwap.mKey, bestSwap.cand);
        // Animate the newly placed route.
        if (emitConnChange) emitConnChange(bestSwap.mKey, bestSwap.cand.path, bestSwap.cand.vias, bestSwap.mItem.net);
        for (const [ck, route] of bestSwap.recovered) {
            insertRoute(route, itemByKey.get(ck), ck);
            bestRoutes.set(ck, route);
            // Animate each recovered route.
            const it = itemByKey.get(ck);
            if (emitConnChange && it) emitConnChange(ck, route.path, route.vias, it.net);
        }
        totalAdded += bestSwap.gain;
        console.info(`[pathfinder] rip-up swap round ${round}: added ${bestSwap.mKey}, displaced ${bestSwap.displaced.size}, recovered ${bestSwap.recovered.size}, gain=+${bestSwap.gain}`);
    }

    return totalAdded;
}

/**
 * Negotiated-congestion (Pathfinder) autorouter.
 *
 * Replaces the rip-up loop of `routeAll` with an iterative negotiation:
 *
 *   for each iteration:
 *       clear the per-iteration demand grid (history persists)
 *       for each connection (in order):
 *           route via A* using a cost function = history + p·overuse
 *           record this route's demand in the grid
 *       if no cell is overused: CONVERGED, done
 *       accumulate history for overused cells
 *       presentFactor p *= 2
 *
 * Pads are the only hard obstacles; traces never block other traces.
 * Conflicts are resolved by the negotiation, not by rip-up.
 *
 * Returns the same shape as routeAll (traces, vias, failed*, counts) but
 * with extra `pathfinder*` diagnostics. NOTE: if the loop hits MAX_ITERATIONS
 * without converging, some traces in the output may still overlap each other;
 * the clearance check will report those as violations and they should be
 * treated as failed connections.
 *
 * @param {Object} input - same shape as routeAll's input
 * @param {Object} [options]
 */
export async function routeAllPathfinder(input, options = {}) {
    const {
        cancelToken = null,
        yieldToUI = async () => {},
        onProgress = null,
        onTrying = null,
        onNetRouted = null,
        onNetFailed = null,
        onConnRipped = null,
        onNetPendingChanged = null,
        // Tuning notes:
        //  - initialPresentFactor small + presentFactorGrowth ≤ 1.5: avoids
        //    over-perturbing the system early, gives nets time to settle.
        //  - historyGrowth ≥ presentFactorGrowth: chronic congestion becomes
        //    persistent enough that nets permanently route around hot spots
        //    rather than oscillating in/out each iteration.
        //  - maxIterations: 25 gives enough rounds for history to dominate.
        maxIterations = 25,
        initialPresentFactor = 0.3,
        presentFactorGrowth = 1.4,
        historyGrowth = 2.0,
        greedyWeight = 1.5,
    } = options;

    // Progress budget: total = iters + trial budget + postprocess budget.
    // Sub-iter progress reports fractional `done` so the UI bar moves
    // smoothly (each pathfinder iter is multiple seconds, sometimes minutes
    // on large boards, so per-iter ticks alone leave the user staring at a
    // frozen bar).
    const PROGRESS_TRIAL_BUDGET = 5;
    const PROGRESS_POST_BUDGET = 2;
    const progressTotal = maxIterations + PROGRESS_TRIAL_BUDGET + PROGRESS_POST_BUDGET;

    // ── Validate inputs ──
    const requirePositive = (name, value) => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
            throw new Error(`routeAllPathfinder: input.${name} must be a positive number, got ${value}`);
        }
        return value;
    };
    const traceWidth = requirePositive('traceWidth', input.traceWidth);
    const clearance = requirePositive('clearance', input.clearance);
    const viaDiameter = requirePositive('viaDiameter', input.viaDiameter);
    const gridStep = requirePositive('gridStep', input.gridStep);
    const viaRadius = viaDiameter / 2;
    const routeBounds = input.bounds &&
        Number.isFinite(input.bounds.minX) &&
        Number.isFinite(input.bounds.minY) &&
        Number.isFinite(input.bounds.maxX) &&
        Number.isFinite(input.bounds.maxY)
        ? input.bounds
        : null;
    const cellSize = Math.max(gridStep * 4, 2.0);

    // ── Build pad list + per-net pad-id lists ──
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

    const layersCompatible = (a, b) => {
        const la = a || 'both';
        const lb = b || 'both';
        return la === 'both' || lb === 'both' || la === lb;
    };
    const findMatchingPad = (cpad, usedIds) => {
        let best = null, bestScore = Infinity;
        for (const pad of allPads) {
            if (usedIds?.has(pad.id)) continue;
            if (Math.abs(pad.x - cpad.x) >= 0.01 || Math.abs(pad.y - cpad.y) >= 0.01) continue;
            const wDiff = Math.abs((pad.width ?? 0) - (cpad.width ?? pad.width ?? 0));
            const hDiff = Math.abs((pad.height ?? 0) - (cpad.height ?? pad.height ?? 0));
            const layerPenalty = layersCompatible(pad.layer, cpad.layer) ? 0 : 10;
            const score = layerPenalty + wDiff + hDiff;
            if (score < bestScore) { bestScore = score; best = pad; }
        }
        return best;
    };

    /** @type {Map<string, Array<Array<string>>>} net -> ordered list of pad-id groups (parallel to conn.pads). Each group holds primary + alternates. */
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

    // ── NNC reorder for multi-pin nets. Pathfinder uses nearest-neighbour-
    //    chain topology (the classic router uses MST instead — see the
    //    `connMap` block above). Tried MST here and the test-board.json
    //    clean count was unchanged at 68/76, but changing pathfinder
    //    topology has knock-on effects on negotiated-congestion
    //    convergence; out of scope for the visual-crossing fix. The chain
    //    mutates conn.pads in place and reorders the parallel
    //    netPadIdList; the classic router uses a side-channel
    //    `conn.edges` array instead. ──
    for (const conn of input.connections) {
        if (conn.pads.length < 3) continue;
        const perm = nncReorderPads(conn);
        if (perm) {
            const oldIds = netPadIdList.get(conn.net);
            if (oldIds) netPadIdList.set(conn.net, perm.map(i => oldIds[i]));
        }
    }

    // ── Build flat list of pad-pair connections ──
    /** @type {Array<{net,connIdx,from,to,skipIds,startLayer,endLayer}>} */
    const connList = [];
    for (const conn of input.connections) {
        if (conn.pads.length < 2) continue;
        const idList = netPadIdList.get(conn.net) || [];
        for (let i = 0; i < conn.pads.length - 1; i++) {
            const from = conn.pads[i];
            const to = conn.pads[i + 1];
            // Skip only the source + destination pad groups of THIS sub-route
            // (groups include alternates for multi-pad pins).
            const skipIds = new Set();
            for (const id of (idList[i] || [])) skipIds.add(id);
            for (const id of (idList[i + 1] || [])) skipIds.add(id);
            connList.push({
                net: conn.net,
                connIdx: i,
                from,
                to,
                skipIds,
                startLayer: from.layer || 'top',
                endLayer: to.layer || 'both',
            });
        }
    }
    const totalConns = connList.length;

    // Initial pending-count emission per net — drives ratsnest visibility in
    // the UI. Each net starts with (pads.length - 1) pending pad-pair routes;
    // pending decrements as each pair is successfully routed in iter 0.
    /** @type {Map<string, number>} */
    const netPending = new Map();
    for (const conn of input.connections) {
        if (conn.pads.length < 2) continue;
        const pending = conn.pads.length - 1;
        netPending.set(conn.net, pending);
        onNetPendingChanged?.(conn.net, pending);
    }

    onProgress?.(0, progressTotal, 'Pathfinder starting', {
        phase: 'pathfinder',
        pendingConnections: totalConns,
    });

    // ── Build pads-only obstacle hash (rebuilt fresh every iteration would be
    //    wasteful; pads never change, so build once and reuse). Reused as the
    //    shared `padHash` for cell-localised pad-conflict checks in
    //    unionExtend / ripUpSwap / geometricVerifyAndDrop. ──
    const obstacles = new SpatialHash(cellSize);
    for (const pad of allPads) {
        obstacles.insertPad(pad.x, pad.y, pad.width, pad.height, pad.id, pad.layer || 'both', { shape: pad.shape });
    }

    // ── Pad-net map: padId -> Set<net names that use this pad>. Built once
    //    from netPadIdList (flattening each group of primary+alternates);
    //    replaces per-call position-keyed maps in the extract / verify /
    //    union / swap helpers. ──
    /** @type {Map<string, Set<string>>} */
    const padNetMap = new Map();
    for (const [net, idList] of netPadIdList) {
        for (const group of idList) {
            if (!group) continue;
            for (const id of group) {
                if (!id) continue;
                let set = padNetMap.get(id);
                if (!set) { set = new Set(); padNetMap.set(id, set); }
                set.add(net);
            }
        }
    }

    // ── Pathfinder iteration ──
    const pfGrid = new PathfinderGrid(gridStep);
    /** @type {Map<string, {path, vias, net} | null>} connKey -> result (current iter) */
    const routes = new Map();
    let presentFactor = initialPresentFactor;
    let iter = 0;
    let converged = false;
    const iterationStats = [];

    // Best-iteration snapshot: emit routes from the iteration with the lowest
    // overuse count, not the last. Pathfinder schedules can oscillate, and
    // the most-converged snapshot is often not the final one.
    let bestOverused = Infinity;
    let bestIter = -1;
    /** @type {Map<string, {path, vias, net} | null> | null} */
    let bestRoutes = null;

    // Top-K snapshots by overusedCells (lowest first). Multi-snapshot trial
    // extraction picks the snapshot with the best post-extraction yield —
    // which is NOT always the lowest-overuse one (a snapshot whose conflicts
    // are concentrated in one channel may force many drops, while a snapshot
    // with conflicts spread out can be pruned more cheaply).
    const SNAPSHOT_LIMIT = 5;
    /** @type {Array<{iter:number, overused:number, routes: Map<string, {path,vias,net}|null>}>} */
    const topSnapshots = [];

    // Always-include early iterations (weak negotiation pressure → routes are
    // near-optimal and geographically spread out → conflicts spread across
    // many small zones → extract drops fewer connections). Empirically the
    // best yield on test-board.json comes from iter=4 (within the first 5);
    // 8 gives margin for other boards without adding many slow trials.
    const EARLY_ITER_KEEP = 8;
    /** @type {Array<{iter:number, overused:number, routes: Map<string, {path,vias,net}|null>}>} */
    const earlySnapshots = [];

    // ── Live animation state ──
    // Hash of the last path we emitted to the UI for each connection. Used to
    // skip re-emitting netRouted when the path is identical iter-over-iter
    // (avoids ~1900 redundant DOM updates on test-board.json), while still
    // showing the "machine thinking" effect when negotiated congestion makes
    // a route shift, rip up, or newly succeed.
    /** @type {Map<string, string>} connKey -> path hash (empty string = currently unrouted) */
    const lastEmittedPathHash = new Map();

    /** Hash a path for cheap iter-over-iter change detection. */
    const hashPath = (path) => {
        if (!path || path.length === 0) return '';
        let h = '';
        for (const p of path) h += `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.layer || 't'}|`;
        return h;
    };

    /**
     * Emit per-conn animation events on transitions only. Idempotent: calling
     * with an unchanged path is a no-op. Used by the iter loop AND threaded
     * into the trial phase (extractAndReroute / unionExtend / ripUpSwap) via
     * opts so trial drops + re-routes also animate.
     *
     * @param {string} connKey
     * @param {Array<{x,y,layer}>|null} newPath - null/empty = unrouted
     * @param {Array<{x,y}>} [vias]
     * @param {string} net
     */
    const emitConnChange = (connKey, newPath, vias, net) => {
        const newHash = hashPath(newPath);
        const oldHash = lastEmittedPathHash.get(connKey) || '';
        if (newHash === oldHash) return;
        const wasRouted = oldHash !== '';
        const isRouted = newHash !== '';
        if (isRouted) {
            const traces = buildConnTracesFromPath(newPath, net, connKey, vias || []);
            onNetRouted?.(traces);
            if (!wasRouted) {
                const prev = netPending.get(net) || 0;
                const next = Math.max(0, prev - 1);
                netPending.set(net, next);
                onNetPendingChanged?.(net, next);
            }
        } else {
            onConnRipped?.(connKey);
            if (wasRouted) {
                const prev = netPending.get(net) || 0;
                const next = prev + 1;
                netPending.set(net, next);
                onNetPendingChanged?.(net, next);
            }
        }
        lastEmittedPathHash.set(connKey, newHash);
    };

    for (iter = 0; iter < maxIterations; iter++) {
        if (cancelToken?.cancelled) break;

        // Keep stable original ordering across iterations. History/present-cost
        // negotiation is the convergence mechanism, not order shuffling.
        const orderedConnList = connList;

        pfGrid.clearDemand();
        const cellCostFn = (x, y, layer) => pfGrid.cellCost(x, y, layer, presentFactor);

        let routedThisIter = 0;
        for (let connIdx = 0; connIdx < orderedConnList.length; connIdx++) {
            const item = orderedConnList[connIdx];
            if (cancelToken?.cancelled) break;
            // Sub-iter progress every 8 connections — pathfinder iters can
            // be many seconds long on dense boards, so per-iter ticks alone
            // leave the progress bar appearing stuck.
            if ((connIdx & 7) === 0) {
                onProgress?.(
                    iter + (connIdx / orderedConnList.length),
                    progressTotal,
                    `Pathfinder iter ${iter + 1}/${maxIterations}: ${item.net}`,
                    { phase: 'pathfinder', pendingConnections: Math.max(0, orderedConnList.length - connIdx) }
                );
            }
            // Iter-0 emits onTrying for every conn (initial-pass animation,
            // mirrors classic router). Later iters skip the trying-flash
            // because the trace is already drawn and a flash before each
            // tentative re-route would just thrash the rats layer.
            if (iter === 0) {
                onTrying?.(item.from, item.to);
            }
            const result = await astarRouteAnyEndpoint(
                item.from, item.to,
                obstacles, item.skipIds, gridStep, traceWidth, clearance,
                greedyWeight, /* allowVias */ true,
                item.startLayer, item.endLayer,
                {
                    cancelToken,
                    yieldToUI,
                    bounds: routeBounds,
                    viaRadius,
                    cellCostFn,
                    routingNet: item.net,
                }
            );

            const connKey = `${item.net}:${item.connIdx}`;
            const newPath = result?.path?.length > 0 ? result.path : null;

            if (newPath) {
                routes.set(connKey, { path: newPath, vias: result.vias || [], net: item.net });
                routedThisIter++;
                // Record this net's demand so subsequent nets in this iter
                // negotiate against it.
                for (let p = 0; p < newPath.length - 1; p++) {
                    const p1 = newPath[p], p2 = newPath[p + 1];
                    if (p1.layer === p2.layer) {
                        pfGrid.recordSegment(p1.x, p1.y, p2.x, p2.y, p1.layer, item.net);
                    }
                }
                for (const v of result.vias || []) pfGrid.recordVia(v.x, v.y, item.net);
            } else {
                routes.set(connKey, null);
            }

            // ── Live animation: emit only on iter-over-iter changes ──
            // Diff vs. lastEmittedPathHash so unchanged routes don't cause UI
            // churn. Transitions:
            //   unrouted → routed : onNetRouted + onNetPendingChanged(--)
            //   routed   → routed (different path) : onNetRouted (UI clears
            //     old trace by connId then renders new)
            //   routed   → unrouted : onConnRipped + onNetPendingChanged(++)
            //   unrouted → unrouted (still failing) : silent
            const wasRoutedPre = (lastEmittedPathHash.get(connKey) || '') !== '';
            emitConnChange(connKey, newPath, result?.vias || [], item.net);
            if (iter === 0 && wasRoutedPre === false && !newPath) {
                // First-pass failure: flash red feedback like classic router's
                // initial pass. Subsequent iters skip the flash because the
                // rat reappearing already signals "unrouted".
                onNetFailed?.({ net: item.net, pads: [item.from, item.to] });
            }
            await yieldToUI();
        }

        const overusedCells = pfGrid.countOverused();
        const overusedNets = pfGrid.overusedNets().size;

        iterationStats.push({ iter, routed: routedThisIter, overusedCells, overusedNets, presentFactor });
        console.info(`[pathfinder] iter ${iter}: routed=${routedThisIter}/${totalConns}, overused cells=${overusedCells}, conflicted nets=${overusedNets}, pf=${presentFactor.toFixed(3)}`);
        onProgress?.(
            iter + 1,
            progressTotal,
            `Pathfinder iter ${iter + 1}/${maxIterations}: ${overusedCells} overused`,
            { phase: 'pathfinder', pendingConnections: overusedNets }
        );

        // Track best-so-far snapshot for emission.
        if (overusedCells < bestOverused) {
            bestOverused = overusedCells;
            bestIter = iter;
            bestRoutes = new Map(routes);
        }

        // Maintain top-K snapshots (lowest overusedCells). Snapshotting
        // copies the routes map (cheap — entries reference shared {path, vias}
        // objects) so it survives the next clearDemand pass.
        if (topSnapshots.length < SNAPSHOT_LIMIT || overusedCells < topSnapshots[topSnapshots.length - 1].overused) {
            topSnapshots.push({ iter, overused: overusedCells, routes: new Map(routes) });
            topSnapshots.sort((a, b) => a.overused - b.overused);
            if (topSnapshots.length > SNAPSHOT_LIMIT) topSnapshots.length = SNAPSHOT_LIMIT;
        }

        // Always keep the first EARLY_ITER_KEEP iterations as candidates.
        if (iter < EARLY_ITER_KEEP) {
            earlySnapshots.push({ iter, overused: overusedCells, routes: new Map(routes) });
        }

        if (overusedCells === 0 && routedThisIter === totalConns) {
            converged = true;
            console.info(`[pathfinder] CONVERGED at iter ${iter}`);
            break;
        }

        pfGrid.accumulateHistory(historyGrowth);
        presentFactor *= presentFactorGrowth;
    }

    // ── Multi-snapshot trial extraction ──
    // Lowest-overuse snapshot is NOT always the best for post-extraction
    // yield: a snapshot whose conflicts are concentrated in one channel may
    // force many drops, while a snapshot with conflicts spread out can be
    // pruned more cheaply. Try the top-K candidates and pick whichever
    // yields the most routed connections after extraction + re-route.
    const candidateSnapshots = [];
    const seenIters = new Set();
    const addCandidate = (snapIter, overused, snapRoutes) => {
        if (seenIters.has(snapIter)) return;
        seenIters.add(snapIter);
        candidateSnapshots.push({ iter: snapIter, overused, routes: snapRoutes });
    };
    if (converged) {
        addCandidate(iter, 0, routes);
    } else {
        // Early-iter snapshots first (often best by yield).
        for (const snap of earlySnapshots) addCandidate(snap.iter, snap.overused, snap.routes);
        // Then top-K by overuse (lowest first).
        for (const snap of topSnapshots) addCandidate(snap.iter, snap.overused, snap.routes);
        // Also include the LAST snapshot if not already present — sometimes
        // the post-history schedule lands on something useful at the end.
        if (iterationStats.length > 0) {
            const lastIter = iterationStats[iterationStats.length - 1].iter;
            const lastOveruse = iterationStats[iterationStats.length - 1].overusedCells;
            addCandidate(lastIter, lastOveruse, routes);
        }
    }

    let bestCleanRouted = -1;
    let bestFinalRoutes = null;
    let bestTrialInfo = null;
    const allTrialRoutes = []; // for union-extend
    const trialBudget = Math.max(1, candidateSnapshots.length);
    let trialIdx = 0;
    // Shared lookup so trial functions can resolve connKey → item.net for
    // emit-change calls without rebuilding it each call.
    const connItemByKey = new Map();
    for (const item of connList) connItemByKey.set(`${item.net}:${item.connIdx}`, item);
    for (const snap of candidateSnapshots) {
        if (cancelToken?.cancelled) break;
        trialIdx++;
        onProgress?.(
            maxIterations + (trialIdx / trialBudget) * PROGRESS_TRIAL_BUDGET,
            progressTotal,
            `Pathfinder trial ${trialIdx}/${candidateSnapshots.length} (iter ${snap.iter})`,
            { phase: 'pathfinder', pendingConnections: Math.max(0, totalConns - Math.max(0, bestCleanRouted)) }
        );
        const trial = await extractAndReroute(
            snap.routes, connList, allPads,
            { gridStep, traceWidth, clearance, viaDiameter, cellSize, viaRadius, routeBounds, greedyWeight, cancelToken, yieldToUI, padHash: obstacles, padNetMap, emitConnChange, itemByKey: connItemByKey },
        );
        console.info(`[pathfinder] trial snapshot iter=${snap.iter} overused=${snap.overused}: dropped=${trial.dropped} recovered=${trial.recovered} routed=${trial.routed}/${totalConns} cleanRouted=${trial.cleanRouted} violators=${trial.violators}`);
        allTrialRoutes.push(trial.finalRoutes);
        if (trial.cleanRouted > bestCleanRouted) {
            bestCleanRouted = trial.cleanRouted;
            bestFinalRoutes = trial.finalRoutes;
            bestTrialInfo = {
                iter: snap.iter,
                overused: snap.overused,
                dropped: trial.dropped,
                recovered: trial.recovered,
                routed: trial.routed,
                cleanRouted: trial.cleanRouted,
                violators: trial.violators,
            };
            // A2: if this trial already routes every connection cleanly there
            // is no information left for further trials to add. Skip them to
            // save (potentially many) seconds of redundant extraction work.
            if (trial.cleanRouted === totalConns) {
                console.info(`[pathfinder] trial reached cleanRouted=${totalConns}/${totalConns}; short-circuiting remaining trials`);
                break;
            }
        }
    }

    // Union-extend: try to import cleanly-routed nets from OTHER trials for
    // connections the winning trial didn't route. Each candidate is
    // geometrically verified against the current extended set; only
    // conflict-free imports are accepted.
    let unionAdded = 0;
    if (bestFinalRoutes && allTrialRoutes.length > 1 && !cancelToken?.cancelled) {
        onProgress?.(
            maxIterations + PROGRESS_TRIAL_BUDGET + 0.5,
            progressTotal,
            'Pathfinder union-extend',
            { phase: 'pathfinder', pendingConnections: Math.max(0, totalConns - Math.max(0, bestCleanRouted)) }
        );
        unionAdded = unionExtend(bestFinalRoutes, allTrialRoutes, connList, allPads,
            { traceWidth, clearance, viaDiameter, cellSize, padHash: obstacles, padNetMap, emitConnChange, itemByKey: connItemByKey });
        if (unionAdded > 0) {
            bestCleanRouted += unionAdded;
            console.info(`[pathfinder] union-extend added ${unionAdded} nets across ${allTrialRoutes.length} trials → final cleanRouted=${bestCleanRouted}/${totalConns}`);
        } else {
            console.info(`[pathfinder] union-extend added 0 nets`);
        }
    }

    // Rip-up swap: greedy union ceilings out when every candidate for a
    // missing net conflicts with some existing route. Here we tentatively
    // drop the conflicting routes, place the candidate, and try to A*
    // re-route the displaced ones against the new state. We accept a swap
    // only when (1 + |recovered|) − |displaced| > 0.
    let swapAdded = 0;
    if (bestFinalRoutes && allTrialRoutes.length > 0 && !cancelToken?.cancelled) {
        onProgress?.(
            maxIterations + PROGRESS_TRIAL_BUDGET + 1.5,
            progressTotal,
            'Pathfinder rip-up swap',
            { phase: 'pathfinder', pendingConnections: Math.max(0, totalConns - Math.max(0, bestCleanRouted)) }
        );
        swapAdded = await ripUpSwap(bestFinalRoutes, allTrialRoutes, connList, allPads, {
            gridStep, traceWidth, clearance, viaDiameter, cellSize, viaRadius,
            routeBounds, greedyWeight, cancelToken, yieldToUI, padNetMap,
            emitConnChange, itemByKey: connItemByKey,
        });
        if (swapAdded > 0) {
            bestCleanRouted += swapAdded;
            console.info(`[pathfinder] rip-up swap added ${swapAdded} nets -> final cleanRouted=${bestCleanRouted}/${totalConns}`);
        } else {
            console.info(`[pathfinder] rip-up swap added 0 nets`);
        }
    }

    onProgress?.(
        progressTotal,
        progressTotal,
        'Pathfinder finalising',
        { phase: 'pathfinder', pendingConnections: Math.max(0, totalConns - Math.max(0, bestCleanRouted)) }
    );

    const finalRoutes = bestFinalRoutes || (converged ? routes : (bestRoutes || routes));
    if (bestTrialInfo) {
        console.info(`[pathfinder] emitting trial from iter ${bestTrialInfo.iter} (overused=${bestTrialInfo.overused}, dropped=${bestTrialInfo.dropped}, recovered=${bestTrialInfo.recovered}, routed=${bestTrialInfo.routed}, violators=${bestTrialInfo.violators}, trialClean=${bestTrialInfo.cleanRouted}, unionAdded=${unionAdded}, swapAdded=${swapAdded}, finalClean=${bestCleanRouted}/${totalConns})`);
    }

    // Cosmetic smoothing: collapse grid staircases via line-of-sight
    // simplification against the final pad+route obstacle set. Purely
    // geometric — no routing decisions are revisited.
    if (!cancelToken?.cancelled) {
        const smoothInfo = smoothPathfinderRoutes(finalRoutes, connList, {
            traceWidth, clearance, viaDiameter, cellSize, padHash: obstacles,
        });
        console.info(`[pathfinder] smoothing: ${smoothInfo.smoothed} routes simplified, ${smoothInfo.segmentsRemoved} waypoints removed`);
    }

    // ── Build result ──
    const allTraces = [];
    const allVias = [];
    let failedCount = 0;
    const failedConnections = [];

    for (const item of connList) {
        const connKey = `${item.net}:${item.connIdx}`;
        const route = finalRoutes.get(connKey);
        if (!route) {
            failedCount++;
            failedConnections.push({
                net: item.net,
                from: { x: item.from.x, y: item.from.y },
                to: { x: item.to.x, y: item.to.y },
            });
            continue;
        }
        // Split the A* path into per-layer trace segments at via boundaries.
        const path = route.path;
        let segStart = 0;
        for (let i = 1; i <= path.length - 1; i++) {
            const layerChanged = path[i].layer !== path[i - 1].layer;
            const isLast = i === path.length - 1;
            if (layerChanged || isLast) {
                const endIdx = layerChanged ? i - 1 : i;
                if (endIdx > segStart) {
                    const points = [];
                    for (let k = segStart; k <= endIdx; k++) {
                        points.push({ x: path[k].x, y: path[k].y });
                    }
                    allTraces.push({
                        net: route.net,
                        points,
                        layer: path[segStart].layer || 'top',
                    });
                }
                if (layerChanged) segStart = i;
            }
        }
        for (const v of route.vias) {
            allVias.push({ net: route.net, x: v.x, y: v.y });
        }
    }

    // Aggregate net-level fail set (nets where ANY pad-pair failed).
    const failedNetSet = new Set();
    for (const fc of failedConnections) failedNetSet.add(fc.net);
    const failedNets = [...failedNetSet];

    return {
        traces: allTraces,
        vias: allVias,
        failed: failedNets,
        failedConnections,
        failedConnectionCount: failedCount,
        totalConnectionCount: totalConns,
        // Pathfinder-specific diagnostics
        pathfinderConverged: converged,
        pathfinderIterations: iter + (converged ? 1 : 0),
        pathfinderIterationStats: iterationStats,
        // Iteration whose snapshot was actually emitted (after multi-snapshot trial).
        pathfinderEmittedIter: converged ? iter : (bestTrialInfo ? bestTrialInfo.iter : bestIter),
        pathfinderEmittedOverusedCells: converged
            ? 0
            : (bestTrialInfo ? bestTrialInfo.overused : (bestIter >= 0 ? iterationStats[bestIter].overusedCells : 0)),
        pathfinderEmittedOverusedNets: converged
            ? 0
            : (bestIter >= 0 ? iterationStats[bestIter].overusedNets : 0),
        // Multi-snapshot trial stats
        pathfinderTrialCandidates: candidateSnapshots.length,
        pathfinderTrialDropped: bestTrialInfo ? bestTrialInfo.dropped : 0,
        pathfinderTrialRecovered: bestTrialInfo ? bestTrialInfo.recovered : 0,
        // Last-iteration stats (may differ from emitted if a worse iter ran after the best)
        pathfinderFinalOverusedCells: iterationStats.length > 0
            ? iterationStats[iterationStats.length - 1].overusedCells
            : 0,
        pathfinderFinalOverusedNets: iterationStats.length > 0
            ? iterationStats[iterationStats.length - 1].overusedNets
            : 0,
    };
}


/**
 * Negotiated-congestion (Pathfinder) autorouter entrypoint.
 */
export async function routeWithPathfinderRouter(input, options = {}) {
    return routeAllPathfinder(input, options);
}
