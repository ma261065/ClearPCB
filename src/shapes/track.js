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
     * Per-edge attribute schema (see PolylineGraph). A Track carries a
     * copper `layer` and a `width` on each edge, so a single track can span
     * multiple layers and vary in width segment-by-segment. Each falls back
     * to the track-wide default (`this.layer` / `this.width`).
     */
    static edgeAttributes = {
        layer: { prop: 'edgeLayers', json: 'el', default: (s) => s.layer },
        width: { prop: 'edgeWidths', json: 'ew', default: (s) => s.width },
    };

    /**
     * @param {object} [options]
     * @param {string} [options.id]
     * @param {string} [options.net] - Net name (e.g. 'VCC', 'Net0034')
     * @param {number} [options.width] - Trace width in mm (track-wide default)
     * @param {string} [options.layer] - Default copper layer for new edges
     *   when edgeLayers is not provided. Edges fall back to this layer.
     * @param {object} [options.edgeLayers] - Map of edgeId → layer name
     * @param {object} [options.edgeWidths] - Map of edgeId → width (mm)
     * @param {object} [options.padConnections] - Map of nodeId →
     *   { componentId, pinNumber }
    * @param {object|null} [options.sourceBoardShape] - Original generic
    *   board shape when this Track was created by shape conversion.
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
        this.sourceBoardShape = options.sourceBoardShape
            ? JSON.parse(JSON.stringify(options.sourceBoardShape))
            : null;

        // Pad connections (mirror of Wire.pinConnections).
        this.padConnections = new Map();
        if (options.padConnections) {
            for (const [nid, conn] of Object.entries(options.padConnections)) {
                if (conn && conn.componentId && conn.pinNumber != null) {
                    this.padConnections.set(nid, { ...conn });
                }
            }
        }

        // Initialise per-edge attributes (layer/width) now that the
        // track-wide defaults they fall back to are in place.
        this._initEdgeAttributes(options);
    }

    /* ──────────────────── Graph overrides ────────────────────── */

    /** @override — also clean up padConnections when removing a node. */
    removeNode(nodeId) {
        this.padConnections.delete(nodeId);
        super.removeNode(nodeId);
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

    /** @override — preserve padConnections during absorb. Per-edge layer
     * and width are carried automatically by the base class. */
    _onAbsorb(other, remap) {
        if (other.padConnections) {
            for (const [oldNid, conn] of other.padConnections) {
                const newNid = remap.get(oldNid);
                if (newNid && !this.padConnections.has(newNid)) {
                    this.padConnections.set(newNid, { ...conn });
                }
            }
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

    /** @override — copy padConnections into subgraph. Per-edge attributes
     * are preserved by the base class (edge IDs + attrs are kept intact). */
    _onExtractSubgraph(sub, nodeIds) {
        for (const nid of nodeIds) {
            if (this.padConnections.has(nid)) {
                sub.padConnections.set(nid, { ...this.padConnections.get(nid) });
            }
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
            sourceBoardShape: this.sourceBoardShape,
        });
        for (const [id, p] of this.nodes) c.nodes.set(id, { x: p.x, y: p.y });
        for (const [id, e] of this.edges) c.edges.set(id, this._cloneEdge(e));
        for (const [id, conn] of this.padConnections) c.padConnections.set(id, { ...conn });
        return c;
    }

    /** @override — extend with track-specific fields. Per-edge attributes
     * (layer/width) are captured by the base class as part of each edge. */
    captureState() {
        const s = super.captureState();
        s.net = this.net;
        s.width = this.width;
        s.layer = this.layer;
        s.sourceBoardShape = this.sourceBoardShape
            ? JSON.parse(JSON.stringify(this.sourceBoardShape))
            : null;
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
        this.sourceBoardShape = state.sourceBoardShape
            ? JSON.parse(JSON.stringify(state.sourceBoardShape))
            : null;
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
        return this.getEdgeAttr(edgeId, 'layer');
    }

    /** Return the width (mm) for a given edge id (or the default). */
    getEdgeWidth(edgeId) {
        return this.getEdgeAttr(edgeId, 'width');
    }

    /* ──────────────────── Serialization ──────────────────────── */

    /**
     * Serialise to a compact JSON-friendly object. Inherits nd/ed plus the
     * per-edge attribute maps (el = layers, ew = widths) from PolylineGraph;
     * adds track-specific n (net), w (width), l (layer), pdc (pad
     * connections).
     */
    toJSON() {
        const json = { ...super.toJSON(), type: 'track' };
        if (this.net) json.n = this.net;
        if (this.width !== 0.2) json.w = this.width;
        if (this.layer) json.l = this.layer;
        if (this.sourceBoardShape) json.sbs = this.sourceBoardShape;
        if (this.padConnections.size > 0) {
            json.pdc = {};
            for (const [nid, conn] of this.padConnections) {
                json.pdc[nid] = { ...conn };
            }
        }
        return json;
    }
}
