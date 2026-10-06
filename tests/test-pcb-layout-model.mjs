import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { Component } from '../src/components/Component.js';
import { Wire } from '../src/shapes/wire.js';
import { Track } from '../src/shapes/track.js';
import { captureResolvedPlacement } from '../src/core/pcb-placement-geometry.js';
import { extractComponents } from '../src/core/netlist.js';

assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
const storage = new Map();
globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
};
const definition = {
    name: 'LayoutFixture', footprint: 'DuplicatePads', _source: 'KiCad',
    symbol: { width: 10, height: 10, graphics: [], pins: [
        { number: '1', name: 'Signal', x: -5, y: 0 }, { number: '2', name: 'Power', x: 5, y: 0 },
    ] },
    footprintShapes: [
        'PAD~RECT~-2~0~1.23456789~2~1~top~1~0',
        'PAD~ELLIPSE~2~0~1.23456789~2~1~both~1~0~0.76543219',
        'PAD~RECT~0~2~1~1~2~bottom~1~0',
        'PASTE~RECT~-2~0~0.6~0.8~top',
        'SILK~LINE~-3~-2~3~-2~0.15~top',
    ],
};
const component = index => new Component(structuredClone(definition), { id: `part-${index}`, reference: `J${index + 1}` });
const project = new ProjectDocument();
const parts = Array.from({ length: 5 }, (_, index) => component(index));
project.schematicDocument.components.push(...parts);
const wire = new Wire({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], net: 'SIGNAL' });
const [firstNode, secondNode] = wire.nodes.keys();
wire.pinConnections.set(firstNode, { componentId: parts[0].id, pinNumber: '1' });
wire.pinConnections.set(secondNode, { componentId: parts[1].id, pinNumber: '1' });
project.schematicDocument.shapes.push(wire);
const state = project.pcbDocument.placementState;
const autoSlots = state.autoSlots;
state.record(parts[0].id, { x: 30.00000001, y: -10.00000002, rotation: 37.12345678,
    side: 'bottom', mirror: true, refDx: Math.PI, refDy: -Math.E, refRot: 17.12345678,
    refSize: 1.23456789, refStrokeWidth: 0.12345678, refVisible: false, locked: true });
const savedOverrides = structuredClone([...state.overrides]);
const revision = project.fileManager.revision;
const layout = project.resolvePcbLayout();
assert.equal(layout.placements.size, 5);
assert.deepEqual([...layout.placements.values()].map(({ x, y }) => [x, y]),
    [[30.00000001, -10.00000002], [10, -10], [50, -10], [10, -30], [30, -30]],
    'Automatic layout retains the 20 mm grid, 10 mm margin and occupied-cell policy');
assert.deepEqual(layout.netlist, project.getNetlist());
assert.deepEqual([...state.overrides], savedOverrides, 'Resolution does not manufacture saved overrides');
assert.equal(project.fileManager.revision, revision, 'Derived layout is not an authored edit');
assert.equal(autoSlots.size, 4);
layout.placements.get(parts[1].id).x = 999;
assert.equal(autoSlots.get(parts[1].id).x, 10, 'Returned automatic poses do not alias the slot cache');
assert.equal(layout.placements.get(parts[0].id).refDx, Math.PI);
assert.equal(layout.placements.get(parts[0].id).padOffsets[0].width, 1.23456789);
assert.deepEqual([...layout.placements.get(parts[0].id).pads.keys()], ['1', '1#2', '2']);
assert.equal(layout.placements.get(parts[0].id).padOffsets[0].layer, 'bottom');
assert.equal(layout.placements.get(parts[0].id).pasteOffsets[0].side, 'bottom');
assert.equal('elements' in layout.placements.get(parts[0].id), false);

for (const side of ['top', 'bottom']) for (const mirror of [false, true]) for (const rotation of [0, 90, 37.12345678]) {
    state.record(parts[0].id, { ...savedOverrides[0][1], side, mirror, rotation });
    const resolved = project.resolvePcbLayout().placements.get(parts[0].id);
    const angle = rotation * Math.PI / 180, mx = mirror !== (side === 'bottom') ? -1 : 1;
    for (const offset of resolved.padOffsets) {
        const pad = resolved.pads.get(offset.padId);
        assert.equal(pad.x, resolved.x + offset.dx * mx * Math.cos(angle) - offset.dy * Math.sin(angle));
        assert.equal(pad.y, resolved.y + offset.dx * mx * Math.sin(angle) + offset.dy * Math.cos(angle));
    }
}
state.record(parts[0].id, savedOverrides[0][1]);
const expected = captureResolvedPlacement(project.resolvePcbLayout().placements.get(parts[0].id));
layout.placements.get(parts[0].id).padOffsets[0].width = 999;
layout.placements.get(parts[0].id).pads.get('1').x = 999;
layout.placements.get(parts[0].id).geometry.pads[0].x = 999;
layout.netlist[0].pins[0].componentId = 'changed';
assert.deepEqual(captureResolvedPlacement(project.resolvePcbLayout().placements.get(parts[0].id)), expected);
assert.equal(project.getNetlist()[0].pins[0].componentId, parts[0].id);

project.schematicDocument.components = [parts[4], parts[2], parts[3], parts[0]];
const stable = project.resolvePcbLayout();
assert.deepEqual([...stable.placements.values()].map(({ x, y }) => [x, y]),
    [[30, -30], [50, -10], [10, -30], [30.00000001, -10.00000002]],
    'Removing and reordering components does not reflow existing automatic placements');
const added = component(5);
project.schematicDocument.components.push(added);
assert.deepEqual(state.autoSlots.get(added.id), undefined);
const grown = project.resolvePcbLayout();
assert.deepEqual([grown.placements.get(added.id).x, grown.placements.get(added.id).y], [10, -10],
    'New components reuse the first unoccupied current-grid cell');
assert.equal(autoSlots, state.autoSlots, 'The model retains stable derived-map identity');
const saved = project.serialize();
assert.deepEqual(new Set(Object.keys(state.serialize())), new Set([...state.autoSlots.keys(), ...state.overrides.keys()]),
    'Automatic positions are saved without manufacturing live overrides');
assert.deepEqual([...state.overrides], savedOverrides);
const copy = new ProjectDocument();
await copy.load(saved);
assert.equal(copy.pcbDocument.placementState.autoSlots.size, 0, 'Saved automatic positions load as stable placement baselines');
for (const [id, placement] of grown.placements) {
    if (id === parts[0].id) continue;
    const restored = copy.resolvePcbLayout().placements.get(id);
    assert.deepEqual([restored.x, restored.y], [placement.x, placement.y]);
}
const loaded = copy.resolvePcbLayout().placements.get(parts[0].id);
assert.equal(loaded.x, 30);
assert.equal(loaded.y, -10);
assert.equal(loaded.refVisible, false);
assert.equal(loaded.side, 'bottom');
const copySlots = copy.pcbDocument.placementState.autoSlots;
await copy.reset();
assert.equal(copySlots.size, 0);
assert.equal(copy.resolvePcbLayout().placements.size, 0);
assert.equal(copySlots, copy.pcbDocument.placementState.autoSlots);
{
    const failedProject = new ProjectDocument();
    failedProject.schematicDocument.components.push(component(10), component(11));
    const summaries = extractComponents(failedProject.schematicDocument);
    Object.defineProperty(summaries[1], 'pins', { get() { throw new Error('Invalid footprint'); } });
    assert.throws(() => failedProject.pcbDocument.placementState.resolve(summaries), /Invalid footprint/);
    assert.equal(failedProject.pcbDocument.placementState.autoSlots.size, 0,
        'A failed resolution does not retain a partial automatic layout');
}

const track = new Track({ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], layer: 'bottom-copper', net: 'SIGNAL' });
const trackNode = [...track.nodes.keys()][0];
track.padConnections.set(trackNode, { componentId: parts[0].id, pinNumber: '1' });
project.pcbDocument.tracks.push(track);
const beforeTrack = track.captureState();
const resolved = project.resolvePcbLayout();
assert.deepEqual(track.captureState(), beforeTrack, 'A layout query does not edit track bonds or geometry');
parts[0].reference = 'J99';
const renamed = project.resolvePcbLayout();
assert.equal(renamed.placements.get(parts[0].id).reference, 'J99');
assert.ok(renamed.netlist.some(entry => entry.net === 'J99.2'), 'Default nets and placement references resolve together');
assert.equal(resolved.placements.get(parts[0].id).reference, 'J1');
parts[0].reference = 'J1';
project.synchronizePcbLayout();
assert.deepEqual(track.nodes.get(trackNode), {
    x: resolved.placements.get(parts[0].id).pads.get('1').x,
    y: resolved.placements.get(parts[0].id).pads.get('1').y,
}, 'Model synchronization re-glues connected tracks before any editor exists');
const synchronizedTrack = track.captureState();
assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');

globalThis.window = { addEventListener() {} };
const { prepareFabricationSnapshot } = await import('../src/pcb/modules/fabrication-snapshot.js');
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
const headless = await prepareFabricationSnapshot({ pcbDocument: project.pcbDocument, ...resolved });
assert.ok(exportGerbers(headless).size > 0, 'A complete resolved layout can reach manufacturing without an editor');

function element() {
    const attributes = new Map();
    return {
        style: {}, dataset: {}, children: [], parentNode: null,
        setAttribute: (name, value) => attributes.set(name, String(value)),
        getAttribute: name => attributes.get(name) ?? null,
        hasAttribute: name => attributes.has(name),
        removeAttribute: name => attributes.delete(name),
        querySelectorAll: () => [], querySelector: () => null,
        appendChild(child) {
            child.parentNode?.removeChild(child);
            this.children.push(child);
            child.parentNode = this;
        },
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
        remove() { this.parentNode?.removeChild(this); },
    };
}
globalThis.document = { createElementNS: element, getElementById: () => null };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { placementTransform } = await import('../src/pcb/modules/track-commands.js');
const slotsBeforeAttachment = structuredClone([...autoSlots]);
new PCBApp(project);
assert.deepEqual([...autoSlots], slotsBeforeAttachment, 'Attaching an editor does not reset model-derived layout');
const groups = new Map();
const app = {
    placements: new Map(),
    get tracks() { assert.fail('Footprint rendering must not read or mutate track models'); },
    getLayerGroup(id) {
        if (!groups.has(id)) groups.set(id, element());
        return groups.get(id);
    },
    _buildLodPlaceholder() {}, rerenderRef() {}, _renderFootprint: PCBApp.prototype._renderFootprint,
};
const expectedPlacements = new Map([...resolved.placements].map(([id, placement]) =>
    [id, captureResolvedPlacement(placement)]));
PCBApp.prototype._placeFootprints.call(app, resolved.placements);
for (const [id, placement] of app.placements) {
    assert.deepEqual(captureResolvedPlacement(placement), expectedPlacements.get(id),
        'The actual editor adapter preserves the model-resolved physical placement');
    for (const svg of placement.elements) assert.equal(svg.getAttribute('transform'), placementTransform(placement));
}
assert.deepEqual(track.captureState(), synchronizedTrack, 'Footprint rendering is presentation-only');
const modelOutput = await prepareFabricationSnapshot({ pcbDocument: project.pcbDocument, ...project.resolvePcbLayout() });
const editorOutput = await prepareFabricationSnapshot({ pcbDocument: project.pcbDocument,
    placements: app.placements, netlist: resolved.netlist });
assert.deepEqual(exportGerbers(modelOutput), exportGerbers(editorOutput),
    'Model-resolved and editor-rendered placements produce identical manufacturing output');
const broken = new ProjectDocument();
broken.schematicDocument.getNetlist = () => { throw new Error('Invalid connectivity'); };
assert.throws(() => broken.resolvePcbLayout(), /Invalid connectivity/);
console.log('PASS model-owned layout/connectivity, stable slots, poses, headless lifecycle, editor projection and fabrication');
