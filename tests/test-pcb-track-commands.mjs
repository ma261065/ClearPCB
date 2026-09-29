import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { Track } from '../src/shapes/track.js';
import { Via } from '../src/shapes/via.js';
import { AddTrackCommand, RemoveTrackCommand, ModifyTrackCommand, MoveVertexCommand,
    ModifyTrackGraphCommand } from '../src/core/pcb-track-commands.js';

assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
const model = new PcbDocument();
const other = new PcbDocument();
const tracks = model.tracks, vias = model.vias;
const untouched = new Track({ points: [{ x: 50, y: 50 }, { x: 60, y: 50 }] });
const untouchedVia = new Via({ x: 50, y: 50 });
tracks.push(untouched);
vias.push(untouchedVia);
const track = new Track({
    id: 'authored-track', net: 'GND', width: 0.234567, cornerRadius: 0.345678,
    graphNodes: { n0: { x: 1.234567, y: -2.345678 }, n1: { x: 10, y: 0 }, n2: { x: 20, y: 0 } },
    graphEdges: { e0: { from: 'n0', to: 'n1' }, e1: { from: 'n1', to: 'n2' } },
    edgeLayers: { e1: 'bottom-copper' }, edgeWidths: { e1: 0.456789 }, edgeBulges: { e0: 0.123456 },
    nodeCornerRadii: { n1: 0.567891 }, padConnections: { n0: { componentId: 'R1', pinNumber: '1' } },
    sourceBoardShape: { id: 'source-line', kind: 'line', layer: 'top-copper', lineWidth: 0.234567,
        points: [{ x: 1.234567, y: -2.345678 }, { x: 20, y: 0 }], segmentBulges: { 0: 0.123456 } },
});
const firstVia = new Via({ x: 10, y: 0 }), secondVia = new Via({ x: 20, y: 0 });
const routeVias = [firstVia, secondVia];
const state = () => ({
    tracks: tracks.map(item => ({ id: item.id, ...item.captureState() })),
    vias: vias.map(item => item.captureState()),
});
const states = [state()];
const history = new CommandHistory();
const add = new AddTrackCommand(model, track, routeVias);
routeVias.splice(0, routeVias.length, untouchedVia);
history.execute(add);
add.execute();
assert.deepEqual(tracks, [untouched, track]);
assert.deepEqual(vias, [untouchedVia, firstVia, secondVia], 'Associated-via membership belongs to the command');
states.push(state());
track.getBounds();
track._dirty = false;
const move = new MoveVertexCommand(track, 'n0', 1.234567, -2.345678, Math.PI, -Math.E);
history.execute(move);
assert.equal(track._bounds, null, 'Node edits invalidate entity geometry without rendering');
assert.deepEqual(track.nodes.get('n0'), { x: Math.PI, y: -Math.E });
assert.deepEqual(model.serializeEntities().tracks[1].nd.n0, [3.1416, -2.7183]);
assert.equal(track.nodes.get('n0').x, Math.PI, 'Saving leaves live coordinates unrounded');
states.push(state());
const beforeScalar = { net: track.net, width: track.width };
const afterScalar = { net: 'POWER', width: 0.678912 };
const scalar = new ModifyTrackCommand(track, beforeScalar, afterScalar);
beforeScalar.net = afterScalar.net = 'caller mutation';
history.execute(scalar);
assert.equal(track.net, 'POWER');
assert.equal(track.width, 0.678912);
states.push(state());
const before = track.captureState();
const after = structuredClone(before);
delete after.nodes.n0;
after.nodes.junction = { x: 3.456789, y: -4.567891 };
after.edges.e0.from = 'junction';
after.edges.e0.width = 0.789123;
after.edges.e1.layer = 'top-copper';
after.edges.branch = { from: 'junction', to: 'n2', layer: 'bottom-copper', width: 0.891234, bulge: -0.234567 };
delete after.padConnections.n0;
after.padConnections.junction = { componentId: 'U2', pinNumber: '3' };
after.nodeCornerRadii.junction = 0.678912;
after.sourceBoardShape.points[0].x = 3.456789;
after.sourceBoardShape.segmentBulges[0] = -0.234567;
const expectedAfter = structuredClone(after);
const graph = new ModifyTrackGraphCommand(track, before, after);
for (const snapshot of [before, after]) {
    Object.values(snapshot.nodes)[0].x = 999;
    snapshot.edges.e0.width = 999;
    Object.values(snapshot.padConnections)[0].componentId = 'caller mutation';
    snapshot.nodeCornerRadii.n1 = 999;
    snapshot.sourceBoardShape.points[0].x = 999;
    snapshot.sourceBoardShape.segmentBulges[0] = 999;
}
history.execute(graph);
assert.deepEqual(track.captureState(), expectedAfter, 'Nested graph snapshots are detached from their caller');
assert.equal(track.id, 'authored-track');
assert.equal(track.nodes.has('n0'), false);
track.nodes.get('junction').x = 888;
track.edges.get('branch').bulge = 888;
track.padConnections.get('junction').componentId = 'live mutation';
track.nodeCornerRadii.n1 = 888;
track.sourceBoardShape.points[0].x = 888;
track.sourceBoardShape.segmentBulges[0] = 888;
graph.execute();
assert.deepEqual(track.captureState(), expectedAfter, 'Applying graph state does not expose the stored snapshot');
states.push(state());
const remove = new RemoveTrackCommand(model, track);
history.execute(remove);
assert.deepEqual(vias, [untouchedVia, firstVia, secondVia], 'Removing a track leaves standalone vias intact');
states.push(state());
for (let cycle = 0; cycle < 2; cycle++) {
    for (let index = states.length - 2; index >= 0; index--) {
        assert.equal(history.undo(), true);
        assert.deepEqual(state(), states[index], `Undo restores step ${index}`);
        assert.equal(model.tracks, tracks);
        assert.equal(model.vias, vias);
        if (index > 0) assert.equal(tracks[1], track);
    }
    for (let index = 1; index < states.length; index++) {
        assert.equal(history.redo(), true);
        assert.deepEqual(state(), states[index], `Redo restores step ${index}`);
        assert.equal(model.tracks, tracks);
        assert.equal(model.vias, vias);
        if (index < states.length - 1) assert.equal(tracks[1], track);
    }
}
remove.execute();
assert.deepEqual(tracks, [untouched]);
remove.undo();
remove.undo();
assert.deepEqual(tracks, [untouched, track]);
const missing = new MoveVertexCommand(track, 'missing', 0, 0, 1, 1);
const beforeMissing = state();
const count = history.undoStack.length;
assert.throws(() => history.execute(missing), /PCB track node is no longer available: authored-track\/missing/);
assert.throws(() => missing.undo(), /PCB track node is no longer available/);
assert.equal(history.undoStack.length, count, 'A missing target cannot silently create a successful history entry');
assert.deepEqual(state(), beforeMissing);
assert.deepEqual(other.tracks, []);
assert.deepEqual(other.vias, []);
assert.equal('_svgElements' in track, false);
assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
console.log('PASS DOM-free track commands, owned graph/route snapshots, topology history, precision and missing-target errors');
