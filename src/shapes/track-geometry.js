import { arcFromBulge, sampleArcEdge } from './arc-edge.js';
import { CORNER_CHORD_TOLERANCE, roundedPathCorners, sampleRoundedCorner } from './rounded-path.js';

/** Resolve copper centrelines identically for model queries, rendering and export. */
export function resolveTrackEdgePaths(track) {
    const adjacent = new Map();
    for (const [edgeId, edge] of track.edges) {
        for (const nodeId of [edge.from, edge.to]) {
            if (!adjacent.has(nodeId)) adjacent.set(nodeId, []);
            adjacent.get(nodeId).push(edgeId);
        }
    }
    const corners = new Map();
    for (const [nodeId, edgeIds] of adjacent) {
        const radius = Number(track.nodeCornerRadii?.[nodeId] ?? track.cornerRadius) || 0;
        if (radius < 0.01 || edgeIds.length !== 2 || track.padConnections?.has(nodeId)) continue;
        const [firstId, secondId] = edgeIds;
        if (track.edges.get(firstId).bulge || track.edges.get(secondId).bulge) continue;
        if ((track.getEdgeLayer?.(firstId) ?? track.layer) !== (track.getEdgeLayer?.(secondId) ?? track.layer)) continue;
        const vertex = track.nodes.get(nodeId);
        const neighbours = edgeIds.map(edgeId => {
            const edge = track.edges.get(edgeId);
            return track.nodes.get(edge.from === nodeId ? edge.to : edge.from);
        });
        if (!vertex || neighbours.some(point => !point)) continue;
        const corner = roundedPathCorners([neighbours[0], vertex, neighbours[1]], [0, radius, 0])[1];
        if (!corner.rounded) continue;
        const samples = sampleRoundedCorner(corner);
        const midpoint = (samples.length - 1) / 2;
        corners.set(nodeId, new Map([[firstId, samples.slice(0, midpoint + 1)], [secondId, samples.slice(midpoint).reverse()]]));
    }
    const paths = new Map();
    for (const [edgeId, edge] of track.edges) {
        const start = track.nodes.get(edge.from);
        const end = track.nodes.get(edge.to);
        if (!start || !end) continue;
        const startCorner = corners.get(edge.from)?.get(edgeId);
        const endCorner = corners.get(edge.to)?.get(edgeId);
        const arc = arcFromBulge(start, end, edge.bulge || 0);
        if (arc) {
            const count = Math.max(16, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - CORNER_CHORD_TOLERANCE / arc.radius))));
            const samples = sampleArcEdge(start, end, edge.bulge, count);
            samples[samples.length - 1] = end;
            paths.set(edgeId, [start, ...samples]);
        } else paths.set(edgeId, [...(startCorner ? [...startCorner].reverse() : [start]), ...(endCorner || [end])]);
    }
    return paths;
}

export function resolveTrackSegments(track) {
    return [...resolveTrackEdgePaths(track)].flatMap(([edgeId, points]) => points.slice(0, -1).map((start, index) => ({
        edgeId, start, end: points[index + 1],
        layer: track.getEdgeLayer?.(edgeId) ?? track.layer,
        width: (track.getEdgeWidth?.(edgeId) ?? track.width) || 0.2,
    })));
}
