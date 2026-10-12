import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { Track } from '../../src/shapes/track.js';
import { Via } from '../../src/shapes/via.js';
import { Pad } from '../../src/shapes/pad.js';
import { CopperFill } from '../../src/shapes/copper-fill.js';
import { createPcbText } from '../../src/core/pcb-text.js';

globalThis.window = { addEventListener() {} };
const { prepareFabricationSnapshot, prepareSnapshotFills, hasFabricationContent } =
    await import('../../src/pcb/modules/fabrication-snapshot.js');
const { exportGerbers } = await import('../../src/pcb/modules/gerber.js');
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');

function modelApp(model) {
    const app = { pcbDocument: model, placements: new Map(), netlist: [] };
    for (const field of ['tracks', 'vias', 'pads', 'texts', 'boardShapes', 'copperFills']) {
        Object.defineProperty(app, field, { get() { throw new Error(`Editor collection read: ${field}`); } });
    }
    return app;
}

{
    const model = new PcbDocument(), app = modelApp(model);
    assert.equal(hasFabricationContent(app), false);
    const cases = [
        () => model.tracks.push(new Track({ points: [{ x: 1, y: -1 }, { x: 2, y: -2 }] })),
        () => model.vias.push(new Via({ x: 1, y: -1 })),
        () => model.pads.push(new Pad({ x: 1, y: -1 })),
        () => model.texts.set('text', createPcbText({ id: 'text', content: 'A' })),
        () => model.boardShapes.push({ kind: 'circle', layer: 'top-silk', x: 1, y: -1, radius: 1 }),
        () => model.boardShapes.push(new CopperFill()),
        () => app.placements.set('component', { x: 1, y: -1 }),
    ];
    for (const add of cases) {
        add();
        assert.equal(hasFabricationContent(app), true, 'Each canonical content kind enables export');
        model.clear();
        app.placements.clear();
        assert.equal(hasFabricationContent(app), false, 'Clearing the model disables export');
    }
    for (const layer of ['top-document', 'bottom-document']) {
        model.boardShapes.push({ kind: 'circle', layer, x: 1, y: -1, radius: 1 });
        assert.equal(hasFabricationContent(app), false, 'Document-only artwork remains non-fabrication content');
    }
}

function transferable(snapshot) {
    return structuredClone({ ...snapshot,
        tracks: snapshot.tracks.map(({ getEdgeWidth, getEdgeLayer, ...track }) => track) });
}

for (const layer of ['top-copper', 'bottom-copper']) {
    const model = new PcbDocument(), app = modelApp(model);
    model.board.width = 30;
    model.board.height = 30;
    model.designSettings.update({ clearance: 0.12345678 });
    const track = new Track({ points: [{ x: Math.PI, y: -2 }, { x: 12.12345678, y: -2 }],
        width: 0.23456789, layer, net: 'GND' });
    const via = new Via({ x: Math.PI, y: -3, diameter: 0.76543219, drill: 0.32109876, net: 'GND' });
    const pad = new Pad({ x: Math.PI, y: -5, size: 1.23456789, drill: 0.45678901, net: 'GND' });
    const text = createPcbText({ id: 'label', content: 'A', x: Math.PI, y: -8, layer,
        size: 1.23456789, strokeWidth: 0.12345678 });
    const shape = { id: 'circle', kind: 'circle', layer, x: Math.PI, y: -12,
        radius: 1.23456789, lineWidth: 0.12345678 };
    const fill = new CopperFill({ layer, net: 'GND', outline: [
        { x: 1, y: -1 }, { x: 29, y: -1 }, { x: 29, y: -29 }, { x: 1, y: -29 },
    ] });
    model.tracks.push(track);
    model.vias.push(via);
    model.pads.push(pad);
    model.texts.set(text.id, text);
    model.boardShapes.push(shape, fill);
    const legacy = { placements: app.placements, netlist: app.netlist,
        tracks: model.tracks, vias: model.vias, pads: model.pads, texts: model.texts,
        boardShapes: model.boardShapes, copperFills: [fill],
        board: { width: model.board.width, height: model.board.height, radius: model.board.radius },
        getRoutingParams: () => model.designSettings.getRoutingParams() };
    const expected = await prepareFabricationSnapshot(legacy, { computeFills: false });
    const pending = prepareFabricationSnapshot(app);
    track.nodes.values().next().value.x = 100;
    via.x = pad.x = text.x = shape.x = 100;
    fill.move(100, 100);
    model.clear();
    const captured = await pending;
    await prepareSnapshotFills(expected);
    assert.deepEqual(transferable(captured), transferable(expected),
        'All canonical entities are detached before asynchronous pour preparation');
    for (const entity of [captured.vias[0], captured.pads[0], captured.texts[0], captured.boardShapes[0]]) {
        assert.equal(entity.x, Math.PI, 'Coordinates retain full precision, not file-save rounding');
    }
    const edgeId = [...captured.tracks[0].edges.keys()][0];
    assert.equal(captured.tracks[0].getEdgeWidth(edgeId), 0.23456789);
    assert.equal(captured.tracks[0].getEdgeLayer(edgeId), layer);
    assert.ok(captured.fills[0]._computed.length > 0);
    assert.deepEqual(exportGerbers(captured), exportGerbers(expected),
        'Canonical and explicit-input captures produce identical Gerber/Excellon files');
    captured.tracks[0].nodes.values().next().value.x = 200;
    for (const entity of [captured.vias[0], captured.pads[0], captured.texts[0], captured.boardShapes[0]]) entity.x = 200;
    captured.fills[0].outline[0].x = 200;
    assert.equal(track.nodes.values().next().value.x, 100);
    for (const entity of [via, pad, text, shape]) assert.equal(entity.x, 100);
    assert.equal(fill.getOutline()[0].x, 101);
}

{
    const model = new PcbDocument(), app = modelApp(model);
    Object.defineProperty(model, 'tracks', { get() { throw new Error('Invalid canonical tracks'); } });
    assert.throws(() => hasFabricationContent(app), /Invalid canonical tracks/);
    await assert.rejects(prepareFabricationSnapshot(app), /Invalid canonical tracks/,
        'Model failures propagate instead of falling back to editor collections');
}

delete globalThis.window;
assert.equal(typeof document, 'undefined');
{
    const model = new PcbDocument();
    const fill = new CopperFill(), circle = { kind: 'circle', layer: 'top-silk' };
    model.boardShapes.push(circle, fill);
    assert.deepEqual(model.copperFills, [fill], 'The model owns the headless derived fill query');
    assert.equal(model.copperFills[0], fill, 'Queries return canonical entities rather than clones');
    model.copperFills.pop();
    assert.deepEqual(model.copperFills, [fill], 'Mutating a query result does not remove authored entities');
    const editor = Object.create(PCBApp.prototype);
    editor.pcbDocument = model;
    Object.defineProperty(editor, 'boardShapes', { get() { throw new Error('Editor boardShapes read'); } });
    assert.deepEqual(editor.copperFills, [fill], 'Editor compatibility getter delegates to the model');
    model.clear();
    assert.deepEqual(model.copperFills, []);
    assert.deepEqual(editor.copperFills, [], 'Derived collections cannot retain stale entities after reset');
}
console.log('PASS canonical fabrication entities, content checks, precision, isolation, output parity and fill queries');
