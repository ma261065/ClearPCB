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
 * True rectangles save a centre/size/rotation frame plus corner and edge IDs;
 * legacy coordinate graphs remain readable and runtime geometry stays graph-based.
 */

import { PolylineGraph } from './polyline-graph.js';
import { ShapeValidator } from '../core/ShapeValidator.js';
import { deletePathVertex, splitPathSegmentMetadata, remapPathNodes, collapseCollinearPath, collapseRoundedPolygon, resizeRectanglePoints } from './path-operations.js';
import { hasRectangleFrame, rectangleFrameFromPoints, rectangleFramePoints } from './rectangle-frame.js';

/**
 * @typedef {{x: number, y: number}} Point
 * @typedef {Record<string, any>} PolylineOptions
 * @typedef {{anchorId: string, nodeIds: string[], points: Point[]}|null} RectAxisCache
 */

/** @param {PolylineOptions} options */
function rectangleGraphOptions(options) {
    if (!Object.hasOwn(options, 'cornerNodeIds')
        && !hasRectangleFrame(options)) return options;
    const ids = /** @type {string[]} */ (options.cornerNodeIds);
    if (options.isRect !== true || options.closed !== true || !Array.isArray(ids) || ids.length !== 4
        || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== 4
        || !options.graphEdges || typeof options.graphEdges !== 'object' || Array.isArray(options.graphEdges)
        || Object.hasOwn(options, 'graphNodes') || Object.hasOwn(options, 'points')) {
        throw new Error('Rectangle frame requires four distinct corner node IDs and a closed rectangle graph without coordinate nodes.');
    }
    const expected = new Set(ids.map((id, index) => JSON.stringify([id, ids[(index + 1) % 4]].sort())));
    const edges = /** @type {Array<[string, string]>} */ (Object.values(options.graphEdges));
    if (edges.length !== 4 || edges.some(edge => !Array.isArray(edge) || edge.length !== 2
        || edge.some(id => typeof id !== 'string'))) {
        throw new Error('Rectangle edges must be four endpoint tuples connecting successive corner node IDs.');
    }
    const actual = edges.map(edge => JSON.stringify([...edge].sort()));
    if (new Set(actual).size !== 4 || actual.some(edge => !expected.has(edge))) {
        throw new Error('Rectangle edges must connect successive corner node IDs exactly once.');
    }
    const points = rectangleFramePoints(options);
    return { ...options, graphNodes: Object.fromEntries(ids.map((id, index) => [id, points[index]])) };
}

/** @param {any} shape */
function rectangleGraphFrame(shape) {
    const ids = /** @type {string[]} */ (shape.getOrderedNodeIds());
    if (!shape.closed || shape.nodes.size !== 4 || shape.edges.size !== 4 || ids.length !== 4
        || ids.some(id => shape.degree(id) !== 2) || shape._hasBulgedEdges()) {
        throw new Error('Rectangle serialization requires a closed four-corner graph with straight edges.');
    }
    return { ids, frame: rectangleFrameFromPoints(ids.map(id => shape.nodes.get(id))) };
}

export class Polyline extends PolylineGraph {
    /** @type {'polyline'} */
    type;

    /**
     * Per-edge attribute schema (see PolylineGraph). `bulge` lets an individual
     * edge curve into a circular arc (0 = straight) — the model behind a
     * "polygon with some segments as arcs". Serialised under the `bg` key.
     */
    static edgeAttributes = {
        bulge: { prop: 'edgeBulges', json: 'bg', default: () => 0 },
        width: { prop: 'edgeWidths', json: 'ew', default: /** @param {Polyline} shape */ (shape) => shape.lineWidth },
    };

    /** @param {PolylineOptions} [options] */
    constructor(options = {}) {
        options = rectangleGraphOptions(options);
        const closed = options.closed !== undefined ? options.closed : false;
        const fill = options.fill !== undefined ? options.fill : (closed ? true : false);
        const fillAlpha = options.fillAlpha ?? 0.3;

        /** @type {Point[]|undefined} */
        let points;
        if (options.points && options.points.length >= 2 && !options.graphNodes) {
            points = /** @type {Point[]} */ (options.points).map(p => ({ x: p.x, y: p.y }));
        }

        super({ ...options, points, closed, fill, fillAlpha });
        /** @type {'polyline'} */
        this.type = 'polyline';

        // Rectangle mode: constrained corner dragging
        /** @type {boolean} */
        this.isRect = options.isRect || false;
        /** @type {RectAxisCache} */
        this._rectAxisCache = null;
        /** @type {Set<import('./text.js').Text>|null|undefined} Labels attached to this polyline. */
        this.attachedLabels = null;

        // Apply per-edge attributes (bulge) from constructor options. Must run
        // after the graph is loaded by super().
        this._initEdgeAttributes(options);
        const providedWidths = options.edgeWidths;
        for (const [edgeId, edge] of this.edges) {
            if (!providedWidths || !Object.prototype.hasOwnProperty.call(providedWidths, edgeId)) {
                delete edge.width;
            }
        }
        if (options.cornerNodeIds) rectangleGraphFrame(this);
    }

    /**
     * @override - rectangle-aware anchor drag.
     * @param {string} anchorId
     * @param {number} x
     * @param {number} y
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

        const currentIds = /** @type {string[]} */ (this.getOrderedNodeIds());
        const currentPoints = /** @type {Point[]} */ (currentIds.map(id => ({ ...this.nodes.get(id) })));
        const nondegenerate = currentPoints.every((point, index) =>
            Math.hypot(point.x - currentPoints[(index + 1) % currentPoints.length].x,
                point.y - currentPoints[(index + 1) % currentPoints.length].y) > 1e-9);
        if (!this._rectAxisCache || this._rectAxisCache.anchorId !== anchorId || nondegenerate) {
            this._rectAxisCache = {
                anchorId, nodeIds: currentIds, points: currentPoints,
            };
        }
        const { points, nodeIds } = /** @type {{points: Point[], nodeIds: string[]}} */ (this._rectAxisCache);
        /** @type {Point[]} */ (resizeRectanglePoints(points, nodeIds.indexOf(anchorId), { x, y }))
            .forEach((point, index) => this.nodes.set(nodeIds[index], point));
        this.invalidate();
    }

    /**
     * @override
     * @param {string} anchorId
     */
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

    /** @returns {any|null} */
    toEditablePath() {
        const nodeIds = /** @type {string[]} */ (this.getOrderedNodeIds());
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

    /** @param {any} path */
    applyEditablePath(path) {
        const usedNodes = new Set(Object.values(path.nodeIds || {}));
        const usedEdges = new Set(Object.values(path.edgeIds || {}));
        /**
         * @param {Set<any>} used
         * @param {string} prefix
         */
        const allocate = (used, prefix) => {
            let index = 0;
            while (used.has(`${prefix}${index}`)) index++;
            const id = `${prefix}${index}`;
            used.add(id);
            return id;
        };
        const pathPoints = /** @type {Point[]} */ (path.points);
        const pathNodeIds = /** @type {Record<number, string>|undefined} */ (path.nodeIds);
        const nodeIds = /** @type {string[]} */ (pathPoints.map((_, index) => pathNodeIds?.[index] ?? allocate(usedNodes, 'n')));
        const nodes = new Map(pathPoints.map((point, index) => [nodeIds[index], { x: point.x, y: point.y }]));
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

    /**
     * @param {string} edgeId
     * @param {Point} point
     */
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

    /**
     * @override
     * @param {string} anchorId
     */
    getAnchorSnapMode(anchorId) {
        if (typeof anchorId === 'string' && anchorId.startsWith('bulge_')) return 'none';
        return this.isRect ? 'grid' : 'axis';
    }

    /** @override */
    captureState() {
        /** @type {any} */
        const s = super.captureState();
        s.isRect = this.isRect;
        s.lineWidth = this.lineWidth;
        return s;
    }

    /**
     * @override
     * @param {any} state
     */
    applyState(state) {
        super.applyState(state);
        if ('isRect' in state) this.isRect = state.isRect;
        if ('lineWidth' in state) this.lineWidth = state.lineWidth;
        this._rectAxisCache = null;
    }

    clone() {
        /** @type {Record<string, Point>} */
        const graphNodes = {};
        for (const [id, p] of this.nodes) graphNodes[id] = { x: p.x, y: p.y };
        /** @type {Record<string, {from: string, to: string}>} */
        const graphEdges = {};
        /** @type {Record<string, number>} */
        const edgeBulges = {};
        /** @type {Record<string, number>} */
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
        /** @type {any} */
        const json = { ...super.toJSON(), type: 'polyline' };
        if (this.isRect) {
            const { ids, frame } = rectangleGraphFrame(this);
            delete json.nd;
            Object.assign(json, {
                ir: true, x: frame.x, y: frame.y, w: frame.width, h: frame.height,
                rot: frame.rotation, cn: ids,
            });
            if (frame.reversed) json.rev = true;
        } else if (this.closed && Object.values(json.ed).some(([from, to]) =>
            json.nd[from][0] === json.nd[to][0] && json.nd[from][1] === json.nd[to][1])) {
            const path = this.toEditablePath();
            if (!path || Object.keys(path.edgeIds).length !== path.points.length) {
                throw new Error(`Cannot save polygon "${this.id}": collapsed edges require a simple closed graph.`);
            }
            path.id = this.id;
            const forward = Object.fromEntries(Object.entries(path.edgeIds).map(([index, id]) =>
                [id, json.ed[id][0] === path.nodeIds[index]]));
            path.points = Object.values(path.nodeIds).map(id => ({ x: json.nd[id][0], y: json.nd[id][1] }));
            collapseRoundedPolygon(path);
            const ids = /** @type {string[]} */ (Object.values(path.nodeIds));
            json.nd = Object.fromEntries(ids.map((id, index) => [id, [path.points[index].x, path.points[index].y]]));
            json.ed = Object.fromEntries(Object.entries(path.edgeIds).map(([index, id]) => {
                const endpoints = [ids[Number(index)], ids[(Number(index) + 1) % ids.length]];
                return [id, forward[id] ? endpoints : endpoints.reverse()];
            }));
            for (const field of ['bg', 'ew']) {
                if (!json[field]) continue;
                json[field] = Object.fromEntries(Object.entries(json[field]).filter(([id]) => Object.hasOwn(json.ed, id)));
                if (!Object.keys(json[field]).length) delete json[field];
            }
            const radii = ids.flatMap((id, index) => Math.abs(path.nodeCornerRadii[index] - this.cornerRadius) >= 1e-9
                ? [[id, path.nodeCornerRadii[index]]] : []);
            if (radii.length) json.ncr = Object.fromEntries(radii);
            else delete json.ncr;
        }
        return json;
    }
}

// ── Factory functions ──────────────────────────────────────────────

/**
 * Create an open polyline (Line tool).
 * @param {PolylineOptions} [options]
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
 * @param {PolylineOptions} [options]
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
 * @param {PolylineOptions} [options]
 */
export function createRect(options = {}) {
    const x = ShapeValidator.validateCoordinate(options.x || 0, { name: 'x' });
    const y = ShapeValidator.validateCoordinate(options.y || 0, { name: 'y' });
    const w = ShapeValidator.validateNumber(options.width || 10, { min: 0, name: 'width' });
    const h = ShapeValidator.validateNumber(options.height || 10, { min: 0, name: 'height' });
    const shapeOptions = { ...options };
    // Factory dimensions describe its top-left drawing API, not a saved frame.
    for (const field of ['width', 'height', 'rotation', 'reversed']) delete shapeOptions[field];

    return new Polyline({
        ...shapeOptions,
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
