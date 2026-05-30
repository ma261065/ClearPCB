// @ts-nocheck — SpatialHash uses runtime type narrowing (obj.isPad) that JSDoc cannot express
/**
 * ClearPCB Autorouter — Shared Infrastructure
 *
 * Common building blocks used by both routers:
 *   - autorouter-maze.js       (rip-up-and-reroute weighted A*)
 *   - autorouter-pathfinder.js (negotiated-congestion pathfinder)
 *
 * Contents:
 *   - Binary min-heap (A* priority queue)
 *   - SpatialHash (obstacle spatial index)
 *   - Geometry helpers (pad-inside / pad-near / segment intersection / distance)
 *   - Pad blocking predicates (point and segment vs. rect/ellipse pads)
 *   - CongestionGrid and PathfinderGrid (cell-based cost accumulation)
 *   - Node-key packing for A* (x,y,layer → int)
 *   - astarRoute / astarProbe (cost-based and crossing-aware searches)
 *   - Angle validation, path simplification, sanitisation
 *   - RouteInput / RouteResult typedefs (the contract both routers honour)inline & delete
 * 
 */

/**
 * @typedef {Object} RouteInput
 * @property {Array<{net: string, pads: Array<{x: number, y: number, width: number, height: number, layer?: ('top'|'bottom'|'both'), shape?: ('rect'|'ellipse'), alternates?: Array<{x: number, y: number, width: number, height: number, layer?: ('top'|'bottom'|'both'), shape?: ('rect'|'ellipse')}>}>}>} connections
 *   Each connection pad's `alternates` array (optional) lists physically
 *   distinct pads that share the same logical pin (e.g. thermal/centre
 *   pads of TQFN/SOIC-with-EP). The router treats reaching the primary OR
 *   any alternate as a successful route, and exempts all of them from
 *   same-net clearance via skipIds. Omit / leave empty for ordinary
 *   single-pad pins.
 *   Each pad may specify `layer` ('top'|'bottom'|'both', default 'top' at routing time)
 *   and `shape` ('rect'|'ellipse', default 'rect'). Ellipse pads use elliptical
 *   blocking; rect pads use AABB.
 * @property {Array<{x: number, y: number, width: number, height: number, layer?: string, shape?: string}>} [allObstaclePads] - ALL component pads (including unconnected)
 * @property {number} traceWidth - trace width in mm (required)
 * @property {number} clearance - clearance in mm (required)
 * @property {number} viaDiameter - via diameter in mm (required)
 * @property {number} gridStep - routing grid step in mm (required)
 * @property {{minX: number, minY: number, maxX: number, maxY: number}} bounds
 */

/**
 * @typedef {Object} RouteResult
 * @property {Array<{net: string, points: Array<{x: number, y: number}>, layer: string}>} traces
 * @property {string[]} failed - net names that couldn't be routed
 * @property {number} [failedConnectionCount] - number of unrouted connections
 * @property {number} [totalConnectionCount] - total connections
 * @property {Array<{net: string, x: number, y: number}>} [vias] - via locations
 * @property {number} [ripupProbeMissCount] - number of probe attempts that found no path
 * @property {number} [ripupConnFallbackCount] - number of probe misses recovered by connId direct blockers
 * @property {number} [ripupCompatibilityFallbackCount] - how often net-level fallback was used in rip-up
 * @property {number} [ripupBlockersFromProbeCount] - unique blocker IDs contributed by probe results
 * @property {number} [ripupBlockersFromConnFallbackCount] - unique blocker IDs contributed by conn-level fallback
 * @property {number} [ripupBlockersFromCompatibilityFallbackCount] - unique blocker IDs contributed by net-level compatibility fallback
 * @property {number} [connectionOnlyRerouteAttempts] - number of ripped connections attempted via connection-only reroute
 * @property {number} [connectionOnlyRerouteFallbacksToNet] - number of nets that fell back to full-net reroute after connection-only attempt
 * @property {number} [connectionOnlyFailAstarNoPathCount] - connection-only failures where A* could not produce a route
 * @property {Array<{connId: string, count: number}>} [connectionOnlyTopNoPathConnIds] - top connIds by connection-only no-path failures
 * @property {Array<{connId: string, count: number, blockerClass: string, blockerNet: string|null, blockerConnId: string|null, blockerId: string|null}>} [connectionOnlyTopNoPathBlockers] - blocker summary for top connection-only no-path connIds
 */

// ── Binary Min-Heap (shared by astarRoute / astarProbe) ──────────

/**
 * Create a binary min-heap ordering nodes by `node.f` (ascending).
 * Shared between the cost-based router and the rip-up probe so that
 * both use identical priority-queue semantics.
 *
 * @returns {{ push: (node: {f: number}) => void, pop: () => any, size: () => number }}
 */
export function createMinHeap() {
    const heap = [];
    const push = (node) => {
        heap.push(node);
        let i = heap.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (heap[parent].f <= heap[i].f) break;
            const tmp = heap[parent];
            heap[parent] = heap[i];
            heap[i] = tmp;
            i = parent;
        }
    };
    const pop = () => {
        const top = heap[0];
        const last = heap.pop();
        if (heap.length > 0) {
            heap[0] = last;
            let i = 0;
            const n = heap.length;
            while (true) {
                let smallest = i;
                const l = 2 * i + 1, r = 2 * i + 2;
                if (l < n && heap[l].f < heap[smallest].f) smallest = l;
                if (r < n && heap[r].f < heap[smallest].f) smallest = r;
                if (smallest === i) break;
                const tmp = heap[i];
                heap[i] = heap[smallest];
                heap[smallest] = tmp;
                i = smallest;
            }
        }
        return top;
    };
    const size = () => heap.length;
    return { push, pop, size };
}

// ── Spatial Hash Index ────────────────────────────────────────────

/**
 * Obstacle stored in the spatial hash. Either a pad (isPad=true) or a trace segment.
 * @typedef {Object} SpatialObstacle
 * @property {string} net - owning net name
 * @property {string} [id] - pad identifier (pads only)
 * @property {string} [connId] - connection identifier
 * @property {string} layer - 'top', 'bottom', or 'both'
 * @property {boolean} [isPad] - true for pads/vias
 * @property {boolean} [isVia] - true for via obstacles
 * @property {number} hw - half-width (pads) or half-trace-width (segments)
 * @property {number} [cx] - pad center X (pads only)
 * @property {number} [cy] - pad center Y (pads only)
 * @property {number} [hh] - half-height (pads only)
 * @property {number} [x1] - segment start X (segments only)
 * @property {number} [y1] - segment start Y (segments only)
 * @property {number} [x2] - segment end X (segments only)
 * @property {number} [y2] - segment end Y (segments only)
 */

export class SpatialHash {
    /**
     * @param {number} cellSize - Size of each hash cell in mm
     */
    constructor(cellSize) {
        this.cellSize = cellSize;
        /** @type {Map<number, Array<SpatialObstacle>>} */
        this.cells = new Map();
        /** Reverse index: connId -> Set of cellKeys that contain an obj with this connId.
         *  Lets removeConnection scan only touched cells instead of every cell in the hash. */
        /** @type {Map<string, Set<number>>} */
        this.connCells = new Map();
    }

    /**
     * Pack cell coordinates into a single safe-integer Map key.
     * Coords range roughly [-4194mm/cellSize, +4194mm/cellSize], well within
     * safe-integer bounds. Numeric Map keys avoid per-query string allocation
     * on the A* hot path (millions of cell lookups per route).
     * @param {number} cx
     * @param {number} cy
     */
    _key(cx, cy) { return ((cx + 4194304) * 8388608) + (cy + 4194304); }

    /**
     * Insert a line segment obstacle with half-width clearance.
     * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
     * @param {number} hw - half-width (trace radius + clearance)
     * @param {string} net - which net this belongs to (same-net doesn't block)
     * @param {string} [layer='top']
     * @param {string} [connId]
     */
    insert(x1, y1, x2, y2, hw, net, layer = 'top', connId = undefined) {
        const obj = { x1, y1, x2, y2, hw, net, layer, connId };
        const minCX = Math.floor((Math.min(x1, x2) - hw) / this.cellSize);
        const maxCX = Math.floor((Math.max(x1, x2) + hw) / this.cellSize);
        const minCY = Math.floor((Math.min(y1, y2) - hw) / this.cellSize);
        const maxCY = Math.floor((Math.max(y1, y2) + hw) / this.cellSize);
        let revIdx = null;
        if (connId) {
            revIdx = this.connCells.get(connId);
            if (!revIdx) { revIdx = new Set(); this.connCells.set(connId, revIdx); }
        }
        for (let cx = minCX; cx <= maxCX; cx++) {
            for (let cy = minCY; cy <= maxCY; cy++) {
                const key = this._key(cx, cy);
                let bucket = this.cells.get(key);
                if (!bucket) { bucket = []; this.cells.set(key, bucket); }
                bucket.push(obj);
                if (revIdx) revIdx.add(key);
            }
        }
    }

    /**
     * Remove all segments and vias belonging to a specific connection.
     * Pads that are not vias are preserved (we never rip non-via pads).
     * @param {string} connId
     */
    removeConnection(connId) {
        if (!connId) return;
        const cks = this.connCells.get(connId);
        if (!cks) return;
        for (const key of cks) {
            const objs = this.cells.get(key);
            if (!objs) continue;
            // Keep obstacles that either belong to a different connection,
            // or are non-via pads (which we never rip).
            const filtered = objs.filter(o => o.connId !== connId || (o.isPad && !o.isVia));
            if (filtered.length === 0) this.cells.delete(key);
            else this.cells.set(key, filtered);
        }
        this.connCells.delete(connId);
    }

    /**
     * Insert a pad obstacle.
     * @param {number} cx @param {number} cy @param {number} w @param {number} h
     * @param {string} net  Pad-instance ID (used for skipIds matching).
     * @param {string} [padLayer='both']
     * @param {{isVia?: boolean, connId?: string|null, shape?: string}} [options={}]
     *   `shape` may be 'rect' (default) or 'ellipse'. Ellipse pads use elliptical
     *   distance for blocking checks; rect pads use AABB.
     */
    insertPad(cx, cy, w, h, net, padLayer = 'both', options = {}) {
        const hw = w / 2, hh = h / 2;
        const obj = { cx, cy, hw, hh, net, isPad: true, layer: padLayer, isVia: !!options.isVia, connId: options.connId || undefined, shape: options.shape || 'rect' };
        // Register in all cells the pad overlaps
        const minCX = Math.floor((cx - hw) / this.cellSize);
        const maxCX = Math.floor((cx + hw) / this.cellSize);
        const minCY = Math.floor((cy - hh) / this.cellSize);
        const maxCY = Math.floor((cy + hh) / this.cellSize);
        let revIdx = null;
        if (obj.connId) {
            revIdx = this.connCells.get(obj.connId);
            if (!revIdx) { revIdx = new Set(); this.connCells.set(obj.connId, revIdx); }
        }
        for (let gx = minCX; gx <= maxCX; gx++) {
            for (let gy = minCY; gy <= maxCY; gy++) {
                const key = this._key(gx, gy);
                let bucket = this.cells.get(key);
                if (!bucket) { bucket = []; this.cells.set(key, bucket); }
                bucket.push(obj);
                if (revIdx) revIdx.add(key);
            }
        }
    }

    /**
     * Check if a point is on or near any pad. Used by via-placement
     * (no-vias-on-pads policy) and by path-simplification (no-diagonal-
     * near-pads heuristic). Pads are never skipped by net — vias on the
     * route's own pads are forbidden too (would short via to wrong layer).
     *
     * @param {number} x @param {number} y @param {number} clearance
     * @returns {boolean}
     */
    isOnPad(x, y, clearance) {
        const cx = Math.floor(x / this.cellSize);
        const cy = Math.floor(y / this.cellSize);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const objs = this.cells.get(this._key(cx + dx, cy + dy));
                if (!objs) continue;
                for (const obj of objs) {
                    if (!obj.isPad) continue;
                    if (padPointBlocked(x, y, obj, clearance)) return true;
                }
            }
        }
        return false;
    }

    /**
     * Check if a point is blocked (too close to any obstacle).
     * @param {number} x @param {number} y @param {number} clearance
     * @param {string|Set<string>} skipIds - obstacle IDs to skip (source/dest pads)
     * @param {string|null} [layer=null] - restrict to this layer
     * @param {string|null} [skipNet=null] - skip same-net traces (not pads)
     * @returns {boolean}
     */
    isBlocked(x, y, clearance, skipIds, layer = null, skipNet = null) {
        const cx = Math.floor(x / this.cellSize);
        const cy = Math.floor(y / this.cellSize);
        const isSet = skipIds instanceof Set;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const objs = this.cells.get(this._key(cx + dx, cy + dy));
                if (!objs) continue;
                for (const obj of objs) {
                    const objId = obj.net || obj.id;
                    if (isSet ? skipIds.has(objId) : objId === skipIds) continue;
                    // Skip same-net traces (not pads) when routing another connection of the same net
                    if (skipNet && !obj.isPad && obj.net === skipNet) continue;
                    // Layer check: obstacles only block on the same layer.
                    // Pads with layer='both' block all layers; single-layer pads
                    // only block their own layer. Traces only block same layer.
                    if (layer) {
                        const objLayer = obj.layer || 'both';
                        if (objLayer !== 'both' && objLayer !== layer) continue;
                    }
                    if (obj.isPad) {
                        if (padPointBlocked(x, y, obj, clearance)) return true;
                    } else {
                        const dist = pointToSegmentDist(x, y, obj.x1, obj.y1, obj.x2, obj.y2);
                        if (dist < obj.hw + clearance) return true;
                    }
                }
            }
        }
        return false;
    }

    /**
     * Check if a segment is blocked.
     * @param {number} ax1 @param {number} ay1 @param {number} ax2 @param {number} ay2
     * @param {number} clearance @param {string|Set<string>} skipIds
     * @returns {boolean}
     */
    isSegmentBlocked(ax1, ay1, ax2, ay2, clearance, skipIds, layer = null, skipNet = null) {
        const minSX = Math.min(ax1, ax2), maxSX = Math.max(ax1, ax2);
        const minSY = Math.min(ay1, ay2), maxSY = Math.max(ay1, ay2);
        const cxMin = Math.floor((minSX - clearance) / this.cellSize) - 1;
        const cxMax = Math.floor((maxSX + clearance) / this.cellSize) + 1;
        const cyMin = Math.floor((minSY - clearance) / this.cellSize) - 1;
        const cyMax = Math.floor((maxSY + clearance) / this.cellSize) + 1;
        const isSet = skipIds instanceof Set;

        for (let cx = cxMin; cx <= cxMax; cx++) {
            for (let cy = cyMin; cy <= cyMax; cy++) {
                const objs = this.cells.get(this._key(cx, cy));
                if (!objs) continue;
                for (const obj of objs) {
                    const objId = obj.net || obj.id;
                    if (isSet ? skipIds.has(objId) : objId === skipIds) continue;
                    // Skip same-net traces when routing another connection of the same net
                    if (skipNet && !obj.isPad && obj.net === skipNet) continue;
                    if (layer) {
                        const objLayer = obj.layer || 'both';
                        if (objLayer !== 'both' && objLayer !== layer) continue;
                    }
                    if (obj.isPad) {
                        if (padSegmentBlocked(ax1, ay1, ax2, ay2, obj, clearance)) return true;
                    } else {
                        const d = segmentToSegmentDist(ax1, ay1, ax2, ay2, obj.x1, obj.y1, obj.x2, obj.y2);
                        if (d < obj.hw + clearance) return true;
                    }
                }
            }
        }
        return false;
    }

    /**
     * Find which nets' traces block a segment (for rip-up).
     * @param {number} ax1 @param {number} ay1 @param {number} ax2 @param {number} ay2
     * @param {number} clearance @param {string|Set<string>} skipIds
     * @param {string|null} [layer=null]
     * @returns {Set<string>}
     */
    findBlockingNets(ax1, ay1, ax2, ay2, clearance, skipIds, layer = null) {
        const blocking = new Set();
        const minSX = Math.min(ax1, ax2), maxSX = Math.max(ax1, ax2);
        const minSY = Math.min(ay1, ay2), maxSY = Math.max(ay1, ay2);
        const cxMin = Math.floor((minSX - clearance) / this.cellSize) - 1;
        const cxMax = Math.floor((maxSX + clearance) / this.cellSize) + 1;
        const cyMin = Math.floor((minSY - clearance) / this.cellSize) - 1;
        const cyMax = Math.floor((maxSY + clearance) / this.cellSize) + 1;
        const isSet = skipIds instanceof Set;

        for (let cx = cxMin; cx <= cxMax; cx++) {
            for (let cy = cyMin; cy <= cyMax; cy++) {
                const objs = this.cells.get(this._key(cx, cy));
                if (!objs) continue;
                for (const obj of objs) {
                    if (obj.isPad) continue; // can't rip up pads
                    const objId = obj.net || obj.id;
                    if (isSet ? skipIds.has(objId) : objId === skipIds) continue;
                    if (layer && obj.layer && obj.layer !== layer) continue;
                    const d = segmentToSegmentDist(ax1, ay1, ax2, ay2, obj.x1, obj.y1, obj.x2, obj.y2);
                    if (d < obj.hw + clearance && obj.net) blocking.add(obj.net);
                }
            }
        }
        return blocking;
    }

    /**
     * Find which foreign connection IDs' traces block a segment (for rip-up).
     * @param {number} ax1 @param {number} ay1 @param {number} ax2 @param {number} ay2
     * @param {number} clearance @param {string|Set<string>} skipIds
     * @param {string|null} [layer=null]
     * @returns {Set<string>}
     */
    findBlockingConnIds(ax1, ay1, ax2, ay2, clearance, skipIds, layer = null) {
        const blocking = new Set();
        const minSX = Math.min(ax1, ax2), maxSX = Math.max(ax1, ax2);
        const minSY = Math.min(ay1, ay2), maxSY = Math.max(ay1, ay2);
        const cxMin = Math.floor((minSX - clearance) / this.cellSize) - 1;
        const cxMax = Math.floor((maxSX + clearance) / this.cellSize) + 1;
        const cyMin = Math.floor((minSY - clearance) / this.cellSize) - 1;
        const cyMax = Math.floor((maxSY + clearance) / this.cellSize) + 1;
        const isSet = skipIds instanceof Set;

        for (let cx = cxMin; cx <= cxMax; cx++) {
            for (let cy = cyMin; cy <= cyMax; cy++) {
                const objs = this.cells.get(this._key(cx, cy));
                if (!objs) continue;
                for (const obj of objs) {
                    if (obj.isPad || !obj.connId) continue;
                    const objId = obj.net || obj.id;
                    if (isSet ? skipIds.has(objId) : objId === skipIds) continue;
                    if (layer && obj.layer && obj.layer !== layer) continue;
                    const d = segmentToSegmentDist(ax1, ay1, ax2, ay2, obj.x1, obj.y1, obj.x2, obj.y2);
                    if (d < obj.hw + clearance) blocking.add(obj.connId);
                }
            }
        }
        return blocking;
    }

    /**
     * Return the nearest blocking obstacle for a segment, if any.
     * This is diagnostic-only and does not affect routing behavior.
     * @param {number} ax1 @param {number} ay1 @param {number} ax2 @param {number} ay2
     * @param {number} clearance @param {string|Set<string>} skipIds
     * @param {string|null} [layer=null]
     */
    firstBlockingObstacleForSegment(ax1, ay1, ax2, ay2, clearance, skipIds, layer = null) {
        const minSX = Math.min(ax1, ax2), maxSX = Math.max(ax1, ax2);
        const minSY = Math.min(ay1, ay2), maxSY = Math.max(ay1, ay2);
        const cxMin = Math.floor((minSX - clearance) / this.cellSize) - 1;
        const cxMax = Math.floor((maxSX + clearance) / this.cellSize) + 1;
        const cyMin = Math.floor((minSY - clearance) / this.cellSize) - 1;
        const cyMax = Math.floor((maxSY + clearance) / this.cellSize) + 1;
        const isSet = skipIds instanceof Set;

        let best = null;
        let bestDist = Infinity;

        for (let cx = cxMin; cx <= cxMax; cx++) {
            for (let cy = cyMin; cy <= cyMax; cy++) {
                const objs = this.cells.get(this._key(cx, cy));
                if (!objs) continue;
                for (const obj of objs) {
                    const objId = obj.net || obj.id;
                    if (isSet ? skipIds.has(objId) : objId === skipIds) continue;
                    if (layer) {
                        const objLayer = obj.layer || 'both';
                        if (objLayer !== 'both' && objLayer !== layer) continue;
                    }

                    if (obj.isPad) {
                        if (!padSegmentBlocked(ax1, ay1, ax2, ay2, obj, clearance)) continue;

                        const d = pointToSegmentDist(obj.cx, obj.cy, ax1, ay1, ax2, ay2);
                        if (d < bestDist) {
                            bestDist = d;
                            best = {
                                kind: obj.isVia ? 'via' : 'pad',
                                net: obj.net || null,
                                connId: obj.connId || null,
                                obstacleId: objId || null,
                            };
                        }
                    } else {
                        const d = segmentToSegmentDist(ax1, ay1, ax2, ay2, obj.x1, obj.y1, obj.x2, obj.y2);
                        if (d >= obj.hw + clearance) continue;
                        if (d < bestDist) {
                            bestDist = d;
                            best = {
                                kind: 'trace',
                                net: obj.net || null,
                                connId: obj.connId || null,
                                obstacleId: objId || null,
                            };
                        }
                    }
                }
            }
        }

        return best;
    }

    /**
     * Estimate local obstacle density near a point.
     * @param {number} x @param {number} y
     * @param {string|Set<string>|null} [skipIds=null]
     * @param {string|null} [layer=null]
     * @param {number} [radiusCells=1]
     * @returns {number}
     */
    localDensity(x, y, skipIds = null, layer = null, radiusCells = 1) {
        const cx = Math.floor(x / this.cellSize);
        const cy = Math.floor(y / this.cellSize);
        const isSet = skipIds instanceof Set;
        let count = 0;
        for (let dx = -radiusCells; dx <= radiusCells; dx++) {
            for (let dy = -radiusCells; dy <= radiusCells; dy++) {
                const objs = this.cells.get(this._key(cx + dx, cy + dy));
                if (!objs) continue;
                for (const obj of objs) {
                    const objId = obj.net || obj.id;
                    if (skipIds && (isSet ? skipIds.has(objId) : objId === skipIds)) continue;
                    if (layer) {
                        const objLayer = obj.layer || 'both';
                        if (objLayer !== 'both' && objLayer !== layer) continue;
                    }
                    count++;
                }
            }
        }
        return count;
    }

    /**
     * Find which connection IDs' traces a point overlaps.
     * Returns set of connId strings. Pads are ignored.
     */
    crossingConnIdsAtPoint(x, y, clearance, skipIds, layer = null) {
        const crossed = new Set();
        const cx = Math.floor(x / this.cellSize);
        const cy = Math.floor(y / this.cellSize);
        const isSet = skipIds instanceof Set;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const objs = this.cells.get(this._key(cx + dx, cy + dy));
                if (!objs) continue;
                for (const obj of objs) {
                    if (obj.isPad || !obj.connId) continue;
                    const objId = obj.net || obj.id;
                    if (isSet ? skipIds.has(objId) : objId === skipIds) continue;
                    if (layer) {
                        const objLayer = obj.layer || 'both';
                        if (objLayer !== 'both' && objLayer !== layer) continue;
                    }
                    const dist = pointToSegmentDist(x, y, obj.x1, obj.y1, obj.x2, obj.y2);
                    if (dist < obj.hw + clearance) crossed.add(obj.connId);
                }
            }
        }
        return crossed;
    }

    /**
     * Find which connection IDs' traces a segment crosses.
     */
    crossingConnIdsForSegment(ax1, ay1, ax2, ay2, clearance, skipIds, layer = null) {
        const crossed = new Set();
        const minSX = Math.min(ax1, ax2), maxSX = Math.max(ax1, ax2);
        const minSY = Math.min(ay1, ay2), maxSY = Math.max(ay1, ay2);
        const cxMin = Math.floor((minSX - clearance) / this.cellSize) - 1;
        const cxMax = Math.floor((maxSX + clearance) / this.cellSize) + 1;
        const cyMin = Math.floor((minSY - clearance) / this.cellSize) - 1;
        const cyMax = Math.floor((maxSY + clearance) / this.cellSize) + 1;
        const isSet = skipIds instanceof Set;
        for (let cx = cxMin; cx <= cxMax; cx++) {
            for (let cy = cyMin; cy <= cyMax; cy++) {
                const objs = this.cells.get(this._key(cx, cy));
                if (!objs) continue;
                for (const obj of objs) {
                    if (obj.isPad || !obj.connId) continue;
                    const objId = obj.net || obj.id;
                    if (isSet ? skipIds.has(objId) : objId === skipIds) continue;
                    if (layer) {
                        const objLayer = obj.layer || 'both';
                        if (objLayer !== 'both' && objLayer !== layer) continue;
                    }
                    const d = segmentToSegmentDist(ax1, ay1, ax2, ay2, obj.x1, obj.y1, obj.x2, obj.y2);
                    if (d < obj.hw + clearance) crossed.add(obj.connId);
                }
            }
        }
        return crossed;
    }
}

// ── Geometry Helpers ──────────────────────────────────────────────

/**
 * Check whether a point (px,py) lies inside a pad's copper footprint.
 * @param {number} px
 * @param {number} py
 * @param {{x: number, y: number, width: number, height: number, shape?: string}} pad
 * @returns {boolean}
 */
export function isInsidePad(px, py, pad) {
    const dx = px - pad.x;
    const dy = py - pad.y;
    const hw = pad.width / 2;
    const hh = pad.height / 2;
    if (pad.shape === 'ellipse') {
        return (dx * dx) / (hw * hw) + (dy * dy) / (hh * hh) <= 1;
    }
    if (pad.shape === 'oval') {
        const r = Math.min(hw, hh);
        const horizontal = hw >= hh;
        const halfLine = horizontal ? (hw - r) : (hh - r);
        const x1 = horizontal ? pad.x - halfLine : pad.x;
        const y1 = horizontal ? pad.y : pad.y - halfLine;
        const x2 = horizontal ? pad.x + halfLine : pad.x;
        const y2 = horizontal ? pad.y : pad.y + halfLine;
        return pointToSegmentDist(px, py, x1, y1, x2, y2) <= r;
    }
    // Default: rectangle
    return Math.abs(dx) <= hw && Math.abs(dy) <= hh;
}

/**
 * Check whether a point is inside a pad expanded by a margin.
 * Used to identify the transition zone just beyond the pad edge.
 * @param {number} px
 * @param {number} py
 * @param {{x: number, y: number, width: number, height: number, shape?: string}} pad
 * @param {number} margin - expansion in mm beyond the pad boundary
 * @returns {boolean}
 */
export function isNearPad(px, py, pad, margin) {
    const dx = px - pad.x;
    const dy = py - pad.y;
    const hw = pad.width / 2 + margin;
    const hh = pad.height / 2 + margin;
    if (pad.shape === 'ellipse') {
        return (dx * dx) / (hw * hw) + (dy * dy) / (hh * hh) <= 1;
    }
    if (pad.shape === 'oval') {
        const baseR = Math.min(pad.width, pad.height) / 2;
        const horizontal = pad.width >= pad.height;
        const halfLine = horizontal ? (pad.width / 2 - baseR) : (pad.height / 2 - baseR);
        const x1 = horizontal ? pad.x - halfLine : pad.x;
        const y1 = horizontal ? pad.y : pad.y - halfLine;
        const x2 = horizontal ? pad.x + halfLine : pad.x;
        const y2 = horizontal ? pad.y : pad.y + halfLine;
        return pointToSegmentDist(px, py, x1, y1, x2, y2) <= baseR + margin;
    }
    return Math.abs(dx) <= hw && Math.abs(dy) <= hh;
}

/**
 * Distance from point (px,py) to line segment (x1,y1)-(x2,y2).
 */
export function pointToSegmentDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * Test if a line segment intersects an axis-aligned bounding box.
 * Uses the Liang-Barsky algorithm.
 */
export function segmentIntersectsAABB(x1, y1, x2, y2, rxMin, ryMin, rxMax, ryMax) {
    // Check if either endpoint is inside the box
    if (x1 >= rxMin && x1 <= rxMax && y1 >= ryMin && y1 <= ryMax) return true;
    if (x2 >= rxMin && x2 <= rxMax && y2 >= ryMin && y2 <= ryMax) return true;

    const dx = x2 - x1, dy = y2 - y1;
    let tMin = 0, tMax = 1;

    // Check each edge
    const edges = [
        [-dx, x1 - rxMin],  // left
        [dx, rxMax - x1],   // right
        [-dy, y1 - ryMin],  // bottom
        [dy, ryMax - y1],   // top
    ];

    for (const [p, q] of edges) {
        if (Math.abs(p) < 1e-10) {
            if (q < 0) return false; // parallel and outside
        } else {
            const t = q / p;
            if (p < 0) { if (t > tMax) return false; tMin = Math.max(tMin, t); }
            else       { if (t < tMin) return false; tMax = Math.min(tMax, t); }
        }
    }
    return tMin <= tMax;
}

/**
 * Test if two line segments intersect (proper + collinear overlap).
 */
export function segmentsIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
    const dax = ax2 - ax1, day = ay2 - ay1;
    const dbx = bx2 - bx1, dby = by2 - by1;

    const d1 = dax * (by1 - ay1) - day * (bx1 - ax1);
    const d2 = dax * (by2 - ay1) - day * (bx2 - ax1);
    const d3 = dbx * (ay1 - by1) - dby * (ax1 - bx1);
    const d4 = dbx * (ay2 - by1) - dby * (ax2 - bx1);

    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
        ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;

    // Collinear/on-segment cases
    const onSeg = (x1, y1, x2, y2, px, py) =>
        px >= Math.min(x1, x2) && px <= Math.max(x1, x2) &&
        py >= Math.min(y1, y2) && py <= Math.max(y1, y2);
    if (d1 === 0 && onSeg(ax1, ay1, ax2, ay2, bx1, by1)) return true;
    if (d2 === 0 && onSeg(ax1, ay1, ax2, ay2, bx2, by2)) return true;
    if (d3 === 0 && onSeg(bx1, by1, bx2, by2, ax1, ay1)) return true;
    if (d4 === 0 && onSeg(bx1, by1, bx2, by2, ax2, ay2)) return true;

    return false;
}

/**
 * Minimum distance between two line segments.
 * Returns 0 if they intersect.
 */
export function segmentToSegmentDist(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
    // If segments cross, distance is zero
    if (segmentsIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2)) return 0;
    // Otherwise check all 4 point-to-segment distances
    return Math.min(
        pointToSegmentDist(ax1, ay1, bx1, by1, bx2, by2),
        pointToSegmentDist(ax2, ay2, bx1, by1, bx2, by2),
        pointToSegmentDist(bx1, by1, ax1, ay1, ax2, ay2),
        pointToSegmentDist(bx2, by2, ax1, ay1, ax2, ay2)
    );
}

// ── Pad clearance geometry ────────────────────────────────────────
//
// All pad-vs-something tests use true Minkowski-sum distance — i.e. the
// trace center-line must stay strictly more than `clearance` away from the
// pad's actual copper boundary. This is mathematically equivalent to (and
// numerically identical to) putting the clearance envelope on the trace
// instead of the pad; the per-shape distance function is intrinsic either
// way. Earlier code used an AABB-inflation approximation which over-blocked
// at corners (square corners on the inflated rect instead of the rounded
// corners produced by a true Minkowski sum with a disk).
//
// Pad shape vocabulary (stored on SpatialHash obstacle records):
//   - 'rect'    (default): axis-aligned rectangle, clearance applied as
//                          rounded-corner Minkowski expansion.
//   - 'ellipse'           : round / true-ellipse pad. When hw === hh this is
//                          treated as an exact circle. Otherwise an
//                          axis-aligned ellipse (clearance approximated as
//                          anisotropic axis expansion — exact only for the
//                          circular case).
//   - 'oval'              : stadium / discorectangle. Two semicircular ends
//                          with radius min(hw, hh); straight section spans
//                          the longer axis.
//   - anything else (e.g. 'polygon' for non-convex EasyEDA pads) falls
//                          through to the rect path, conservatively treated
//                          as the pad's bounding box.

/**
 * Returns true if point (x, y) is within `clearance` of the pad obstacle's copper.
 * @param {number} x @param {number} y
 * @param {{cx:number, cy:number, hw:number, hh:number, shape?:string}} obj
 * @param {number} clearance
 */
export function padPointBlocked(x, y, obj, clearance) {
    const dx = x - obj.cx;
    const dy = y - obj.cy;

    if (obj.shape === 'ellipse') {
        if (obj.hw === obj.hh) {
            // Circle: exact
            const r = obj.hw + clearance;
            return dx * dx + dy * dy <= r * r;
        }
        // True ellipse: anisotropic approximation
        const ex = dx / (obj.hw + clearance);
        const ey = dy / (obj.hh + clearance);
        return ex * ex + ey * ey <= 1;
    }

    if (obj.shape === 'oval') {
        // Stadium: distance from point to center segment ≤ minor radius + clearance
        const r = Math.min(obj.hw, obj.hh);
        const horizontal = obj.hw >= obj.hh;
        const halfLine = horizontal ? (obj.hw - r) : (obj.hh - r);
        const x1 = horizontal ? obj.cx - halfLine : obj.cx;
        const y1 = horizontal ? obj.cy : obj.cy - halfLine;
        const x2 = horizontal ? obj.cx + halfLine : obj.cx;
        const y2 = horizontal ? obj.cy : obj.cy + halfLine;
        return pointToSegmentDist(x, y, x1, y1, x2, y2) <= r + clearance;
    }

    // Rect (default): true Minkowski distance — rounded corners.
    const adx = Math.abs(dx) - obj.hw;
    const ady = Math.abs(dy) - obj.hh;
    if (adx <= 0 && ady <= 0) return true; // strictly inside the rect
    const ox = adx > 0 ? adx : 0;
    const oy = ady > 0 ? ady : 0;
    return ox * ox + oy * oy <= clearance * clearance;
}

/**
 * Returns true if segment (ax1,ay1)-(ax2,ay2) is within `clearance` of the pad.
 */
export function padSegmentBlocked(ax1, ay1, ax2, ay2, obj, clearance) {
    if (obj.shape === 'ellipse' && obj.hw === obj.hh) {
        // Circle: distance from circle center to segment ≤ r + clearance
        const r = obj.hw + clearance;
        return pointToSegmentDist(obj.cx, obj.cy, ax1, ay1, ax2, ay2) <= r;
    }
    if (obj.shape === 'oval') {
        const r = Math.min(obj.hw, obj.hh);
        const horizontal = obj.hw >= obj.hh;
        const halfLine = horizontal ? (obj.hw - r) : (obj.hh - r);
        const bx1 = horizontal ? obj.cx - halfLine : obj.cx;
        const by1 = horizontal ? obj.cy : obj.cy - halfLine;
        const bx2 = horizontal ? obj.cx + halfLine : obj.cx;
        const by2 = horizontal ? obj.cy : obj.cy + halfLine;
        return segmentToSegmentDist(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) <= r + clearance;
    }
    if (obj.shape === 'ellipse') {
        // True ellipse (hw !== hh): conservative AABB-inflation (over-blocks slightly).
        const rx1 = obj.cx - obj.hw - clearance, ry1 = obj.cy - obj.hh - clearance;
        const rx2 = obj.cx + obj.hw + clearance, ry2 = obj.cy + obj.hh + clearance;
        return segmentIntersectsAABB(ax1, ay1, ax2, ay2, rx1, ry1, rx2, ry2);
    }

    // Rect (default): exact distance from segment to rect ≤ clearance.
    // Fast cull with inflated-AABB; if it passes, do precise corner-rounded test.
    const xMin = obj.cx - obj.hw, xMax = obj.cx + obj.hw;
    const yMin = obj.cy - obj.hh, yMax = obj.cy + obj.hh;
    if (!segmentIntersectsAABB(ax1, ay1, ax2, ay2,
            xMin - clearance, yMin - clearance,
            xMax + clearance, yMax + clearance)) return false;
    // Inside un-inflated rect → blocked.
    if (segmentIntersectsAABB(ax1, ay1, ax2, ay2, xMin, yMin, xMax, yMax)) return true;
    // Either endpoint within Minkowski (point-to-rect distance ≤ clearance)?
    const c2 = clearance * clearance;
    const ptToRectSq = (px, py) => {
        const dxr = px < xMin ? xMin - px : (px > xMax ? px - xMax : 0);
        const dyr = py < yMin ? yMin - py : (py > yMax ? py - yMax : 0);
        return dxr * dxr + dyr * dyr;
    };
    if (ptToRectSq(ax1, ay1) <= c2) return true;
    if (ptToRectSq(ax2, ay2) <= c2) return true;
    // Corner-grazing case: any rect corner within clearance of the segment?
    if (pointToSegmentDist(xMin, yMin, ax1, ay1, ax2, ay2) <= clearance) return true;
    if (pointToSegmentDist(xMax, yMin, ax1, ay1, ax2, ay2) <= clearance) return true;
    if (pointToSegmentDist(xMin, yMax, ax1, ay1, ax2, ay2) <= clearance) return true;
    if (pointToSegmentDist(xMax, yMax, ax1, ay1, ax2, ay2) <= clearance) return true;
    return false;
}

// ── Congestion Grid ───────────────────────────────────────────────

/**
 * Tracks historical routing demand per spatial cell.
 * Used by negotiated-congestion routing: areas where many nets compete
 * get higher costs, encouraging routes to spread out.
 */
export class CongestionGrid {
    constructor(cellSize = 1.0) {
        this.cellSize = cellSize;
        this.cells = new Map(); // "cx,cy" -> Set<netName>
    }

    _key(x, y) {
        return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
    }

    /** Record that a net uses this cell. */
    recordUsage(x, y, net) {
        const key = this._key(x, y);
        let s = this.cells.get(key);
        if (!s) { s = new Set(); this.cells.set(key, s); }
        s.add(net);
    }

    /** Record usage along a trace segment. */
    recordSegment(x1, y1, x2, y2, net) {
        const dist = Math.hypot(x2 - x1, y2 - y1);
        const steps = Math.max(1, Math.ceil(dist / this.cellSize));
        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            this.recordUsage(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, net);
        }
    }

    /** Get congestion at a point (number of different nets using this cell). */
    getCongestion(x, y) {
        const s = this.cells.get(this._key(x, y));
        return s ? s.size : 0;
    }

    /** Build from an iterable of trace objects [{net, points: [{x,y},...]}]. */
    buildFromTraces(traces) {
        this.cells.clear();
        for (const t of traces) {
            const pts = t.points;
            if (!pts || pts.length < 2) continue;
            for (let i = 0; i < pts.length - 1; i++) {
                this.recordSegment(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, t.net);
            }
        }
    }

    /** Also record demand from connections that WANT to route (even if they failed). */
    recordDemandLine(x1, y1, x2, y2, net) {
        this.recordSegment(x1, y1, x2, y2, net);
    }

    clear() { this.cells.clear(); }
}

/**
 * Per-cell resource grid for negotiated-congestion (Pathfinder) routing.
 *
 * Tracks two things per (cellX, cellY, layer):
 *   - present demand: distinct nets currently using this cell this iteration
 *   - history penalty: accumulated overuse penalty from prior iterations
 *
 * Capacity is 1 (a cell can host one net's trace without conflict).
 * Pathfinder cost for A*: `history + presentFactor * overuse`, where
 * `presentFactor` grows each iteration to force nets to negotiate away from
 * shared resources.
 *
 * Layer-aware: traces on different layers don't conflict; vias consume
 * both layers at their position.
 */
export class PathfinderGrid {
    constructor(cellSize = 0.5) {
        this.cellSize = cellSize;
        /** @type {Map<number, Map<string, number>>} cellKey -> (net -> hitCount) */
        this.demand = new Map();
        /** @type {Map<number, number>} cellKey -> accumulated history penalty */
        this.history = new Map();
    }

    _key(x, y, layer) {
        const cx = Math.floor(x / this.cellSize);
        const cy = Math.floor(y / this.cellSize);
        const lbit = (layer === 'bottom' || layer === 1) ? 1 : 0;
        // Same pack scheme as packNodeKey but cell-quantized.
        return ((cx + 4194304) * 33554432) + ((cy + 4194304) * 2) + lbit;
    }

    addUsage(x, y, layer, net) {
        const k = this._key(x, y, layer);
        let m = this.demand.get(k);
        if (!m) { m = new Map(); this.demand.set(k, m); }
        m.set(net, (m.get(net) || 0) + 1);
    }

    /** Record a per-layer segment by sampling at cellSize resolution. */
    recordSegment(x1, y1, x2, y2, layer, net) {
        const dist = Math.hypot(x2 - x1, y2 - y1);
        const steps = Math.max(1, Math.ceil(dist / this.cellSize));
        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            this.addUsage(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, layer, net);
        }
    }

    /** A via consumes resources on BOTH layers at its position. */
    recordVia(x, y, net) {
        this.addUsage(x, y, 'top', net);
        this.addUsage(x, y, 'bottom', net);
    }

    /** Distinct nets using this cell (=cell demand). */
    getDemand(x, y, layer) {
        const m = this.demand.get(this._key(x, y, layer));
        return m ? m.size : 0;
    }

    /** Overuse = max(0, demand - 1). 0 means this cell has at most one net. */
    getOveruse(x, y, layer) {
        return Math.max(0, this.getDemand(x, y, layer) - 1);
    }

    getHistory(x, y, layer) {
        return this.history.get(this._key(x, y, layer)) || 0;
    }

    /**
     * Pathfinder cost: `history + presentFactor * overuse`. Used as a cost
     * multiplier passed into astarRoute via the cellCostFn option.
     */
    cellCost(x, y, layer, presentFactor) {
        const k = this._key(x, y, layer);
        const m = this.demand.get(k);
        const overuse = m ? Math.max(0, m.size - 1) : 0;
        const history = this.history.get(k) || 0;
        return history + presentFactor * overuse;
    }

    /**
     * For every currently-overused cell, add (overuse * scale) to its
     * persistent history penalty. Called once per Pathfinder iteration.
     */
    accumulateHistory(scale = 1) {
        for (const [k, m] of this.demand.entries()) {
            const overuse = Math.max(0, m.size - 1);
            if (overuse > 0) {
                this.history.set(k, (this.history.get(k) || 0) + overuse * scale);
            }
        }
    }

    clearDemand() { this.demand.clear(); }

    /** Count of cells currently overused (convergence indicator: 0 = converged). */
    countOverused() {
        let n = 0;
        for (const m of this.demand.values()) if (m.size > 1) n++;
        return n;
    }

    /** Set of net names that touch at least one overused cell. */
    overusedNets() {
        const nets = new Set();
        for (const m of this.demand.values()) {
            if (m.size > 1) for (const net of m.keys()) nets.add(net);
        }
        return nets;
    }
}

// ── A* Pathfinder ─────────────────────────────────────────────────

// Numeric node key packing for A* Map/Set lookups.
// Packs (x_μm, y_μm, layer) into a single safe-integer key so Maps store
// numeric keys instead of allocating a fresh string per expansion. Integer
// Map ops are noticeably faster in V8 and avoid GC pressure on the A* hot path.
//
// Supports coords in roughly [-4194mm, +4194mm] (far beyond any real PCB).
// Max key magnitude ≈ 2^48, well under Number.MAX_SAFE_INTEGER (2^53).
export const NODE_KEY_OFFSET = 4194304;     // = 2^22 μm = 4194 mm; shifts coords to non-negative
export const NODE_KEY_Y_STRIDE = 33554432;  // = 2^25 = 2 × (2 × NODE_KEY_OFFSET); reserves layer bit + y range
/** @param {number} x @param {number} y @param {0|1|string} layer */
export function packNodeKey(x, y, layer) {
    // layer may arrive as 'top'/'bottom' or 0/1; coerce to 0/1
    const lbit = (layer === 1 || layer === 'bottom') ? 1 : 0;
    return (Math.round(x * 1000) + NODE_KEY_OFFSET) * NODE_KEY_Y_STRIDE
         + (Math.round(y * 1000) + NODE_KEY_OFFSET) * 2
         + lbit;
}

/**
 * Find a path from (sx,sy) to (ex,ey) with 2-layer via support.
 * Uses weighted A* on a virtual grid with layer transitions.
 *
 * @param {number} sx @param {number} sy - start
 * @param {number} ex @param {number} ey - end
 * @param {SpatialHash} obstacles
 * @param {string|Set<string>} skipIds - pad IDs to skip
 * @param {number} gridStep - routing grid resolution (mm)
 * @param {number} traceWidth - trace width (mm)
 * @param {number} clearance - min clearance from obstacles (mm)
 * @param {number} [greedyWeight=3.0] - A* greedy multiplier
 * @param {boolean} [allowVias=true] - allow layer transitions
 * @returns {Promise<{path: Array<{x: number, y: number, layer: string}>, vias: Array<{x: number, y: number}>}|null>}
 */
export async function astarRoute(sx, sy, ex, ey, obstacles, skipIds, gridStep, traceWidth, clearance, greedyWeight = 2.5, allowVias = true, startLayer = 'top', endPadLayer = 'both', options = {}) {
    const {
        maxIter = 800000,
        stagnationIters = 80000,
        cancelToken = null,
        yieldEvery = 3000,
        minYieldIntervalMs = 45,
        yieldToUI = null,
        onTick = null,
        maxDetourFactor = 3.0,
        corridorMargin = null,
        bounds = null,
        viaCostScale = 1.0,
        bendCostScale = 1.0,
        padDiagCostScale = 1.0,
        dirPenaltyScale = 1.0,
        congestionPenaltyScale = 1.0,
        viaCongestionScale = 1.0,
        congestionGrid = null,
        historyWeight = 0,
        // Pathfinder hook: optional per-cell cost function (x, y, layer) -> number
        // added directly to tentG for the destination of each expansion. Used by
        // negotiated-congestion routing to penalise resources that are currently
        // overused or have a history of overuse. null = no-op (no extra cost).
        cellCostFn = null,
        routingNet = null,
        viaRadius: optViaRadius = null,
        startPad = null,
        endPad = null,
    } = options;
    const halfTrace = traceWidth / 2;
    const totalClear = halfTrace + clearance;
    const viaRadius = optViaRadius || (clearance + halfTrace);
    const VIA_COST = gridStep * 30 * viaCostScale;
    const BEND_COST = gridStep * 0.5 * bendCostScale;
    const PAD_DIAG_COST = gridStep * 5 * padDiagCostScale;
    // Centerline-exit preference: scale factor applied to (perpendicular
    // distance from the pad's long-axis centerline) for cells inside or
    // immediately outside an elongated own start/end pad. Encourages traces
    // to enter/leave through the centre of the pad's short edge rather
    // than the corners — the standard PCB convention.
    const PAD_CENTER_COST = 6.0;

    // Pre-compute centerline info for own pads. For elongated pads
    // (aspect > 1.3) we steer toward the long-axis centerline only:
    // a tall pad (height > width) → align with x = pad.x so exits go
    // top/bottom; a wide pad → align with y = pad.y. For square or
    // round pads (aspect ≈ 1) there is no "long" axis — both centerlines
    // are equally valid, so the penalty uses the distance to the
    // *nearest* axis (north/south OR east/west exit, never corner).
    // The active band extends one gridStep beyond the pad boundary so
    // the exit cell on the immediate outside is still steered to the
    // centerline.
    const routeDist = Math.hypot(ex - sx, ey - sy);
    // Long routes scale up congestion avoidance — they have room to detour.
    const distCongScale = Math.min(8, Math.max(1, routeDist / 20));
    // Cap the effective step — never coarser than 2mm, gives enough resolution
    const effectiveStep = Math.min(Math.max(gridStep, routeDist / 200), 2.0);

    const buildCenterlineInfo = (pad) => {
        if (!pad) return null;
        const w = pad.width, h = pad.height;
        const aspect = Math.max(w, h) / Math.max(Math.min(w, h), 1e-6);
        let mode;
        if (aspect < 1.3) mode = 'either';
        else if (w > h)   mode = 'horizontal'; // long axis is X → align Y
        else              mode = 'vertical';   // long axis is Y → align X
        // Margin scales with effectiveStep so the cell one step out from
        // the pad is still in the pull zone for long-route step sizes.
        // Also extend by the pad's short half-dim so the trace walks
        // straight along the centerline for a few cells past the pad
        // edge instead of bending immediately on exit.
        const shortHalf = Math.min(w, h) / 2;
        const margin = Math.max(gridStep, effectiveStep) + shortHalf;
        return { pad, mode, margin };
    };
    const startCenterline = buildCenterlineInfo(startPad);
    const endCenterline = buildCenterlineInfo(endPad);

    const snap = (v) => Math.round(v / effectiveStep) * effectiveStep;
    let startX = snap(sx), startY = snap(sy);
    let endX = snap(ex), endY = snap(ey);
    // Centerline-aligned snap: the start/end cell must sit ON the pad's
    // centerline axis, otherwise the path's first segment (sx,sy)→startCell
    // is a snap-error dogleg perpendicular to the pad axis (visible as a
    // small jog at the pad exit). For elongated pads, lock the SHORT-axis
    // coordinate to the pad centre; the long-axis coord can stay snap-
    // aligned so the goal-side grid still meshes. Square/round ('either'
    // mode) lock both axes so the start cell IS the pad centre.
    if (startCenterline) {
        if (startCenterline.mode === 'vertical' || startCenterline.mode === 'either') {
            startX = startPad.x;
        }
        if (startCenterline.mode === 'horizontal' || startCenterline.mode === 'either') {
            startY = startPad.y;
        }
    }
    if (endCenterline) {
        if (endCenterline.mode === 'vertical' || endCenterline.mode === 'either') {
            endX = endPad.x;
        }
        if (endCenterline.mode === 'horizontal' || endCenterline.mode === 'either') {
            endY = endPad.y;
        }
    }
    const effectiveRouteDist = Math.max(routeDist, effectiveStep);

    // Restrict search to a conservative corridor around start/end to avoid
    // exploring unbounded space on difficult nets.
    const detourCap = effectiveRouteDist * maxDetourFactor + effectiveStep * 8;
    const margin = corridorMargin ?? Math.max(effectiveRouteDist * 0.6, effectiveStep * 30);
    const minX = Math.min(startX, endX) - margin;
    const maxX = Math.max(startX, endX) + margin;
    const minY = Math.min(startY, endY) - margin;
    const maxY = Math.max(startY, endY) + margin;

    const boundsMargin = effectiveStep * 3;
    const boundedMinX = bounds ? Math.max(minX, bounds.minX - boundsMargin) : minX;
    const boundedMaxX = bounds ? Math.min(maxX, bounds.maxX + boundsMargin) : maxX;
    const boundedMinY = bounds ? Math.max(minY, bounds.minY - boundsMargin) : minY;
    const boundedMaxY = bounds ? Math.min(maxY, bounds.maxY + boundsMargin) : maxY;
    // Goal tolerance: at least effectiveStep but also the snap error from start/end
    const goalTol = effectiveStep * 0.6 + Math.max(
        Math.hypot(sx - startX, sy - startY),
        Math.hypot(ex - endX, ey - endY)
    );

    // Node key packs (x_μm, y_μm, layer) into a single safe-integer. Numeric
    // Map keys avoid per-expansion string allocation/hashing on the A* hot path.
    const nodeKey = packNodeKey;

    // startLayer is passed as parameter
    const startKey = nodeKey(startX, startY, startLayer);

    // Binary min-heap for priority queue
    const { push: pushHeap, pop: popHeap, size: heapSize } = createMinHeap();

    const gScore = new Map();
    const cameFrom = new Map(); // key → { x, y, layer, prevDir }
    const closed = new Set();

    gScore.set(startKey, 0);
    pushHeap({ x: startX, y: startY, layer: startLayer, f: 0 });

    // 8-directional neighbors
    const dirs = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [1, -1], [-1, 1], [-1, -1]
    ];


    const maxIterations = maxIter;
    let iterations = 0;
    let stagnantIterations = 0;
    let bestHSeen = Math.hypot(startX - endX, startY - endY);

    while (heapSize() > 0 && iterations < maxIterations) {
        if (cancelToken?.cancelled) return null;
        iterations++;
        if (yieldToUI && iterations % yieldEvery === 0) {
            onTick?.();
            await yieldToUI();
            if (cancelToken?.cancelled) return null;
        }
        const current = popHeap();
        const curKey = nodeKey(current.x, current.y, current.layer);

        if (closed.has(curKey)) continue;
        closed.add(curKey);

        const currentH = Math.hypot(current.x - endX, current.y - endY);
        if (currentH + effectiveStep * 0.25 < bestHSeen) {
            bestHSeen = currentH;
            stagnantIterations = 0;
        } else {
            stagnantIterations++;
            if (stagnantIterations > stagnationIters) return null;
        }

        // Goal check — only accept on a layer the destination pad supports
        if (Math.abs(current.x - endX) < goalTol &&
            Math.abs(current.y - endY) < goalTol) {
            // Verify we're on a valid layer for the destination pad
            const validEnd = endPadLayer === 'both' ||
                             endPadLayer === current.layer;
            if (validEnd) {
                // Goal-bridge clearance: the segment from (ex,ey) to current
                // is implicit (no A* expansion checked it). It can be up to
                // ~2 * effectiveStep long when effectiveStep is large, which
                // is plenty to clip a foreign pad. If blocked, FALL THROUGH
                // to neighbor expansion (do NOT `continue`) so A* can keep
                // exploring from `current` — a closer cell may yield a safe
                // bridge. Inside-pad exemption: if both endpoints lie inside
                // endPad, the bridge is fully inside own pad copper.
                const bridgeBothInside = endPad &&
                    isInsidePad(ex, ey, endPad) &&
                    isInsidePad(current.x, current.y, endPad);
                const bridgeClean = bridgeBothInside ||
                    !obstacles.isSegmentBlocked(ex, ey, current.x, current.y, totalClear, skipIds, current.layer, routingNet);
                if (bridgeClean) {
                    // Reconstruct path — include `current` so the bridge
                    // from (ex,ey) is short and the subsequent
                    // current→parent hop is the regular A*-checked edge.
                    const path = [
                        { x: ex, y: ey, layer: current.layer },
                        { x: current.x, y: current.y, layer: current.layer },
                    ];
                    const vias = [];
                    let key = curKey;
                    while (cameFrom.has(key)) {
                        const prev = cameFrom.get(key);
                        const pt = { x: prev.x, y: prev.y, layer: prev.layer };
                        // Detect via (layer changed)
                        if (path.length > 0 && path[path.length - 1].layer !== prev.layer) {
                            vias.push({ x: prev.x, y: prev.y });
                        }
                        path.push(pt);
                        key = nodeKey(prev.x, prev.y, prev.layer);
                    }
                    path.push({ x: sx, y: sy, layer: startLayer });
                    path.reverse();
                    return { path, vias };
                }
                // bridge blocked: fall through to neighbor expansion below
            } else {
                continue;  // wrong layer — keep searching, need to via first
            }
        }

        const curG = gScore.get(curKey);
        const prevInfo = cameFrom.get(curKey);
        const prevDx = prevInfo ? prevInfo.dx : 0;
        const prevDy = prevInfo ? prevInfo.dy : 0;

        // Try moving in 8 directions on same layer
        for (const [dx, dy] of dirs) {
            const nx = current.x + dx * effectiveStep;
            const ny = current.y + dy * effectiveStep;
            const nKey = nodeKey(nx, ny, current.layer);

            if (closed.has(nKey)) continue;

            // Generic pruning: keep expansion within a reasonable corridor.
            if (nx < boundedMinX || nx > boundedMaxX || ny < boundedMinY || ny > boundedMaxY) continue;

            // Generic pruning: skip nodes whose best possible route is already
            // too long relative to the direct route.
            const detourEstimate = Math.hypot(nx - startX, ny - startY) + Math.hypot(nx - endX, ny - endY);
            if (detourEstimate > detourCap) continue;

            // Pad-geometry clearance model:
            //   Segment ENTIRELY inside an own (start/end) pad: skip clearance.
            //     BOTH `current` AND neighbour must lie inside the SAME own
            //     pad. Otherwise the segment can cross the pad boundary and
            //     pass close to a foreign pad outside — that crossing portion
            //     would skip clearance and silently produce a DRC violation
            //     (the classic case: route ENTERING its destination pad from
            //     outside while a neighbouring foreign pad lies in the entry
            //     corridor). ALWAYS run the segment check unless we're
            //     walking entirely inside the pad copper.
            //   Near own pad: skip only the radial point check (which falsely
            //     blocks traces escaping between tight pads) but keep the full
            //     perpendicular segment check with totalClear — this correctly
            //     prevents traces from overlapping neighboring pads.
            //   Further out: full point + segment checks with totalClear.
            //
            // Note: we DO run these checks even when nKey == endpoint key.
            // Own pads are filtered via skipIds; foreign traces / pads are
            // NOT skipped, so they correctly block landing on a destination
            // cell that has been previously occupied by a foreign trace.
            const insideStartN = startPad && isInsidePad(nx, ny, startPad);
            const insideEndN   = endPad   && isInsidePad(nx, ny, endPad);
            const insideStartC = startPad && isInsidePad(current.x, current.y, startPad);
            const insideEndC   = endPad   && isInsidePad(current.x, current.y, endPad);
            const segInsideOwn = (insideStartN && insideStartC) || (insideEndN && insideEndC);
            if (!segInsideOwn) {
                const nearStart = startPad && isNearPad(nx, ny, startPad, gridStep * 2);
                const nearEnd = endPad && isNearPad(nx, ny, endPad, gridStep * 2);
                if (nearStart || nearEnd) {
                    // Near own pad: skip the radial point check (which falsely
                    // blocks tight escapes between own and neighboring pads),
                    // but keep the FULL totalClear segment check. Own-net
                    // source/dest pads are already in skipIds so they cannot
                    // block; foreign pads must still be respected at the full
                    // halfTrace+clearance distance.
                    if (obstacles.isSegmentBlocked(current.x, current.y, nx, ny, totalClear, skipIds, current.layer, routingNet)) continue;
                } else {
                    // Open field: full radial point check + segment check
                    if (obstacles.isBlocked(nx, ny, totalClear, skipIds, current.layer, routingNet)) continue;
                    if (obstacles.isSegmentBlocked(current.x, current.y, nx, ny, totalClear, skipIds, current.layer, routingNet)) continue;
                }
            }

            const stepCost = Math.hypot(dx, dy) * effectiveStep;
            // Bend penalty: if direction changed from previous move
            const bendPenalty = (prevDx !== 0 || prevDy !== 0) && (dx !== prevDx || dy !== prevDy) ? BEND_COST : 0;
            const isDiag = Math.abs(dx) + Math.abs(dy) === 2;
            const isHoriz = dy === 0 && dx !== 0;
            const isVert = dx === 0 && dy !== 0;

            // Layer-specific direction costs:
            //   Top Cu:    H=0, 45°=1.0, V=2.0
            //   Bottom Cu: V=0, 45°=1.0, H=2.0
            let dirPenalty = 0;
            if (current.layer === 'top') {
                if (isDiag) dirPenalty = gridStep * 1.0;
                else if (isVert) dirPenalty = gridStep * 2.0;
                // isHoriz = 0 (preferred)
            } else {
                if (isDiag) dirPenalty = gridStep * 1.0;
                else if (isHoriz) dirPenalty = gridStep * 2.0;
                // isVert = 0 (preferred)
            }
            dirPenalty *= dirPenaltyScale;

            // Pad exit/entry penalty: strongly prefer orthogonal traces near pads
            let padDiagPenalty = 0;
            if (isDiag) {
                const nearPad = obstacles.isOnPad(current.x, current.y, effectiveStep * 2);
                if (nearPad) padDiagPenalty = PAD_DIAG_COST;
            }

            // Centerline-exit preference: when the neighbour cell is inside
            // or just outside an own pad, add cost proportional to how far
            // it is from a centerline. For elongated pads only the long-axis
            // centerline counts; for square/round pads either axis is valid
            // (penalty is the distance to the nearest one), which steers
            // exits to N/S/E/W instead of corner-diagonal.
            let padCenterPenalty = 0;
            for (const ci of [startCenterline, endCenterline]) {
                if (!ci) continue;
                if (!isNearPad(nx, ny, ci.pad, ci.margin)) continue;
                const dxCenter = Math.abs(nx - ci.pad.x);
                const dyCenter = Math.abs(ny - ci.pad.y);
                let offCenter;
                if (ci.mode === 'horizontal')      offCenter = dyCenter;
                else if (ci.mode === 'vertical')   offCenter = dxCenter;
                else /* 'either' */                offCenter = Math.min(dxCenter, dyCenter);
                padCenterPenalty += offCenter * PAD_CENTER_COST;
            }

            // In congested neighborhoods, slightly bias against expansion.
            // Scale congestion avoidance by route distance: long routes can afford
            // detours to avoid congestion; short routes in dense areas cannot.
            const localDensity = obstacles.localDensity(nx, ny, skipIds, current.layer, 1);
            const congestionPenalty = Math.min(localDensity, 120) * gridStep * 0.01 * congestionPenaltyScale * distCongScale;

            // Historical congestion: penalize cells where many nets compete.
            let histPenalty = 0;
            if (congestionGrid && historyWeight > 0) {
                const cong = congestionGrid.getCongestion(nx, ny);
                if (cong > 1) histPenalty = (cong - 1) * gridStep * historyWeight * distCongScale;
            }

            // Pathfinder negotiated-congestion cost (additive, scaled by step length).
            const pathfinderCost = cellCostFn ? cellCostFn(nx, ny, current.layer) * stepCost : 0;

            const tentG = curG + stepCost + bendPenalty + dirPenalty + padDiagPenalty + padCenterPenalty + congestionPenalty + histPenalty + pathfinderCost;

            if (tentG < (gScore.has(nKey) ? gScore.get(nKey) : Infinity)) {
                gScore.set(nKey, tentG);
                cameFrom.set(nKey, { x: current.x, y: current.y, layer: current.layer, dx, dy });
                const h = Math.hypot(nx - endX, ny - endY);
                pushHeap({ x: nx, y: ny, layer: current.layer, f: tentG + greedyWeight * h });
            }
        }

        // Try via (layer change at same position)
        if (allowVias) {
            const otherLayer = current.layer === 'top' ? 'bottom' : 'top';
            const viaKey = nodeKey(current.x, current.y, otherLayer);
            if (!closed.has(viaKey)) {
                // Check the via position is clear on BOTH layers.
                // Use viaRadius + clearance (not totalClear) because the via copper
                // footprint is larger than a trace — its edge must maintain design
                // clearance from all other copper.
                // Foreign traces and other-net pads MUST be respected even at
                // endpoints; only own-net pads (in skipIds) are skipped. Without
                // this, a via could land on a previously-routed foreign trace
                // that happens to pass through the source/dest pad position on
                // the opposite layer.
                const viaClear = viaRadius + clearance;
                const clearOnOther = !obstacles.isBlocked(current.x, current.y, viaClear, skipIds, otherLayer, routingNet);
                const clearOnCurrent = !obstacles.isBlocked(current.x, current.y, viaClear, skipIds, current.layer, routingNet);

                // NEVER place a via on or near ANY pad — including the route's
                // own start/end pads. For SMD pads this would be a real DRC
                // violation (via-in-pad shorts the pad copper through the
                // plated hole to the wrong layer). For through-hole pads the
                // pad itself already conducts both layers, so a via on top is
                // redundant and just wastes routing space. The route must
                // escape the pad first, then place the via off-pad.
                const viaPadClear = viaRadius + clearance;
                const onPad = obstacles.isOnPad(current.x, current.y, viaPadClear);

                if (clearOnOther && clearOnCurrent && !onPad) {
                    const viaDensity = obstacles.localDensity(current.x, current.y, skipIds, otherLayer, 1);
                    const viaCongestionPenalty = Math.min(viaDensity, 120) * gridStep * 0.04 * viaCongestionScale;
                    // Pathfinder cost at the via destination cell (other layer, same x,y).
                    // Vias also consume routing resources on the layer they land on.
                    const viaPathfinderCost = cellCostFn ? cellCostFn(current.x, current.y, otherLayer) * VIA_COST : 0;
                    const tentG = curG + VIA_COST + viaCongestionPenalty + viaPathfinderCost;
                    if (tentG < (gScore.has(viaKey) ? gScore.get(viaKey) : Infinity)) {
                        gScore.set(viaKey, tentG);
                        cameFrom.set(viaKey, { x: current.x, y: current.y, layer: current.layer, dx: 0, dy: 0 });
                        const h = Math.hypot(current.x - endX, current.y - endY);
                        pushHeap({ x: current.x, y: current.y, layer: otherLayer, f: tentG + greedyWeight * h });
                    }
                }
            }
        }
    }

    return null;
}

// ── Cost-based Rip-up Probe ───────────────────────────────────────

/**
 * Lightweight A* probe that treats existing traces as crossable (with a high
 * penalty) instead of impassable. Returns the set of foreign connection IDs
 * whose traces the cheapest path actually crossed, or null if no path was found at
 * all (e.g. pads in the way).
 *
 * This is used during rip-up to surgically identify which connections to rip
 * instead of blasting every net along the direct bounding-box path.
 */
export async function astarProbe(sx, sy, ex, ey, obstacles, skipIds, gridStep, traceWidth, clearance, startLayer = 'top', endPadLayer = 'both', options = {}) {
    const {
        maxIter = 120000,
        cancelToken = null,
        yieldEvery = 5000,
        yieldToUI = null,
        bounds = null,
        routingNet = null,
    } = options;
    const halfTrace = traceWidth / 2;
    const totalClear = halfTrace + clearance;
    const viaRadius = clearance + halfTrace;  // conservative estimate for probing
    const CROSS_PENALTY = gridStep * 60;  // heavy but not infinite
    const VIA_COST = gridStep * 30;
    const routeDist = Math.hypot(ex - sx, ey - sy);
    const effectiveStep = Math.min(Math.max(gridStep, routeDist / 150), 2.0);
    const snap = (v) => Math.round(v / effectiveStep) * effectiveStep;
    const startX = snap(sx), startY = snap(sy);
    const endX = snap(ex), endY = snap(ey);
    const goalTol = effectiveStep * 0.6 + Math.max(
        Math.hypot(sx - startX, sy - startY),
        Math.hypot(ex - endX, ey - endY)
    );
    const margin = Math.max(routeDist * 0.8, effectiveStep * 40);
    const minX = Math.min(startX, endX) - margin;
    const maxX = Math.max(startX, endX) + margin;
    const minY = Math.min(startY, endY) - margin;
    const maxY = Math.max(startY, endY) + margin;
    const boundsMargin = effectiveStep * 3;
    const boundedMinX = bounds ? Math.max(minX, bounds.minX - boundsMargin) : minX;
    const boundedMaxX = bounds ? Math.min(maxX, bounds.maxX + boundsMargin) : maxX;
    const boundedMinY = bounds ? Math.max(minY, bounds.minY - boundsMargin) : minY;
    const boundedMaxY = bounds ? Math.min(maxY, bounds.maxY + boundsMargin) : maxY;

    // Numeric-packed node key; see packNodeKey for rationale.
    const nodeKey = packNodeKey;

    const startKey = nodeKey(startX, startY, startLayer);
    const { push: pushHeap, pop: popHeap, size: heapSize } = createMinHeap();

    const gScore = new Map();
    /** @type {Map<number, Set<string>>} nodeKey -> accumulated crossed connection IDs */
    const crossedAtNode = new Map();
    const closed = new Set();

    gScore.set(startKey, 0);
    crossedAtNode.set(startKey, new Set());
    pushHeap({ x: startX, y: startY, layer: startLayer, f: 0 });

    const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    let iterations = 0;

    while (heapSize() > 0 && iterations < maxIter) {
        if (cancelToken?.cancelled) return null;
        iterations++;
        if (yieldToUI && iterations % yieldEvery === 0) await yieldToUI();

        const current = popHeap();
        const curKey = nodeKey(current.x, current.y, current.layer);
        if (closed.has(curKey)) continue;
        closed.add(curKey);

        // Goal check
        if (Math.abs(current.x - endX) < goalTol && Math.abs(current.y - endY) < goalTol) {
            const validEnd = endPadLayer === 'both' || endPadLayer === current.layer;
            if (validEnd) {
                return crossedAtNode.get(curKey) || new Set();
            }
        }

        const curG = gScore.get(curKey);
        const curCrossed = crossedAtNode.get(curKey) || new Set();

        for (const [dx, dy] of dirs) {
            const nx = current.x + dx * effectiveStep;
            const ny = current.y + dy * effectiveStep;
            const nKey = nodeKey(nx, ny, current.layer);
            if (closed.has(nKey)) continue;
            if (nx < boundedMinX || nx > boundedMaxX || ny < boundedMinY || ny > boundedMaxY) continue;

            // Pads from other nets still hard-block (can't rip up pads)
            const padBlocked = obstacles.isBlocked(nx, ny, totalClear, skipIds, current.layer);
            let isPadBlock = false;
            if (padBlocked) {
                // If there are no trace crossings at this point, it must be a pad blocking
                const traceConns = obstacles.crossingConnIdsAtPoint(nx, ny, totalClear, skipIds, current.layer);
                isPadBlock = traceConns.size === 0;
            }
            if (isPadBlock) continue;  // hard-blocked by pad, skip

            const stepCost = Math.hypot(dx, dy) * effectiveStep;

            // crossing penalty: cost per connection crossed
            const segCrossed = obstacles.crossingConnIdsForSegment(
                current.x, current.y, nx, ny, totalClear, skipIds, current.layer
            );
            const crossPenalty = segCrossed.size * CROSS_PENALTY;

            const tentG = curG + stepCost + crossPenalty;
            if (tentG < (gScore.has(nKey) ? gScore.get(nKey) : Infinity)) {
                gScore.set(nKey, tentG);
                // Accumulate crossed connIds along this path
                const newCrossed = new Set(curCrossed);
                for (const cn of segCrossed) newCrossed.add(cn);
                crossedAtNode.set(nKey, newCrossed);
                const h = Math.hypot(nx - endX, ny - endY);
                pushHeap({ x: nx, y: ny, layer: current.layer, f: tentG + 1.5 * h });
            }
        }

        // Via
        const otherLayer = current.layer === 'top' ? 'bottom' : 'top';
        const viaKey = nodeKey(current.x, current.y, otherLayer);
        if (!closed.has(viaKey)) {
            const viaPadClear = viaRadius + clearance;
            const onPad = obstacles.isOnPad(current.x, current.y, viaPadClear);
            if (!onPad) {
                const tentG = curG + VIA_COST;
                if (tentG < (gScore.has(viaKey) ? gScore.get(viaKey) : Infinity)) {
                    gScore.set(viaKey, tentG);
                    crossedAtNode.set(viaKey, new Set(curCrossed));
                    const h = Math.hypot(current.x - endX, current.y - endY);
                    pushHeap({ x: current.x, y: current.y, layer: otherLayer, f: tentG + 1.5 * h });
                }
            }
        }
    }

    return null; // couldn't find any path even with crossings
}

// ── Path Simplification ───────────────────────────────────────────

/**
 * Check if a segment is at a valid PCB angle (0°, 45°, 90°, 135°).
 */
export function isValidAngle(x1, y1, x2, y2) {
    const dx = Math.abs(x2 - x1);
    const dy = Math.abs(y2 - y1);
    const tol = 0.01;
    if (dx < tol && dy < tol) return true;     // same point
    if (dx < tol) return true;                  // vertical
    if (dy < tol) return true;                  // horizontal
    if (Math.abs(dx - dy) < tol) return true;   // 45°
    return false;
}

/**
 * Fix non-H/V/45° segments by inserting dog-leg waypoints.
 * Also merges consecutive collinear segments.
 */
export function fixAngles(path) {
    if (path.length <= 1) return path;

    // First: merge consecutive collinear segments (same dx/dy direction)
    const merged = [path[0]];
    for (let i = 1; i < path.length; i++) {
        const prev = merged[merged.length - 1];
        const cur = path[i];
        if (merged.length >= 2 && prev.layer === cur.layer) {
            const pp = merged[merged.length - 2];
            // Only merge if segments are truly collinear (same actual slope)
            const adx1 = prev.x - pp.x, ady1 = prev.y - pp.y;
            const adx2 = cur.x - prev.x, ady2 = cur.y - prev.y;
            // Cross product: if zero, segments are collinear
            const cross = adx1 * ady2 - ady1 * adx2;
            if (Math.abs(cross) < 0.01 &&
                Math.sign(adx1) === Math.sign(adx2) &&
                Math.sign(ady1) === Math.sign(ady2)) {
                // Truly collinear and same direction — extend
                merged[merged.length - 1] = cur;
                continue;
            }
        }
        merged.push(cur);
    }

    // Second: fix remaining non-H/V/45° angles by decomposing into
    // a 45° diagonal segment + a H or V straight segment
    const result = [merged[0]];
    for (let i = 1; i < merged.length; i++) {
        const prev = result[result.length - 1];
        const cur = merged[i];
        if (prev.layer === cur.layer && !isValidAngle(prev.x, prev.y, cur.x, cur.y)) {
            const dx = cur.x - prev.x;
            const dy = cur.y - prev.y;
            const adx = Math.abs(dx);
            const ady = Math.abs(dy);
            if (adx > ady) {
                // Mostly horizontal: 45° diagonal for ady, then horizontal for the rest
                const diagX = prev.x + Math.sign(dx) * ady;
                result.push({ x: diagX, y: cur.y, layer: prev.layer });
            } else {
                // Mostly vertical: 45° diagonal for adx, then vertical for the rest
                const diagY = prev.y + Math.sign(dy) * adx;
                result.push({ x: cur.x, y: diagY, layer: prev.layer });
            }
        }
        result.push(cur);
    }
    return result;
}

/**
 * Build candidate 1–3 segment routes between two points using clean patterns:
 * direct, L-shaped, and 45°+straight combinations.
 */
export function buildCandidateRoutes(si, sj) {
    const layer = si.layer;
    const dx = sj.x - si.x;
    const dy = sj.y - si.y;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    const candidates = [];

    // 1. Direct line (works only if H/V/45°)
    candidates.push([si, sj]);

    // 2. L-shapes — order by preferred direction for the layer
    if (layer === 'bottom') {
        // Bottom prefers vertical → try V-first L
        candidates.push([si, { x: si.x, y: sj.y, layer }, sj]);
        candidates.push([si, { x: sj.x, y: si.y, layer }, sj]);
    } else {
        // Top prefers horizontal → try H-first L
        candidates.push([si, { x: sj.x, y: si.y, layer }, sj]);
        candidates.push([si, { x: si.x, y: sj.y, layer }, sj]);
    }

    // 3. 45° entry/exit + straight run
    if (ady > adx && adx > 0.001) {
        // Mostly vertical: 45° diagonal to align X, then straight vertical
        candidates.push([si, { x: sj.x, y: si.y + Math.sign(dy) * adx, layer }, sj]);
        // Or: straight vertical, then 45° diagonal to destination
        candidates.push([si, { x: si.x, y: sj.y - Math.sign(dy) * adx, layer }, sj]);
    } else if (adx > ady && ady > 0.001) {
        // Mostly horizontal: 45° diagonal to align Y, then straight horizontal
        candidates.push([si, { x: si.x + Math.sign(dx) * ady, y: sj.y, layer }, sj]);
        // Or: straight horizontal, then 45° diagonal to destination
        candidates.push([si, { x: sj.x - Math.sign(dx) * ady, y: si.y, layer }, sj]);
    }

    return candidates;
}

/**
 * Optimize path by replacing staircase patterns with clean L-shaped
 * or 45°+straight routes.  Runs after simplifyPath + fixAngles so it
 * can collapse dog-leg staircases into 1–3 segment routes.
 */
export function optimizePath(path, obstacles, skipIds, totalClear, skipNet = null) {
    if (path.length <= 3) return path;

    const result = [path[0]];
    let i = 0;

    while (i < path.length - 1) {
        let jumped = false;

        for (let j = path.length - 1; j > i + 1; j--) {
            const si = path[i], sj = path[j];
            if (sj.layer !== si.layer) continue;

            // All intermediate points must be on the same layer
            let sameLayer = true;
            for (let k = i + 1; k < j; k++) {
                if (path[k].layer !== si.layer) { sameLayer = false; break; }
            }
            if (!sameLayer) continue;

            const layer = si.layer;
            const candidates = buildCandidateRoutes(si, sj);

            for (const candidate of candidates) {
                let valid = true;
                for (let s = 0; s < candidate.length - 1; s++) {
                    const a = candidate[s], b = candidate[s + 1];
                    if (!isValidAngle(a.x, a.y, b.x, b.y)) { valid = false; break; }
                    // Prevent 45° segments near pads
                    const segDx = Math.abs(b.x - a.x);
                    const segDy = Math.abs(b.y - a.y);
                    if (segDx > 0.001 && segDy > 0.001) {
                        if (obstacles.isOnPad(a.x, a.y, totalClear) ||
                            obstacles.isOnPad(b.x, b.y, totalClear)) { valid = false; break; }
                    }
                    if (obstacles.isSegmentBlocked(a.x, a.y, b.x, b.y, totalClear, skipIds, layer, skipNet)) { valid = false; break; }
                }
                if (valid) {
                    for (let s = 1; s < candidate.length; s++) {
                        result.push(candidate[s]);
                    }
                    i = j;
                    jumped = true;
                    break;
                }
            }
            if (jumped) break;
        }

        if (!jumped) {
            i++;
            result.push(path[i]);
        }
    }

    return result;
}

export function simplifyPath(path, obstacles, skipIds, totalClear, skipNet = null) {
    if (path.length <= 2) return path;

    const result = [path[0]];
    let i = 0;

    while (i < path.length - 1) {
        let farthest = i + 1;
        for (let j = path.length - 1; j > i + 1; j--) {
            // Can only simplify within same layer
            if (path[j].layer !== path[i].layer) continue;
            let sameLayer = true;
            for (let k = i + 1; k < j; k++) {
                if (path[k].layer !== path[i].layer) { sameLayer = false; break; }
            }
            if (!sameLayer) continue;

            // Only allow H/V/45° simplified segments
            if (!isValidAngle(path[i].x, path[i].y, path[j].x, path[j].y)) continue;

            // If either end of this segment is near a pad, only allow H/V (no 45°)
            const isDiagSeg = Math.abs(Math.abs(path[j].x - path[i].x) - Math.abs(path[j].y - path[i].y)) < 0.001
                && Math.abs(path[j].x - path[i].x) > 0.001;
            if (isDiagSeg) {
                const startNearPad = obstacles.isOnPad(path[i].x, path[i].y, totalClear);
                const endNearPad = obstacles.isOnPad(path[j].x, path[j].y, totalClear);
                if (startNearPad || endNearPad) continue; // don't simplify to diagonal near pads
            }

            if (!obstacles.isSegmentBlocked(
                path[i].x, path[i].y,
                path[j].x, path[j].y,
                totalClear, skipIds, path[i].layer, skipNet
            )) {
                farthest = j;
                break;
            }
        }
        result.push(path[farthest]);
        i = farthest;
    }

    return result;
}

/**
 * Final sanitization: forcefully decompose every segment that is not
 * at a valid PCB angle into a 45°+H/V pair. Runs on the final output
 * points before rendering.
 */
export function sanitizeAngles(pts) {
    if (pts.length <= 1) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
        const prev = out[out.length - 1];
        const cur = pts[i];
        if (!isValidAngle(prev.x, prev.y, cur.x, cur.y)) {
            const dx = cur.x - prev.x;
            const dy = cur.y - prev.y;
            const diag = Math.min(Math.abs(dx), Math.abs(dy));
            // Insert a 45° elbow of `diag` length; the remainder to `cur`
            // is automatically H (if |dx|>|dy|) or V (if |dy|>|dx|).
            out.push({
                x: prev.x + Math.sign(dx) * diag,
                y: prev.y + Math.sign(dy) * diag,
                layer: cur.layer,
            });
        }
        out.push(cur);
    }
    return out;
}

