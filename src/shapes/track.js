/**
 * Track – Graph-based copper track for PCB
 *
 * Models a routed (or hand-drawn) PCB track as a graph: nodes connected
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
 * track-render.js), not via schematic shape rendering which
 * targets the schematic SVG layer.
 */

import { PolylineGraph } from './polyline-graph.js';
import { arcFromBulge } from './arc-edge.js';
import { resolveTrackSegments } from './track-geometry.js';
import { distanceToSegment } from '../core/geometry.js';

/** @typedef {{x:number,y:number}} Point */
/** @typedef {{from:string,to:string,bulge?:number,layer?:string,width?:number,[key:string]:any}} TrackEdge */
/** @typedef {{componentId:string,pinNumber:string|number}} PadConnection */
/** @typedef {{id?:string,plated?:true}} SourceShapeRecord */
/**
 * @typedef {import('./polyline-graph.js').PolylineGraphOptions & {
 * net?: string,
 * width?: number,
 * layer?: string,
 * edgeLayers?: object|Map<string,string>,
 * edgeWidths?: object|Map<string,number>,
 * edgeBulges?: object|Map<string,number>,
 * cornerRadius?: number,
 * nodeCornerRadii?: Record<string,number>,
 * padConnections?: object|Map<string,PadConnection>,
 * sourceBoardShape?: object|null
 * }} TrackOptions
 */

/** Default copper layer for a Track if none is specified. */
const DEFAULT_LAYER = 'top-copper';

/** Default track width in mm. */
const DEFAULT_WIDTH = 0.2;

/**
 * What a Track keeps of the board shape it was converted from: the shape id (reused
 * when it turns back into a shape, while still free) and a hole's plating. Everything
 * else comes from the track itself; older files stored a full shape copy, trimmed here.
 * @param {any} source
 * @returns {SourceShapeRecord|null}
 */
export function sourceShapeRecord(source) {
    if (!source || typeof source !== 'object') return null;
    /** @type {{id?: string, plated?: true}} */
    const record = {};
    if (typeof source.id === 'string' && source.id) record.id = source.id;
    if (source.plated === true) record.plated = true;
    return Object.keys(record).length ? record : null;
}

export class Track extends PolylineGraph {
    /**
     * Per-edge attribute schema (see PolylineGraph). A Track carries a
     * copper `layer` and a `width` on each edge, so a single track can span
     * multiple layers and vary in width segment-by-segment. Each falls back
     * to the track-wide default (`this.layer` / `this.width`).
     */
    /** @type {Record<string, {prop:string,json:string,default:(s:Track)=>unknown}>} */
    static edgeAttributes = {
        layer: { prop: 'edgeLayers', json: 'el', default: (s) => s.layer },
        width: { prop: 'edgeWidths', json: 'ew', default: (s) => s.width },
        bulge: { prop: 'edgeBulges', json: 'bg', default: () => 0 },
    };

    /**
     * @param {TrackOptions} [options]
     */
    constructor(options = {}) {
        super(options);
        this.type = 'track';

        this.net = typeof options.net === 'string' ? options.net : '';
        const optionWidth = options.width;
        this.width = Number.isFinite(optionWidth) && /** @type {number} */ (optionWidth) > 0
            ? /** @type {number} */ (optionWidth)
            : DEFAULT_WIDTH;

        // Default layer fallback for edges with no explicit assignment.
        this.layer = options.layer || DEFAULT_LAYER;
        this.sourceBoardShape = sourceShapeRecord(options.sourceBoardShape);

        // Pad connections (mirror of Wire.pinConnections).
        /** @type {Map<string, PadConnection>} */
        this.padConnections = new Map();
        if (options.padConnections) {
            const entries = options.padConnections instanceof Map ? options.padConnections : Object.entries(/** @type {Record<string, PadConnection>} */ (options.padConnections));
            for (const [nid, conn] of entries) {
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

    /**
     * @param {string} edgeId
     * @param {Point} point
     */
    splitEdge(edgeId, point) {
        const edge = this.edges.get(edgeId);
        const start = edge && this.nodes.get(edge.from);
        const end = edge && this.nodes.get(edge.to);
        const arc = edge && start && end ? arcFromBulge(start, end, edge.bulge || 0) : null;
        const result = super.splitEdge(edgeId, point);
        if (result && arc) {
            const sourceBulge = /** @type {TrackEdge} */ (edge).bulge || 0;
            /**
             * @param {Point} first
             * @param {Point} second
             */
            const ratio = (first, second) => {
                const cross = (first.x - arc.cx) * (second.y - arc.cy) - (first.y - arc.cy) * (second.x - arc.cx);
                const dot = (first.x - arc.cx) * (second.x - arc.cx) + (first.y - arc.cy) * (second.y - arc.cy);
                return Math.sign(sourceBulge) * Math.tan(Math.abs(Math.atan2(cross, dot)) / 4);
            };
            this.setEdgeAttr(result.edge1Id, 'bulge', ratio(/** @type {Point} */ (start), point));
            this.setEdgeAttr(result.edge2Id, 'bulge', ratio(point, /** @type {Point} */ (end)));
        }
        return result;
    }

    /** @override — also clean up padConnections when removing a node. */
    /** @param {string} nodeId */
    removeNode(nodeId) {
        this.padConnections.delete(nodeId);
        delete this.nodeCornerRadii[nodeId];
        super.removeNode(nodeId);
    }

    /** @override — preserve padConnections during node merge. */
    /**
     * @param {string} keepId
     * @param {string} removeId
     */
    mergeNodes(keepId, removeId) {
        if (keepId === removeId) return;
        if (!(keepId in this.nodeCornerRadii) && removeId in this.nodeCornerRadii) {
            this.nodeCornerRadii[keepId] = this.nodeCornerRadii[removeId];
        }
        if (this.padConnections.has(removeId) && !this.padConnections.has(keepId)) {
            this.padConnections.set(keepId, /** @type {PadConnection} */ (this.padConnections.get(removeId)));
        }
        this.padConnections.delete(removeId);
        super.mergeNodes(keepId, removeId);
        delete this.nodeCornerRadii[removeId];
    }

    /** @override — protect pad-connected nodes from graph simplification. */
    /** @param {string} nodeId */
    _isProtectedNode(nodeId) {
        return this.padConnections.has(nodeId);
    }

    /** @override — preserve padConnections during absorb. Per-edge layer
     * and width are carried automatically by the base class. */
    /**
     * @param {Track} other
     * @param {Map<string,string>} remap
     */
    _onAbsorb(other, remap) {
        for (const [oldId, newId] of remap) {
            this.setNodeCornerRadius(newId, other.nodeCornerRadius(oldId));
        }
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
            cornerRadius: this.cornerRadius,
        });
    }

    /** @override — copy padConnections into subgraph. Per-edge attributes
     * are preserved by the base class (edge IDs + attrs are kept intact). */
    /**
     * @param {Track} sub
     * @param {Set<string>} nodeIds
     */
    _onExtractSubgraph(sub, nodeIds) {
        for (const nid of nodeIds) {
            if (nid in this.nodeCornerRadii) sub.nodeCornerRadii[nid] = this.nodeCornerRadii[nid];
            if (this.padConnections.has(nid)) {
                sub.padConnections.set(nid, { .../** @type {PadConnection} */ (this.padConnections.get(nid)) });
            }
        }
    }

    /** @override — also delete padConnection when deleting an anchor. */
    /** @param {string} anchorId */
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
            cornerRadius: this.cornerRadius,
            nodeCornerRadii: this.nodeCornerRadii,
        });
        for (const [id, p] of this.nodes) c.nodes.set(id, { x: p.x, y: p.y });
        for (const [id, e] of this.edges) c.edges.set(id, this._cloneEdge(e));
        for (const [id, conn] of this.padConnections) c.padConnections.set(id, { ...conn });
        return c;
    }

    /** @override — extend with track-specific fields. Per-edge attributes
     * (layer/width) are captured by the base class as part of each edge. */
    captureState() {
        /** @type {ReturnType<PolylineGraph['captureState']> & {net?:string,width?:number,layer?:string,sourceBoardShape?:SourceShapeRecord|null,padConnections?:Record<string,PadConnection>}} */
        const s = super.captureState();
        s.net = this.net;
        s.width = this.width;
        s.layer = this.layer;
        s.sourceBoardShape = sourceShapeRecord(this.sourceBoardShape);
        s.padConnections = {};
        for (const [nid, conn] of this.padConnections) s.padConnections[nid] = { ...conn };
        return s;
    }

    /** Detached, full-precision copper graph with resolved per-edge attributes; no rendering state. */
    captureCopperGeometry() {
        const nodes = new Map([...this.nodes].map(([id, point]) => [id, { x: point.x, y: point.y }]));
        const edges = new Map([...this.edges].map(([id, edge]) => [id, { ...edge,
            width: this.getEdgeWidth(id), layer: this.getEdgeLayer(id),
        }]));
        return {
            id: this.id, net: this.net, width: this.width, layer: this.layer, nodes, edges,
            cornerRadius: this.cornerRadius, nodeCornerRadii: { ...this.nodeCornerRadii },
            padConnections: new Map([...this.padConnections].map(([id, connection]) => [id, { ...connection }])),
        };
    }

    /** @override — restore track-specific fields. */
    /** @param {Partial<ReturnType<Track['captureState']>>} state */
    applyState(state) {
        super.applyState(state);
        if ('net' in state) this.net = state.net || '';
        if (typeof state.width === 'number' && Number.isFinite(state.width) && state.width > 0) this.width = state.width;
        if (typeof state.layer === 'string') this.layer = state.layer;
        this.sourceBoardShape = sourceShapeRecord(state.sourceBoardShape);
        this.padConnections = new Map();
        if (state.padConnections) {
            for (const [nid, conn] of Object.entries(state.padConnections)) {
                this.padConnections.set(nid, { ...conn });
            }
        }
    }

    /* ──────────────────── Query helpers ──────────────────────── */

    /** Copper bounds include per-edge widths and the resolved rounded path. */
    _calculateBounds() {
        const segments = resolveTrackSegments(this);
        if (!segments.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const { start, end, width } of segments) {
            const halfWidth = width / 2;
            minX = Math.min(minX, start.x - halfWidth, end.x - halfWidth);
            minY = Math.min(minY, start.y - halfWidth, end.y - halfWidth);
            maxX = Math.max(maxX, start.x + halfWidth, end.x + halfWidth);
            maxY = Math.max(maxY, start.y + halfWidth, end.y + halfWidth);
        }
        return { minX, minY, maxX, maxY };
    }

    /** @param {Point} point */
    hitTest(point, tolerance = 0.5) {
        return resolveTrackSegments(this).some(({ start, end, width }) =>
            distanceToSegment(point, start, end) <= width / 2 + tolerance);
    }

    /** @param {Point} point */
    distanceTo(point) {
        return resolveTrackSegments(this).reduce((distance, { start, end }) =>
            Math.min(distance, distanceToSegment(point, start, end)), Infinity);
    }

    /** Return the layer name for a given edge id (or the default). */
    /**
     * @param {string} edgeId
     * @returns {string}
     */
    getEdgeLayer(edgeId) {
        return this.getEdgeAttr(edgeId, 'layer');
    }

    /** Return the width (mm) for a given edge id (or the default). */
    /**
     * @param {string} edgeId
     * @returns {number}
     */
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
        /** @type {ReturnType<PolylineGraph['toJSON']> & {type:string,n?:string,w?:number,l?:string,sbs?:SourceShapeRecord,pdc?:Record<string,PadConnection>}} */
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
