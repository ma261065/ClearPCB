/**
 * ClearPCB Maze Router with Rip-up-and-Reroute
 *
 * Inspired by Freerouting's core algorithm:
 *   - Weighted A* with 8-direction + 45° movement
 *   - Two-layer routing with via support (F.Cu + B.Cu)
 *   - Rip-up-and-reroute: failed nets cause blocking traces to be
 *     removed and re-routed in a different order
 *   - Bend penalty to prefer straight traces
 *   - Via cost to minimize layer transitions
 *   - Path simplification (line-of-sight)
 *   - Spatial hash for fast obstacle lookup
 *   - Multiple passes with increasing flexibility
 */

// ── Spatial Hash Index ────────────────────────────────────────────

class SpatialHash {
    /**
     * @param {number} cellSize - Size of each hash cell in mm
     */
    constructor(cellSize) {
        this.cellSize = cellSize;
        /** @type {Map<string, Array<object>>} */
        this.cells = new Map();
    }

    _key(cx, cy) { return `${cx},${cy}`; }

    /**
     * Insert a line segment obstacle with half-width clearance.
     * @param {number} x1 @param {number} y1 @param {number} x2 @param {number} y2
     * @param {number} hw - half-width (trace radius + clearance)
     * @param {string} net - which net this belongs to (same-net doesn't block)
     */
    insert(x1, y1, x2, y2, hw, net, layer = 'top') {
        const obj = { x1, y1, x2, y2, hw, net, layer };
        const minCX = Math.floor((Math.min(x1, x2) - hw) / this.cellSize);
        const maxCX = Math.floor((Math.max(x1, x2) + hw) / this.cellSize);
        const minCY = Math.floor((Math.min(y1, y2) - hw) / this.cellSize);
        const maxCY = Math.floor((Math.max(y1, y2) + hw) / this.cellSize);
        for (let cx = minCX; cx <= maxCX; cx++) {
            for (let cy = minCY; cy <= maxCY; cy++) {
                const key = this._key(cx, cy);
                if (!this.cells.has(key)) this.cells.set(key, []);
                this.cells.get(key).push(obj);
            }
        }
    }

    /**
     * Remove all segments belonging to a specific net.
     * Used by rip-up-and-reroute.
     */
    removeNet(net) {
        for (const [key, objs] of this.cells) {
            // Keep component pads, but remove net-owned via obstacles on rip-up.
            const filtered = objs.filter(o => o.net !== net || (o.isPad && !o.isVia));
            if (filtered.length === 0) this.cells.delete(key);
            else this.cells.set(key, filtered);
        }
    }

    /**
     * Insert a rectangular pad obstacle.
     * @param {number} cx @param {number} cy @param {number} w @param {number} h
     * @param {string} net
     */
    insertPad(cx, cy, w, h, net, padLayer = 'both', options = {}) {
        const hw = w / 2, hh = h / 2;
        const obj = { cx, cy, hw, hh, net, isPad: true, layer: padLayer, isVia: !!options.isVia };
        // Register in all cells the pad overlaps
        const minCX = Math.floor((cx - hw) / this.cellSize);
        const maxCX = Math.floor((cx + hw) / this.cellSize);
        const minCY = Math.floor((cy - hh) / this.cellSize);
        const maxCY = Math.floor((cy + hh) / this.cellSize);
        for (let gx = minCX; gx <= maxCX; gx++) {
            for (let gy = minCY; gy <= maxCY; gy++) {
                const key = this._key(gx, gy);
                if (!this.cells.has(key)) this.cells.set(key, []);
                this.cells.get(key).push(obj);
            }
        }
    }

    /**
     * Check if a point overlaps any pad (regardless of layer or net).
     * Used to prevent vias from being placed on top of pads.
     * Does NOT skip any pads — vias must never land on ANY pad.
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
                    if (x >= obj.cx - obj.hw - clearance &&
                        x <= obj.cx + obj.hw + clearance &&
                        y >= obj.cy - obj.hh - clearance &&
                        y <= obj.cy + obj.hh + clearance) return true;
                }
            }
        }
        return false;
    }

    /**
     * Check if a point is blocked (too close to any obstacle from a different net).
     * @param {number} x @param {number} y @param {number} clearance
     * @param {string|Set<string>} skipIds - the net we're routing (same-net obstacles are ignored)
     * @returns {boolean}
     */
    /**
     * Check if a point is blocked.
     * @param {number} x @param {number} y @param {number} clearance
     * @param {string|Set<string>} skipIds - obstacle IDs to skip (source/dest pads)
     * @returns {boolean}
     */
    isBlocked(x, y, clearance, skipIds, layer = null) {
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
                    // Layer check: obstacles only block on the same layer.
                    // Pads with layer='both' block all layers; single-layer pads
                    // only block their own layer. Traces only block same layer.
                    if (layer) {
                        const objLayer = obj.layer || 'both';
                        if (objLayer !== 'both' && objLayer !== layer) continue;
                    }
                    if (obj.isPad) {
                        if (x >= obj.cx - obj.hw - clearance &&
                            x <= obj.cx + obj.hw + clearance &&
                            y >= obj.cy - obj.hh - clearance &&
                            y <= obj.cy + obj.hh + clearance) return true;
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
    isSegmentBlocked(ax1, ay1, ax2, ay2, clearance, skipIds, layer = null) {
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
                    if (layer) {
                        const objLayer = obj.layer || 'both';
                        if (objLayer !== 'both' && objLayer !== layer) continue;
                    }
                    if (obj.isPad) {
                        const rx1 = obj.cx - obj.hw - clearance;
                        const ry1 = obj.cy - obj.hh - clearance;
                        const rx2 = obj.cx + obj.hw + clearance;
                        const ry2 = obj.cy + obj.hh + clearance;
                        if (segmentIntersectsAABB(ax1, ay1, ax2, ay2, rx1, ry1, rx2, ry2)) return true;
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
                    if (!obj.isPad) {
                        const d = segmentToSegmentDist(ax1, ay1, ax2, ay2, obj.x1, obj.y1, obj.x2, obj.y2);
                        if (d < obj.hw + clearance && obj.net) blocking.add(obj.net);
                    }
                }
            }
        }
        return blocking;
    }

    /**
     * Estimate local obstacle density near a point.
     * Returns the count of nearby obstacle objects (excluding skipped IDs).
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
}

// ── Geometry Helpers ──────────────────────────────────────────────

/**
 * Distance from point (px,py) to line segment (x1,y1)-(x2,y2).
 */
function pointToSegmentDist(px, py, x1, y1, x2, y2) {
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
function segmentIntersectsAABB(x1, y1, x2, y2, rxMin, ryMin, rxMax, ryMax) {
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
function segmentsIntersect(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
    const cross = (ox, oy, dx, dy, px, py) => dx * (py - oy) - dy * (px - oy ? py - oy : px - ox);
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
function segmentToSegmentDist(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2) {
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

// ── A* Pathfinder ─────────────────────────────────────────────────

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
async function astarRoute(sx, sy, ex, ey, obstacles, skipIds, gridStep, traceWidth, clearance, greedyWeight = 2.5, allowVias = true, startLayer = 'top', endPadLayer = 'both', options = {}) {
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
    } = options;
    const halfTrace = traceWidth / 2;
    const totalClear = halfTrace + clearance;
    const VIA_COST = gridStep * 30;
    const BEND_COST = gridStep * 0.5;
    const PAD_DIAG_COST = gridStep * 5;

    const routeDist = Math.hypot(ex - sx, ey - sy);
    // Cap the effective step — never coarser than 2mm, gives enough resolution
    const effectiveStep = Math.min(Math.max(gridStep, routeDist / 200), 2.0);

    const snap = (v) => Math.round(v / effectiveStep) * effectiveStep;
    const startX = snap(sx), startY = snap(sy);
    const endX = snap(ex), endY = snap(ey);
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

    // Node key includes layer: "x,y,layer"
    function nodeKey(x, y, layer) { return `${Math.round(x * 1000)},${Math.round(y * 1000)},${layer}`; }

    // startLayer is passed as parameter
    const startKey = nodeKey(startX, startY, startLayer);

    // Binary min-heap for priority queue
    const heap = [];
    const pushHeap = (node) => {
        heap.push(node);
        let i = heap.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (heap[parent].f <= heap[i].f) break;
            [heap[parent], heap[i]] = [heap[i], heap[parent]];
            i = parent;
        }
    };
    const popHeap = () => {
        const top = heap[0];
        const last = heap.pop();
        if (heap.length > 0) {
            heap[0] = last;
            let i = 0;
            while (true) {
                let smallest = i;
                const l = 2 * i + 1, r = 2 * i + 2;
                if (l < heap.length && heap[l].f < heap[smallest].f) smallest = l;
                if (r < heap.length && heap[r].f < heap[smallest].f) smallest = r;
                if (smallest === i) break;
                [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
                i = smallest;
            }
        }
        return top;
    };

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
    let lastYieldAt = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();

    while (heap.length > 0 && iterations < maxIterations) {
        if (cancelToken?.cancelled) return null;
        iterations++;
        if (yieldToUI && iterations % yieldEvery === 0) {
            const now = (typeof performance !== 'undefined' && performance.now)
                ? performance.now()
                : Date.now();
            if (now - lastYieldAt >= minYieldIntervalMs) {
                onTick?.();
                await yieldToUI();
                if (cancelToken?.cancelled) return null;
                lastYieldAt = (typeof performance !== 'undefined' && performance.now)
                    ? performance.now()
                    : Date.now();
            }
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
            if (!validEnd) continue;  // keep searching — need to via first
            // Reconstruct path
            const path = [{ x: ex, y: ey, layer: current.layer }];
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

            const nStartKey = nodeKey(startX, startY, current.layer);
            const nEndKeyTop = nodeKey(endX, endY, 'top');
            const nEndKeyBot = nodeKey(endX, endY, 'bottom');
            if (nKey !== nStartKey && nKey !== nEndKeyTop && nKey !== nEndKeyBot) {
                if (obstacles.isBlocked(nx, ny, totalClear, skipIds, current.layer)) continue;
                if (obstacles.isSegmentBlocked(current.x, current.y, nx, ny, totalClear, skipIds, current.layer)) continue;
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

            // Pad exit/entry penalty: strongly prefer orthogonal traces near pads
            let padDiagPenalty = 0;
            if (isDiag) {
                const nearPad = obstacles.isOnPad(current.x, current.y, effectiveStep * 2);
                if (nearPad) padDiagPenalty = PAD_DIAG_COST;
            }

            // In congested neighborhoods, slightly bias against expansion.
            const localDensity = obstacles.localDensity(nx, ny, skipIds, current.layer, 1);
            const congestionPenalty = Math.min(localDensity, 120) * gridStep * 0.01;

            const tentG = curG + stepCost + bendPenalty + dirPenalty + padDiagPenalty + congestionPenalty;

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
                // Don't place vias at start/end pad positions
                const nStartKey = nodeKey(startX, startY, otherLayer);
                const nEndKeyTop = nodeKey(endX, endY, 'top');
                const nEndKeyBot = nodeKey(endX, endY, 'bottom');
                const isEndpoint = viaKey === nStartKey || viaKey === nEndKeyTop || viaKey === nEndKeyBot;

                // Check the via position is clear on BOTH layers
                const clearOnOther = isEndpoint || !obstacles.isBlocked(current.x, current.y, totalClear, skipIds, otherLayer);
                const clearOnCurrent = isEndpoint || !obstacles.isBlocked(current.x, current.y, totalClear, skipIds, current.layer);

                // NEVER place a via on or near ANY pad — use generous clearance
                const viaPadClear = totalClear * 2;
                const onPad = obstacles.isOnPad(current.x, current.y, viaPadClear);

                if (clearOnOther && clearOnCurrent && !onPad) {
                    const viaDensity = obstacles.localDensity(current.x, current.y, skipIds, otherLayer, 1);
                    const viaCongestionPenalty = Math.min(viaDensity, 120) * gridStep * 0.04;
                    const tentG = curG + VIA_COST + viaCongestionPenalty;
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

// ── Path Simplification ───────────────────────────────────────────

/**
 * Simplify a path by removing redundant waypoints.
 * If we can go directly from point A to point C without collision,
 * remove point B.
 *
 * @param {Array<{x: number, y: number}>} path
 * @param {SpatialHash} obstacles
 * @param {string|Set<string>} skipIds
 * @param {number} totalClear
 * @returns {Array<{x: number, y: number}>}
 */
/**
 * Check if a segment is at a valid PCB angle (0°, 45°, 90°, 135°).
 */
function isValidAngle(x1, y1, x2, y2) {
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
function fixAngles(path) {
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
function buildCandidateRoutes(si, sj) {
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
function optimizePath(path, obstacles, skipIds, totalClear) {
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
                    if (obstacles.isSegmentBlocked(a.x, a.y, b.x, b.y, totalClear, skipIds, layer)) { valid = false; break; }
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

function simplifyPath(path, obstacles, skipIds, totalClear) {
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
                totalClear, skipIds, path[i].layer
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
function sanitizeAngles(pts) {
    if (pts.length <= 1) return pts;
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
        const prev = out[out.length - 1];
        const cur = pts[i];
        if (!isValidAngle(prev.x, prev.y, cur.x, cur.y)) {
            const dx = cur.x - prev.x;
            const dy = cur.y - prev.y;
            const adx = Math.abs(dx);
            const ady = Math.abs(dy);
            const diag = Math.min(adx, ady);
            if (adx > ady) {
                // 45° diagonal for diag distance, then horizontal
                out.push({ x: prev.x + Math.sign(dx) * diag, y: prev.y + Math.sign(dy) * diag, layer: cur.layer });
            } else {
                // 45° diagonal for diag distance, then vertical
                out.push({ x: prev.x + Math.sign(dx) * diag, y: prev.y + Math.sign(dy) * diag, layer: cur.layer });
            }
        }
        out.push(cur);
    }
    return out;
}

// ── Main Router ───────────────────────────────────────────────────

/**
 * @typedef {Object} RouteInput
 * @property {Array<{net: string, pads: Array<{x: number, y: number, width: number, height: number}>}>} connections
 * @property {Array<{x: number, y: number, width: number, height: number}>} [allObstaclePads] - ALL component pads (including unconnected)
 * @property {number} [traceWidth=0.254] - trace width in mm
 * @property {number} [clearance=0.2] - clearance in mm
 * @property {number} [gridStep=0.254] - routing grid step in mm
 * @property {{minX: number, minY: number, maxX: number, maxY: number}} bounds
 */

/**
 * @typedef {Object} RouteResult
 * @property {Array<{net: string, points: Array<{x: number, y: number}>, layer: string}>} traces
 * @property {string[]} failed - net names that couldn't be routed
 * @property {Array<{net: string, x: number, y: number}>} [vias] - via locations
 */

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
 * @param {function(number, number, string): void} [options.onProgress] - (completed, total, netName)
 * @param {function(Array): void} [options.onNetRouted] - called with trace segments after each net is routed
 * @param {function(object): void} [options.onNetFailed] - called with the connection object when a net fails
 * @param {function(object, object): void} [options.onTrying] - called with (fromPad, toPad) before each routing attempt
 * @param {{cancelled: boolean}} [options.cancelToken] - set .cancelled = true to abort
 * @returns {Promise<RouteResult>}
 */
export async function routeAll(input, options = {}) {
    const { onProgress, onNetRouted, onNetFailed, onTrying, cancelToken } = options;
    /** Yield to browser so UI can repaint & cancel clicks can fire */
    const yieldToUI = () => new Promise(r => setTimeout(r, 0));
    const traceWidth = input.traceWidth || 0.254;
    const clearance = input.clearance || 0.2;
    const gridStep = input.gridStep || 0.5;
    const halfTrace = traceWidth / 2;
    const totalClear = halfTrace + clearance;
    const MAX_PASSES = 4;

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
    for (const conn of input.connections) {
        const ids = new Set();
        const used = new Set();
        for (const cpad of conn.pads) {
            const found = findMatchingPad(cpad, used);
            if (found) {
                ids.add(found.id);
                used.add(found.id);
            }
        }
        netPadIds.set(conn.net, ids);
    }

    // Connection map for quick lookup
    const connMap = new Map();
    for (const conn of input.connections) {
        if (conn.pads.length >= 2) connMap.set(conn.net, conn);
    }

    /** Optional route cache reused across rip-up passes. */
    const routeAttemptCache = new Map();
    let obstacleVersion = 0;

    /**
     * Build a fresh obstacle hash and insert all pads.
     */
    function buildObstacles() {
        const obs = new SpatialHash(cellSize);
        for (const pad of allPads) {
            obs.insertPad(pad.x, pad.y, pad.width, pad.height, pad.id, pad.layer || 'both');
        }
        obstacleVersion = 1;
        return obs;
    }

    function cloneAstarResult(result) {
        return {
            path: result.path.map(p => ({ x: p.x, y: p.y, layer: p.layer })),
            vias: result.vias.map(v => ({ x: v.x, y: v.y })),
        };
    }

    function isCachedPathStillClear(path, skipIds, totalClear) {
        for (let i = 1; i < path.length; i++) {
            const a = path[i - 1];
            const b = path[i];
            if (a.layer === b.layer) {
                if (obstacles.isSegmentBlocked(a.x, a.y, b.x, b.y, totalClear, skipIds, a.layer)) return false;
            } else {
                if (obstacles.isBlocked(a.x, a.y, totalClear, skipIds, 'top')) return false;
                if (obstacles.isBlocked(a.x, a.y, totalClear, skipIds, 'bottom')) return false;
            }
        }
        return true;
    }

    function makeAttemptKey(from, to, startLayer, endLayer, step, weight) {
        return [
            from.x.toFixed(3), from.y.toFixed(3), from.layer || 'both',
            to.x.toFixed(3), to.y.toFixed(3), to.layer || 'both',
            startLayer, endLayer,
            step.toFixed(3), weight.toFixed(2),
            traceWidth.toFixed(3), clearance.toFixed(3),
        ].join('|');
    }

    function getCachedAttemptResult(key, skipIds) {
        const entry = routeAttemptCache.get(key);
        if (!entry) return undefined;
        if (entry.successResult && isCachedPathStillClear(entry.successResult.path, skipIds, totalClear)) {
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
     * Route a single net. Returns traces array or null.
     */
    async function routeNet(conn, obstacles, skipIds) {
        const traces = [];
        for (let i = 0; i < conn.pads.length - 1; i++) {
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
                    !obstacles.isSegmentBlocked(from.x, from.y, to.x, to.y, totalClear, skipIds, layer)) {
                    traces.push({ net: conn.net, points: [
                        { x: from.x, y: from.y, layer },
                        { x: to.x, y: to.y, layer }
                    ], layer, vias: [] });
                    obstacles.insert(from.x, from.y, to.x, to.y, halfTrace, conn.net, layer);
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
                    // Check all segments are clear
                    let allClear = true;
                    for (let k = 0; k < cleanPts.length - 1; k++) {
                        if (obstacles.isSegmentBlocked(cleanPts[k].x, cleanPts[k].y, cleanPts[k+1].x, cleanPts[k+1].y, totalClear, skipIds, layer)) {
                            allClear = false;
                            break;
                        }
                    }
                    if (allClear) {
                        traces.push({ net: conn.net, points: cleanPts, layer, vias: [] });
                        for (let k = 0; k < cleanPts.length - 1; k++) {
                            obstacles.insert(cleanPts[k].x, cleanPts[k].y, cleanPts[k+1].x, cleanPts[k+1].y, halfTrace, conn.net, layer);
                        }
                        obstacleVersion++;
                        routed = true;
                        break;
                    }
                }
            }
            if (routed) continue;

            // A* with via support — try starting on each viable layer
            const startLayers = fromLayer === 'both' ? ['top', 'bottom']
                : [fromLayer];
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

                const attempt1Key = makeAttemptKey(from, to, startLayer, endLayer, gridStep, 1.4);
                const cached1 = getCachedAttemptResult(attempt1Key, skipIds);
                if (cached1 !== undefined) {
                    result = cached1;
                } else {
                    result = await astarRoute(
                    from.x, from.y, to.x, to.y,
                    obstacles, skipIds, gridStep, traceWidth, clearance,
                    1.4, true, startLayer, endLayer,
                    {
                        maxIter: 100000,
                        stagnationIters: 25000,
                        cancelToken,
                        yieldToUI,
                        onTick: throttledTryingTick,
                        maxDetourFactor: 2.0,
                        bounds: routeBounds,
                    }
                    );
                    setCachedAttemptResult(attempt1Key, result);
                }
                if (result) break;

                onTrying?.(from, to);
                await yieldToUI();

                // Try 2: finer grid (300K)
                const attempt2Key = makeAttemptKey(from, to, startLayer, endLayer, gridStep * 0.5, 1.2);
                const cached2 = getCachedAttemptResult(attempt2Key, skipIds);
                if (cached2 !== undefined) {
                    result = cached2;
                } else {
                    result = await astarRoute(
                    from.x, from.y, to.x, to.y,
                    obstacles, skipIds, gridStep * 0.5, traceWidth, clearance,
                    1.2, true, startLayer, endLayer,
                    {
                        maxIter: 300000,
                        stagnationIters: 60000,
                        cancelToken,
                        yieldToUI,
                        onTick: throttledTryingTick,
                        maxDetourFactor: 3.0,
                        bounds: routeBounds,
                    }
                    );
                    setCachedAttemptResult(attempt2Key, result);
                }
                if (result) break;

                onTrying?.(from, to);
                await yieldToUI();

                // Try 3: finest grid, thorough search (600K)
                const attempt3Key = makeAttemptKey(from, to, startLayer, endLayer, gridStep * 0.25, 1.0);
                const cached3 = getCachedAttemptResult(attempt3Key, skipIds);
                if (cached3 !== undefined) {
                    result = cached3;
                } else {
                    result = await astarRoute(
                    from.x, from.y, to.x, to.y,
                    obstacles, skipIds, gridStep * 0.25, traceWidth, clearance,
                    1.0, true, startLayer, endLayer,
                    {
                        maxIter: 600000,
                        stagnationIters: 120000,
                        cancelToken,
                        yieldToUI,
                        onTick: throttledTryingTick,
                        maxDetourFactor: 5.0,
                        bounds: routeBounds,
                    }
                    );
                    setCachedAttemptResult(attempt3Key, result);
                }
                if (result) break;
            }

            if (result) {
                const rawSimplified = simplifyPath(result.path, obstacles, skipIds, totalClear);
                const fixed = fixAngles(rawSimplified);
                const simplified = fixAngles(optimizePath(fixed, obstacles, skipIds, totalClear));
                // Detect vias directly from the simplified path — wherever
                // the layer changes between consecutive points, place a via
                const detectedVias = [];
                for (let s = 1; s < simplified.length; s++) {
                    if (simplified[s].layer !== simplified[s-1].layer) {
                        detectedVias.push({ x: simplified[s].x, y: simplified[s].y });
                    }
                }

                // Split path into strictly single-layer segments.
                let runStart = 0;
                const flushRun = (runEnd) => {
                    const segPts = simplified.slice(runStart, runEnd + 1);
                    const layer = simplified[runStart].layer || 'top';
                    if (segPts.length < 2) return;
                    const cleanPts = sanitizeAngles(segPts);
                    traces.push({ net: conn.net, points: cleanPts, layer, vias: [] });
                    for (let k = 0; k < cleanPts.length - 1; k++) {
                        obstacles.insert(cleanPts[k].x, cleanPts[k].y, cleanPts[k+1].x, cleanPts[k+1].y,
                            halfTrace, conn.net, layer);
                    }
                    obstacleVersion++;
                };

                for (let s = 1; s < simplified.length; s++) {
                    if (simplified[s].layer !== simplified[s - 1].layer) {
                        flushRun(s - 1);
                        runStart = s;
                    }
                }
                flushRun(simplified.length - 1);
                // Attach detected vias to the last trace segment
                if (detectedVias.length > 0 && traces.length > 0) {
                    traces[traces.length - 1].vias = detectedVias;
                }

                // Register vias as obstacles so future nets avoid them
                const viaDia = totalClear * 2;  // via occupies space on both layers
                for (const v of detectedVias) {
                    obstacles.insertPad(v.x, v.y, viaDia, viaDia, conn.net, 'both', { isVia: true });
                }
                if (detectedVias.length > 0) obstacleVersion++;
            } else {
                return null; // failed
            }
        }
        return traces;
    }

    // ── Pass 1: Initial routing (shortest nets first) ────────────

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

    const sorted = [...connMap.values()].sort((a, b) => netDifficultyScore(a) - netDifficultyScore(b));
    const totalNets = sorted.length;
    let completedNets = 0;

    let obstacles = buildObstacles();
    /** @type {Map<string, Array>} net → traces */
    const routedTraces = new Map();
    const failedNets = [];

    for (const conn of sorted) {
        if (cancelToken?.cancelled) break;
        onProgress?.(completedNets, totalNets, conn.net);
        await yieldToUI();

        const skipIds = netPadIds.get(conn.net) || new Set();
        skipIds.add(conn.net);

        const result = await routeNet(conn, obstacles, skipIds);
        if (result) {
            routedTraces.set(conn.net, result);
            onNetRouted?.(result);
        } else {
            failedNets.push(conn.net);
            onNetFailed?.(conn);
        }
        completedNets++;
    }

    // ── Passes 2+: Rip-up-and-reroute ────────────────────────────

    for (let pass = 1; pass <= MAX_PASSES && failedNets.length > 0; pass++) {
        if (cancelToken?.cancelled) break;
        onProgress?.(completedNets, totalNets, `Rip-up pass ${pass}`);
        await yieldToUI();
        const stillFailed = [];

        for (const failedNet of failedNets) {
            if (cancelToken?.cancelled) break;
            const conn = connMap.get(failedNet);
            if (!conn) continue;

            onProgress?.(completedNets, totalNets, `Rip-up: ${failedNet}`);
            await yieldToUI();

            // Find which nets block the direct path
            const skipIds = netPadIds.get(failedNet) || new Set();
            skipIds.add(failedNet);
            const blockingNets = new Set();
            for (let i = 0; i < conn.pads.length - 1; i++) {
                const from = conn.pads[i];
                const to = conn.pads[i + 1];
                const blockers = obstacles.findBlockingNets(from.x, from.y, to.x, to.y, totalClear, skipIds);
                for (const b of blockers) blockingNets.add(b);
            }

            if (blockingNets.size === 0) {
                // No trace obstacles — just pads in the way, can't help
                stillFailed.push(failedNet);
                onNetFailed?.(conn);
                continue;
            }

            // Rip up blocking nets
            const rippedNets = [];
            for (const bn of blockingNets) {
                if (routedTraces.has(bn)) {
                    obstacles.removeNet(bn);
                    obstacleVersion++;
                    rippedNets.push(bn);
                    routedTraces.delete(bn);
                }
            }

            // Try routing the failed net now
            const result = await routeNet(conn, obstacles, skipIds);
            if (result) {
                routedTraces.set(failedNet, result);
                onNetRouted?.(result);
            } else {
                stillFailed.push(failedNet);
                onNetFailed?.(conn);
            }

            // Re-route ripped nets
            for (const rn of rippedNets) {
                const rc = connMap.get(rn);
                if (!rc) continue;
                const rSkip = netPadIds.get(rn) || new Set();
                rSkip.add(rn);
                const rResult = await routeNet(rc, obstacles, rSkip);
                if (rResult) {
                    routedTraces.set(rn, rResult);
                    onNetRouted?.(rResult);
                } else {
                    // Ripped net can't reroute — it becomes failed
                    if (!stillFailed.includes(rn)) stillFailed.push(rn);
                    onNetFailed?.(rc);
                }
            }
        }

        failedNets.length = 0;
        failedNets.push(...stillFailed);

        if (failedNets.length === 0) break;
    }

    // ── Collect results ──────────────────────────────────────────

    const allTraces = [];
    const allVias = [];
    for (const [, netTraces] of routedTraces) {
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

    return { traces: allTraces, failed: failedNets, vias: allVias };
}

/**
 * Manhattan distance for the shortest pair in a net.
 */
function netManhattan(conn) {
    if (conn.pads.length < 2) return Infinity;
    let min = Infinity;
    for (let i = 0; i < conn.pads.length - 1; i++) {
        const d = Math.abs(conn.pads[i].x - conn.pads[i + 1].x) +
                  Math.abs(conn.pads[i].y - conn.pads[i + 1].y);
        min = Math.min(min, d);
    }
    return min;
}

