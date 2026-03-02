/**
 * Wire – Graph-based wire for connecting component pins
 *
 * Represents a wire as a graph: nodes connected by edges.
 *   • One Wire object = one electrical net
 *   • Junctions are nodes with degree ≥ 3 (rendered automatically)
 *   • Pin connections map specific nodes to component pins
 *
 * Node IDs: n0, n1, n2, …   Edge IDs: e0, e1, e2, …
 * Anchor IDs: node IDs for vertex handles, mid_eN for edge-midpoint insertion
 */

import { Shape } from './shape.js';
import { distanceToSegment } from '../core/geometry.js';
import { buildPointAnchorsGroup } from '../core/ui-helpers.js';

const _r4 = v => Math.round(v * 10000) / 10000;
const COLLINEAR_EPSILON = 0.01;

export class Wire extends Shape {

    /* ──────────────────────── constructor ──────────────────────── */

    constructor(options = {}) {
        super(options);
        this.type = 'wire';

        this._nodeCounter = 0;
        this._edgeCounter = 0;

        // Core graph data
        this.nodes = new Map();           // nodeId → {x, y}
        this.edges = new Map();           // edgeId → {from: nodeId, to: nodeId}
        this.pinConnections = new Map();  // nodeId → {componentId, pinNumber}

        this.net = options.net || '';

        // ── Initialise from graph format ──────────────────────
        if (options.graphNodes && options.graphEdges) {
            this._loadGraph(options.graphNodes, options.graphEdges, options.pinConnections);
        }
    }

    /* ──────────────────── graph loading helpers ────────────────── */

    _loadGraph(graphNodes, graphEdges, pinConnections) {
        for (const [id, pos] of Object.entries(graphNodes)) {
            const c = Array.isArray(pos) ? { x: pos[0], y: pos[1] } : pos;
            this.nodes.set(id, { x: c.x, y: c.y });
            this._bumpCounter('_nodeCounter', id);
        }
        for (const [id, ep] of Object.entries(graphEdges)) {
            const e = Array.isArray(ep) ? { from: ep[0], to: ep[1] } : ep;
            this.edges.set(id, { from: e.from, to: e.to });
            this._bumpCounter('_edgeCounter', id);
        }
        if (pinConnections) {
            for (const [nid, conn] of Object.entries(pinConnections))
                this.pinConnections.set(nid, { ...conn });
        }
    }

    _bumpCounter(prop, id) {
        const m = id.match(/\d+$/);
        if (m) {
            const n = parseInt(m[0], 10) + 1;
            if (n > this[prop]) this[prop] = n;
        }
    }

    /* ──────────────────── graph mutation ───────────────────────── */

    addNode(x, y) {
        const id = `n${this._nodeCounter++}`;
        this.nodes.set(id, { x, y });
        this.invalidate();
        return id;
    }

    addEdge(fromId, toId) {
        if (fromId === toId) return null;           // no self-loops
        const id = `e${this._edgeCounter++}`;
        this.edges.set(id, { from: fromId, to: toId });
        this.invalidate();
        return id;
    }

    removeNode(nodeId) {
        for (const [eid, e] of [...this.edges]) {
            if (e.from === nodeId || e.to === nodeId) this.edges.delete(eid);
        }
        this.nodes.delete(nodeId);
        this.pinConnections.delete(nodeId);
        this.invalidate();
    }

    removeEdge(edgeId) {
        this.edges.delete(edgeId);
        this.invalidate();
    }

    /* ──────────────────── graph queries ────────────────────────── */

    degree(nodeId) {
        let c = 0;
        for (const e of this.edges.values()) {
            if (e.from === nodeId || e.to === nodeId) c++;
        }
        return c;
    }

    incidentEdges(nodeId) {
        const out = [];
        for (const [eid, e] of this.edges) {
            if (e.from === nodeId || e.to === nodeId)
                out.push({ edgeId: eid, edge: e, otherNode: e.from === nodeId ? e.to : e.from });
        }
        return out;
    }

    neighborNodes(nodeId) {
        return this.incidentEdges(nodeId).map(e => e.otherNode);
    }

    getJunctionNodes() {
        const r = [];
        for (const nid of this.nodes.keys()) if (this.degree(nid) >= 3) r.push(nid);
        return r;
    }

    getLeafNodes() {
        const r = [];
        for (const nid of this.nodes.keys()) if (this.degree(nid) === 1) r.push(nid);
        return r;
    }

    hasEdgeBetween(a, b) {
        for (const e of this.edges.values()) {
            if ((e.from === a && e.to === b) || (e.from === b && e.to === a)) return true;
        }
        return false;
    }

    /* ──────────────────── spatial queries ──────────────────────── */

    /** Find node at or very near a point */
    nodeAt(point, epsilon = 0.15) {
        for (const [id, pos] of this.nodes) {
            if (Math.hypot(point.x - pos.x, point.y - pos.y) < epsilon) return id;
        }
        return null;
    }

    /** Closest edge to a point → {edgeId, t, point, distance} | null */
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

    /** Hit-test returning edgeId or null */
    hitTestEdge(point, tolerance = 0.5) {
        const c = this.closestEdge(point);
        if (!c) return null;
        return c.distance <= tolerance + this.lineWidth / 2 ? c.edgeId : null;
    }

    /** Point on an edge but NOT near any node */
    pointOnEdge(point, tolerance = 0.15) {
        const c = this.closestEdge(point);
        if (!c || c.distance > tolerance) return null;
        if (this.nodeAt(point, tolerance)) return null;
        return c;
    }

    /* ──────────────────── graph operations ─────────────────────── */

    /** Split an edge at a point, creating a new node.
     *  Returns {newNodeId, edge1Id, edge2Id} or null. */
    splitEdge(edgeId, point) {
        const edge = this.edges.get(edgeId);
        if (!edge) return null;
        const nid = this.addNode(point.x, point.y);
        this.edges.delete(edgeId);
        const e1 = this.addEdge(edge.from, nid);
        const e2 = this.addEdge(nid, edge.to);
        return { newNodeId: nid, edge1Id: e1, edge2Id: e2 };
    }

    /** Merge nodes: keep keepId, redirect removeId's edges to keepId, delete removeId */
    mergeNodes(keepId, removeId) {
        if (keepId === removeId) return;
        for (const [eid, e] of [...this.edges]) {
            if (e.from === removeId) e.from = keepId;
            if (e.to === removeId) e.to = keepId;
            if (e.from === e.to) this.edges.delete(eid);    // collapse self-loops
        }
        if (this.pinConnections.has(removeId) && !this.pinConnections.has(keepId))
            this.pinConnections.set(keepId, this.pinConnections.get(removeId));
        this.nodes.delete(removeId);
        this.pinConnections.delete(removeId);
        this.invalidate();
    }

    /**
     * Absorb another Wire's graph into this one (re-mapping IDs).
     * @returns {Map<oldNodeId, newNodeId>} node remapping
     */
    absorb(other) {
        const remap = new Map();
        for (const [oldId, pos] of other.nodes)
            remap.set(oldId, this.addNode(pos.x, pos.y));
        for (const [, e] of other.edges)
            this.addEdge(remap.get(e.from), remap.get(e.to));
        for (const [oldNid, conn] of other.pinConnections) {
            const newNid = remap.get(oldNid);
            if (newNid && !this.pinConnections.has(newNid))
                this.pinConnections.set(newNid, { ...conn });
        }
        if (!this.net && other.net) this.net = other.net;
        this.invalidate();
        return remap;
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

    /** Extract a subgraph (preserving original IDs) */
    extractSubgraph(nodeIds) {
        const ns = nodeIds instanceof Set ? nodeIds : new Set(nodeIds);
        const sub = new Wire({ color: this.color, lineWidth: this.lineWidth, net: this.net });
        sub.nodes.clear(); sub.edges.clear();
        sub._nodeCounter = 0; sub._edgeCounter = 0;

        for (const nid of ns) {
            const p = this.nodes.get(nid);
            if (p) { sub.nodes.set(nid, { x: p.x, y: p.y }); sub._bumpCounter('_nodeCounter', nid); }
        }
        for (const [eid, e] of this.edges) {
            if (ns.has(e.from) && ns.has(e.to)) {
                sub.edges.set(eid, { from: e.from, to: e.to });
                sub._bumpCounter('_edgeCounter', eid);
            }
        }
        for (const nid of ns) {
            if (this.pinConnections.has(nid))
                sub.pinConnections.set(nid, { ...this.pinConnections.get(nid) });
        }
        sub.invalidate();
        return sub;
    }

    /**
     * Clean graph: remove zero-length edges, duplicate edges,
     * collinear degree-2 nodes, and isolated nodes.
     */
    cleanGraph() {
        let changed = true;
        while (changed) {
            changed = false;

            // 0a. Co-located nodes → merge (even if no shared edge)
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
                    if (t <= 0.001 || t >= 0.999) continue;  // near endpoints → handled by 0a
                    const px = a.x + t * dx, py = a.y + t * dy;
                    if (Math.hypot(pos.x - px, pos.y - py) < COLLINEAR_EPSILON) {
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

            // 2. Duplicate edges (same pair regardless of direction)
            const seen = new Map();
            for (const [eid, e] of this.edges) {
                const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
                if (seen.has(key)) { this.edges.delete(eid); changed = true; }
                else seen.set(key, eid);
            }
            if (changed) continue;

            // 3. Collinear degree-2 nodes (skip pin-connected ones)
            for (const [nid, pos] of this.nodes) {
                if (this.degree(nid) !== 2) continue;
                if (this.pinConnections.has(nid)) continue;
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

            // 4. Isolated nodes (degree 0, no pin)
            for (const nid of this.nodes.keys()) {
                if (this.degree(nid) === 0 && !this.pinConnections.has(nid)) {
                    this.nodes.delete(nid); changed = true;
                }
            }
        }
        this.invalidate();
    }

    _areCollinear(p1, p2, p3) {
        const cross = (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
        return Math.abs(cross) < COLLINEAR_EPSILON;
    }

    /**
     * Split a junction node: detach specified edges from the original node,
     * create a duplicate at the same position with those edges attached.
     * Used when segment-dragging away from a T-junction.
     * @returns new node ID
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

    hitTest(point, tolerance = 0.5) {
        return this.distanceTo(point) <= tolerance + this.lineWidth / 2;
    }

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
     * Returns new anchor ID for midpoint insertions, undefined otherwise.
     */
    moveAnchor(anchorId, x, y) {
        if (anchorId.startsWith('mid_')) {
            const eid = anchorId.substring(4);          // "mid_e3" → "e3"
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
     * Returns true if deleted.
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
            this.pinConnections.delete(anchorId);
            if (!this.hasEdgeBetween(e1.otherNode, e2.otherNode))
                this.addEdge(e1.otherNode, e2.otherNode);
            this.invalidate();
            return true;
        }
        return false;   // junction nodes (degree ≥ 3) not deletable
    }

    move(dx, dy) {
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
        for (const p of this.nodes.values()) { p.x += dx; p.y += dy; }
        this.invalidate();
    }

    clone() {
        const c = new Wire({
            color: this.color, lineWidth: this.lineWidth,
            layer: this.layer, net: this.net,
            visible: this.visible, locked: this.locked,
        });
        c.nodes.clear(); c.edges.clear();
        c._nodeCounter = 0; c._edgeCounter = 0;
        for (const [id, p] of this.nodes) { c.nodes.set(id, { x: p.x, y: p.y }); c._bumpCounter('_nodeCounter', id); }
        for (const [id, e] of this.edges) { c.edges.set(id, { from: e.from, to: e.to }); c._bumpCounter('_edgeCounter', id); }
        for (const [id, cn] of this.pinConnections) c.pinConnections.set(id, { ...cn });
        return c;
    }

    captureState() {
        const s = { nodes: {}, edges: {}, pinConnections: {}, net: this.net, _nc: this._nodeCounter, _ec: this._edgeCounter };
        for (const [id, p] of this.nodes) s.nodes[id] = { x: p.x, y: p.y };
        for (const [id, e] of this.edges) s.edges[id] = { from: e.from, to: e.to };
        for (const [id, c] of this.pinConnections) s.pinConnections[id] = { ...c };
        return s;
    }

    applyState(state) {
        this.nodes = new Map();
        this.edges = new Map();
        this.pinConnections = new Map();
        for (const [id, p] of Object.entries(state.nodes)) this.nodes.set(id, { x: p.x, y: p.y });
        for (const [id, e] of Object.entries(state.edges)) this.edges.set(id, { from: e.from, to: e.to });
        if (state.pinConnections)
            for (const [id, c] of Object.entries(state.pinConnections)) this.pinConnections.set(id, { ...c });
        this.net = state.net || '';
        this._nodeCounter = state._nc || 0;
        this._edgeCounter = state._ec || 0;
        this.invalidate();
    }

    getPosition() {
        if (this.nodes.size === 0) return { x: 0, y: 0 };
        const first = this.nodes.values().next().value;
        return { x: first.x, y: first.y };
    }

    getAnchorSnapMode() { return 'axis'; }

    getPropertyDescriptors() {
        return [{ key: 'locked', label: 'Locked', type: 'checkbox' }];
    }

    /* ──────────────────── SVG rendering ────────────────────────── */

    _createElement() {
        return document.createElementNS('http://www.w3.org/2000/svg', 'g');
    }

    _updateElement(el, strokeColor, _fillColor, scale) {
        el.textContent = '';                               // clear children

        const sw = this._getEffectiveStrokeWidth(scale);

        // One <line> per edge
        for (const e of this.edges.values()) {
            const a = this.nodes.get(e.from), b = this.nodes.get(e.to);
            if (!a || !b) continue;
            const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            ln.setAttribute('x1', a.x); ln.setAttribute('y1', a.y);
            ln.setAttribute('x2', b.x); ln.setAttribute('y2', b.y);
            ln.setAttribute('stroke', strokeColor);
            ln.setAttribute('stroke-width', sw);
            ln.setAttribute('stroke-linecap', 'round');
            ln.setAttribute('fill', 'none');
            el.appendChild(ln);
        }

        // Junction dots at degree ≥ 3 nodes
        const jr = Math.max(0.4, 2.5 / scale);
        for (const [nid, pos] of this.nodes) {
            if (this.degree(nid) >= 3) {
                const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                c.setAttribute('cx', pos.x); c.setAttribute('cy', pos.y);
                c.setAttribute('r', jr);
                c.setAttribute('fill', strokeColor);
                c.setAttribute('stroke', 'none');
                c.classList.add('junction-dot');
                el.appendChild(c);
            }
        }
    }

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

    toJSON() {
        const json = { ...super.toJSON(), type: 'wire', nd: {}, ed: {} };
        for (const [id, p] of this.nodes) json.nd[id] = [_r4(p.x), _r4(p.y)];
        for (const [id, e] of this.edges) json.ed[id] = [e.from, e.to];
        if (this.pinConnections.size > 0) {
            json.pc = {};
            for (const [nid, c] of this.pinConnections) json.pc[nid] = { ...c };
        }
        if (this.net) json.n = this.net;
        return json;
    }
}
