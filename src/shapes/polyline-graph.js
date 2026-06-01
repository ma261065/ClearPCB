/**
 * PolylineGraph – Graph-based polyline/polygon base class
 *
 * Represents a shape as a graph of nodes connected by edges.
 * Supports open polylines (line, wire, track) and closed polygons
 * (polygon, rectangle, board outline) via the `closed` property.
 *
 *   • Junctions are nodes with degree ≥ 3 (rendered as dots)
 *   • Midpoint anchors allow edge splitting (vertex insertion)
 *   • H/V axis-constrained anchor snapping
 *   • Graph cleanup: merge co-located nodes, remove zero-length
 *     edges, simplify collinear degree-2 nodes
 *
 * Node IDs: n0, n1, n2, …   Edge IDs: e0, e1, e2, …
 *
 * Subclasses:
 *   Wire  – adds net names, pin connections, electrical semantics
 *   (future: Track, BoardOutline, CopperPour, etc.)
 */

import { Shape } from './shape.js';
import { distanceToSegment, pointsCollinear, pointInPolygon } from '../core/geometry.js';
import { buildPointAnchorsGroup } from '../core/ui-helpers.js';

/** Round to 4 decimal places for compact serialisation. */
const _r4 = v => Math.round(v * 10000) / 10000;

// ── Geometry constants ────────────────────────────────────────────

/** Threshold for treating points as coincident (world units). */
export const COLLINEAR_EPSILON = 0.01;

/** Snap radius for finding a node near a point (world units). */
const NODE_SNAP_EPSILON = 0.15;

/** Margin from edge endpoints when detecting node-on-edge (t-parameter). */
const T_ENDPOINT_MARGIN = 0.001;

/** Default tolerance for hit-testing (world units). */
const HIT_TEST_TOLERANCE = 0.5;

/** Minimum junction dot radius (world units). */
const MIN_JUNCTION_RADIUS = 0.4;

/** Junction dot radius in screen pixels (divided by scale). */
const JUNCTION_SCREEN_PX = 2.5;

/** Maximum iterations for cleanGraph convergence loop. */
const MAX_CLEAN_ITERATIONS = 100;

export class PolylineGraph extends Shape {

    /* ──────────────────────── constructor ──────────────────────── */

    /**
     * @param {object} [options]
     * @param {string} [options.id]
     * @param {string} [options.layer]
     * @param {string|number} [options.color]
     * @param {string|number} [options.fillColor]
     * @param {number} [options.lineWidth]
     * @param {boolean} [options.visible]
     * @param {boolean} [options.locked]
     * @param {boolean} [options.closed=false] - Whether the shape is closed (polygon) or open (polyline)
     * @param {boolean} [options.fill=false] - Whether to fill the interior (only for closed shapes)
     * @param {number} [options.fillAlpha=0.5] - Fill opacity
     * @param {object} [options.graphNodes] - Node map {id: {x,y} | [x,y]}
     * @param {object} [options.graphEdges] - Edge map {id: {from,to} | [from,to]}
     * @param {Array<{x:number,y:number}>} [options.points] - Simple point array (auto-converted to graph)
     * @param {number} [options.cornerRadius=0] - Corner rounding radius
     */
    constructor(options = {}) {
        super(options);
        this.type = 'polyline';

        // Core graph data
        this.nodes = new Map();           // nodeId → {x, y}
        this.edges = new Map();           // edgeId → {from: nodeId, to: nodeId}

        // Closed/fill properties
        this.closed = options.closed || false;
        this.fill = options.fill !== undefined ? options.fill : false;
        this.fillAlpha = options.fillAlpha ?? 0.3;
        this.cornerRadius = options.cornerRadius || 0;

        // Initialise from graph format
        if (options.graphNodes && options.graphEdges) {
            this._loadGraph(options.graphNodes, options.graphEdges);
        }
        // Or from simple point array
        else if (options.points && options.points.length >= 2) {
            this._loadFromPoints(options.points, this.closed);
        }
    }

    /* ──────────────────── graph loading helpers ────────────────── */

    /**
     * Populate the graph from deserialised node/edge data.
     * Accepts both object ({x,y}) and array ([x,y]) position formats.
     * @param {object} graphNodes - {nodeId: {x,y} | [x,y]}
     * @param {object} graphEdges - {edgeId: {from,to} | [from,to]}
     */
    _loadGraph(graphNodes, graphEdges) {
        for (const [id, pos] of Object.entries(graphNodes)) {
            const c = Array.isArray(pos) ? { x: pos[0], y: pos[1] } : pos;
            this.nodes.set(id, { x: c.x, y: c.y });
        }
        for (const [id, ep] of Object.entries(graphEdges)) {
            const e = Array.isArray(ep) ? { from: ep[0], to: ep[1] } : ep;
            this.edges.set(id, { from: e.from, to: e.to });
        }
    }

    /**
     * Convert a simple point array into graph nodes + edges.
     * @param {Array<{x:number,y:number}>} points
     * @param {boolean} [close=false] - Add a closing edge from last to first
     */
    _loadFromPoints(points, close = false) {
        const nodeIds = [];
        for (const p of points) {
            nodeIds.push(this.addNode(p.x, p.y));
        }
        for (let i = 0; i < nodeIds.length - 1; i++) {
            this.addEdge(nodeIds[i], nodeIds[i + 1]);
        }
        if (close && nodeIds.length >= 3) {
            this.addEdge(nodeIds[nodeIds.length - 1], nodeIds[0]);
        }
    }

    /**
     * Get the ordered points array (for simple open/closed shapes without branches).
     * Returns null if the graph has branches (degree > 2 nodes).
     * @returns {Array<{x:number,y:number}>|null}
     */
    getOrderedPoints() {
        if (this.nodes.size === 0) return [];
        // Find a starting node: prefer a leaf (degree 1), or any node for closed shapes
        let startId = null;
        for (const nid of this.nodes.keys()) {
            if (this.degree(nid) === 1) { startId = nid; break; }
        }
        if (!startId) startId = this.nodes.keys().next().value;

        const points = [];
        const visited = new Set();
        let current = startId;
        let prevEdge = null;

        while (current && !visited.has(current)) {
            const pos = this.nodes.get(current);
            if (!pos) break;
            points.push({ x: pos.x, y: pos.y });
            visited.add(current);

            const edges = this.incidentEdges(current);
            const next = edges.find(e => e.edgeId !== prevEdge && !visited.has(e.otherNode));
            if (!next) break;
            prevEdge = next.edgeId;
            current = next.otherNode;
        }
        return points;
    }

    /* ──────────────────── graph mutation ───────────────────────── */

    /**
     * Add a new node at the given position.
     * @param {number} x
     * @param {number} y
     * @returns {string} The new node ID (e.g. 'n3')
     */
    addNode(x, y) {
        let i = 0;
        while (this.nodes.has(`n${i}`)) i++;
        const id = `n${i}`;
        this.nodes.set(id, { x, y });
        this.invalidate();
        return id;
    }

    /**
     * Add an edge connecting two nodes. Self-loops are rejected.
     * @param {string} fromId
     * @param {string} toId
     * @returns {string|null} The new edge ID, or null if self-loop
     */
    addEdge(fromId, toId) {
        if (fromId === toId) return null;
        let i = 0;
        while (this.edges.has(`e${i}`)) i++;
        const id = `e${i}`;
        this.edges.set(id, { from: fromId, to: toId });
        this.invalidate();
        return id;
    }

    /**
     * Remove a node and all its incident edges.
     * @param {string} nodeId
     */
    removeNode(nodeId) {
        for (const [eid, e] of [...this.edges]) {
            if (e.from === nodeId || e.to === nodeId) this.edges.delete(eid);
        }
        this.nodes.delete(nodeId);
        this.invalidate();
    }

    /**
     * Remove an edge (does not remove its endpoint nodes).
     * @param {string} edgeId
     */
    removeEdge(edgeId) {
        this.edges.delete(edgeId);
        this.invalidate();
    }

    /* ──────────────────── graph queries ────────────────────────── */

    /**
     * Get the degree (number of incident edges) of a node.
     * @param {string} nodeId
     * @returns {number}
     */
    degree(nodeId) {
        let c = 0;
        for (const e of this.edges.values()) {
            if (e.from === nodeId || e.to === nodeId) c++;
        }
        return c;
    }

    /**
     * Get all edges incident to a node.
     * @param {string} nodeId
     * @returns {Array<{edgeId: string, edge: object, otherNode: string}>}
     */
    incidentEdges(nodeId) {
        const out = [];
        for (const [eid, e] of this.edges) {
            if (e.from === nodeId || e.to === nodeId)
                out.push({ edgeId: eid, edge: e, otherNode: e.from === nodeId ? e.to : e.from });
        }
        return out;
    }

    /**
     * Get IDs of all nodes directly connected to a node.
     * @param {string} nodeId
     * @returns {string[]}
     */
    neighborNodes(nodeId) {
        return this.incidentEdges(nodeId).map(e => e.otherNode);
    }

    /**
     * Get IDs of all junction nodes (degree ≥ 3).
     * @returns {string[]}
     */
    getJunctionNodes() {
        const r = [];
        for (const nid of this.nodes.keys()) if (this.degree(nid) >= 3) r.push(nid);
        return r;
    }

    /**
     * Get IDs of all leaf nodes (degree 1).
     * @returns {string[]}
     */
    getLeafNodes() {
        const r = [];
        for (const nid of this.nodes.keys()) if (this.degree(nid) === 1) r.push(nid);
        return r;
    }

    /**
     * Check whether an edge exists between two nodes (either direction).
     * @param {string} a - Node ID
     * @param {string} b - Node ID
     * @returns {boolean}
     */
    hasEdgeBetween(a, b) {
        for (const e of this.edges.values()) {
            if ((e.from === a && e.to === b) || (e.from === b && e.to === a)) return true;
        }
        return false;
    }

    /* ──────────────────── spatial queries ──────────────────────── */

    /**
     * Find a node at or very near a point.
     * @param {{x: number, y: number}} point
     * @param {number} [epsilon=NODE_SNAP_EPSILON]
     * @returns {string|null} Node ID, or null
     */
    nodeAt(point, epsilon = NODE_SNAP_EPSILON) {
        for (const [id, pos] of this.nodes) {
            if (Math.hypot(point.x - pos.x, point.y - pos.y) < epsilon) return id;
        }
        return null;
    }

    /**
     * Find the closest edge to a point.
     * @param {{x: number, y: number}} point
     * @returns {{edgeId: string, t: number, point: {x,y}, distance: number}|null}
     */
    closestEdge(point) {
        let bestD = Infinity, bestId = null, bestT = 0;
        for (const [eid, e] of this.edges) {
            const a = this.nodes.get(e.from), b = this.nodes.get(e.to);
            if (!a || !b) continue;
            const dx = b.x - a.x, dy = b.y - a.y;
            const lenSq = dx * dx + dy * dy;
            let t = lenSq === 0 ? 0 : ((point.x - a.x) * dx + (point.y - a.y) * dy) / lenSq;
            t = Math.max(0, Math.min(1, t));
            const d = Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
            if (d < bestD) { bestD = d; bestId = eid; bestT = t; }
        }
        if (!bestId) return null;
        const e = this.edges.get(bestId);
        const a = this.nodes.get(e.from), b = this.nodes.get(e.to);
        return {
            edgeId: bestId, t: bestT,
            point: { x: a.x + bestT * (b.x - a.x), y: a.y + bestT * (b.y - a.y) },
            distance: bestD,
        };
    }

    /**
     * Hit-test a point against all edges.
     * @param {{x: number, y: number}} point
     * @param {number} [tolerance=HIT_TEST_TOLERANCE]
     * @returns {string|null} Edge ID if hit, otherwise null
     */
    hitTestEdge(point, tolerance = HIT_TEST_TOLERANCE) {
        const c = this.closestEdge(point);
        if (!c) return null;
        return c.distance <= tolerance + this.lineWidth / 2 ? c.edgeId : null;
    }

    /**
     * Find the closest point on an edge interior (not near an existing node).
     * @param {{x: number, y: number}} point
     * @param {number} [tolerance=NODE_SNAP_EPSILON]
     * @returns {{edgeId: string, t: number, point: {x,y}, distance: number}|null}
     */
    pointOnEdge(point, tolerance = NODE_SNAP_EPSILON) {
        const c = this.closestEdge(point);
        if (!c || c.distance > tolerance) return null;
        if (this.nodeAt(point, tolerance)) return null;
        return c;
    }

    /* ──────────────────── graph operations ─────────────────────── */

    /**
     * Split an edge at a point, creating a new node.
     * @returns {{newNodeId: string, edge1Id: string, edge2Id: string}|null}
     */
    splitEdge(edgeId, point) {
        const edge = this.edges.get(edgeId);
        if (!edge) return null;
        const nid = this.addNode(point.x, point.y);
        this.edges.delete(edgeId);
        const e1 = this.addEdge(edge.from, nid);
        const e2 = this.addEdge(nid, edge.to);
        return { newNodeId: nid, edge1Id: e1, edge2Id: e2 };
    }

    /**
     * Merge nodes: keep keepId, redirect removeId's edges to keepId, delete removeId.
     * Subclasses can override to handle additional data (e.g. pinConnections).
     */
    mergeNodes(keepId, removeId) {
        if (keepId === removeId) return;
        for (const [eid, e] of [...this.edges]) {
            if (e.from === removeId) e.from = keepId;
            if (e.to === removeId) e.to = keepId;
            if (e.from === e.to) this.edges.delete(eid);
        }
        this.nodes.delete(removeId);
        this.invalidate();
    }

    /**
     * Absorb another PolylineGraph's graph into this one (re-mapping IDs).
     * @param {PolylineGraph} other
     * @returns {Map<string, string>} node remapping (oldId → newId)
     */
    absorb(other) {
        const remap = new Map();
        for (const [oldId, pos] of other.nodes)
            remap.set(oldId, this.addNode(pos.x, pos.y));
        for (const [, e] of other.edges)
            this.addEdge(remap.get(e.from), remap.get(e.to));
        this._onAbsorb(other, remap);
        this.invalidate();
        return remap;
    }

    /**
     * Hook for subclasses to handle additional data during absorb.
     * @param {PolylineGraph} _other
     * @param {Map<string,string>} _remap
     */
    _onAbsorb(_other, _remap) {
        // Override in subclasses (e.g. Wire handles pinConnections + net names)
    }

    /** Connected components → array of Set<nodeId> */
    connectedComponents() {
        const visited = new Set(), comps = [];
        for (const nid of this.nodes.keys()) {
            if (visited.has(nid)) continue;
            const comp = new Set(), queue = [nid];
            while (queue.length) {
                const n = queue.shift();
                if (visited.has(n)) continue;
                visited.add(n); comp.add(n);
                for (const { otherNode } of this.incidentEdges(n))
                    if (!visited.has(otherNode)) queue.push(otherNode);
            }
            comps.push(comp);
        }
        return comps;
    }

    /**
     * Extract a subgraph (preserving original IDs).
     * Subclasses should override _createSubgraphInstance to return the right type.
     * @param {Set<string>|string[]} nodeIds
     * @returns {PolylineGraph}
     */
    extractSubgraph(nodeIds) {
        const ns = nodeIds instanceof Set ? nodeIds : new Set(nodeIds);
        const sub = this._createSubgraphInstance();
        for (const nid of ns) {
            const p = this.nodes.get(nid);
            if (p) sub.nodes.set(nid, { x: p.x, y: p.y });
        }
        for (const [eid, e] of this.edges) {
            if (ns.has(e.from) && ns.has(e.to)) {
                sub.edges.set(eid, { from: e.from, to: e.to });
            }
        }
        this._onExtractSubgraph(sub, ns);
        sub.invalidate();
        return sub;
    }

    /**
     * Create a new instance of the same type for extractSubgraph.
     * Override in subclasses to return the correct type.
     * @returns {PolylineGraph}
     */
    _createSubgraphInstance() {
        return new PolylineGraph({
            color: this.color, lineWidth: this.lineWidth,
            closed: this.closed, fill: this.fill,
            fillColor: this.fillColor, fillAlpha: this.fillAlpha,
        });
    }

    /**
     * Hook for subclasses to copy additional per-node data during extractSubgraph.
     * @param {PolylineGraph} _sub
     * @param {Set<string>} _nodeIds
     */
    _onExtractSubgraph(_sub, _nodeIds) {
        // Override in subclasses
    }

    /**
     * Clean graph: remove zero-length edges, duplicate edges,
     * collinear degree-2 nodes, and isolated nodes.
     */
    cleanGraph() {
        let changed = true;
        let iterations = 0;
        while (changed && iterations < MAX_CLEAN_ITERATIONS) {
            changed = false;
            iterations++;

            // 0a. Co-located nodes → merge
            {
                const nodeArr = [...this.nodes.entries()];
                for (let i = 0; i < nodeArr.length && !changed; i++) {
                    const [idA, pA] = nodeArr[i];
                    if (!this.nodes.has(idA)) continue;
                    for (let j = i + 1; j < nodeArr.length; j++) {
                        const [idB, pB] = nodeArr[j];
                        if (!this.nodes.has(idB)) continue;
                        if (Math.hypot(pA.x - pB.x, pA.y - pB.y) < COLLINEAR_EPSILON) {
                            this.mergeNodes(idA, idB);
                            changed = true; break;
                        }
                    }
                }
            }
            if (changed) continue;

            // 0b. Node lying on a non-incident edge → split edge & merge
            for (const [nid, pos] of this.nodes) {
                if (changed) break;
                for (const [eid, e] of this.edges) {
                    if (e.from === nid || e.to === nid) continue;
                    const a = this.nodes.get(e.from), b = this.nodes.get(e.to);
                    if (!a || !b) continue;
                    const dx = b.x - a.x, dy = b.y - a.y;
                    const lenSq = dx * dx + dy * dy;
                    if (lenSq < COLLINEAR_EPSILON * COLLINEAR_EPSILON) continue;
                    let t = ((pos.x - a.x) * dx + (pos.y - a.y) * dy) / lenSq;
                    if (t <= T_ENDPOINT_MARGIN || t >= 1 - T_ENDPOINT_MARGIN) continue;
                    const px = a.x + t * dx, py = a.y + t * dy;
                    if (Math.hypot(pos.x - px, pos.y - py) < NODE_SNAP_EPSILON) {
                        const { newNodeId } = this.splitEdge(eid, pos);
                        this.mergeNodes(nid, newNodeId);
                        changed = true; break;
                    }
                }
            }
            if (changed) continue;

            // 1. Zero-length edges → merge nodes
            for (const [eid, e] of this.edges) {
                const a = this.nodes.get(e.from), b = this.nodes.get(e.to);
                if (!a || !b) { this.edges.delete(eid); changed = true; continue; }
                if (Math.hypot(a.x - b.x, a.y - b.y) < COLLINEAR_EPSILON) {
                    this.mergeNodes(e.from, e.to);
                    changed = true; break;
                }
            }
            if (changed) continue;

            // 2. Duplicate edges
            const seen = new Map();
            for (const [eid, e] of this.edges) {
                const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
                if (seen.has(key)) { this.edges.delete(eid); changed = true; }
                else seen.set(key, eid);
            }
            if (changed) continue;

            // 3. Collinear degree-2 nodes (skip protected ones)
            for (const [nid, pos] of this.nodes) {
                if (this.degree(nid) !== 2) continue;
                if (this._isProtectedNode(nid)) continue;
                const [e1, e2] = this.incidentEdges(nid);
                const p1 = this.nodes.get(e1.otherNode), p2 = this.nodes.get(e2.otherNode);
                if (!p1 || !p2) continue;
                if (this._areCollinear(p1, pos, p2)) {
                    this.edges.delete(e1.edgeId);
                    this.edges.delete(e2.edgeId);
                    this.nodes.delete(nid);
                    if (!this.hasEdgeBetween(e1.otherNode, e2.otherNode))
                        this.addEdge(e1.otherNode, e2.otherNode);
                    changed = true; break;
                }
            }
            if (changed) continue;

            // 4. Isolated nodes (degree 0, not protected)
            for (const nid of this.nodes.keys()) {
                if (this.degree(nid) === 0 && !this._isProtectedNode(nid)) {
                    this.nodes.delete(nid); changed = true;
                }
            }
        }
        this.invalidate();
    }

    /**
     * Hook for subclasses to protect specific nodes from graph simplification.
     * Wire overrides this to protect pin-connected nodes.
     * @param {string} _nodeId
     * @returns {boolean}
     */
    _isProtectedNode(_nodeId) {
        return false;
    }

    /**
     * Test whether three points are collinear within COLLINEAR_EPSILON.
     * @param {{x,y}} p1
     * @param {{x,y}} p2
     * @param {{x,y}} p3
     * @returns {boolean}
     */
    _areCollinear(p1, p2, p3) {
        return pointsCollinear(p1, p2, p3, COLLINEAR_EPSILON);
    }

    /**
     * Split a junction node: detach specified edges from the original node,
     * create a duplicate at the same position with those edges attached.
     * @param {string} nodeId
     * @param {string[]} edgeIdsToDetach
     * @returns {string|null} New node ID
     */
    splitNode(nodeId, edgeIdsToDetach) {
        const pos = this.nodes.get(nodeId);
        if (!pos) return null;
        const newId = this.addNode(pos.x, pos.y);
        for (const eid of edgeIdsToDetach) {
            const e = this.edges.get(eid);
            if (!e) continue;
            if (e.from === nodeId) e.from = newId;
            if (e.to === nodeId) e.to = newId;
        }
        this.invalidate();
        return newId;
    }

    /* ──────────────────── Shape interface ──────────────────────── */

    /** @override */
    _calculateBounds() {
        if (this.nodes.size === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const p of this.nodes.values()) {
            if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
        const hw = this.lineWidth / 2;
        return { minX: minX - hw, minY: minY - hw, maxX: maxX + hw, maxY: maxY + hw };
    }

    /** @override */
    hitTest(point, tolerance = HIT_TEST_TOLERANCE) {
        // Filled shapes: check point-in-polygon
        if (this.fill) {
            const pts = this.getOrderedPoints();
            if (pts && pts.length >= 3 && pointInPolygon(point, pts)) {
                return true;
            }
        }
        return this.distanceTo(point) <= tolerance + this.lineWidth / 2;
    }

    /** @override */
    distanceTo(point) {
        if (this.edges.size === 0) return Infinity;
        let min = Infinity;
        for (const e of this.edges.values()) {
            const a = this.nodes.get(e.from), b = this.nodes.get(e.to);
            if (!a || !b) continue;
            min = Math.min(min, distanceToSegment(point, a, b));
        }
        return min;
    }

    /**
     * Get anchor handles for the selection UI.
     * One per node + one per edge midpoint (insertion handle).
     * @returns {Array<{id: string, x: number, y: number, cursor: string, midpoint?: boolean}>}
     */
    getAnchors() {
        const anchors = [];
        for (const [nid, pos] of this.nodes)
            anchors.push({ id: nid, x: pos.x, y: pos.y, cursor: 'nwse-resize' });
        for (const [eid, e] of this.edges) {
            const a = this.nodes.get(e.from), b = this.nodes.get(e.to);
            if (!a || !b) continue;
            anchors.push({
                id: `mid_${eid}`,
                x: (a.x + b.x) / 2, y: (a.y + b.y) / 2,
                cursor: 'copy', midpoint: true,
            });
        }
        return anchors;
    }

    /**
     * Move a node anchor, or split an edge at its midpoint.
     * @returns {string|undefined} New anchor ID for midpoint insertions
     */
    moveAnchor(anchorId, x, y) {
        if (anchorId.startsWith('mid_')) {
            const eid = anchorId.substring(4);
            const r = this.splitEdge(eid, { x, y });
            return r ? r.newNodeId : anchorId;
        }
        if (this.nodes.has(anchorId)) {
            const p = this.nodes.get(anchorId);
            p.x = x; p.y = y;
            this.invalidate();
        }
    }

    /**
     * Delete a node anchor.
     * degree 1 → remove leaf; degree 2 → reconnect neighbours.
     * @returns {boolean} true if deleted
     */
    deleteAnchor(anchorId) {
        if (!this.nodes.has(anchorId)) return false;
        if (this.edges.size <= 1) return false;
        const deg = this.degree(anchorId);
        if (deg === 1) { this.removeNode(anchorId); return true; }
        if (deg === 2) {
            const [e1, e2] = this.incidentEdges(anchorId);
            this.edges.delete(e1.edgeId);
            this.edges.delete(e2.edgeId);
            this.nodes.delete(anchorId);
            if (!this.hasEdgeBetween(e1.otherNode, e2.otherNode))
                this.addEdge(e1.otherNode, e2.otherNode);
            this.invalidate();
            return true;
        }
        return false;
    }

    /** @override — Wire-style: anchor dragging snaps along H/V axes. */
    getAnchorSnapMode() { return 'axis'; }

    /**
     * Translate the entire graph by (dx, dy).
     * @param {number} dx
     * @param {number} dy
     */
    move(dx, dy) {
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        for (const p of this.nodes.values()) { p.x += dx; p.y += dy; }
        this.invalidate();
    }

    /**
     * Create a deep copy with new node/edge IDs.
     * @returns {PolylineGraph}
     */
    clone() {
        const c = this._createSubgraphInstance();
        for (const [id, p] of this.nodes) c.nodes.set(id, { x: p.x, y: p.y });
        for (const [id, e] of this.edges) c.edges.set(id, { from: e.from, to: e.to });
        return c;
    }

    /**
     * Capture the current graph state for undo/redo.
     * @returns {object}
     */
    captureState() {
        const s = { nodes: {}, edges: {}, closed: this.closed, type: this.type, fill: this.fill, fillAlpha: this.fillAlpha, cornerRadius: this.cornerRadius };
        for (const [id, p] of this.nodes) s.nodes[id] = { x: p.x, y: p.y };
        for (const [id, e] of this.edges) s.edges[id] = { from: e.from, to: e.to };
        return s;
    }

    /**
     * Restore the graph from a previously captured state.
     * @param {object} state
     */
    applyState(state) {
        if (state.nodes) {
            this.nodes = new Map();
            this.edges = new Map();
            for (const [id, p] of Object.entries(state.nodes)) {
                if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
                this.nodes.set(id, { x: p.x, y: p.y });
            }
            if (state.edges)
                for (const [id, e] of Object.entries(state.edges)) {
                    if (!e || !this.nodes.has(e.from) || !this.nodes.has(e.to)) continue;
                    this.edges.set(id, { from: e.from, to: e.to });
                }
        }
        if ('closed' in state) this.closed = state.closed;
        if ('type' in state) this.type = state.type;
        if ('fill' in state) this.fill = state.fill;
        if ('fillAlpha' in state) this.fillAlpha = state.fillAlpha;
        if ('cornerRadius' in state) this.cornerRadius = state.cornerRadius;
        this.invalidate();
    }

    /** @override */
    getPosition() {
        if (this.nodes.size === 0) return { x: 0, y: 0 };
        const first = this.nodes.values().next().value;
        return { x: first.x, y: first.y };
    }

    /**
     * Check if this closed shape forms an axis-aligned rectangle.
     * @returns {boolean}
     */
    isAxisAlignedRect() {
        if (!this.closed || this.nodes.size !== 4 || this.edges.size !== 4) return false;
        const pts = this.getOrderedPoints();
        if (!pts || pts.length !== 4) return false;

        for (let i = 0; i < 4; i++) {
            const a = pts[i];
            const b = pts[(i + 1) % 4];
            const c = pts[(i + 2) % 4];
            const dx1 = b.x - a.x, dy1 = b.y - a.y;
            const dx2 = c.x - b.x, dy2 = c.y - b.y;
            if (Math.abs(dx1 * dx2 + dy1 * dy2) > 0.01) return false;
        }
        return true;
    }

    /** @override */
    getPropertyDescriptors() {
        const props = [
            { key: 'locked',    label: 'Locked',     type: 'checkbox' },
            { key: 'lineWidth', label: 'Line width',  type: 'number', min: 0.05, max: 5, step: 0.05 },
        ];
        if (this.nodes && this.nodes.size >= 3) {
            props.push({ key: 'cornerRadius', label: 'Corner radius', type: 'number', min: 0, max: 25, step: 0.5 });
            props.push({ key: 'fill', label: 'Fill', type: 'checkbox' });
        }
        return props;
    }

    /* ──────────────────── SVG rendering ────────────────────────── */

    /** Create the root SVG <g> element. */
    _createElement() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'g');
    }

    /**
     * Rebuild SVG children: one <line> per edge, one <circle> per junction.
     * Closed filled shapes also render a <polygon> fill underneath.
     */
    _updateElement(el, strokeColor, fillColor, scale) {
        el.textContent = '';

        const sw = this._getEffectiveStrokeWidth(scale);
        const r = this.cornerRadius || 0;

        // Rounded-corner path rendering for shapes with cornerRadius
        // Only use path rendering for simple chains (no branching)
        if (r > 0) {
            const pts = this.getOrderedPoints();
            const hasBranches = this.getJunctionNodes().length > 0;
            if (pts && pts.length >= 3 && pts.length === this.nodes.size && !hasBranches) {
                const pathData = this.closed
                    ? this._buildRoundedPath(pts, r)
                    : this._buildRoundedOpenPath(pts, r);

                // Fill path
                if (this.fill) {
                    const fillPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    fillPath.setAttribute('d', pathData);
                    fillPath.setAttribute('fill', fillColor);
                    fillPath.setAttribute('fill-opacity', String(this.fillAlpha));
                    fillPath.setAttribute('stroke', 'none');
                    el.appendChild(fillPath);
                }

                // Stroke path
                const strokePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                strokePath.setAttribute('d', pathData);
                strokePath.setAttribute('stroke', strokeColor);
                strokePath.setAttribute('stroke-width', String(sw));
                strokePath.setAttribute('stroke-linejoin', 'round');
                strokePath.setAttribute('fill', 'none');
                el.appendChild(strokePath);

                // Junction dots still needed
                const jr = Math.max(MIN_JUNCTION_RADIUS, JUNCTION_SCREEN_PX / scale);
                for (const [nid, pos] of this.nodes) {
                    if (this.degree(nid) >= 3) {
                        const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                        c.setAttribute('cx', pos.x); c.setAttribute('cy', pos.y);
                        c.setAttribute('r', String(jr));
                        c.setAttribute('fill', strokeColor);
                        c.setAttribute('stroke', 'none');
                        c.classList.add('junction-dot');
                        el.appendChild(c);
                    }
                }
                return;
            }
        }

        // For filled shapes without radius, render fill polygon underneath edges
        if (this.fill) {
            const pts = this.getOrderedPoints();
            if (pts && pts.length >= 3) {
                const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                poly.setAttribute('points', pts.map(p => `${p.x},${p.y}`).join(' '));
                poly.setAttribute('fill', fillColor);
                poly.setAttribute('fill-opacity', String(this.fillAlpha));
                poly.setAttribute('stroke', 'none');
                el.appendChild(poly);
            }
        }

        // One <line> per edge
        for (const e of this.edges.values()) {
            const a = this.nodes.get(e.from), b = this.nodes.get(e.to);
            if (!a || !b) continue;
            const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            ln.setAttribute('x1', a.x); ln.setAttribute('y1', a.y);
            ln.setAttribute('x2', b.x); ln.setAttribute('y2', b.y);
            ln.setAttribute('stroke', strokeColor);
            ln.setAttribute('stroke-width', String(sw));
            ln.setAttribute('stroke-linecap', 'round');
            ln.setAttribute('fill', 'none');
            el.appendChild(ln);
        }

        // Junction dots at degree ≥ 3 nodes (wires only)
        if (this.type === 'wire') {
            const jr = Math.max(MIN_JUNCTION_RADIUS, JUNCTION_SCREEN_PX / scale);
            for (const [nid, pos] of this.nodes) {
                if (this.degree(nid) >= 3) {
                    const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                    c.setAttribute('cx', pos.x); c.setAttribute('cy', pos.y);
                    c.setAttribute('r', String(jr));
                    c.setAttribute('fill', strokeColor);
                    c.setAttribute('stroke', 'none');
                    c.classList.add('junction-dot');
                    el.appendChild(c);
                }
            }
        }
    }

    /**
     * Build an SVG path string with rounded corners for a closed polygon.
     * Each corner is replaced with a quadratic bezier arc.
     * @param {Array<{x:number,y:number}>} pts - Ordered vertices
     * @param {number} r - Corner radius
     * @returns {string} SVG path data
     */
    _buildRoundedPath(pts, r) {
        const n = pts.length;
        if (n < 3) return '';

        const parts = [];
        for (let i = 0; i < n; i++) {
            const prev = pts[(i - 1 + n) % n];
            const curr = pts[i];
            const next = pts[(i + 1) % n];

            // Vector from curr to prev and curr to next
            const dx1 = prev.x - curr.x, dy1 = prev.y - curr.y;
            const dx2 = next.x - curr.x, dy2 = next.y - curr.y;
            const len1 = Math.hypot(dx1, dy1);
            const len2 = Math.hypot(dx2, dy2);

            // Clamp radius to half of shortest adjacent edge
            const maxR = Math.min(len1, len2) / 2;
            const cr = Math.min(r, maxR);

            if (cr < 0.01 || len1 < 0.01 || len2 < 0.01) {
                // No rounding possible at this corner
                if (i === 0) parts.push(`M ${curr.x} ${curr.y}`);
                else parts.push(`L ${curr.x} ${curr.y}`);
            } else {
                // Start point of arc (on edge from prev)
                const sx = curr.x + (dx1 / len1) * cr;
                const sy = curr.y + (dy1 / len1) * cr;
                // End point of arc (on edge to next)
                const ex = curr.x + (dx2 / len2) * cr;
                const ey = curr.y + (dy2 / len2) * cr;

                if (i === 0) parts.push(`M ${sx} ${sy}`);
                else parts.push(`L ${sx} ${sy}`);
                // Quadratic bezier through the corner point
                parts.push(`Q ${curr.x} ${curr.y} ${ex} ${ey}`);
            }
        }
        parts.push('Z');
        return parts.join(' ');
    }

    /**
     * Build an SVG path string with rounded corners for an open polyline.
     * First and last points are not rounded.
     * @param {Array<{x:number,y:number}>} pts
     * @param {number} r
     * @returns {string}
     */
    _buildRoundedOpenPath(pts, r) {
        const n = pts.length;
        if (n < 3) return `M ${pts[0].x} ${pts[0].y} L ${pts[1].x} ${pts[1].y}`;

        const parts = [`M ${pts[0].x} ${pts[0].y}`];

        for (let i = 1; i < n - 1; i++) {
            const prev = pts[i - 1];
            const curr = pts[i];
            const next = pts[i + 1];

            const dx1 = prev.x - curr.x, dy1 = prev.y - curr.y;
            const dx2 = next.x - curr.x, dy2 = next.y - curr.y;
            const len1 = Math.hypot(dx1, dy1);
            const len2 = Math.hypot(dx2, dy2);

            const maxR = Math.min(len1, len2) / 2;
            const cr = Math.min(r, maxR);

            if (cr < 0.01 || len1 < 0.01 || len2 < 0.01) {
                parts.push(`L ${curr.x} ${curr.y}`);
            } else {
                const sx = curr.x + (dx1 / len1) * cr;
                const sy = curr.y + (dy1 / len1) * cr;
                const ex = curr.x + (dx2 / len2) * cr;
                const ey = curr.y + (dy2 / len2) * cr;

                parts.push(`L ${sx} ${sy}`);
                parts.push(`Q ${curr.x} ${curr.y} ${ex} ${ey}`);
            }
        }

        // Last point
        parts.push(`L ${pts[n - 1].x} ${pts[n - 1].y}`);
        return parts.join(' ');
    }

    /**
     * Rebuild anchor handle overlays.
     * @param {number} scale
     */
    _updateAnchors(scale) {
        if (!this.selected) {
            if (this.anchorsGroup) { this.anchorsGroup.remove(); this.anchorsGroup = null; this._anchorRects = null; }
            return;
        }
        if (this.anchorsGroup) this.anchorsGroup.remove();
        const { group, rects } = buildPointAnchorsGroup(this, scale);
        this.anchorsGroup = group;
        this._anchorRects = rects;
        if (this.element?.parentNode)
            this.element.parentNode.insertBefore(this.anchorsGroup, this.element.nextSibling);
    }

    /* ──────────────────── serialization ────────────────────────── */

    /** @override */
    toJSON() {
        const json = { ...super.toJSON(), nd: {}, ed: {} };
        for (const [id, p] of this.nodes) json.nd[id] = [_r4(p.x), _r4(p.y)];
        for (const [id, e] of this.edges) json.ed[id] = [e.from, e.to];
        if (this.closed) json.cl = true;
        if (this.fill) json.f = true;
        else json.f = false;
        if (this.fillAlpha !== 0.3) json.fa = this.fillAlpha;
        if (this.cornerRadius) json.cr = this.cornerRadius;
        return json;
    }
}
