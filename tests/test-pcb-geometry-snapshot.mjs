import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { Track } from '../src/shapes/track.js';
import { Via } from '../src/shapes/via.js';
import { Pad } from '../src/shapes/pad.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { createPcbText, serializePcbText } from '../src/core/pcb-text.js';
import { serializeBoardShapes } from '../src/core/pcb-board-shapes.js';

assert.equal(typeof window, 'undefined');
assert.equal(typeof document, 'undefined');
assert.equal(typeof PcbDocument.prototype.captureGeometry, 'function');

function fixture(layer = 'top-copper') {
    const model = new PcbDocument();
    model.tracks.push(new Track({ id: 'track', layer, width: 0.23456789, net: 'GND',
        points: [{ x: Math.PI, y: -2 }, { x: 10.12345678, y: -2 }] }));
    model.vias.push(new Via({ id: 'via', x: Math.PI, y: -4, diameter: 0.87654321,
        drill: 0.45678901, net: 'GND', locked: true, visible: false }));
    model.pads.push(new Pad({ id: 'pad', x: Math.PI, y: -6, size: 1.23456789,
        drill: 0.56789012, net: 'GND', locked: true, visible: false }));
    model.texts.set('text', createPcbText({ id: 'text', layer, content: 'A', x: Math.PI, y: -9,
        size: 1.23456789, strokeWidth: 0.12345678 }));
    const points = [{ x: Math.PI, y: -12 }, { x: 10.12345678, y: -12 },
        { x: 10.12345678, y: -18 }, { x: Math.PI, y: -18 }];
    model.boardShapes.push(
        { id: 'rect', kind: 'rect', layer, points, lineWidth: 0.23456789, cornerRadius: 0.34567891 },
        { id: 'image', kind: 'image', layer: 'top-silk', points: structuredClone(points),
            artwork: { width: 10, height: 6, rectangles: [{ x: 3, y: 1, width: 1, height: 2 }] } },
        new CopperFill({ id: 'fill', layer, net: 'GND',
            outline: [{ x: 1, y: -1 }, { x: 29, y: -1 }, { x: 29, y: -29 }, { x: 1, y: -29 }] }),
    );
    for (const entity of [...model.tracks, ...model.vias, ...model.pads, ...model.texts.values(), ...model.boardShapes]) {
        entity.element = { uncloneable() {} };
    }
    return model;
}

// The previous adapter's entity contract, without its consumer-only methods/results.
function expectedGeometry(model) {
    return {
        tracks: model.tracks.map(track => track.captureCopperGeometry()),
        vias: model.vias.map(via => ({ id: via.id, x: via.x, y: via.y,
            diameter: via.diameter, drill: via.drill, net: via.net })),
        pads: model.pads.map(pad => structuredClone(pad.captureState())),
        texts: [...model.texts.values()].map(serializePcbText),
        fills: model.copperFills.map(fill => fill.captureCopperGeometry()),
        boardShapes: serializeBoardShapes({ boardShapes: model.boardShapes.filter(shape => shape.type !== 'fill') },
            { compactArtwork: false, roundGeometry: false, parametricRectangles: false }),
    };
}

for (const layer of ['top-copper', 'bottom-copper']) {
    const model = fixture(layer);
    const saved = model.serializeEntities(), expected = expectedGeometry(model);
    const geometry = model.captureGeometry();
    assert.deepEqual(geometry, expected);
    assert.deepEqual(structuredClone(geometry), geometry, 'The complete model snapshot is transferable without adaptation');
    assert.equal('getEdgeWidth' in geometry.tracks[0], false);
    assert.equal('_computed' in geometry.fills[0], false, 'Pour results remain outside the model');
    assert.equal(geometry.vias[0].x, Math.PI);
    assert.equal(geometry.pads[0].size, 1.23456789);
    assert.equal(geometry.texts[0].strokeWidth, 0.12345678);
    assert.equal(geometry.boardShapes[0].points[0].x, Math.PI);
    assert.equal(geometry.boardShapes[1].points[0].x, Math.PI);
    assert.deepEqual(geometry.boardShapes[1].artwork.rectangles, [{ x: 3, y: 1, width: 1, height: 2 }]);
    assert.equal(geometry.vias[0].visible, undefined, 'Via export field policy is unchanged');
    assert.equal(geometry.pads[0].visible, false, 'Pad capture retains its existing authored flags');
    assert.deepEqual(model.serializeEntities(), saved, 'Capture does not change authored data or file serialization');
    geometry.tracks[0].nodes.values().next().value.x = 999;
    geometry.vias[0].x = geometry.pads[0].x = geometry.texts[0].x = 999;
    geometry.boardShapes[0].points[0].x = 999;
    geometry.boardShapes[1].artwork.rectangles[0].x = 999;
    geometry.fills[0].outline[0].x = 999;
    assert.deepEqual(expectedGeometry(model), expected, 'Every captured entity is isolated from the source');
    const detached = model.captureGeometry();
    model.tracks[0].nodes.values().next().value.x = 555;
    model.vias[0].x = model.pads[0].x = model.texts.get('text').x = 555;
    model.boardShapes[0].points[0].x = 555;
    model.boardShapes[1].artwork.rectangles[0].x = 555;
    model.copperFills[0].move(100, 100);
    model.clear();
    assert.deepEqual(detached, expected, 'Live edits and reset cannot change an earlier model snapshot');
    assert.deepEqual(model.captureGeometry(), { tracks: [], vias: [], pads: [], texts: [], fills: [], boardShapes: [] });
}
{
    const model = fixture();
    const expected = expectedGeometry(model);
    const freeze = value => {
        if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
        for (const child of value instanceof Map ? value.values() : Object.values(value)) freeze(child);
        Object.freeze(value);
    };
    freeze(model);
    assert.deepEqual(model.captureGeometry(), expected, 'Model capture works with frozen state and no browser globals');
}
assert.equal(typeof window, 'undefined');
assert.equal(typeof document, 'undefined');

globalThis.window = { addEventListener() {} };
const { prepareFabricationSnapshot, prepareSnapshotFills } = await import('../src/pcb/modules/fabrication-snapshot.js');
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
for (const layer of ['top-copper', 'bottom-copper']) {
    const model = fixture(layer);
    const expected = expectedGeometry(model);
    const app = { pcbDocument: model, placements: new Map(), netlist: [] };
    let captures = 0, neutral;
    const capture = model.captureGeometry.bind(model);
    model.captureGeometry = () => { captures++; neutral = capture(); return neutral; };
    const pending = prepareFabricationSnapshot(app, { computeFills: false });
    model.clear();
    const snapshot = await pending;
    assert.equal(captures, 1, 'Fabrication delegates entity assembly to the model once');
    assert.deepEqual(neutral, expected);
    const equivalent = { ...snapshot, ...expected,
        tracks: expected.tracks.map(track => ({ ...track,
            getEdgeWidth: id => track.edges.get(id).width, getEdgeLayer: id => track.edges.get(id).layer })),
        fills: expected.fills.map(fill => ({ ...fill, _computed: null })) };
    await prepareSnapshotFills(snapshot);
    await prepareSnapshotFills(equivalent);
    assert.deepEqual(snapshot.fills, equivalent.fills);
    assert.deepEqual(exportGerbers(snapshot), exportGerbers(equivalent), 'Manufacturing output matches the previous entity contract');
    assert.deepEqual(structuredClone(neutral), neutral, 'Consumer adaptation does not add methods to the neutral result');
    assert.equal('_computed' in neutral.fills[0], false, 'Consumer pour preparation does not enter the neutral result');
    model.captureGeometry = () => { throw new Error('Invalid model geometry'); };
    await assert.rejects(prepareFabricationSnapshot(app), /Invalid model geometry/);
}
console.log('PASS headless model geometry assembly, precision, isolation, delegation and unchanged fabrication output');
