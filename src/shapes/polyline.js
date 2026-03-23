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
        if (this.isRect && this.nodes.size <= 4) return false;
        const result = super.deleteAnchor(anchorId);
        if (result) this.isRect = false;
        return result;
    }

    /** @override */
    getAnchorSnapMode() { return this.isRect ? 'grid' : 'axis'; }

    /** @override */
    captureState() {
        const s = super.captureState();
        s.isRect = this.isRect;
        return s;
    }

    /** @override */
    applyState(state) {
        super.applyState(state);
        if ('isRect' in state) this.isRect = state.isRect;
        this._rectAxisCache = null;
    }

    clone() {
        const pts = this.getOrderedPoints();
        return new Polyline({
            color: this.color, lineWidth: this.lineWidth,
            layer: this.layer, visible: this.visible, locked: this.locked,
            closed: this.closed, fill: this.fill,
            fillColor: this.fillColor, fillAlpha: this.fillAlpha,
            isRect: this.isRect, cornerRadius: this.cornerRadius,
            points: pts ? pts.map(p => ({ x: p.x, y: p.y })) : [],
        });
    }

    toJSON() {
        const json = { ...super.toJSON(), type: 'polyline' };
        if (this.isRect) json.ir = true;
        return json;
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
