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

        const adj1Id = edges[0].otherNode;
        const adj2Id = edges[1].otherNode;
        const dragPos = this.nodes.get(anchorId);
        const adj1 = this.nodes.get(adj1Id);
        const adj2 = this.nodes.get(adj2Id);

        if (!dragPos || !adj1 || !adj2) return super.moveAnchor(anchorId, x, y);

        if (!this._rectAxisCache || this._rectAxisCache.anchorId !== anchorId) {
            const dx1 = Math.abs(adj1.x - dragPos.x);
            const dy1 = Math.abs(adj1.y - dragPos.y);
            this._rectAxisCache = {
                anchorId,
                edge1IsVertical: dx1 < dy1,
            };
        }

        const { edge1IsVertical } = this._rectAxisCache;

        dragPos.x = x;
        dragPos.y = y;

        if (edge1IsVertical) {
            adj1.x = x;
            adj2.y = y;
        } else {
            adj1.y = y;
            adj2.x = x;
        }

        this.invalidate();
    }

    /** @override */
    deleteAnchor(anchorId) {
        // Open shapes need at least 2 vertices (1 edge)
        if (!this.closed && this.edges.size <= 1) return false;
        // Closed shape with 3 nodes: deleting opens it into a line
        if (this.closed && this.nodes.size <= 3) {
            // Remove the node and break the closure
            if (!this.nodes.has(anchorId)) return false;
            const edges = this.incidentEdges(anchorId);
            if (edges.length < 2) return false;
            // Remove edges and node
            for (const e of edges) this.edges.delete(e.edgeId);
            this.nodes.delete(anchorId);
            // Remaining 2 nodes: ensure they're connected
            const remaining = [...this.nodes.keys()];
            if (remaining.length === 2 && !this.hasEdgeBetween(remaining[0], remaining[1])) {
                this.addEdge(remaining[0], remaining[1]);
            }
            this.closed = false;
            this.isRect = false;
            this.invalidate();
            return true;
        }
        const result = super.deleteAnchor(anchorId);
        if (result) this.isRect = false;
        return result;
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
