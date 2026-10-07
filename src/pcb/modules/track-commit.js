import { showAlert } from '../../shared/ui/modal.js';
import { collectNodeConnections } from './track-connections.js';
import { AddTrackCommand, AddViaCommand, RemoveTrackCommand, ModifyTrackCommand, ModifyTrackGraphCommand, ModifyViaCommand, CompoundCommand, canonicalTrack } from './track-commands.js';
import { ModifyPadCommand } from './pad-commands.js';
import { ModifyFillCommand } from './copper-fill-commands.js';
import { ModifyBoardShapeCommand } from './shape-commands.js';
import { captureBoardShapeState } from './board-shapes.js';
import { Track } from '../../shapes/track.js';

const VIA_NODE_EPS = 1e-4;
const NODE_MERGE_EPS = 1e-3;
/** True if any standalone Via sits on `(x, y)`. */
function _viaAtPoint(app, x, y) {
    for (const via of (app.vias || [])) {
        if (Math.abs(via.x - x) < VIA_NODE_EPS && Math.abs(via.y - y) < VIA_NODE_EPS) return true;
    }
    return false;
}

/**
 * Dissolve redundant collinear waypoints from a track: any degree-2 node
 * whose two incident edges share a copper layer and whose neighbours are
 * collinear through it is removed, joining the neighbours with a single
 * edge of that layer. Nodes anchored to a pad, or sitting on a via (a
 * layer transition / stitch point), are preserved. Mutates `track` in
 * place and returns whether anything was removed — callers fold the
 * result into their own undo snapshot.
 *
 * @param {object} app
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
            if (_viaAtPoint(app, pos.x, pos.y)) continue;  // via / layer change
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

/** A locked track is never a join target: joining would rewrite or delete it. */
const lockedJoinTarget = (app, track) => !!canonicalTrack(app, track)?.locked;

/** Set of copper layers of the edges incident to `nodeId` on `track`. */
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
 * @returns {{track:object, nodeId:string}|null}
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

function _bondedNets(bonded, shapes = bonded.shapes) {
    return new Set([...bonded.tracks, ...bonded.vias, ...shapes].map(object => object.net || '')
        .concat([...bonded.padNets]).filter(Boolean));
}

function _showBondedNetConflict(app, nets) {
    const message = `Cannot connect different nets: ${[...nets].map(net => `"${net}"`).join(', ')}.`;
    if (app.alert) app.alert(message);
    else showAlert(message, { title: 'Net Conflict' });
}

function _buildCopperNetCommands(app, bonded, net, shapes = bonded.shapes, includeTracks = true) {
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
/**
 * Commit one or more freshly drawn Track objects plus any
 * layer-transition Vias as a single undo step. A draw that toggled
 * copper layers mid-route produces several single-layer Tracks joined
 * by vias; grouping them and connected-copper Net adoption keeps undo/redo atomic.
 * @param {object} app
 * @param {object[]} tracks
 * @param {object[]} [vias]
 * @param {object[]} [destinationShapes]
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
 * @param {object} app
 * @param {object|object[]} newTracks freshly built (uncommitted) tracks
 * @param {object[]} [newVias] standalone vias produced alongside the draw
 * @param {object[]} [destinationShapes] Explicit destination copper contacts.
 * @returns {object|null|false} A command, null when empty, or false on a Net conflict.
 */
export function buildDrawnTrackCommands(app, newTracks, newVias = [], destinationShapes = []) {
    const drawn = Array.isArray(newTracks) ? newTracks.slice() : [newTracks];
    const vias = newVias || [];
    const drawnSet = new Set(drawn);
    const bonded = collectNodeConnections({
        ...app, tracks: [...(app.tracks || []), ...drawn], vias: [...(app.vias || []), ...vias],
        pads: app.pads, boardShapes: app.boardShapes,
    }, new Map(drawn.map(track => [track, new Set(track.nodes.keys())])));
    const shapes = new Set([...bonded.shapes, ...destinationShapes]);
    const nets = _bondedNets(bonded, shapes);
    if (nets.size > 1) {
        _showBondedNetConflict(app, nets);
        return false;
    }
    const net = [...nets][0] || '';

    const beforeStates = new Map();      // existing track -> pre-merge snapshot
    const removedExisting = new Set();   // existing tracks emptied by absorb
    const independentAdds = [];          // drawn tracks with no existing join
    const ensureBefore = (t) => { if (!beforeStates.has(t)) beforeStates.set(t, t.captureState()); };
    if (net) {
        for (const track of bonded.tracks) {
            if (track.net || drawnSet.has(track)) continue;
            ensureBefore(track);
            const nodes = bonded.trackNodes.get(track);
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
