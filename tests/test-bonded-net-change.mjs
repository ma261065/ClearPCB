import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById() { return null; },
    createElementNS() {
        return {
            setAttribute() {},
            remove() {},
            classList: { add() {} },
            dataset: {},
        };
    },
};

const [{ Track }, { Via }, { _applyNetToBondedCopper, applyNetToCopperSelection }] = await Promise.all([
    import('../src/shapes/track.js'),
    import('../src/shapes/via.js'),
    import('../src/pcb/modules/track-select.js'),
]);

const track = new Track({ points: [{ x: 0, y: 0 }, { x: 5, y: 0 }], net: 'OLD' });
const firstEdgeId = track.edges.keys().next().value;
const n2 = track.addNode(20, 0);
const n3 = track.addNode(25, 0);
track.addEdge(n2, n3);
const nearVia = new Via({ x: 0, y: 0, net: 'OLD' });
const remoteVia = new Via({ x: 20, y: 0, net: 'OLD' });
const app = {
    tracks: [track],
    vias: [nearVia, remoteVia],
    placements: new Map(),
    netlist: [],
    boardShapes: [],
    copperFills: [],
    _layerGroups: new Map(),
    _getLayerGroup() { return null; },
    history: {
        command: null,
        execute(command) {
            this.command = command;
            command.execute();
        },
    },
};

assert.equal(_applyNetToBondedCopper(app, { track, edgeId: firstEdgeId }, 'NEW'), true);
assert.equal(app.tracks.length, 2, 'disconnected components become independent tracks');
assert.equal(app.tracks.find(item => item.nodes.has('n0'))?.net, 'NEW',
    'the clicked connected component receives the new net');
assert.equal(app.tracks.find(item => item.nodes.has(n2))?.net, 'OLD',
    'the disconnected component keeps its original net');
assert.equal(nearVia.net, 'NEW', 'a physically bonded via receives the new net');
assert.equal(remoteVia.net, 'OLD', 'an unconnected via on the old net is unchanged');

app.history.command.undo();
assert.deepEqual(app.tracks, [track], 'undo restores the original track object');
assert.equal(nearVia.net, 'OLD', 'undo restores the connected via net');
assert.equal(remoteVia.net, 'OLD', 'undo leaves unrelated copper unchanged');

console.log('PASS: net changes propagate only through physically bonded copper');

{
    const selectedTrack = new Track({ points: [{ x: 0, y: 10 }, { x: 5, y: 10 }], net: 'OLD' });
    const selectedVia = new Via({ x: 5, y: 10, net: 'OLD' });
    const unrelatedVia = new Via({ x: 20, y: 10, net: 'OLD' });
    const mixedApp = {
        ...app,
        tracks: [selectedTrack],
        vias: [selectedVia, unrelatedVia],
        history: { execute(command) { command.execute(); } },
    };
    assert.equal(applyNetToCopperSelection(mixedApp, [
        { kind: 'track', object: selectedTrack },
        { kind: 'via', object: selectedVia },
    ], 'NEW'), true);
    assert.equal(selectedTrack.net, 'NEW');
    assert.equal(selectedVia.net, 'NEW');
    assert.equal(unrelatedVia.net, 'OLD');
}
