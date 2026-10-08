/**
 * What dropping dragged copper does: a dropped node joins the track node or via it lands
 * on, copper that now touches another net's copper adopts or refuses the net, and the
 * gesture's changes become one undoable command (trackPointerCommands). reconcileCopperRegion
 * re-derives the nets of copper a change touched.
 */
import { collectNodeConnections } from './track-connections.js';
import { showBondedNetConflict } from './track-commit.js';
import { MoveVertexCommand, CompoundCommand, ModifyTrackGraphCommand, RemoveTrackCommand, AddViaCommand, AddTrackCommand, ModifyTrackCommand, ModifyViaCommand, canonicalTrack } from './track-commands.js';
import { Via } from '../../shapes/via.js';
import { Track } from '../../shapes/track.js';
import { formatNumberInputValue } from '../../core/number-inputs.js';
import { ModifyPadCommand } from './pad-commands.js';
import { captureBoardShapeState } from '../../core/pcb-board-shapes.js';
import { ModifyBoardShapeCommand } from './shape-commands.js';
import { ModifyFillCommand } from './copper-fill-commands.js';
import { collapseCollinearTrackNodes, showTrackViaNetConflict } from './track-edits.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {ReturnType<import('../../core/PcbDesignSettings.js').PcbDesignSettings['getRoutingParams']>} RoutingParams */
/** @typedef {{track: Track, nodeId: string}} TrackNodeRef */
/** @typedef {import('./track-drag.js').VertexDrag} VertexDrag */

/** World-space tolerance for treating two dropped nodes as coincident. */
export const NODE_MERGE_EPS = 1e-3;

/**
 * Find a node (on any track) coincident with `(x, y)`, other than the
 * dragged node itself. Returns `{track, nodeId}` or null.
 */
/**
 * A locked track is never a join target: joining would rewrite or delete it.
 * @param {PcbEditor} app
 * @param {Track} track
 */
export const lockedJoinTarget = (app, track) => !!canonicalTrack(app, track)?.locked;

/** @param {PcbEditor} app @param {Track} dragTrack @param {string} dragNodeId @param {number} x @param {number} y */
function _findCoincidentNode(app, dragTrack, dragNodeId, x, y) {
    for (const t of (app.tracks || [])) {
        if (t !== dragTrack && lockedJoinTarget(app, t)) continue;
        for (const [nid, p] of t.nodes) {
            if (t === dragTrack && nid === dragNodeId) continue;
            if (Math.abs(p.x - x) < NODE_MERGE_EPS && Math.abs(p.y - y) < NODE_MERGE_EPS) {
                return { track: t, nodeId: nid };
            }
        }
    }
    return null;
}

/** Set of copper layers of the edges incident to `nodeId` on `track`. */
/** @param {Track} track @param {string} nodeId */
function _incidentLayers(track, nodeId) {
    const layers = new Set();
    for (const [eid, e] of track.edges) {
        if (e.from === nodeId || e.to === nodeId) {
            layers.add(track.getEdgeLayer(eid));
        }
    }
    return layers;
}

/**
 * Find an existing track node coincident with `(x, y)` that the drawn
 * geometry may fuse into: same net (or one side blank) and carrying an
 * edge on `layer`. Tracks in `exclude` (the freshly drawn ones, not yet
 * committed) are skipped.
 *
 * @param {PcbEditor} app
 * @param {number} x
 * @param {number} y
 * @param {string} net
 * @param {string} layer
 * @param {Iterable<Track>|Set<Track>|null|undefined} exclude
 * @returns {TrackNodeRef|null}
 */
function _findExistingMergeNode(app, x, y, net, layer, exclude) {
    const excludeSet = exclude instanceof Set ? exclude : new Set(exclude || []);
    for (const t of (app.tracks || [])) {
        if (excludeSet.has(t) || lockedJoinTarget(app, t)) continue;
        const otherNet = t.net || '';
        if (net && otherNet && net !== otherNet) continue; // net conflict
        for (const [nid, p] of t.nodes) {
            if (Math.abs(p.x - x) >= NODE_MERGE_EPS || Math.abs(p.y - y) >= NODE_MERGE_EPS) continue;
            // Same copper layer required so we don't silently fuse what
            // should be a via transition.
            if (!_incidentLayers(t, nid).has(layer)) continue;
            return { track: t, nodeId: nid };
        }
    }
    return null;
}

/** @param {any} bonded @param {any[]} [shapes] */
function _bondedNets(bonded, shapes = bonded.shapes) {
    return new Set([...bonded.tracks, ...bonded.vias, ...shapes].map(object => object.net || '')
        .concat([...bonded.padNets]).filter(Boolean));
}

/** @param {PcbEditor} app @param {any} bonded @param {string} net @param {any[]} [shapes] @param {boolean} [includeTracks] */
function _buildCopperNetCommands(app, bonded, net, shapes = bonded.shapes, includeTracks = true) {
    /** @type {any[]} */
    const commands = [];
    if (!net) return commands;
    if (includeTracks) {
        for (const track of bonded.tracks) {
            if (track.net) continue;
            const nodes = bonded.trackNodes.get(track);
            if (nodes.size === track.nodes.size) {
                commands.push(new ModifyTrackCommand(app, track, { net: track.net }, { net }));
            } else {
                const before = track.captureState();
                const after = track.extractSubgraph(nodes).captureState();
                after.net = net;
                commands.push(new ModifyTrackGraphCommand(app, track, before, after));
                for (const component of track.connectedComponents()) {
                    if (![...component].some(node => nodes.has(node))) {
                        commands.push(new AddTrackCommand(app, track.extractSubgraph(component)));
                    }
                }
            }
        }
    }
    for (const via of bonded.vias) {
        if (!via.net) commands.push(new ModifyViaCommand(app, via, { net: via.net }, { net }));
    }
    for (const pad of app.pads || []) {
        if (pad.net || !bonded.padKeys.has(`null|${pad.id}`)) continue;
        const before = pad.captureState();
        commands.push(new ModifyPadCommand(app, pad, before, { ...before, net }));
    }
    for (const shape of shapes) {
        if (shape.net) continue;
        if (shape.type === 'fill') {
            const before = shape.captureState();
            commands.push(new ModifyFillCommand(app, shape, before, { ...before, net }));
        } else {
            const before = captureBoardShapeState(shape);
            commands.push(new ModifyBoardShapeCommand(app, shape, before, { ...before, net }));
        }
    }
    return commands;
}

/** Capture Net edits after the move/merge so snapshots reference the final topology. */
class AdoptDroppedCopperNetCommand {
    /** @param {PcbEditor} app @param {any} bonded @param {string} net */
    constructor(app, bonded, net) {
        this.app = app;
        this.bonded = bonded;
        this.net = net;
        this.command = null;
    }
    execute() {
        if (!this.command) {
            // Rebind validated contacts to final topology, without rediscovering
            // crossings or depending on a dropped node that may have been merged.
            const tracks = new Set();
            const trackNodes = new Map();
            for (const [preview, nodes] of this.bonded.trackNodes) {
                const track = /** @type {Track[]} */ (this.app.tracks).find(candidate => candidate.id === preview.id);
                if (!track) continue; // Absorbed tracks are now part of the surviving graph.
                const connected = /** @type {Set<string>[]} */ (track.connectedComponents()).filter(component =>
                    [...component].some(id => nodes.has(id)));
                if (!connected.length) continue;
                tracks.add(track);
                trackNodes.set(track, new Set(connected.flatMap((/** @param {Set<string>} component */ component) => [...component])));
            }
            const vias = new Set();
            for (const preview of this.bonded.vias) {
                const via = /** @type {Via[]} */ (this.app.vias).find(candidate => candidate.id === preview.id)
                    || /** @type {Via[]} */ (this.app.vias).find(candidate => candidate.x === preview.x && candidate.y === preview.y);
                if (!via) throw new Error('Validated node-drop Via is missing after the geometry command.');
                vias.add(via);
            }
            const bonded = { ...this.bonded, tracks, trackNodes, vias };
            this.command = new CompoundCommand(_buildCopperNetCommands(this.app, bonded, this.net));
        }
        this.command.execute();
    }
    undo() { this.command?.undo(); }
}

/**
 * True if a standalone Via already sits at `(x, y)`.
 * @param {PcbEditor} app
 * @param {number} x
 * @param {number} y
 */
function _hasViaAt(app, x, y) {
    return /** @type {Via[]} */ (app.vias || []).some(
        (v) => Math.abs(v.x - x) < NODE_MERGE_EPS && Math.abs(v.y - y) < NODE_MERGE_EPS);
}

/**
 * Build a standalone Via at `(x, y)` on `net` using the app's routing params.
 * @param {PcbEditor} app
 * @param {number} x
 * @param {number} y
 * @param {string} net
 */
function _makeViaAt(app, x, y, net) {
    const p = /** @type {Partial<RoutingParams>} */ (app.getRoutingParams?.() || {});
    const viaDiameter = p.viaDiameter;
    const viaDrill = p.viaDrill;
    const diameter = typeof viaDiameter === 'number' && Number.isFinite(viaDiameter) && viaDiameter > 0 ? viaDiameter : 0.6;
    const drill = typeof viaDrill === 'number' && Number.isFinite(viaDrill) && viaDrill > 0 ? viaDrill : 0.3;
    return new Via({ x, y, diameter, drill, net: net || '' });
}

/**
 * Re-normalise the whole copper region physically bonded to `seedTrack`
 * into the canonical model and return the minimal command payload to get
 * there. Handles BOTH directions of an edit:
 *
 *  - SPLIT: an edge now jumps layer → the region splits into one
 *    single-layer Track per maximal same-layer connected run, with a
 *    standalone Via added at every position where ≥2 layers now meet.
 *  - MERGE: an edge moved back so a former transition is gone → the two
 *    formerly-separate single-layer Tracks fuse into one and the now
 *    superfluous Via is removed.
 *
 * The region is the set of Tracks reachable from `seedTrack` through
 * coincident node positions (positional bonding — the same premise the
 * ratsnest uses), plus every standalone Via sitting on one of those
 * positions. The region is rebuilt from a single position-keyed multigraph
 * of all its edges: per layer → connected components → one Track each; a
 * via is needed iff a position carries edges of ≥2 distinct layers. Region
 * vias at a still-needed position are KEPT (preserving their diameter/drill);
 * all other region vias are removed as superfluous.
 *
 * A via is required at EVERY layer boundary regardless of copper-ness, so a
 * TOP → SILK → BOTTOM run keeps a via at each boundary.
 *
 * The caller must apply the edge's layer change to `seedTrack` BEFORE calling
 * this (the mutated graph is read here), then restore it to its pre-change
 * state so the returned RemoveTrackCommand captures clean undo.
 *
 * @param {PcbEditor} app
 * @param {import('../../shapes/track.js').Track} seedTrack
 * @returns {{removeTracks: object[], addTracks: object[], removeVias: object[], addVias: object[]}}
 */
export function reconcileCopperRegion(app, seedTrack) {
    const EPS = NODE_MERGE_EPS;
    /** @param {number} x @param {number} y */
    const key = (x, y) => `${Math.round(x / EPS)}|${Math.round(y / EPS)}`;

    // Index every track node by rounded position for fast coincidence lookup.
    const nodeIndex = new Map();   // posKey → [{ track }]
    for (const t of (app.tracks || [])) {
        for (const [, p] of t.nodes) {
            const k = key(p.x, p.y);
            if (!nodeIndex.has(k)) nodeIndex.set(k, []);
            nodeIndex.get(k).push(t);
        }
    }

    // BFS the region of tracks connected through shared positions.
    const regionTracks = new Set([seedTrack]);
    const stack = [seedTrack];
    while (stack.length) {
        const t = stack.pop();
        if (!t) continue;
        for (const [, p] of t.nodes) {
            for (const other of nodeIndex.get(key(p.x, p.y)) || []) {
                if (!regionTracks.has(other)) {
                    regionTracks.add(other);
                    stack.push(other);
                }
            }
        }
    }

    // Positions occupied by region copper, and the region's standalone vias.
    const regionPosSet = new Set();
    for (const t of regionTracks)
        for (const [, p] of t.nodes) regionPosSet.add(key(p.x, p.y));
    const regionVias = /** @type {Via[]} */ (app.vias || []).filter((v) => regionPosSet.has(key(v.x, v.y)));

    // Net for rebuilt copper: first non-empty among region tracks, then vias.
    let net = '';
    for (const t of regionTracks) if (t.net) { net = t.net; break; }
    if (!net) for (const v of regionVias) if (v.net) { net = v.net; break; }

    // Unified position-keyed multigraph of all region edges.
    const uNodes = new Map();      // posKey → { x, y }
    const uEdges = [];             // { a, b, layer, width }
    const padAt = new Map();       // posKey → padConnection
    const radiusAt = new Map();
    for (const t of regionTracks) {
        for (const [nodeId, point] of t.nodes) {
            const position = key(point.x, point.y);
            if (!radiusAt.has(position)) radiusAt.set(position, t.nodeCornerRadius(nodeId));
        }
        for (const [eid, e] of t.edges) {
            const pa = t.nodes.get(e.from), pb = t.nodes.get(e.to);
            const ka = key(pa.x, pa.y), kb = key(pb.x, pb.y);
            if (!uNodes.has(ka)) uNodes.set(ka, { x: pa.x, y: pa.y });
            if (!uNodes.has(kb)) uNodes.set(kb, { x: pb.x, y: pb.y });
            uEdges.push({ a: ka, b: kb, layer: t.getEdgeLayer(eid), width: t.getEdgeWidth(eid), bulge: e.bulge || 0 });
        }
        for (const [nid, conn] of t.padConnections) {
            const p = t.nodes.get(nid);
            if (p) padAt.set(key(p.x, p.y), { ...conn });
        }
    }

    // Per-layer connected components → one fresh single-layer Track each.
    const addTracks = [];
    const layers = new Set(uEdges.map((e) => e.layer));
    for (const layer of layers) {
        const layerEdges = uEdges.filter((e) => e.layer === layer);
        const adj = new Map();     // posKey → [posKey]
        for (const e of layerEdges) {
            if (!adj.has(e.a)) adj.set(e.a, []);
            if (!adj.has(e.b)) adj.set(e.b, []);
            adj.get(e.a).push(e.b);
            adj.get(e.b).push(e.a);
        }
        const seen = new Set();
        for (const startK of adj.keys()) {
            if (seen.has(startK)) continue;
            const compKeys = new Set();
            const st = [startK];
            while (st.length) {
                const k = st.pop();
                if (compKeys.has(k)) continue;
                compKeys.add(k);
                seen.add(k);
                for (const o of adj.get(k) || []) if (!compKeys.has(o)) st.push(o);
            }
            const compWidth = layerEdges.find((e) => compKeys.has(e.a))?.width || seedTrack.width;
            const sub = new Track({ net, width: compWidth, layer, cornerRadius: seedTrack.cornerRadius });
            const kToNid = new Map();
            for (const k of compKeys) {
                const p = uNodes.get(k);
                const nn = sub.addNode(p.x, p.y);
                kToNid.set(k, nn);
                sub.setNodeCornerRadius(nn, radiusAt.get(k) || 0);
                if (padAt.has(k)) sub.padConnections.set(nn, { ...padAt.get(k) });
            }
            for (const e of layerEdges) {
                if (!compKeys.has(e.a)) continue;
                // Carry the per-edge layer and width onto the rebuilt edge so
                // a component with mixed-width segments keeps each width.
                sub.addEdge(kToNid.get(e.a), kToNid.get(e.b), { layer, width: e.width, bulge: e.bulge });
            }
            addTracks.push(sub);
        }
    }

    // Positions where ≥2 distinct layers meet require a via.
    const layersAt = new Map();    // posKey → Set(layer)
    for (const e of uEdges) {
        if (!layersAt.has(e.a)) layersAt.set(e.a, new Set());
        if (!layersAt.has(e.b)) layersAt.set(e.b, new Set());
        layersAt.get(e.a).add(e.layer);
        layersAt.get(e.b).add(e.layer);
    }
    const neededViaKeys = new Set();
    for (const [k, ls] of layersAt) if (ls.size >= 2) neededViaKeys.add(k);

    // Keep region vias still at a needed boundary; remove the rest as
    // superfluous; add vias at needed boundaries not already covered.
    const keptKeys = new Set();
    const removeVias = [];
    for (const v of regionVias) {
        const k = key(v.x, v.y);
        if (neededViaKeys.has(k) && !keptKeys.has(k)) keptKeys.add(k);
        else removeVias.push(v);
    }
    const addVias = [];
    for (const k of neededViaKeys) {
        if (keptKeys.has(k)) continue;
        const p = uNodes.get(k);
        addVias.push(_makeViaAt(app, p.x, p.y, net));
    }

    return { removeTracks: [...regionTracks], addTracks, removeVias, addVias };
}

/** @param {PcbEditor} app @param {VertexDrag} drag */
function _droppedNodeTarget(app, drag) {
    const nd = drag.nodes[0];
    const track = drag.track;
    const n = track.nodes.get(nd.nodeId);
    if (!n) return null;
    // Prefer the node the cursor actually snapped onto during the drag (the
    // yellow target). Coincidence re-detection is a fallback: with the
    // screen-pixel node-snap band, a drop can land visually-on but not
    // bit-exactly on the target, so coincidence alone would miss the merge.
    if (drag.snapTargetNode
        && !(drag.snapTargetNode.track === track && drag.snapTargetNode.nodeId === nd.nodeId)
        && app.tracks?.includes(drag.snapTargetNode.track)
        && !lockedJoinTarget(app, drag.snapTargetNode.track)
        && drag.snapTargetNode.track.nodes?.has(drag.snapTargetNode.nodeId)) {
        return drag.snapTargetNode;
    }
    return _findCoincidentNode(app, track, nd.nodeId, n.x, n.y);
}

/**
 * Same-layer drops fuse nodes; cross-layer drops keep distinct coincident
 * nodes joined by a Via, preserving the single-layer graph-node invariant.
 * Builds canonical commands from the detached graph, or null for a plain move.
 * @param {PcbEditor} app
 * @param {PcbEditor} view
 * @param {VertexDrag} drag
 */
function droppedNodeCommands(app, view, drag) {
    const nd = drag.nodes[0];
    const track = drag.track;
    const n = track.nodes.get(nd.nodeId);
    if (!n) return null;
    let dropX = n.x, dropY = n.y;
    const target = _droppedNodeTarget(view, drag);
    if (!target) return null;
    // Pull the dragged node exactly onto the target so the fused geometry is
    // bit-coincident regardless of the release position.
    const tp = target.track.nodes.get(target.nodeId);
    if (tp) { dropX = tp.x; dropY = tp.y; n.x = tp.x; n.y = tp.y; }

    const netA = track.net || '';
    const netB = target.track.net || '';
    if (netA && netB && netA !== netB) {
        app.alert(`Cannot merge nodes on different nets: "${netA}" and "${netB}".`, { title: 'Net Conflict' });
        return [];
    }

    // Does the merge span copper layers? The dragged node and target node
    // each carry the layer(s) of their incident edges; if they share none,
    // this is a layer transition (→ keep nodes distinct + bond with a via).
    const dragLayers = _incidentLayers(track, nd.nodeId);
    const targetLayers = _incidentLayers(target.track, target.nodeId);
    let shareLayer = false;
    for (const l of dragLayers) if (targetLayers.has(l)) { shareLayer = true; break; }
    const crossLayer = dragLayers.size > 0 && targetLayers.size > 0 && !shareLayer;
    const needsVia = crossLayer && !_hasViaAt(app, dropX, dropY);
    const mergedNet = netA || netB;

    const cmds = [];
    if (crossLayer) {
        // CROSS-LAYER: do NOT fuse the nodes. Place the dragged node exactly
        // on the target coordinate so the two single-layer nodes are
        // coincident, then bond them with a via. Each node keeps only its
        // own layer's edges, so a later segment drag moves only that layer.
        const dn = track.nodes.get(nd.nodeId);
        if (dn) { dn.x = dropX; dn.y = dropY; }
        if (!track.net && netB) track.net = netB;
        const after = track.captureState();
        cmds.push(new ModifyTrackGraphCommand(app, drag.original, drag.before, after));
        if (needsVia) {
            cmds.push(new AddViaCommand(app, _makeViaAt(app, dropX, dropY, mergedNet)));
        }
    } else if (target.track === track) {
        // Same track, same layer: collapse the two nodes (keep the target).
        track.mergeNodes(target.nodeId, nd.nodeId);
        const after = track.captureState();
        cmds.push(new ModifyTrackGraphCommand(app, drag.original, drag.before, after));
    } else {
        // Cross-track, same layer: pull the other track's graph in, fuse the
        // shared node into one continuous track, inherit its net if we had
        // none, then drop the now-empty other track.
        const remap = track.absorb(target.track);
        const absorbedNid = remap.get(target.nodeId);
        const dn = track.nodes.get(nd.nodeId);
        if (dn) { dn.x = dropX; dn.y = dropY; }
        if (absorbedNid) track.mergeNodes(nd.nodeId, absorbedNid);
        if (!track.net && netB) track.net = netB;
        const after = track.captureState();
        cmds.push(new RemoveTrackCommand(app, canonicalTrack(app, target.track)));
        cmds.push(new ModifyTrackGraphCommand(app, drag.original, drag.before, after));
    }
    return cmds;
}

/** @param {PcbEditor} app @param {PcbEditor} view @param {VertexDrag} drag */
export function trackPointerCommands(app, view, drag) {
    if (drag.mode === 'bulge') {
        const edge = drag.track.edges.get(drag.edgeId);
        if (Number(formatNumberInputValue(edge.bulge)) === 0) edge.bulge = 0;
        const after = drag.track.captureState();
        return JSON.stringify(after) === JSON.stringify(drag.before) ? []
            : [new ModifyTrackGraphCommand(app, drag.original, drag.before, after)];
    }
    const moved = /** @type {any[]} */ (drag.nodes).some(nd => {
        const n = drag.track.nodes.get(nd.nodeId);
        return n && (Math.abs(n.x - nd.startX) > 1e-6 || Math.abs(n.y - nd.startY) > 1e-6);
    });
    if (!moved && (drag.topology || !drag.snapTargetNode)) return [];
    let netCommand = null;
    if (drag.mode === 'node' && drag.nodes.length === 1 && (moved || drag.snapTargetNode)) {
        const nodeId = drag.nodes[0].nodeId;
        const target = _droppedNodeTarget(view, drag);
        let prospectiveApp = /** @type {PcbEditor} */ (/** @type {unknown} */ (view));
        if (target && !drag.topology) {
            const fromLayers = _incidentLayers(drag.track, nodeId);
            const toLayers = _incidentLayers(target.track, target.nodeId);
            const point = target.track.nodes.get(target.nodeId);
            if (fromLayers.size && toLayers.size && ![...fromLayers].some((/** @param {string} layer */ layer) => toLayers.has(layer))
                && !_hasViaAt(app, point.x, point.y)) {
                // Validate the connection the merge will create across layers,
                // including the transition Via that is not on the board yet.
                prospectiveApp = /** @type {PcbEditor} */ (/** @type {unknown} */ ({ ...view,
                    vias: [...(app.vias || []), _makeViaAt(app, point.x, point.y, '')] }));
            }
        }
        const bonded = collectNodeConnections(prospectiveApp,
            new Map([[drag.track, new Set([nodeId])]]));
        const nets = _bondedNets(bonded);
        if (nets.size > 1) {
            const terminalNet = drag.snapTargetVia?.net;
            if (drag.track.net && terminalNet && drag.track.net !== terminalNet) {
                showTrackViaNetConflict(app, drag.track.net, terminalNet, drag.snapTargetKind);
            } else showBondedNetConflict(app, nets);
            return [];
        }
        const net = [...nets][0];
        if (net) netCommand = new AdoptDroppedCopperNetCommand(app, bonded, net);
    }
    /** @param {any[]} commands */
    const withNet = commands => netCommand && commands.length ? [...commands, netCommand] : commands;
    if (drag.topology) {
        if (drag.mode !== 'move') collapseCollinearTrackNodes(app, drag.track);
        if (drag.splitNodeId) {
            const components = drag.track.connectedComponents();
            if (components.length > 1) {
                const movingNodes = /** @type {Set<string>[]} */ (components).find(nodes => nodes.has(drag.splitNodeId));
                const movingPart = drag.track.extractSubgraph(movingNodes);
                movingPart.sourceBoardShape = drag.track.sourceBoardShape;
                const remainder = /** @type {Set<string>[]} */ (components).filter(nodes => nodes !== movingNodes)
                    .map(nodes => drag.track.extractSubgraph(nodes));
                const after = movingPart.captureState();
                return withNet([
                    new ModifyTrackGraphCommand(app, drag.original, drag.before, after),
                    ...remainder.map((/** @param {Track} track */ track) => new AddTrackCommand(app, track)),
                ]);
            }
        }
        const after = drag.track.captureState();
        return withNet([new ModifyTrackGraphCommand(app, drag.original, drag.before, after)]);
    }

    // Single-node drop onto another node → merge into one (schematic-style).
    // A net conflict (two different non-empty nets) is rejected with a dialog.
    // The merge also fires when the node didn't net-move but snapped onto
    // another track's node during the drag (`snapTargetNode`): two endpoints
    // that are already coincident (the visible "join") produce zero net
    // displacement when one is dragged onto the other, so a `moved`-only gate
    // would never fuse them.
    if (drag.mode === 'node' && drag.nodes.length === 1 && (moved || drag.snapTargetNode)) {
        const merged = droppedNodeCommands(app, view, drag);
        if (merged) return withNet(merged);
    }

    /** @type {any[]} */
    const moves = [];
    for (const nd of drag.nodes) {
        const n = drag.track.nodes.get(nd.nodeId);
        if (!n) continue;
        if (Math.abs(n.x - nd.startX) > 1e-6 || Math.abs(n.y - nd.startY) > 1e-6) {
            moves.push({ nodeId: nd.nodeId, fromX: nd.startX, fromY: nd.startY, toX: n.x, toY: n.y });
        }
    }
    if (!moves.length) return [];
    const collapsed = collapseCollinearTrackNodes(app, drag.track);
    const after = drag.track.captureState();
    if (collapsed || JSON.stringify(after.padConnections) !== JSON.stringify(drag.before.padConnections)) {
        return withNet([new ModifyTrackGraphCommand(app, drag.original, drag.before, after)]);
    }
    const moveCmds = moves.map((m) =>
        new MoveVertexCommand(app, drag.original, m.nodeId, m.fromX, m.fromY, m.toX, m.toY));
    return withNet(moveCmds);
}
