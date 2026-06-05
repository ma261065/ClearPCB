/**
 * Track – Graph-based copper trace for PCB
 *
 * Models a routed (or hand-drawn) PCB trace as a graph: nodes connected
 * by edges, where each edge carries its own copper layer. This mirrors
 * the schematic Wire's graph data model so that interactive editing
 * (segment drag, T-junction insert, mid-segment branch) works the same
 * way it does for wires.
 *
 * Per-edge layer (rather than per-track) means a single Track can span
 * multiple copper layers, with a via implied at any node where adjacent
 * edges differ in layer. Standalone vias (e.g. ground-plane stitching)
 * are represented by separate Via shapes, not by Track nodes.
 *
 * Node IDs: n0, n1, n2, …   Edge IDs: e0, e1, e2, …
 *
 * Pad connections map specific nodes to component pads (componentId +
 * pinNumber) so the track stays attached when components are moved.
 *
 * Note: Track extends PolylineGraph for the data model only. The PCB
 * editor renders Tracks via a custom pipeline (src/pcb/modules/
 * track-render.js), not via the inherited Shape.render() path which
 * targets the schematic SVG layer.
 */

import { PolylineGraph } from './polyline-graph.js';

/** Default copper layer for a Track if none is specified. */
const DEFAULT_LAYER = 'top-copper';

/** Default trace width in mm. */
const DEFAULT_WIDTH = 0.2;

export class Track extends PolylineGraph {
    /**
     * @param {object} [options]
     * @param {string} [options.id]
     * @param {string} [options.net] - Net name (e.g. 'VCC', 'Net0034')
     * @param {number} [options.width] - Trace width in mm
     * @param {string} [options.layer] - Default copper layer for new edges
     *   when edgeLayers is not provided. Edges fall back to this layer.
     * @param {object} [options.edgeLayers] - Map of edgeId → layer name
     * @param {object} [options.padConnections] - Map of nodeId →
     *   { componentId, pinNumber }
     * @param {object} [options.graphNodes] - Forwarded to PolylineGraph
     * @param {object} [options.graphEdges] - Forwarded to PolylineGraph
     * @param {Array<{x:number,y:number}>} [options.points] - Forwarded
     */
    constructor(options = {}) {
        super(options);
        this.type = 'track';

        this.net = typeof options.net === 'string' ? options.net : '';
        this.width = Number.isFinite(options.width) && options.width > 0
            ? options.width
            : DEFAULT_WIDTH;

        // Default layer fallback for edges with no explicit assignment.
        this.layer = options.layer || DEFAULT_LAYER;

        // Per-edge layer assignment.
        this.edgeLayers = new Map();
        if (options.edgeLayers) {
            for (const [eid, lyr] of Object.entries(options.edgeLayers)) {
                if (typeof lyr === 'string') this.edgeLayers.set(eid, lyr);
            }
        }
        // Ensure every edge has a layer entry; default to track.layer.
        for (const eid of this.edges.keys()) {
            if (!this.edgeLayers.has(eid)) this.edgeLayers.set(eid, this.layer);
        }

        // Pad connections (mirror of Wire.pinConnections).
        this.padConnections = new Map();
        if (options.padConnections) {
            for (const [nid, conn] of Object.entries(options.padConnections)) {
                if (conn && conn.componentId && conn.pinNumber != null) {
                    this.padConnections.set(nid, { ...conn });
                }
            }
        }
    }

    /* ──────────────────── Graph overrides ────────────────────── */

    /** @override — also clean up padConnections when removing a node. */
    removeNode(nodeId) {
        this.padConnections.delete(nodeId);
        super.removeNode(nodeId);
    }

    /** @override — also clean up edgeLayers when removing an edge. */
    removeEdge(edgeId) {
        this.edgeLayers.delete(edgeId);
        super.removeEdge(edgeId);
    }

    /** @override — preserve padConnections during node merge. */
    mergeNodes(keepId, removeId) {
        if (keepId === removeId) return;
        if (this.padConnections.has(removeId) && !this.padConnections.has(keepId)) {
            this.padConnections.set(keepId, this.padConnections.get(removeId));
        }
        this.padConnections.delete(removeId);
        super.mergeNodes(keepId, removeId);
    }

    /** @override — protect pad-connected nodes from graph simplification. */
    _isProtectedNode(nodeId) {
        return this.padConnections.has(nodeId);
    }

    /** @override — preserve padConnections + edgeLayers during absorb. */
    _onAbsorb(other, remap) {
        if (other.padConnections) {
            for (const [oldNid, conn] of other.padConnections) {
                const newNid = remap.get(oldNid);
                if (newNid && !this.padConnections.has(newNid)) {
                    this.padConnections.set(newNid, { ...conn });
                }
            }
        }
        // Carry over each absorbed edge's copper layer. Edge IDs are
        // re-issued during absorb, but the endpoints are remapped via
        // `remap`, so match the new edge by its (remapped) node pair.
        if (other.edgeLayers && other.edges) {
            const layerByPair = new Map();
            for (const [oldEid, e] of other.edges) {
                const a = remap.get(e.from);
                const b = remap.get(e.to);
                if (a == null || b == null) continue;
                const lyr = other.edgeLayers.get(oldEid) || other.layer;
                layerByPair.set(`${a}|${b}`, lyr);
                layerByPair.set(`${b}|${a}`, lyr);
            }
            for (const [eid, e] of this.edges) {
                if (this.edgeLayers.has(eid)) continue;
                const lyr = layerByPair.get(`${e.from}|${e.to}`);
                if (lyr) this.edgeLayers.set(eid, lyr);
            }
        }
        // Ensure any still-unassigned edges fall back to this track's layer.
        for (const eid of this.edges.keys()) {
            if (!this.edgeLayers.has(eid)) this.edgeLayers.set(eid, this.layer);
        }
        if (!this.net && other.net) this.net = other.net;
    }

    /** @override — create Track instances for subgraph extraction. */
    _createSubgraphInstance() {
        return new Track({
            net: this.net,
            width: this.width,
            layer: this.layer,
        });
    }

    /** @override — copy padConnections + per-edge layers into subgraph. */
    _onExtractSubgraph(sub, nodeIds) {
        for (const nid of nodeIds) {
            if (this.padConnections.has(nid)) {
                sub.padConnections.set(nid, { ...this.padConnections.get(nid) });
            }
        }
        // Edges that exist in the subgraph were copied with new IDs by the
        // base class. We can't recover the original→new edge ID mapping
        // here, so assume sub already populated its edges; assign each
        // subgraph edge the layer of any original edge that shares the
        // same {fromNode, toNode} pair.
        const layerByPair = new Map();
        for (const [eid, e] of this.edges) {
            const key = `${e.from}|${e.to}`;
            layerByPair.set(key, this.edgeLayers.get(eid) || this.layer);
            layerByPair.set(`${e.to}|${e.from}`, this.edgeLayers.get(eid) || this.layer);
        }
        for (const [eid, e] of sub.edges) {
            const key = `${e.from}|${e.to}`;
            sub.edgeLayers.set(eid, layerByPair.get(key) || sub.layer);
        }
    }

    /** @override — also delete padConnection when deleting an anchor. */
    deleteAnchor(anchorId) {
        const result = super.deleteAnchor(anchorId);
        if (result) this.padConnections.delete(anchorId);
        return result;
    }

    /** @override */
    clone() {
        const c = new Track({
            net: this.net,
            width: this.width,
            layer: this.layer,
            color: this.color,
            lineWidth: this.lineWidth,
            visible: this.visible,
            locked: this.locked,
        });
        for (const [id, p] of this.nodes) c.nodes.set(id, { x: p.x, y: p.y });
        for (const [id, e] of this.edges) c.edges.set(id, { from: e.from, to: e.to });
        for (const [id, lyr] of this.edgeLayers) c.edgeLayers.set(id, lyr);
        for (const [id, conn] of this.padConnections) c.padConnections.set(id, { ...conn });
        return c;
    }

    /** @override — extend with track-specific fields. */
    captureState() {
        const s = super.captureState();
        s.net = this.net;
        s.width = this.width;
        s.layer = this.layer;
        s.edgeLayers = {};
        for (const [eid, lyr] of this.edgeLayers) s.edgeLayers[eid] = lyr;
        s.padConnections = {};
        for (const [nid, conn] of this.padConnections) s.padConnections[nid] = { ...conn };
        return s;
    }

    /** @override — restore track-specific fields. */
    applyState(state) {
        super.applyState(state);
        if ('net' in state) this.net = state.net || '';
        if (Number.isFinite(state.width) && state.width > 0) this.width = state.width;
        if (typeof state.layer === 'string') this.layer = state.layer;
        this.edgeLayers = new Map();
        if (state.edgeLayers) {
            for (const [eid, lyr] of Object.entries(state.edgeLayers)) {
                this.edgeLayers.set(eid, lyr);
            }
        }
        for (const eid of this.edges.keys()) {
            if (!this.edgeLayers.has(eid)) this.edgeLayers.set(eid, this.layer);
        }
        this.padConnections = new Map();
        if (state.padConnections) {
            for (const [nid, conn] of Object.entries(state.padConnections)) {
                this.padConnections.set(nid, { ...conn });
            }
        }
    }

    /* ──────────────────── Query helpers ──────────────────────── */

    /** Return the layer name for a given edge id (or the default). */
    getEdgeLayer(edgeId) {
        return this.edgeLayers.get(edgeId) || this.layer;
    }

    /* ──────────────────── Serialization ──────────────────────── */

    /**
     * Serialise to a compact JSON-friendly object. Inherits nd/ed from
     * PolylineGraph; adds track-specific n (net), w (width), l (layer),
     * el (per-edge layers), pdc (pad connections).
     */
    toJSON() {
        const json = { ...super.toJSON(), type: 'track' };
        if (this.net) json.n = this.net;
        if (this.width !== 0.2) json.w = this.width;
        if (this.layer) json.l = this.layer;
        // Per-edge layers: only emit entries that differ from this.layer.
        const el = {};
        let hasOverride = false;
        for (const [eid, lyr] of this.edgeLayers) {
            if (lyr !== this.layer) { el[eid] = lyr; hasOverride = true; }
        }
        if (hasOverride) json.el = el;
        if (this.padConnections.size > 0) {
            json.pdc = {};
            for (const [nid, conn] of this.padConnections) {
                json.pdc[nid] = { ...conn };
            }
        }
        return json;
    }
}
