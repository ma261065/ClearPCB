import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById() { return null; } };
const { Pad } = await import('../src/shapes/pad.js');
const { Via } = await import('../src/shapes/via.js');
const { Track } = await import('../src/shapes/track.js');
const { CopperFill } = await import('../src/shapes/copper-fill.js');
const { startVertexDrag, updateVertexDrag, finishVertexDrag, cancelVertexDrag } =
    await import('../src/pcb/modules/track-drag.js');

function fixture(kind = 'via', chain = false) {
    const pad = new Pad({ x: 0, y: 0, layers: 'both', net: 'SIGNAL' });
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], net: 'SIGNAL' });
    const terminal = kind === 'via' ? new Via({ x: 20, y: 0 }) : new Pad({ x: 20, y: 0 });
    const commands = [];
    const app = {
        tracks: [track], vias: kind === 'via' ? [terminal] : [], pads: kind === 'pad' ? [pad, terminal] : [pad],
        placements: new Map(), netlist: [], boardShapes: [],
        _getLayerGroup() { return null; },
        viewport: { scale: 100, gridVisible: false, setCrosshair() {}, hideCrosshair() {} },
        history: { execute(command) { commands.push(command); command.execute(); } },
        _alert(message) { this.lastAlert = message; },
    };
    const connected = [terminal];
    if (chain) {
        const branch = new Track({ points: [{ x: 20, y: 0 }, { x: 30, y: 0 }] });
        const via = new Via({ x: 30, y: 0 });
        const bottom = new Track({ points: [{ x: 30, y: 0 }, { x: 40, y: 0 }], layer: 'bottom-copper' });
        const end = new Pad({ x: 40, y: 0, layers: 'both' });
        app.tracks.push(branch, bottom);
        app.vias.push(via);
        app.pads.push(end);
        connected.push(via, bottom, end);
    }
    const nodeId = [...track.nodes.keys()][1];
    return { app, pad, track, terminal, connected, commands, nodeId };
}

for (const kind of ['via', 'pad']) {
    for (const chain of [false, true]) {
        const { app, track, terminal, connected, commands, nodeId } = fixture(kind, chain);
        const originals = [...app.tracks];
        const before = originals.map(item => item.captureState());
        const remote = new Via({ x: 100, y: 0 });
        app.vias.push(remote);
        assert.ok(startVertexDrag(app, track, { x: 10, y: 0 }, { nodeId }));
        updateVertexDrag(app, { x: 19.98, y: 0 });
        assert.equal(terminal.net, '', 'preview does not assign a Net');
        finishVertexDrag(app);
        assert.equal(app.lastAlert, undefined);
        assert.deepEqual(track.nodes.get(nodeId), { x: 20, y: 0 });
        for (const item of [...app.tracks, ...connected]) assert.equal(item.net, 'SIGNAL');
        assert.equal(remote.net, '');
        assert.equal(commands.length, 1);
        commands[0].undo();
        assert.deepEqual(new Set(app.tracks), new Set(originals));
        assert.deepEqual(originals.map(item => item.captureState()), before);
        for (const item of connected) assert.equal(item.net, '');
        commands[0].execute();
        for (const item of [...app.tracks, ...connected]) assert.equal(item.net, 'SIGNAL');
    }
}

{
    const { app, track, terminal, nodeId, commands } = fixture();
    startVertexDrag(app, track, { x: 10, y: 0 }, { nodeId });
    updateVertexDrag(app, { x: 19.98, y: 0 });
    cancelVertexDrag(app);
    assert.equal(terminal.net, '');
    assert.equal(commands.length, 0);
    assert.deepEqual(track.nodes.get(nodeId), { x: 10, y: 0 });
}

for (const kind of ['via', 'pad', 'component']) {
    const { app, pad, track, terminal, nodeId, commands } = fixture(kind === 'pad' ? 'pad' : 'via');
    pad.net = track.net = '';
    terminal.net = 'SIGNAL';
    if (kind === 'component') {
        app.vias = [];
        app.placements.set('U1', { pads: new Map([['1', { x: 20, y: 0, number: '1' }]]) });
        app.netlist.push({ net: 'SIGNAL', pins: [{ componentId: 'U1', pinNumber: '1' }] });
    }
    startVertexDrag(app, track, { x: 10, y: 0 }, { nodeId });
    updateVertexDrag(app, { x: 19.98, y: 0 });
    finishVertexDrag(app);
    assert.equal(track.net, 'SIGNAL', `an unassigned Track inherits from a ${kind}`);
    assert.equal(pad.net, 'SIGNAL', 'the original unassigned Pad inherits too');
    commands[0].undo();
    assert.equal(track.net, '');
    assert.equal(pad.net, '');
    assert.deepEqual(track.nodes.get(nodeId), { x: 10, y: 0 });
    commands[0].execute();
    assert.equal(track.net, 'SIGNAL');
    assert.equal(pad.net, 'SIGNAL');
}

{
    const { app, track, terminal, nodeId, commands } = fixture('via', true);
    const bottom = app.tracks.at(-1);
    const remoteStart = bottom.addNode(100, 0);
    const remoteEnd = bottom.addNode(110, 0);
    bottom.addEdge(remoteStart, remoteEnd);
    const before = bottom.captureState();
    startVertexDrag(app, track, { x: 10, y: 0 }, { nodeId });
    updateVertexDrag(app, { x: 19.98, y: 0 });
    finishVertexDrag(app);
    assert.equal(terminal.net, 'SIGNAL');
    assert.equal(bottom.net, 'SIGNAL');
    assert.equal(app.tracks.find(item => item.nodes.has(remoteStart))?.net, '',
        'a disconnected subgraph does not inherit the connected chain Net');
    commands[0].undo();
    assert.deepEqual(bottom.captureState(), before);
    commands[0].execute();
    assert.equal(app.tracks.find(item => item.nodes.has(remoteStart))?.net, '');
}

{
    const { app, track, terminal, nodeId } = fixture();
    const ground = new CopperFill({ net: 'GND', layer: 'top-copper' });
    ground._computed = [{
        outer: [{ x: 11, y: -5 }, { x: 25, y: -5 }, { x: 25, y: 5 }, { x: 11, y: 5 }],
        holes: [[{ x: 19, y: -1 }, { x: 21, y: -1 }, { x: 21, y: 1 }, { x: 19, y: 1 }]],
    }];
    app.boardShapes.push(ground);
    startVertexDrag(app, track, { x: 10, y: 0 }, { nodeId });
    updateVertexDrag(app, { x: 19.98, y: 0 });
    finishVertexDrag(app);
    assert.equal(app.lastAlert, undefined, 'the old ground pour does not block a moved Track');
    assert.equal(terminal.net, 'SIGNAL');
    assert.equal(ground.net, 'GND');
}

{
    const { app, track, terminal, connected, nodeId, commands } = fixture('via', true);
    connected.at(-1).net = 'OTHER';
    startVertexDrag(app, track, { x: 10, y: 0 }, { nodeId });
    updateVertexDrag(app, { x: 19.98, y: 0 });
    finishVertexDrag(app);
    assert.equal(commands.length, 0, 'a remote assigned Net rejects the entire drop');
    assert.equal(terminal.net, '');
    assert.deepEqual(track.nodes.get(nodeId), { x: 10, y: 0 });
    assert.match(app.lastAlert, /different nets/);
}

for (const net of ['SIGNAL', 'OTHER']) {
    const { app, track, nodeId, commands } = fixture();
    app.vias = [];
    const bottom = new Track({ points: [{ x: 20, y: 0 }, { x: 30, y: 0 }], layer: 'bottom-copper' });
    app.tracks.push(bottom);
    app.pads.push(new Pad({ x: 30, y: 0, net }));
    startVertexDrag(app, track, { x: 10, y: 0 }, { nodeId });
    updateVertexDrag(app, { x: 19.98, y: 0 });
    finishVertexDrag(app);
    if (net === 'OTHER') {
        assert.equal(commands.length, 0, 'a planned layer-transition Via must not short a remote Net');
        assert.equal(app.vias.length, 0);
        assert.match(app.lastAlert, /different nets/);
    } else {
        assert.equal(app.vias.length, 1);
        assert.equal(app.vias[0].net, 'SIGNAL');
        assert.equal(bottom.net, 'SIGNAL');
        commands[0].undo();
        assert.equal(app.vias.length, 0);
        assert.equal(bottom.net, '');
        commands[0].execute();
        assert.equal(bottom.net, 'SIGNAL');
    }
}

console.log('PASS endpoint-drag Net inheritance, Via/Pad chains, cancel, conflicts and atomic Undo/Redo');
