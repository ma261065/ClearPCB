import { copperLayer, resolveCopperPads } from './copper-model.js';

/**
 * One electrically-connected piece of copper: a Track's connected component, a
 * Via, a Pad, or (added by track-draw) an additive copper shape or pour region.
 * @typedef {object} CopperCluster
 * @property {'track'|'via'|'pad'|'shape'} [kind]
 * @property {string} net
 * @property {Array<{x:number,y:number}>} points
 * @property {string} [layer]
 * @property {any} [track] @property {Set<string>} [nodeIds] @property {Set<string>} [edgeIds]
 * @property {Array<{a:{x:number,y:number}, b:{x:number,y:number}, radius:number}>} [segments]
 * @property {any} [via] @property {number} [viaRadius]
 * @property {any} [pad] @property {string} [padNet] @property {string} [padKey]
 * @property {any} [shape] @property {any} [geometry] @property {any} [copperShape] @property {any} [source]
 */

/** @returns {CopperCluster[]} */
export function buildCopperClusters(app, nets = null) {
    /** @type {CopperCluster[]} */
    const clusters = [];
    for (const track of app.tracks || []) {
        const net = track.net || '';
        if (nets && !nets.has(net)) continue;
        const adjacency = new Map([...track.nodes.keys()].map((id) => [id, []]));
        for (const [edgeId, edge] of track.edges) {
            adjacency.get(edge.from)?.push({ node: edge.to, edgeId });
            adjacency.get(edge.to)?.push({ node: edge.from, edgeId });
        }
        const seen = new Set();
        for (const start of track.nodes.keys()) {
            if (seen.has(start)) continue;
            const points = [], segments = [], layers = new Set(), edges = new Set();
            const nodeIds = new Set();
            const stack = [start];
            while (stack.length) {
                const nodeId = stack.pop();
                if (seen.has(nodeId)) continue;
                seen.add(nodeId);
                nodeIds.add(nodeId);
                const point = track.nodes.get(nodeId);
                if (point) points.push({ x: point.x, y: point.y });
                for (const link of adjacency.get(nodeId) || []) {
                    edges.add(link.edgeId);
                    stack.push(link.node);
                }
            }
            for (const edgeId of edges) {
                const edge = track.edges.get(edgeId);
                const startPoint = track.nodes.get(edge.from), endPoint = track.nodes.get(edge.to);
                if (!startPoint || !endPoint) continue;
                layers.add(track.getEdgeLayer(edgeId));
                segments.push({ a: startPoint, b: endPoint, radius: (track.getEdgeWidth?.(edgeId) || track.width || 0.2) / 2 });
            }
            if (points.length) clusters.push({ kind: 'track', track, net, points, segments,
                nodeIds, edgeIds: edges,
                layer: layers.size === 1 ? [...layers][0] : 'all' });
        }
    }
    for (const via of app.vias || []) {
        const net = via.net || '';
        if (nets && !nets.has(net)) continue;
        clusters.push({ kind: 'via', via, net, layer: 'all',
            points: [{ x: via.x, y: via.y }], viaRadius: (via.diameter || 0.6) / 2 });
    }
    for (const pad of resolveCopperPads(app, { physical: true })) {
        if (nets && !nets.has(pad.net)) continue;
        clusters.push({ kind: 'pad', pad, net: pad.net, padNet: pad.net,
            padKey: `${pad.componentId}|${pad.padId}`, layer: copperLayer(pad.layer),
            points: [{ x: pad.x, y: pad.y }] });
    }
    return clusters;
}

export function unionCoincidentClusters(clusters, union, sameNet = false) {
    const buckets = new Map();
    for (let index = 0; index < clusters.length; index++) {
        for (const point of clusters[index].points) {
            const key = `${Math.round(point.x * 10000)},${Math.round(point.y * 10000)}`;
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(index);
        }
    }
    for (const bucket of buckets.values()) {
        const firstByGroup = new Map();
        for (const index of bucket) {
            const cluster = clusters[index];
            const net = sameNet ? cluster.net : '';
            let group = firstByGroup.get(net);
            if (!group) { group = new Map(); firstByGroup.set(net, group); }
            if (cluster.layer === 'all') {
                for (const other of group.values()) union(index, other);
            } else {
                const other = group.get(cluster.layer) ?? group.get('all');
                if (other !== undefined) union(index, other);
            }
            group.set(cluster.layer, index);
        }
    }
}