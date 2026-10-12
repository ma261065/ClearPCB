import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { areDragOverlaysDeferred } from '../../src/pcb/modules/refresh-state.js';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';

installFakeDom();
const { Pad } = await import('../../src/shapes/pad.js');
const { Track } = await import('../../src/shapes/track.js');
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');
const { createPadSelectionAdapter } = await import('../../src/pcb/modules/pad-selection.js');
const { startVertexDrag, updateVertexDrag, finishVertexDrag } = await import('../../src/pcb/modules/track-drag.js');

function fixture(layers = 'both') {
    const pad = new Pad({ x: 0, y: 0, layers, net: 'GND' });
    const top = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], layer: 'top-copper', net: 'GND' });
    const bottom = new Track({ points: [{ x: 0, y: 0 }, { x: 0, y: 10 }], layer: 'bottom-copper', net: 'GND' });
    const commands = [];
    const pcbDocument = new PcbDocument();
    pcbDocument.pads.push(pad);
    pcbDocument.tracks.push(top, bottom);
    const app = { ...pcbEditorStubs(),
        pcbDocument, placements: new Map(), netlist: [],
        getLayerGroup() { return null; },
        viewport: { scale: 100, gridVisible: false, setCrosshair() {}, hideCrosshair() {} },
        history: { execute(command) { commands.push(command); command.execute(); } },
        alert(message) { this.lastAlert = message; },
    };
    for (const key of ['tracks', 'vias', 'pads']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    return { app, pad, top, bottom, commands, adapter: createPadSelectionAdapter(app, pad, 'pad:test') };
}

for (const layers of ['both', 'top-copper', 'bottom-copper']) {
    const { app, pad, top, bottom, commands, adapter } = fixture(layers);
    adapter.beginMove({ x: 0.25, y: 0.5 });
    adapter.updateMove({ x: 3.25, y: 4.5 });
    assert.deepEqual([pad.x, pad.y], [0, 0], 'The authored pad is not moved during preview');
    assert.equal(app.pads[0].x, 3);
    assert.equal(app.pads[0].y, 4);
    for (const track of [top, bottom]) {
        const attached = layers === 'both' || layers === track.layer;
        const displayed = app.tracks.find(item => item.id === track.id);
        assert.deepEqual([...displayed.nodes.values()][0], attached ? { x: 3, y: 4 } : { x: 0, y: 0 });
        assert.deepEqual([...track.nodes.values()][0], { x: 0, y: 0 });
    }
    adapter.endMove(true);
    assert.equal(commands.length, 1);
    assert.equal(areDragOverlaysDeferred(app), false);
    commands[0].undo();
    assert.deepEqual([pad.x, pad.y], [0, 0]);
    for (const track of [top, bottom]) assert.deepEqual([...track.nodes.values()][0], { x: 0, y: 0 });
    commands[0].execute();
    assert.deepEqual([pad.x, pad.y], [3, 4]);
    adapter.beginMove({ x: 3, y: 4 });
    adapter.updateMove({ x: 6, y: 8 });
    adapter.endMove(false);
    assert.deepEqual([pad.x, pad.y], [3, 4], 'cancel restores Pad and attached nodes');
    for (const track of [top, bottom]) {
        const attached = layers === 'both' || layers === track.layer;
        assert.deepEqual([...track.nodes.values()][0], attached ? { x: 3, y: 4 } : { x: 0, y: 0 });
    }
}

{
    const { app, pad, adapter, commands } = fixture();
    const track = new Track({ points: [{ x: 5, y: -5 }, { x: 5, y: 5 }], net: 'GND' });
    app.tracks = [track];
    adapter.beginMove({ x: 0, y: 0 });
    adapter.updateMove({ x: 5.03, y: 0 });
    adapter.endMove(true);
    assert.deepEqual([pad.x, pad.y], [5, 0]);
    assert.equal(track.nodes.size, 3, 'dropping on a segment creates a sticky junction');
    commands[0].undo();
    assert.equal(track.nodes.size, 2, 'undo removes the inserted junction');
    commands[0].execute();
    adapter.beginMove({ x: 5, y: 0 });
    adapter.updateMove({ x: 7, y: 2 });
    assert.ok([...app.tracks[0].nodes.values()].some(node => node.x === app.pads[0].x && node.y === app.pads[0].y),
        'newly connected junction follows the next Pad drag');
    adapter.endMove(false);
}

{
    const { app, pad, adapter, commands } = fixture();
    app.tracks = [new Track({ points: [{ x: 5, y: -5 }, { x: 5, y: 5 }], net: 'OTHER' })];
    adapter.beginMove({ x: 0, y: 0 });
    adapter.updateMove({ x: 5.03, y: 0 });
    adapter.endMove(true);
    assert.deepEqual([pad.x, pad.y], [0, 0]);
    assert.equal(commands.length, 0);
    assert.match(app.lastAlert, /pad net/);
}

for (const net of ['GND', 'OTHER']) {
    const { app, pad, top, adapter } = fixture();
    app.tracks = [top];
    pad.x = 20;
    pad.net = net;
    const nodeId = [...top.nodes.keys()][1];
    assert.equal(startVertexDrag(app, top, { x: 10, y: 0 }, { nodeId }), true);
    updateVertexDrag(app, { x: 19.8, y: 0 });
    finishVertexDrag(app);
    assert.equal(top.nodes.get(nodeId).x, net === 'GND' ? 20 : 10);
    assert.equal(top.padConnections.size, 0, 'standalone Pads do not create invalid component pin links');
    if (net === 'GND') {
        adapter.beginMove({ x: 20, y: 0 });
        adapter.updateMove({ x: 23, y: 4 });
        assert.deepEqual(app.tracks[0].nodes.get(nodeId), { x: app.pads[0].x, y: app.pads[0].y });
        adapter.endMove(false);
    } else assert.match(app.lastAlert, /pad net/);
}
console.log('PASS Pad/Track sticky drag, layer compatibility, segment bonding, conflicts, undo/redo and cancel');
