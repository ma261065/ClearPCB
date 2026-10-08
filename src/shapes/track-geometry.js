import { arcFromBulge, sampleArcEdge } from './arc-edge.js';
import { CORNER_CHORD_TOLERANCE, roundedPathCorners, sampleRoundedCorner } from './rounded-path.js';
import { pointsFormAxisAlignedRect } from './path-operations.js';

/** @typedef {{x:number,y:number}} Point */
/** @typedef {import('./polyline-graph.js').GraphEdge} GraphEdge */
/** @typedef {import('./track.js').Track} Track */
/** @typedef {{edgeId:any,start:Point,end:Point,layer:string,width:number}} TrackSegment Legacy context-menu callbacks carry hit-test edge ids through nullable UI state. */
/** @typedef {Iterable<[string, Point[]]> & {size: number, get(key: string): Point[], set(key: string, value: Point[]): TrackEdgePathMap, has(key: string): boolean, delete(key: string): boolean, keys(): IterableIterator<string>, values(): IterableIterator<Point[]>, entries(): IterableIterator<[string, Point[]]>}} TrackEdgePathMap */

/**
 * Whether a track is a rectangle: one closed, single-layer loop of four straight
 * edges with axis-aligned sides. Without per-node radii its rounded corners are
 * circular quarter-arcs, by the same rule as a board rectangle
 * (boardShapeHasCircularCorners); other tracks use quadratic corners.
 */
/**
 * @param {Track} track
 * @returns {boolean}
 */
export function isTrackRectangleLoop(track) {
    return !!trackRectangleOrder(track);
}

/** Node ids of a rectangular track loop in loop order (see isTrackRectangleLoop), else null. */
/**
 * @param {Track} track
 * @returns {string[]|null}
 */
export function trackRectangleOrder(track) {
    if (track.nodes.size !== 4 || track.edges.size !== 4) return null;
    /** @type {Map<string, string[]>} */
    const neighbours = new Map([...track.nodes.keys()].map(nodeId => [nodeId, []]));
    for (const [edgeId, edge] of track.edges) {
        if (edge.bulge || !neighbours.has(edge.from) || !neighbours.has(edge.to)) return null;
        if ((track.getEdgeLayer?.(edgeId) ?? track.layer) !== track.layer) return null;
        /** @type {string[]} */ (neighbours.get(edge.from)).push(edge.to);
        /** @type {string[]} */ (neighbours.get(edge.to)).push(edge.from);
    }
    if ([...neighbours.values()].some(list => list.length !== 2)) return null;
    /** @type {string[]} */
    const order = [/** @type {string} */ (track.nodes.keys().next().value)];
    while (order.length < 4) {
        const next = /** @type {string[]} */ (neighbours.get(/** @type {string} */ (order.at(-1)))).find(nodeId => !order.includes(nodeId));
        if (!next) return null;
        order.push(next);
    }
    return pointsFormAxisAlignedRect(order.map(nodeId => /** @type {Point} */ (track.nodes.get(nodeId)))) ? order : null;
}

/** Resolve copper centrelines identically for model queries, rendering and export. */
/**
 * @param {Track} track
 * @returns {TrackEdgePathMap}
 */
export function resolveTrackEdgePaths(track) {
    /** @type {Map<string, string[]>} */
    const adjacent = new Map();
    for (const [edgeId, edge] of track.edges) {
        for (const nodeId of [edge.from, edge.to]) {
            if (!adjacent.has(nodeId)) adjacent.set(nodeId, []);
            /** @type {string[]} */ (adjacent.get(nodeId)).push(edgeId);
        }
    }
    /** @type {Map<string, Map<string, Point[]>>} */
    const corners = new Map();
    const circular = !Object.keys(track.nodeCornerRadii || {}).length && isTrackRectangleLoop(track);
    for (const [nodeId, edgeIds] of adjacent) {
        const radius = Number(track.nodeCornerRadii?.[nodeId] ?? track.cornerRadius) || 0;
        if (radius < 0.01 || edgeIds.length !== 2 || track.padConnections?.has(nodeId)) continue;
        const [firstId, secondId] = edgeIds;
        const firstEdge = /** @type {GraphEdge} */ (track.edges.get(firstId));
        const secondEdge = /** @type {GraphEdge} */ (track.edges.get(secondId));
        if (firstEdge.bulge || secondEdge.bulge) continue;
        if ((track.getEdgeLayer?.(firstId) ?? track.layer) !== (track.getEdgeLayer?.(secondId) ?? track.layer)) continue;
        const vertex = track.nodes.get(nodeId);
        const neighbours = edgeIds.map(edgeId => {
            const edge = /** @type {GraphEdge} */ (track.edges.get(edgeId));
            return track.nodes.get(edge.from === nodeId ? edge.to : edge.from);
        });
        if (!vertex || neighbours.some(point => !point)) continue;
        const corner = roundedPathCorners([/** @type {Point} */ (neighbours[0]), vertex, /** @type {Point} */ (neighbours[1])], [0, radius, 0], false, circular)[1];
        if (!corner.rounded) continue;
        const samples = sampleRoundedCorner(corner);
        const midpoint = (samples.length - 1) / 2;
        corners.set(nodeId, new Map([[firstId, samples.slice(0, midpoint + 1)], [secondId, samples.slice(midpoint).reverse()]]));
    }
    const paths = /** @type {TrackEdgePathMap} */ (new Map());
    for (const [edgeId, edge] of track.edges) {
        const start = track.nodes.get(edge.from);
        const end = track.nodes.get(edge.to);
        if (!start || !end) continue;
        const startCorner = corners.get(edge.from)?.get(edgeId);
        const endCorner = corners.get(edge.to)?.get(edgeId);
        const arc = arcFromBulge(start, end, edge.bulge || 0);
        if (arc) {
            const count = Math.max(16, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - CORNER_CHORD_TOLERANCE / arc.radius))));
            const samples = sampleArcEdge(start, end, edge.bulge || 0, count);
            samples[samples.length - 1] = end;
            paths.set(edgeId, [start, ...samples]);
        } else paths.set(edgeId, [...(startCorner ? [...startCorner].reverse() : [start]), ...(endCorner || [end])]);
    }
    return paths;
}

/**
 * @param {Track} track
 * @returns {TrackSegment[]}
 */
export function resolveTrackSegments(track) {
    return /** @type {Array<[string, Point[]]>} */ ([...resolveTrackEdgePaths(track)]).flatMap(([edgeId, points]) => points.slice(0, -1).map((start, index) => ({
        edgeId, start, end: points[index + 1],
        layer: track.getEdgeLayer?.(edgeId) ?? track.layer,
        width: (track.getEdgeWidth?.(edgeId) ?? track.width) || 0.2,
    })));
}
