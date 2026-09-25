/**
 * Polyline – Unified line / polygon / rectangle shape (extends PolylineGraph)
 *
 * A single class for all non-wire graph-based shapes:
 *   - Open polyline (closed=false) — drawn with the Line tool
 *   - Closed polygon (closed=true) — drawn with the Polygon tool
 *   - Rectangle (closed=true, isRect=true) — drawn with the Rect tool
 *
 * Shapes can convert between these modes via anchor editing:
 *   - Splitting a rect segment → becomes a polygon (isRect=false)
 *   - Closing a line's endpoints → becomes a polygon (closed=true)
 *   - Breaking a polygon's closing edge → becomes a line (closed=false)
 *   - Dragging a polygon into rect shape → becomes a rectangle (isRect=true)
 *
 * type is always 'polyline' for serialization.
 */

import { PolylineGraph } from './polyline-graph.js';
import { ShapeValidator } from '../core/ShapeValidator.js';
import { deletePathVertex, splitPathSegmentMetadata, remapPathNodes, collapseCollinearPath, resizeRectanglePoints } from './path-operations.js';

export class Polyline extends PolylineGraph {
    /**
     * Per-edge attribute schema (see PolylineGraph). `bulge` lets an individual
     * edge curve into a circular arc (0 = straight) — the model behind a
     * "polygon with some segments as arcs". Serialised under the `bg` key.
     */
    static edgeAttributes = {
        bulge: { prop: 'edgeBulges', json: 'bg', default: () => 0 },
        width: { prop: 'edgeWidths', json: 'ew', default: (shape) => shape.lineWidth },
    };

    constructor(options = {}) {
        const closed = options.closed !== undefined ? options.closed : false;
        const fill = options.fill !== undefined ? options.fill : (closed ? true : false);
        const fillAlpha = options.fillAlpha ?? 0.3;

        let points;
        if (options.points && options.points.length >= 2 && !options.graphNodes) {
            points = options.points.map(p => ({ x: p.x, y: p.y }));
        }

        super({ ...options, points, closed, fill, fillAlpha });
        this.type = 'polyline';

        // Rectangle mode: constrained corner dragging
        this.isRect = options.isRect || false;

        // Apply per-edge attributes (bulge) from constructor options. Must run
        // after the graph is loaded by super().
        this._initEdgeAttributes(options);
        const providedWidths = options.edgeWidths;
        for (const [edgeId, edge] of this.edges) {
            if (!providedWidths || !Object.prototype.hasOwnProperty.call(providedWidths, edgeId)) {
                delete edge.width;
            }
        }
    }

    /**
     * @override - rectangle-aware anchor drag.
     */
    moveAnchor(anchorId, x, y) {
        if (!this.isRect) return super.moveAnchor(anchorId, x, y);

        if (anchorId.startsWith('mid_')) {
            const result = super.moveAnchor(anchorId, x, y);
            this.isRect = false;
            this._rectAxisCache = null;
            return result;
        }

        if (!this.nodes.has(anchorId)) return;

        const edges = this.incidentEdges(anchorId);
        if (edges.length !== 2) {
            this.isRect = false;
            this._rectAxisCache = null;
            return super.moveAnchor(anchorId, x, y);
        }

        const currentIds = this.getOrderedNodeIds();
        const currentPoints = currentIds.map(id => ({ ...this.nodes.get(id) }));
        const nondegenerate = currentPoints.every((point, index) =>
            Math.hypot(point.x - currentPoints[(index + 1) % currentPoints.length].x,
                point.y - currentPoints[(index + 1) % currentPoints.length].y) > 1e-9);
        if (!this._rectAxisCache || this._rectAxisCache.anchorId !== anchorId || nondegenerate) {
            this._rectAxisCache = {
                anchorId, nodeIds: currentIds, points: currentPoints,
            };
        }
        const { points, nodeIds } = this._rectAxisCache;
        resizeRectanglePoints(points, nodeIds.indexOf(anchorId), { x, y })
            .forEach((point, index) => this.nodes.set(nodeIds[index], point));
        this.invalidate();
    }

    /** @override */
    deleteAnchor(anchorId) {
        const path = this.toEditablePath();
        if (path) {
            const index = Object.values(path.nodeIds).indexOf(anchorId);
            if (!deletePathVertex(path, index)) return false;
            this.applyEditablePath(path);
            return true;
        }
        const result = super.deleteAnchor(anchorId);
        if (result) this.isRect = false;
        return result;
    }

    toEditablePath() {
        const nodeIds = this.getOrderedNodeIds();
        const chain = this.getOrderedEdgeChain();
        if (this.getJunctionNodes().length || nodeIds.length !== this.nodes.size
            || chain.length !== this.edges.size) return null;
        return {
            kind: this.closed ? 'polygon' : 'line',
            points: nodeIds.map(id => ({ ...this.nodes.get(id) })),
            nodeIds: Object.fromEntries(nodeIds.map((id, index) => [index, id])),
            edgeIds: Object.fromEntries(chain.map((edge, index) => [index, edge.edgeId])),
            nodeCornerRadii: Object.fromEntries(nodeIds.map((id, index) => [index, this.nodeCornerRadius(id)])),
            segmentWidths: Object.fromEntries(chain.map((edge, index) => [index, this.getEdgeAttr(edge.edgeId, 'width')])),
            segmentBulges: Object.fromEntries(chain.map((edge, index) => [index, edge.bulge])),
        };
    }

    cleanGraph() {
        const path = this.toEditablePath();
        if (!path) return super.cleanGraph();
        if (collapseCollinearPath(path)) this.applyEditablePath(path);
    }

    applyEditablePath(path) {
        const usedNodes = new Set(Object.values(path.nodeIds || {}));
        const usedEdges = new Set(Object.values(path.edgeIds || {}));
        const allocate = (used, prefix) => {
            let index = 0;
            while (used.has(`${prefix}${index}`)) index++;
            const id = `${prefix}${index}`;
            used.add(id);
            return id;
        };
        const nodeIds = path.points.map((_, index) => path.nodeIds?.[index] ?? allocate(usedNodes, 'n'));
        const nodes = new Map(path.points.map((point, index) => [nodeIds[index], { x: point.x, y: point.y }]));
        const closed = path.kind !== 'line';
        const count = closed ? nodeIds.length : Math.max(0, nodeIds.length - 1);
        const edges = new Map();
        for (let index = 0; index < count; index++) {
            const id = path.edgeIds?.[index] ?? allocate(usedEdges, 'e');
            edges.set(id, { ...this.edges.get(id), from: nodeIds[index], to: nodeIds[(index + 1) % nodeIds.length],
                width: path.segmentWidths?.[index] ?? this.lineWidth, bulge: path.segmentBulges?.[index] || 0 });
            if (edges.get(id).width === this.lineWidth) delete edges.get(id).width;
        }
        this.nodes = nodes;
        this.edges = edges;
        this.nodeCornerRadii = Object.fromEntries(nodeIds.flatMap((id, index) => {
            const radius = path.nodeCornerRadii?.[index] ?? this.cornerRadius;
            return Math.abs(radius - this.cornerRadius) > 1e-9 ? [[id, radius]] : [];
        }));
        this.closed = closed;
        this.isRect = closed && this.isAxisAlignedRect();
        this._rectAxisCache = null;
        this.invalidate();
    }

    splitEdge(edgeId, point) {
        const path = this.toEditablePath();
        if (!path) return super.splitEdge(edgeId, point);
        const index = Object.values(path.edgeIds).indexOf(edgeId);
        if (index < 0) return null;
        path.points.splice(index + 1, 0, { ...point });
        splitPathSegmentMetadata(path, index);
        remapPathNodes(path, index + 1, 1);
        this.applyEditablePath(path);
        this.isRect = false;
        const nodeIds = this.getOrderedNodeIds();
        const chain = this.getOrderedEdgeChain();
        return { newNodeId: nodeIds[index + 1], edge1Id: chain[index].edgeId, edge2Id: chain[index + 1].edgeId };
    }

    /** @override */
    getAnchorSnapMode(anchorId) {
        if (typeof anchorId === 'string' && anchorId.startsWith('bulge_')) return 'none';
        return this.isRect ? 'grid' : 'axis';
    }

    /** @override */
    captureState() {
        const s = super.captureState();
        s.isRect = this.isRect;
        s.lineWidth = this.lineWidth;
        return s;
    }

    /** @override */
    applyState(state) {
        super.applyState(state);
        if ('isRect' in state) this.isRect = state.isRect;
        if ('lineWidth' in state) this.lineWidth = state.lineWidth;
        this._rectAxisCache = null;
    }

    clone() {
        const graphNodes = {};
        for (const [id, p] of this.nodes) graphNodes[id] = { x: p.x, y: p.y };
        const graphEdges = {};
        const edgeBulges = {};
        const edgeWidths = {};
        for (const [id, e] of this.edges) {
            graphEdges[id] = { from: e.from, to: e.to };
            if (e.bulge) edgeBulges[id] = e.bulge;
            if (e.width !== this.lineWidth) edgeWidths[id] = e.width;
        }
        return new Polyline({
            color: this.color, lineWidth: this.lineWidth,
            layer: this.layer, visible: this.visible, locked: this.locked,
            closed: this.closed, fill: this.fill,
            fillColor: this.fillColor, fillAlpha: this.fillAlpha,
            isRect: this.isRect, cornerRadius: this.cornerRadius,
            nodeCornerRadii: { ...this.nodeCornerRadii },
            graphNodes, graphEdges, edgeBulges, edgeWidths,
        });
    }

    toJSON() {
        const json = { ...super.toJSON(), type: 'polyline' };
        if (this.isRect) json.ir = true;
        return json;
    }
}

// ── Factory functions ──────────────────────────────────────────────

/**
 * Create an open polyline (Line tool).
 */
export function createLine(options = {}) {
    return new Polyline({
        ...options,
        closed: false,
        fill: false,
    });
}

/**
 * Create a closed polygon (Polygon tool).
 */
export function createPolygon(options = {}) {
    return new Polyline({
        ...options,
        closed: true,
        fill: options.fill !== undefined ? options.fill : true,
    });
}

/**
 * Create a rectangle (Rect tool) from x/y/width/height.
 */
export function createRect(options = {}) {
    const x = ShapeValidator.validateCoordinate(options.x || 0, { name: 'x' });
    const y = ShapeValidator.validateCoordinate(options.y || 0, { name: 'y' });
    const w = ShapeValidator.validateNumber(options.width || 10, { min: 0, name: 'width' });
    const h = ShapeValidator.validateNumber(options.height || 10, { min: 0, name: 'height' });

    return new Polyline({
        ...options,
        points: [
            { x: x,     y: y },
            { x: x + w, y: y },
            { x: x + w, y: y + h },
            { x: x,     y: y + h },
        ],
        closed: true,
        fill: options.fill !== undefined ? options.fill : false,
        fillAlpha: options.fillAlpha ?? 0.3,
        isRect: true,
    });
}
