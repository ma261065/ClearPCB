import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { getVertexDrag } from '../../src/pcb/modules/track-drag.js';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';

installFakeDom();
const { Pad } = await import('../../src/shapes/pad.js');
const { Track } = await import('../../src/shapes/track.js');
const { startVertexDrag, updateVertexDrag, finishVertexDrag } = await import('../../src/pcb/modules/track-drag.js');
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');
const copperPrototype = Object.create(null, Object.fromEntries(['tracks', 'vias', 'pads', 'boardShapes']
    .map(key => [key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key)])));

function loop(points, options = {}) {
    return new Track({
        width: 0.3, layer: 'top-copper', ...options,
        graphNodes: Object.fromEntries(points.map((point, index) => [`n${index}`, point])),
        graphEdges: Object.fromEntries(points.map((_, index) => [`e${index}`,
            { from: `n${index}`, to: `n${(index + 1) % points.length}` }])),
    });
}

function appFor(tracks, pads = []) {
    const commands = [];
    const app = Object.assign(Object.create(copperPrototype), pcbEditorStubs(), {
        pcbDocument: new PcbDocument(), tracks, vias: [], pads, placements: new Map(), netlist: [], boardShapes: [],
        getLayerGroup() { return null; },
        viewport: { scale: 100, gridVisible: false, setCrosshair() {}, hideCrosshair() {} },
        history: { execute(command) { commands.push(command); command.execute(); } },
        alert(message) { this.lastAlert = message; },
    });
    return { app, commands };
}

const positions = track => Object.fromEntries([...track.nodes].map(([id, point]) => [id, [point.x, point.y]]));
const rectangle = [{ x: 10, y: -10 }, { x: 30, y: -10 }, { x: 30, y: -25 }, { x: 10, y: -25 }];

{
    const track = loop(rectangle);
    const { app, commands } = appFor([track]);
    const before = positions(track);
    assert.ok(startVertexDrag(app, track, { x: 30, y: -25 }, { nodeId: 'n2' }));
    assert.equal(getVertexDrag(app).mode, 'rectangle', 'a rectangular loop corner starts a rectangle resize');
    updateVertexDrag(app, { x: 35, y: -30 });
    assert.deepEqual(positions(track), before, 'the resize previews without changing the track');
    finishVertexDrag(app);
    assert.deepEqual(positions(track), { n0: [10, -10], n1: [35, -10], n2: [35, -30], n3: [10, -30] },
        'the opposite corner stays put and the sides stay axis-aligned');
    assert.equal(commands.length, 1, 'one undo step');
    commands[0].undo();
    assert.deepEqual(positions(track), before, 'undo restores the rectangle');
}

{
    const track = loop(rectangle);
    const { app } = appFor([track]);
    assert.ok(startVertexDrag(app, track, { x: 30, y: -25 }, { nodeId: 'n2' }));
    updateVertexDrag(app, { x: 10, y: -40 });
    updateVertexDrag(app, { x: 30, y: -25 });
    finishVertexDrag(app);
    assert.deepEqual(positions(track), positions(loop(rectangle)),
        'a zero-width preview is skipped and returning to the start commits nothing');
}

for (const [label, track, pads] of [
    ['a pentagon', loop([...rectangle, { x: 5, y: -17 }]), []],
    ['an open path', new Track({ width: 0.3, layer: 'top-copper', points: rectangle }), []],
    ['a loop tied to a pad', loop(rectangle, { padConnections: { n2: { componentId: 'U1', pinNumber: '1' } } }),
        [new Pad({ x: 30, y: -25, layers: 'both' })]],
]) {
    const { app } = appFor([track], pads);
    const nodeId = [...track.nodes.keys()][2];
    assert.ok(startVertexDrag(app, track, track.nodes.get(nodeId), { nodeId }));
    assert.equal(getVertexDrag(app).mode, 'node', `${label} keeps free node dragging`);
    finishVertexDrag(app);
}

console.log('PASS rectangular track loops resize like rectangles; other tracks keep free node dragging');
