// @ts-nocheck — SpatialHash uses runtime type narrowing (obj.isPad) that JSDoc cannot express
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

// ── Binary Min-Heap (shared by astarRoute / astarProbe) ──────────

/**
 * Create a binary min-heap ordering nodes by `node.f` (ascending).
 * Shared between the cost-based router and the rip-up probe so that
 * both use identical priority-queue semantics.
 *
 * @returns {{ push: (node: {f: number}) => void, pop: () => any, size: () => number }}
 */
function createMinHeap() {
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

class SpatialHash {
    /**
     * @param {number} cellSize - Size of each hash cell in mm
     */
    constructor(cellSize) {
        this.cellSize = cellSize;
        /** @type {Map<string, Array<SpatialObstacle>>} */
        this.cells = new Map();
    }

    /**
     * @param {number} cx
     * @param {number} cy
     */
    _key(cx, cy) { return `${cx},${cy}`; }

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
        for (let cx = minCX; cx <= maxCX; cx++) {
            for (let cy = minCY; cy <= maxCY; cy++) {
                const key = this._key(cx, cy);
                if (!this.cells.has(key)) this.cells.set(key, []);
                this.cells.get(key).push(obj);
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
        for (const [key, objs] of this.cells) {
            // Fast path: no obstacle in this cell carries this connId
            let hasMatch = false;
            for (const o of objs) {
                if (o.connId === connId && !(o.isPad && !o.isVia)) { hasMatch = true; break; }
            }
            if (!hasMatch) continue;
            // Keep obstacles that either belong to a different connection,
            // or are non-via pads (which we never rip).
            const filtered = objs.filter(o => o.connId !== connId || (o.isPad && !o.isVia));
            if (filtered.length === 0) this.cells.delete(key);
            else this.cells.set(key, filtered);
        }
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
        for (let gx = minCX; gx <= maxCX; gx++) {
            for (let gy = minCY; gy <= maxCY; gy++) {
                const key = this._key(gx, gy);
                if (!this.cells.has(key)) this.cells.set(key, []);
                this.cells.get(key).push(obj);
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
function isInsidePad(px, py, pad) {
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
function isNearPad(px, py, pad, margin) {
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
function padPointBlocked(x, y, obj, clearance) {
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
function padSegmentBlocked(ax1, ay1, ax2, ay2, obj, clearance) {
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
class CongestionGrid {
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

// ── A* Pathfinder ─────────────────────────────────────────────────

// Numeric node key packing for A* Map/Set lookups.
// Packs (x_μm, y_μm, layer) into a single safe-integer key so Maps store
// numeric keys instead of allocating a fresh string per expansion. Integer
// Map ops are noticeably faster in V8 and avoid GC pressure on the A* hot path.
//
// Supports coords in roughly [-4194mm, +4194mm] (far beyond any real PCB).
// Max key magnitude ≈ 2^48, well under Number.MAX_SAFE_INTEGER (2^53).
const NODE_KEY_OFFSET = 4194304;     // = 2^22 μm = 4194 mm; shifts coords to non-negative
const NODE_KEY_Y_STRIDE = 33554432;  // = 2^25 = 2 × (2 × NODE_KEY_OFFSET); reserves layer bit + y range
/** @param {number} x @param {number} y @param {0|1|string} layer */
function packNodeKey(x, y, layer) {
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
        viaCostScale = 1.0,
        bendCostScale = 1.0,
        padDiagCostScale = 1.0,
        dirPenaltyScale = 1.0,
        congestionPenaltyScale = 1.0,
        viaCongestionScale = 1.0,
        congestionGrid = null,
        historyWeight = 0,
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

    const routeDist = Math.hypot(ex - sx, ey - sy);
    // Long routes scale up congestion avoidance — they have room to detour.
    const distCongScale = Math.min(8, Math.max(1, routeDist / 20));
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

            // Pad-geometry clearance model:
            //   Inside own (start/end) pad: skip clearance entirely
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
            const insideStart = startPad && isInsidePad(nx, ny, startPad);
            const insideEnd = endPad && isInsidePad(nx, ny, endPad);
            if (!insideStart && !insideEnd) {
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

            const tentG = curG + stepCost + bendPenalty + dirPenalty + padDiagPenalty + congestionPenalty + histPenalty;

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
async function astarProbe(sx, sy, ex, ey, obstacles, skipIds, gridStep, traceWidth, clearance, startLayer = 'top', endPadLayer = 'both', options = {}) {
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
function optimizePath(path, obstacles, skipIds, totalClear, skipNet = null) {
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

function simplifyPath(path, obstacles, skipIds, totalClear, skipNet = null) {
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
function sanitizeAngles(pts) {
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

// ── Main Router ───────────────────────────────────────────────────

/**
 * @typedef {Object} RouteInput
 * @property {Array<{net: string, pads: Array<{x: number, y: number, width: number, height: number, layer?: ('top'|'bottom'|'both'), shape?: ('rect'|'ellipse')}>}>} connections
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
     * - Visible tab: macrotask yield lets the UI repaint and process clicks.
     * - Hidden/unfocused tab: avoid timer-based yields that can be aggressively throttled.
     */
    const yieldToUI = (() => {
        if (typeof document !== 'undefined') {
            return () => {
                // Main-thread browser path: avoid hidden-tab timer throttling stalls.
                if (document.visibilityState === 'visible') {
                    return new Promise(r => setTimeout(r, 0));
                }
                return Promise.resolve();
            };
        }

        // Worker / non-DOM environments: keep classic timer-yield pacing.
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
    // Per-net ordered pad-id list, parallel to conn.pads. Used to compute
    // skipIds for an individual sub-route: only the source and destination
    // pad IDs of the current segment are skipped, NOT every pad on the net.
    // (Otherwise an A→B route in a 3-pin net A,B,C would treat C as a
    //  source/dest and route straight through it.)
    const netPadIdList = new Map();
    for (const conn of input.connections) {
        const idList = [];
        const used = new Set();
        for (const cpad of conn.pads) {
            const found = findMatchingPad(cpad, used);
            if (found) {
                idList.push(found.id);
                used.add(found.id);
            } else {
                idList.push(null);
            }
        }
        netPadIdList.set(conn.net, idList);
    }

    /**
     * Build a skipIds Set containing only the source and destination pad IDs
     * for a single sub-route (one segment of a multi-pin net).
     */
    const skipIdsForPair = (netName, fromIdx, toIdx) => {
        const list = netPadIdList.get(netName);
        const ids = new Set();
        if (list) {
            if (list[fromIdx] != null) ids.add(list[fromIdx]);
            if (list[toIdx] != null) ids.add(list[toIdx]);
        }
        return ids;
    };

    // Connection map for quick lookup
    // For multi-pad nets, reorder pads using nearest-neighbor chain
    // to minimize total connection length and avoid parallel traces.
    const connMap = new Map();
    for (const conn of input.connections) {
        if (conn.pads.length < 2) continue;
        if (conn.pads.length >= 3) {
            // Nearest-neighbor chain: pick the pad farthest from centroid as start,
            // then greedily connect to the closest unvisited pad.
            const pads = conn.pads;
            const cx = pads.reduce((s, p) => s + p.x, 0) / pads.length;
            const cy = pads.reduce((s, p) => s + p.y, 0) / pads.length;
            let startIdx = 0;
            let maxDist = 0;
            for (let i = 0; i < pads.length; i++) {
                const d = Math.hypot(pads[i].x - cx, pads[i].y - cy);
                if (d > maxDist) { maxDist = d; startIdx = i; }
            }
            const ordered = [pads[startIdx]];
            const used = new Set([startIdx]);
            while (ordered.length < pads.length) {
                const last = ordered[ordered.length - 1];
                let bestIdx = -1, bestDist = Infinity;
                for (let i = 0; i < pads.length; i++) {
                    if (used.has(i)) continue;
                    const d = Math.hypot(pads[i].x - last.x, pads[i].y - last.y);
                    if (d < bestDist) { bestDist = d; bestIdx = i; }
                }
                ordered.push(pads[bestIdx]);
                used.add(bestIdx);
            }
            // Reorder the parallel pad-id list to match the new pad order so
            // skipIdsForPair() returns the correct ids for routing pairs.
            const oldIds = netPadIdList.get(conn.net);
            if (oldIds) {
                const orderedIds = [];
                for (const p of ordered) {
                    const origIdx = pads.indexOf(p);
                    orderedIds.push(origIdx >= 0 ? oldIds[origIdx] : null);
                }
                netPadIdList.set(conn.net, orderedIds);
            }
            conn.pads = ordered;
        }
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
    // Flatten all nets into individual connections and score each one.
    const allConnections = [];
    /** @type {Map<string, {net: string, from: {x:number,y:number}, to: {x:number,y:number}}>} */
    const connIdToPads = new Map();
    for (const conn of sorted) {
        for (let ci = 0; ci < conn.pads.length - 1; ci++) {
            const from = conn.pads[ci];
            const to = conn.pads[ci + 1];
            const manhattan = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
            const localCrowd = (baseObstacles.localDensity(from.x, from.y, null, from.layer || null, 1)
                              + baseObstacles.localDensity(to.x, to.y, null, to.layer || null, 1)) / 2;
            const score = manhattan + localCrowd * Math.max(gridStep, 0.5);
            allConnections.push({ conn, connIdx: ci, from, to, score });
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
        const { conn, connIdx } = item;
        const connId = makeConnectionId(conn.net, connIdx);
        connIdToPads.set(connId, { net: conn.net, from: conn.pads[connIdx], to: conn.pads[connIdx + 1] });
        emitProgress(completedConns, totalConns, conn.net, { phase: 'initial', pendingConnections: pendingConnectionsTotal() });
        await yieldToUI();

        const skipIds = skipIdsForPair(conn.net, connIdx, connIdx + 1);
        const miniConn = { net: conn.net, pads: [conn.pads[connIdx], conn.pads[connIdx + 1]] };
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
            if (!conn || parsed.index >= conn.pads.length - 1) continue;
            const from = conn.pads[parsed.index];
            const to = conn.pads[parsed.index + 1];
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
            if (!conn || failedConnIdx >= conn.pads.length - 1) continue;

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
            const skipIds = skipIdsForPair(failedNet, failedConnIdx, failedConnIdx + 1);
            const blockingConnIds = new Set();

            {
                const from = conn.pads[failedConnIdx];
                const to = conn.pads[failedConnIdx + 1];
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

            const miniConn = { net: failedNet, pads: [conn.pads[failedConnIdx], conn.pads[failedConnIdx + 1]] };
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
                if (!rc || connIdx >= rc.pads.length - 1) continue;
                const rSkip = skipIdsForPair(rn, connIdx, connIdx + 1);

                connectionOnlyRerouteAttempts++;
                const rMiniConn = { net: rn, pads: [rc.pads[connIdx], rc.pads[connIdx + 1]] };
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
                    const fromPad = rc.pads[connIdx];
                    const toPad = rc.pads[connIdx + 1];
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

