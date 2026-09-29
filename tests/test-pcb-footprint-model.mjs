import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { Component } from '../src/components/Component.js';
import { BuiltInComponents } from '../src/components/BuiltInComponents.js';
import { Track } from '../src/shapes/track.js';
import { createPcbFootprint } from '../src/core/pcb-footprint.js';
import { updatePlacementPadPositions, repositionPadConnectedNodes } from '../src/core/pcb-placement-geometry.js';

assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');

const project = new ProjectDocument();
const definition = {
    name: 'PhysicalPadFixture', _source: 'KiCad', footprint: 'DuplicatePads',
    symbol: { width: 10, height: 10, graphics: [], pins: [{ number: '1', name: 'GND' }] },
    footprintShapes: [
        'PAD~RECT~-2.123456~0~1.234567~2~1~top~0~0~0',
        'PAD~ELLIPSE~2.123456~0~1.234567~2~1~both~1~0~0.765432',
        'PAD~OVAL~0~1~1~1~1~bottom~1~1~0',
        'PASTE~RECT~-0.25~0~0.2~0.3~top',
        'PASTE~OVAL~0.25~0~0.2~0.3~bottom',
        'SILK~LINE~-3~-2~3~-2~0.15~top',
    ],
};
const component = new Component(definition, { id: 'connector', reference: 'J1' });
project.schematicDocument.components.push(component);
const original = structuredClone(definition);
const revision = project.fileManager.revision;
const footprint = project.getPcbFootprint(component.id);
assert.deepEqual(footprint.padOffsets.map(pad => pad.padId), ['1', '1#2', '1#3']);
assert.deepEqual(footprint.padOffsets.map(pad => pad.number), ['1', '1', '1']);
assert.deepEqual(footprint.padOffsets[0], {
    number: '1', padId: '1', dx: -2.123456, dy: -0.25, width: 1.234567, height: 2,
    drill: 0, slotLength: 0, slotAngle: 0, layer: 'top', shape: 'rect', mask: false, paste: false,
});
assert.equal(footprint.padOffsets[1].drill, 0.765432);
assert.equal(footprint.padOffsets[1].layer, 'both');
assert.equal(footprint.padOffsets[2].layer, 'bottom');
assert.deepEqual(footprint.pasteOffsets, [
    { dx: -0.25, dy: -0.25, width: 0.2, height: 0.3, shape: 'rect', side: 'top' },
    { dx: 0.25, dy: -0.25, width: 0.2, height: 0.3, shape: 'oval', side: 'bottom' },
]);
assert.deepEqual(definition, original);
assert.equal(project.fileManager.revision, revision, 'Footprint resolution is not an authored edit');
assert.equal(project.pcbDocument.placementState.overrides.size, 0);
assert.equal('pcb' in project.serialize(), false, 'Resolving geometry does not invent a PCB section');

const expected = structuredClone(footprint);
footprint.padOffsets[0].dx = 999;
footprint.pasteOffsets[0].width = 999;
footprint.geometry.pads[0].x = 999;
footprint.geometry.silks.length = 0;
assert.deepEqual(project.getPcbFootprint(component.id), expected, 'Every resolution is detached, not a shared mutable cache');
assert.deepEqual(definition, original);

project.registerView('pcb', { get placements() { assert.fail('Resolution must not inspect generated placements'); } });
assert.deepEqual(project.getPcbFootprint(component.id), expected);
project.views.clear();

const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    padConnections: { n0: { componentId: component.id, pinNumber: '1#2' } } });
project.pcbDocument.tracks.push(track);
project.pcbDocument.placementState.record(component.id, { x: Math.PI, y: -Math.E, rotation: 37 });
const reposition = () => {
    const current = project.getPcbFootprint(component.id);
    const placement = { ...project.pcbDocument.placementState.overrides.get(component.id),
        padOffsets: current.padOffsets, pads: new Map() };
    updatePlacementPadPositions(placement);
    repositionPadConnectedNodes(project.pcbDocument.tracks, component.id, placement.pads);
    assert.deepEqual(track.nodes.get('n0'), { x: placement.pads.get('1#2').x, y: placement.pads.get('1#2').y });
};
reposition();
const beforeReplacement = { ...track.nodes.get('n0') };
component.definition.footprintShapes[1] = 'PAD~ELLIPSE~4.123456~0~1.234567~2~1~both~1~0~0.765432';
reposition();
assert.notDeepEqual(track.nodes.get('n0'), beforeReplacement, 'In-place definition edits affect the next resolution without editor sync');
assert.equal(track.padConnections.get('n0').pinNumber, '1#2');

const live = project.getPcbFootprint(component.id);
const saved = project.serialize();
assert.deepEqual(project.getPcbFootprint(component.id), live, 'Saving must not round live footprint geometry');
const copy = new ProjectDocument();
await copy.load(saved);
const loaded = copy.getPcbFootprint(component.id);
const round4 = value => Math.round(value * 10000) / 10000;
assert.deepEqual(loaded.padOffsets, live.padOffsets.map(pad => ({
    ...pad, dx: round4(pad.dx), dy: round4(pad.dy), width: round4(pad.width),
    height: round4(pad.height), drill: round4(pad.drill),
})), 'Embedded footprint coordinates retain the existing four-decimal file precision');
assert.deepEqual(loaded.pasteOffsets, live.pasteOffsets);
assert.equal(copy.views.size, 0, 'Loaded definitions resolve without constructing either editor');
await copy.reset();
assert.equal(copy.getPcbFootprint(component.id), null, 'New clears the source; no stale geometry survives');
await copy.load(saved);
assert.deepEqual(copy.getPcbFootprint(component.id), loaded);

const resistor = new Component(BuiltInComponents.find(item => item.name === 'Resistor'), { id: component.id });
project.schematicDocument.components[0] = resistor;
for (const packageId of ['default', '0603', '0805', 'default']) {
    resistor.packageId = packageId;
    const resolved = project.getPcbFootprint(resistor.id);
    assert.deepEqual(resolved.padOffsets.map(pad => pad.padId), ['1', '2']);
    assert.ok(resolved.padOffsets.every(pad => packageId === 'default'
        ? pad.layer === 'both' && pad.drill > 0 && !pad.paste
        : pad.layer === 'top' && pad.drill === 0 && pad.paste));
    const restored = new ProjectDocument();
    await restored.load(project.serialize());
    assert.deepEqual(restored.getPcbFootprint(resistor.id), resolved, 'Current package survives headless save/load');
}
assert.equal(project.getPcbFootprint('missing'), null);
for (const name of ['Net', 'NoConnect']) {
    project.schematicDocument.components[0] = new Component({ ...definition, name }, { id: component.id });
    assert.equal(project.getPcbFootprint(component.id), null, 'Non-physical components have no PCB footprint');
}
project.schematicDocument.components[0] = new Component({ ...definition, footprintShapes: [] }, { id: component.id });
assert.deepEqual(project.getPcbFootprint(component.id), {
    geometry: { pads: [], silks: [], outline: null, courtyard: null }, padOffsets: [], pasteOffsets: [],
}, 'A physical component with no supplied footprint keeps the existing empty geometry behavior');

const slotted = createPcbFootprint({ footprint: 'Slot', pins: [], source: 'EasyEDA',
    footprintShapes: ['PAD~OVAL~0~0~3~2~11~~7~0.4~~0~~2~0 -0.6 0 0.6'] });
assert.equal(slotted.padOffsets[0].drill, 0.8);
assert.equal(slotted.padOffsets[0].slotLength, 2);
assert.equal(slotted.padOffsets[0].slotAngle, Math.PI / 2);
assert.equal(slotted.padOffsets[0].shape, 'oval');
assert.equal(slotted.padOffsets[0].layer, 'both');
assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
console.log('PASS current model footprint source, physical pad descriptors, package changes, isolation and headless lifecycle');
