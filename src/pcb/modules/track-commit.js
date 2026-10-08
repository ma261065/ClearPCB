import { collectNodeConnections, copperBoardWith } from './track-connections.js';
import { AddTrackCommand, AddViaCommand, RemoveTrackCommand, ModifyTrackCommand, ModifyTrackGraphCommand, ModifyViaCommand, CompoundCommand, canonicalTrack } from './track-commands.js';
import { ModifyPadCommand } from './pad-commands.js';
import { ModifyFillCommand } from './copper-fill-commands.js';
import { ModifyBoardShapeCommand } from './shape-commands.js';
import { captureBoardShapeState } from '../../core/pcb-board-shapes.js';
import { Track } from '../../shapes/track.js';
import { viaAtPoint } from './track-edits.js';
import { NODE_MERGE_EPS } from './track-drop.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../shapes/via.js').Via} Via */
/** @typedef {import('../../core/CommandHistory.js').HistoryCommand} HistoryCommand */
/** @typedef {import('../../core/netlist.js').NetShape} NetShape */
/** @typedef {import('./track-connections.js').BondedCopper} BondedCopper */


/**
 * Dissolve redundant collinear waypoints from a track: any degree-2 node
 * whose two incident edges share a copper layer and whose neighbours are
 * collinear through it is removed, joining the neighbours with a single
 * edge of that layer. Nodes anchored to a pad, or sitting on a via (a
 * layer transition / stitch point), are preserved. Mutates `track` in
 * place and returns whether anything was removed — callers fold the
 * result into their own undo snapshot.
 *
 * @param {PcbEditor} app
 * @param {Track} track
 * @returns {boolean} true if at least one node was dissolved.
 */
export function collapseCollinearTrackNodes(app, track) {
    if (!track?.nodes) return false;
    let removedAny = false;
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 10000) {
        changed = false;
        for (const [nid, pos] of track.nodes) {
            if (track.degree(nid) !== 2) continue;
            if (track.padConnections.has(nid)) continue;   // pad anchor
            if (viaAtPoint(app, pos.x, pos.y)) continue;  // via / layer change
            const inc = track.incidentEdges(nid);
            if (inc.length !== 2) continue;
            if (inc.some(({ edgeId }) => track.getEdgeAttr(edgeId, 'bulge'))) continue;
            const l1 = track.getEdgeLayer(inc[0].edgeId);
            const l2 = track.getEdgeLayer(inc[1].edgeId);
            if (l1 !== l2) continue;                        // layer change → keep
            const w1 = track.getEdgeWidth(inc[0].edgeId);
            const w2 = track.getEdgeWidth(inc[1].edgeId);
            if (w1 !== w2) continue;                         // width change → keep
            const p1 = track.nodes.get(inc[0].otherNode);
            const p2 = track.nodes.get(inc[1].otherNode);
            if (!p1 || !p2) continue;
            if (!track._areCollinear(p1, pos, p2)) continue;
            // Drop the node and its two edges, then bridge the neighbours,
            // carrying the (shared) layer/width onto the new edge.
            const bridgeAttrs = track._cloneEdge(track.edges.get(inc[0].edgeId));
            track.removeEdge(inc[0].edgeId);
            track.removeEdge(inc[1].edgeId);
            track.removeNode(nid);
            if (!track.hasEdgeBetween(inc[0].otherNode, inc[1].otherNode)) {
                track.addEdge(inc[0].otherNode, inc[1].otherNode, bridgeAttrs);
            }
            removedAny = true;
            changed = true;
            break;
        }
    }
    return removedAny;
}

/**
 * A locked track is never a join target: joining would rewrite or delete it.
 * @param {PcbEditor} app
 * @param {Track} track
 */
const lockedJoinTarget = (app, track) => !!canonicalTrack(app, track)?.locked;

/** Set of copper layers of the edges incident to `nodeId` on `track`. */
/**
 * @param {Track} track
 * @param {string} nodeId
 */
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
 * @param {Iterable<Track>} exclude
 * @returns {{track:Track, nodeId:string}|null}
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

/**
 * @param {BondedCopper} bonded
 * @param {Iterable<NetShape>} [shapes]
 */
function _bondedNets(bonded, shapes = bonded.shapes) {
    return new Set([...bonded.tracks, ...bonded.vias, ...shapes].map(object => object.net || '')
        .concat([...bonded.padNets]).filter(Boolean));
}

/**
 * Say that a connection would join copper on different nets.
 * @param {PcbEditor} app
 * @param {Iterable<string>} nets
 */
export function showBondedNetConflict(app, nets) {
    app.alert(`Cannot connect different nets: ${[...nets].map(net => `"${net}"`).join(', ')}.`, { title: 'Net Conflict' });
}

/**
 * @param {PcbEditor} app
 * @param {BondedCopper} bonded
 * @param {string} net
 * @param {Iterable<NetShape>} [shapes]
 * @param {boolean} [includeTracks]
 * @returns {HistoryCommand[]}
 */
function _buildCopperNetCommands(app, bonded, net, shapes = bonded.shapes, includeTracks = true) {
    /** @type {HistoryCommand[]} */
    const commands = [];
    if (!net) return commands;
    if (includeTracks) {
        for (const track of bonded.tracks) {
            if (track.net) continue;
            const nodes = bonded.trackNodes.get(track);
            if (!nodes) continue;
            if (nodes.size === track.nodes.size) {
                commands.push(new ModifyTrackCommand(app, track, { net: track.net }, { net }));
            } else {
                const before = track.captureState();
                const after = track.extractSubgraph(nodes).captureState();
                after.net = net;
                commands.push(new ModifyTrackGraphCommand(app, track, before, after));
                for (const component of track.connectedComponents()) {
                    if (![...component].some(node => nodes.has(node))) {
                        commands.push(new AddTrackCommand(app, /** @type {Track} */ (track.extractSubgraph(component))));
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
            const fill = /** @type {import('../../shapes/copper-fill.js').CopperFill} */ (shape);
            const before = fill.captureState();
            commands.push(new ModifyFillCommand(app, fill, before, { ...before, net }));
        } else {
            const boardShape = /** @type {import('./board-shapes.js').BoardShape} */ (shape);
            const before = captureBoardShapeState(boardShape);
            commands.push(new ModifyBoardShapeCommand(app, boardShape, before, { ...before, net }));
        }
    }
    return commands;
}
/**
 * Commit one or more freshly drawn Track objects plus any
 * layer-transition Vias as a single undo step. A draw that toggled
 * copper layers mid-route produces several single-layer Tracks joined
 * by vias; grouping them and connected-copper Net adoption keeps undo/redo atomic.
 * @param {PcbEditor} app
 * @param {Track|Track[]} tracks
 * @param {Via[]} [vias]
 * @param {NetShape[]} [destinationShapes]
 */
export function commitDrawnTracks(app, tracks, vias = [], destinationShapes = []) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    // Fuse any drawn endpoint that lands on an existing same-net/
    // same-layer track node into that track, so joined tracks render
    // as one continuous polyline instead of two coincident objects.
    const command = buildDrawnTrackCommands(app, list, vias, destinationShapes);
    if (command === false) return false;
    if (command) app.history.execute(command);
    return true;
}

/**
 * Build the history command(s) that commit freshly drawn tracks/vias,
 * fusing any drawn endpoint that lands on an existing track's node (same
 * net, same copper layer) into that existing track. Joined tracks become
 * one continuous polyline instead of two coincident Track objects (which
 * render with a doubled round end-cap at the join).
 *
 * Cross-layer coincidences are deliberately NOT fused here — those remain
 * distinct single-layer nodes bonded by a via (the via/transition model).
 *
 * @param {PcbEditor} app
 * @param {Track|Track[]} newTracks freshly built (uncommitted) tracks
 * @param {Via[]} [newVias] standalone vias produced alongside the draw
 * @param {NetShape[]} [destinationShapes] Explicit destination copper contacts.
 * @returns {HistoryCommand|null|false} A command, null when empty, or false on a Net conflict.
 */
export function buildDrawnTrackCommands(app, newTracks, newVias = [], destinationShapes = []) {
    const drawn = Array.isArray(newTracks) ? newTracks.slice() : [newTracks];
    const vias = newVias || [];
    const drawnSet = new Set(drawn);
    const bonded = collectNodeConnections(copperBoardWith(app, {
        tracks: [...(app.tracks || []), ...drawn], vias: [...(app.vias || []), ...vias],
    }), new Map(drawn.map(track => [track, new Set(track.nodes.keys())])));
    const shapes = new Set([...bonded.shapes, ...destinationShapes]);
    const nets = _bondedNets(bonded, shapes);
    if (nets.size > 1) {
        showBondedNetConflict(app, nets);
        return false;
    }
    const net = [...nets][0] || '';

    /** @type {Map<Track, any>} */
    const beforeStates = new Map();      // existing track -> pre-merge snapshot
    const removedExisting = new Set();   // existing tracks emptied by absorb
    /** @type {Track[]} */
    const independentAdds = [];          // drawn tracks with no existing join
    /** @param {Track} t */
    const ensureBefore = (t) => { if (!beforeStates.has(t)) beforeStates.set(t, t.captureState()); };
    if (net) {
        for (const track of bonded.tracks) {
            if (track.net || drawnSet.has(track)) continue;
            ensureBefore(track);
            const nodes = bonded.trackNodes.get(track);
            if (!nodes) continue;
            if (nodes.size < track.nodes.size) {
                for (const component of track.connectedComponents()) {
                    if (![...component].some(node => nodes.has(node))) independentAdds.push(track.extractSubgraph(component));
                }
                track.applyState(track.extractSubgraph(nodes).captureState());
            }
            track.net = net;
        }
        for (const track of drawn) track.net = net;
        for (const via of vias) via.net = net;
    }

    for (const nt of drawn) {
        // Endpoints (degree-1 nodes) of the drawn track, with their layer.
        /** @type {Array<{nodeId: string, target: {track: Track, nodeId: string}}>} */
        const conns = [];
        for (const [nid] of nt.nodes) {
            const inc = nt.incidentEdges(nid);
            if (inc.length !== 1) continue;
            const layer = nt.getEdgeLayer(inc[0].edgeId) || nt.layer;
            const p = nt.nodes.get(nid);
            const target = _findExistingMergeNode(app, p.x, p.y, nt.net, layer, drawnSet);
            if (target) conns.push({ nodeId: nid, target });
        }
        if (conns.length === 0) { independentAdds.push(nt); continue; }

        // Fuse the drawn track into the first existing track it touches.
        const primary = conns[0].target.track;
        ensureBefore(primary);
        const remapNt = primary.absorb(nt);
        if (!primary.net && nt.net) primary.net = nt.net;

        for (const { nodeId, target } of conns) {
            let targetNodeId = target.nodeId;
            if (target.track !== primary) {
                // Drawn track bridges two existing tracks: pull the second
                // one into primary as well, then drop it.
                ensureBefore(target.track);
                const remapEx = primary.absorb(target.track);
                if (!primary.net && target.track.net) primary.net = target.track.net;
                removedExisting.add(target.track);
                drawnSet.add(target.track);
                targetNodeId = remapEx.get(target.nodeId) ?? targetNodeId;
            }
            const drawnNodeId = remapNt.get(nodeId);
            if (drawnNodeId && targetNodeId) primary.mergeNodes(targetNodeId, drawnNodeId);
        }
        // Dissolve any now-redundant collinear waypoint at the join.
        collapseCollinearTrackNodes(app, primary);
    }

    /** @type {HistoryCommand[]} */
    const cmds = [];
    for (const [existing, before] of beforeStates) {
        const after = existing.captureState();
        existing.applyState(before);
        if (removedExisting.has(existing)) {
            cmds.push(new RemoveTrackCommand(app, existing));
        } else {
            cmds.push(new ModifyTrackGraphCommand(app, existing, before, after));
        }
    }
    for (const nt of independentAdds) cmds.push(new AddTrackCommand(app, nt));
    for (const v of vias) cmds.push(new AddViaCommand(app, v));
    cmds.push(..._buildCopperNetCommands(app, bonded, net, shapes, false));

    if (cmds.length === 0) return null;
    return cmds.length === 1 ? cmds[0] : new CompoundCommand(cmds);
}
