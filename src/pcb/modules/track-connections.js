import { buildCopperClusters, unionCoincidentClusters } from './copper-connectivity.js';
import { getComputedFill } from './computed-fill-cache.js';
import { pointInPolygon, distanceToSegment } from '../../core/geometry.js';
import { resolveTrackSegments } from '../../shared/pcb/board-geometry.js';
import { resolveCopperPads } from './copper-model.js';
import { normalizeShapeCopperMode } from '../../shared/pcb/board-shape-geometry.js';
import { spatialPairs, spatialCrossPairs } from '../../core/spatial-pairs.js';
import { resolveTrackContactGeometry, copperContactsTouch, copperRegionShape, copperSegmentShape, copperSegmentContact, resolveTerminalCopperContact, pointInCopperRegion } from './track-contact-geometry.js';

const TOGGLE_LAYERS = ['top-copper', 'bottom-copper'];
const ratlinePointKey = ({ x, y }) => `${Math.round(x * 10000)},${Math.round(y * 10000)}`;
export function shapeCopperContains(contact, point) {
    const { geometry, bounds } = contact;
    if (point.x < bounds.minX || point.x > bounds.maxX || point.y < bounds.minY || point.y > bounds.maxY) return false;
    if (geometry.copperMode !== 'add') return false;
    if (geometry.circle) {
        const distance = Math.hypot(point.x - geometry.circle.x, point.y - geometry.circle.y);
        return geometry.filled ? distance <= geometry.circle.outerRadius
            : Math.abs(distance - geometry.circle.radius) <= geometry.lineWidth / 2;
    }
    if (geometry.areaOutline && pointInPolygon(point, geometry.areaOutline)) return true;
    if (geometry.strokeSegments.length) {
        return geometry.strokeSegments.some(({ start, end, lineWidth }) =>
            distanceToSegment(point, start, end) <= lineWidth / 2);
    }
    const points = geometry.centerline;
    const count = points.length - (geometry.pathClosed ? 0 : 1);
    for (let index = 0; index < count; index++) {
        if (distanceToSegment(point, points[index], points[(index + 1) % points.length])
            <= geometry.lineWidth / 2) return true;
    }
    return false;
}

export function collectBondedCopper(app, seed, { includeShapes = false, newTracks = null } = {}) {
    const clusters = buildBondedClusters(app, includeShapes);

    // Union-find with layer-aware coincidence (mirrors reconcileRatsnest).
    const parent = clusters.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    unionCoincidentClusters(clusters, union);
    if (!includeShapes) _unionViaTrackOverlaps(clusters, union, false);

    const roots = new Set();
    for (let i = 0; i < clusters.length; i++) {
        const c = clusters[i];
        const seededTrackComponent = (seed.tracks?.has(c.track) || seed.track && c.track === seed.track)
            && (!seed.edgeId || c.edgeIds?.has(seed.edgeId))
            && (!seed.nodeId || c.nodeIds?.has(seed.nodeId));
        if (seededTrackComponent || (seed.via && c.via === seed.via)
            || (seed.padKey && c.padKey === seed.padKey)) {
            roots.add(find(i));
        }
    }
    if (includeShapes && roots.size) {
        const contacts = _clusterCopperContacts(app, clusters).map(contact => ({
            ...contact, root: find(contact.index),
        }));
        expandCopperContactRoots(contacts, roots, newTracks);
    }
    return bondedCopperFromClusters(clusters.filter((_, index) => roots.has(find(index))));
}

export function expandCopperContactRoots(contacts, roots, newTracks = null, touches = copperContactsTouch) {
    const neighbours = new Map();
    for (const [first, second] of spatialPairs(contacts, contact => contact.resolved.bounds, 1e-7)) {
        if (first.root === second.root
            || (first.layer !== 'all' && second.layer !== 'all' && first.layer !== second.layer)) continue;
        const fill = first.shape?.type === 'fill' ? first.shape
            : second.shape?.type === 'fill' ? second.shape : null;
        const track = first.track || second.track;
        // Repouring cuts clearance around new foreign-net Tracks instead of bonding them.
        if (fill?.net && newTracks?.has(track) && fill.net !== track.net) continue;
        for (const [from, to] of [[first, second], [second, first]]) {
            if (!neighbours.has(from.root)) neighbours.set(from.root, []);
            neighbours.get(from.root).push([from, to]);
        }
    }
    // Only resolve exact contacts reachable from the seed's existing connections.
    const pending = [...roots];
    for (let index = 0; index < pending.length; index++) {
        for (const [from, to] of neighbours.get(pending[index]) || []) {
            if (roots.has(to.root)) continue;
            if (!touches(from.resolved, to.resolved)) continue;
            roots.add(to.root);
            pending.push(to.root);
        }
    }
}

export function buildBondedClusters(app, includeShapes) {
    const clusters = buildCopperClusters(app);
    if (!clusters.length) terminalContactPasses.delete(app);
    if (includeShapes) {
        for (const shape of new Set([...(app.boardShapes || []), ...(app.copperFills || [])])) {
            if (!TOGGLE_LAYERS.includes(shape.layer)
                || (shape.type !== 'fill' && normalizeShapeCopperMode(shape.copperMode) !== 'add')) continue;
            const geometries = shape.type === 'fill'
                ? (getComputedFill(shape) || []).map(copperRegionShape)
                : [shape];
            for (const geometry of geometries) {
                clusters.push({ kind: 'shape', shape, geometry, net: shape.net || '',
                    layer: shape.layer, points: [] });
            }
        }
    }

    return clusters;
}

/** Layer-compatible copper under a node, never copper crossed by its edges. */
export function* nodeTargetPairs(nodes, contacts) {
    const bounds = item => item.resolved?.bounds
        || { minX: item.x, maxX: item.x, minY: item.y, maxY: item.y };
    for (const [node, contact] of spatialCrossPairs(nodes, contacts, bounds, 1e-7)) {
        if (node.layer !== 'all' && contact.layer !== 'all' && node.layer !== contact.layer) continue;
        const resolved = contact.resolved;
        if (resolved.region ? pointInCopperRegion(node, resolved.region)
            : shapeCopperContains({ ...resolved,
                geometry: { ...resolved.geometry, copperMode: 'add' } }, node)) yield [node, contact];
    }
}

/**
 * Resolve placed nodes and their connected groups for Net validation/adoption.
 * Track connections are node-to-target hits; track/track crossings are never queried.
 * @param {object} app
 * @param {Map<object, Set<string>>} placedNodes
 */
export function collectNodeConnections(app, placedNodes) {
    const clusters = buildBondedClusters(app, true);
    const contacts = _clusterCopperContacts(app, clusters);
    const parent = clusters.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    unionCoincidentClusters(clusters, union);
    const nodes = [];
    const seeds = [];
    clusters.forEach((cluster, index) => {
        if (!cluster.track) return;
        const { track } = cluster;
        const ids = placedNodes.get(track) || cluster.nodeIds;
        if (placedNodes.has(track) && [...ids].some(id => cluster.nodeIds.has(id))) seeds.push(index);
        const seen = new Set();
        for (const edgeId of cluster.edgeIds) {
            const edge = track.edges.get(edgeId), layer = track.getEdgeLayer(edgeId);
            for (const id of [edge.from, edge.to]) {
                const key = `${id}|${layer}`;
                if (!ids.has(id) || seen.has(key)) continue;
                seen.add(key);
                nodes.push({ ...track.nodes.get(id), layer, index, track });
            }
        }
    });
    // Existing nodes target stationary copper; only the placed node can create
    // a new connection to a moving track.
    const targets = contacts.filter(contact => !placedNodes.has(contact.track));
    for (const [node, target] of nodeTargetPairs(nodes, targets)) {
        if (node.track === target.track) continue;
        const fill = target.shape?.type === 'fill' ? target.shape : null;
        if (fill?.net && placedNodes.has(node.track) && fill.net !== node.track.net) continue;
        union(node.index, target.index);
    }
    const roots = new Set(seeds.map(find));
    if (roots.size) {
        const terminals = contacts.filter(contact => !contact.track).map(contact => ({
            ...contact, root: find(contact.index),
        }));
        expandCopperContactRoots(terminals, roots);
    }
    return bondedCopperFromClusters(clusters.filter((_, index) => roots.has(find(index))));
}

function bondedCopperFromClusters(clusters) {
    const tracks = new Set();
    const trackNodes = new Map();
    const vias = new Set();
    const shapes = new Set();
    const padNets = new Set();
    const padKeys = new Set();
    const padNetByKey = new Map();
    for (const c of clusters) {
        if (c.kind === 'track' && c.track) {
            tracks.add(c.track);
            if (!trackNodes.has(c.track)) trackNodes.set(c.track, new Set());
            for (const nodeId of c.nodeIds) trackNodes.get(c.track).add(nodeId);
        }
        else if (c.kind === 'via' && c.via) vias.add(c.via);
        else if (c.kind === 'shape') shapes.add(c.shape);
        else if (c.kind === 'pad') {
            if (c.padNet) padNets.add(c.padNet);
            if (c.padKey) {
                padKeys.add(c.padKey);
                padNetByKey.set(c.padKey, c.padNet || '');
            }
        }
    }
    return { tracks, trackNodes, vias, shapes, padNets, padKeys, padNetByKey };
}
function _projectPointOnSegment(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    if (len2 < 1e-12) return { x: a.x, y: a.y };
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return { x: a.x + abx * t, y: a.y + aby * t };
}

// Retain only the last contact pass, not deleted terminals or an unbounded geometry history.
const terminalContactPasses = new WeakMap();

export function clearTerminalContactPasses(app) {
    terminalContactPasses.delete(app);
}

/** Shared physical geometry for ratlines and bonded-Net traversal. */
export function _clusterCopperContacts(app, clusters) {
    const contacts = [];
    const segments = new Map();
    const model = app.pcbDocument || app;
    const previous = terminalContactPasses.get(app);
    const terminals = new Map();
    clusters.forEach((cluster, index) => {
        const isShape = cluster.kind === 'shape' || !!cluster.copperShape;
        let geometries, terminal;
        if (isShape) geometries = [cluster.geometry || cluster.copperShape];
        else if (cluster.kind === 'via' || cluster.kind === 'pad') {
            const key = cluster.via || cluster.padKey;
            terminal = resolveTerminalCopperContact(cluster,
                previous?.model === model ? previous.terminals.get(key) : undefined);
            terminals.set(key, terminal);
            geometries = [terminal.shape];
        } else {
            if (!segments.has(cluster.track)) segments.set(cluster.track, resolveTrackSegments(cluster.track));
            geometries = segments.get(cluster.track).filter(segment => cluster.edgeIds.has(segment.edgeId))
                .map(copperSegmentShape);
        }
        for (const geometry of geometries) contacts.push({
            index, geometry, track: cluster.track, shape: cluster.shape,
            resolved: terminal ? terminal.resolved
                : geometry.copperSegment ? copperSegmentContact(geometry.copperSegment)
                : resolveTrackContactGeometry(geometry),
            layer: geometry.layer || cluster.layer,
        });
    });
    terminalContactPasses.set(app, { model, terminals });
    return contacts;
}

/** Spatially join vias to physically-overlapping stroked Track segments. */
function _unionViaTrackOverlaps(clusters, union, requireSameNet) {
    const cellSize = 2;
    const cells = new Map();
    const cellKey = (x, y) => `${x},${y}`;

    for (let clusterIndex = 0; clusterIndex < clusters.length; clusterIndex++) {
        const cluster = clusters[clusterIndex];
        if (!cluster.segments?.length) continue;
        for (const segment of cluster.segments) {
            const record = { clusterIndex, segment };
            const minX = Math.floor((Math.min(segment.a.x, segment.b.x) - segment.radius) / cellSize);
            const maxX = Math.floor((Math.max(segment.a.x, segment.b.x) + segment.radius) / cellSize);
            const minY = Math.floor((Math.min(segment.a.y, segment.b.y) - segment.radius) / cellSize);
            const maxY = Math.floor((Math.max(segment.a.y, segment.b.y) + segment.radius) / cellSize);
            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) {
                    const key = cellKey(x, y);
                    if (!cells.has(key)) cells.set(key, []);
                    cells.get(key).push(record);
                }
            }
        }
    }

    for (let viaIndex = 0; viaIndex < clusters.length; viaIndex++) {
        const via = clusters[viaIndex];
        if (!Number.isFinite(via.viaRadius)) continue;
        const centre = via.points[0];
        const minX = Math.floor((centre.x - via.viaRadius) / cellSize);
        const maxX = Math.floor((centre.x + via.viaRadius) / cellSize);
        const minY = Math.floor((centre.y - via.viaRadius) / cellSize);
        const maxY = Math.floor((centre.y + via.viaRadius) / cellSize);
        const candidates = new Set();
        for (let x = minX; x <= maxX; x++) {
            for (let y = minY; y <= maxY; y++) {
                for (const record of cells.get(cellKey(x, y)) || []) candidates.add(record);
            }
        }
        const bondedClusters = new Set();
        for (const record of candidates) {
            const trackIndex = record.clusterIndex;
            if (bondedClusters.has(trackIndex)) continue;
            const track = clusters[trackIndex];
            if (requireSameNet && via.net !== track.net) continue;
            const nearest = _projectPointOnSegment(centre, record.segment.a, record.segment.b);
            const dx = centre.x - nearest.x;
            const dy = centre.y - nearest.y;
            const reach = via.viaRadius + record.segment.radius;
            if (dx * dx + dy * dy <= reach * reach + 1e-12) {
                union(viaIndex, trackIndex);
                bondedClusters.add(trackIndex);
            }
        }
    }
}
export function bondedExclusion(app, seedTrack, terminalSeed = null) {
    if (!seedTrack && !terminalSeed) return null;
    const { tracks, trackNodes, vias, padKeys } = collectBondedCopper(app, seedTrack ? { track: seedTrack } : terminalSeed);
    const ratlinePointKeys = new Set();
    for (const track of tracks) {
        for (const id of trackNodes.get(track) || []) {
            ratlinePointKeys.add(ratlinePointKey(track.nodes.get(id)));
        }
    }
    for (const via of vias) ratlinePointKeys.add(ratlinePointKey(via));
    if (padKeys.size) {
        for (const pad of resolveCopperPads(app)) {
            if (padKeys.has(`${pad.componentId}|${pad.padId}`)) ratlinePointKeys.add(ratlinePointKey(pad));
        }
    }
    return { excludeTracks: tracks, excludeVias: vias, excludePadKeys: padKeys, ratlinePointKeys };
}


