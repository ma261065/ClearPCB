import assert from 'node:assert/strict';
import { ProjectDocument } from '../../src/core/ProjectDocument.js';
import { Component } from '../../src/components/Component.js';
import { Track } from '../../src/shapes/track.js';
import { capturePlacementOverride } from '../../src/core/PcbPlacementState.js';
import { captureResolvedPlacement } from '../../src/core/pcb-placement-geometry.js';
import { applyPlacementOverrides, placeFootprints, renderPcbFootprint } from '../../src/pcb/modules/schematic-sync.js';
import { installFakeDom, fakeElement } from './helpers/fake-dom.mjs';

const definition = distance => ({
    name: 'RestorationFixture', _source: 'KiCad', symbol: { pins: [{ number: '1' }] },
    footprintShapes: [
        `PAD~RECT~-${distance}~1~1~1~1~top`,
        `PAD~RECT~${distance}~-1~1~1~1~both~1~0~0.5`,
        'PASTE~RECT~-2~1~0.5~0.5~top',
    ],
});
function fixture(pose) {
    const project = new ProjectDocument();
    for (const id of ['part', 'outside', 'automatic']) {
        project.schematicDocument.components.push(new Component(definition(2), { id, reference: 'J1' }));
    }
    const state = project.pcbDocument.placementState;
    state.record('part', { x: Math.PI, y: -Math.E, ...pose });
    state.record('outside', { x: 50, y: 60 });
    state.record('orphan', { x: 70, y: 80 });
    const copper = pose.side === 'bottom' ? 'bottom-copper' : 'top-copper';
    const opposite = copper === 'top-copper' ? 'bottom-copper' : 'top-copper';
    const connected = (componentId, pinNumber, layer) => new Track({
        layer, points: [{ x: 100, y: 200 }, { x: 300, y: 400 }],
        padConnections: { n0: { componentId, pinNumber } },
    });
    const tracks = [
        connected('part', '1', copper), connected('part', '1', opposite),
        connected('part', '1#2', opposite), connected('outside', '1', 'top-copper'),
        connected('automatic', '1', 'top-copper'),
    ];
    project.pcbDocument.tracks.push(...tracks);
    return { project, state, tracks };
}
assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
for (const side of ['top', 'bottom']) for (const mirror of [false, true]) for (const rotation of [0, 37.123456789]) {
    const { project, state, tracks } = fixture({ side, mirror, rotation, locked: true,
        refVisible: false, refDx: Math.PI, refDy: -Math.E, refRot: 23.125,
        refSize: 1.23456789, refStrokeWidth: 0.123456789 });
    const overrides = structuredClone(state.overrides);
    const before = tracks.map(track => track.captureState());
    const revision = project.fileManager.revision;
    project.views.set('pcb', new Proxy({}, { get() { assert.fail('Headless restoration cannot consult an editor'); } }));
    const placements = project.restorePcbPlacementOverrides(['part', 'part', 'orphan', 'missing', 'automatic']);
    assert.deepEqual([...placements.keys()], ['part']);
    const placement = placements.get('part');
    assert.deepEqual(capturePlacementOverride(placement), overrides.get('part'));
    for (const [index, padId] of [[0, '1'], [2, '1#2']]) {
        const pad = placement.pads.get(padId);
        assert.deepEqual(tracks[index].nodes.get('n0'), { x: pad.x, y: pad.y },
            'Every restored pose, including unrotated top-side poses, moves compatible bonds');
    }
    assert.equal(tracks[1].padConnections.size, 0, 'Restoration disconnects incompatible SMD bonds on either side');
    assert.deepEqual(tracks[1].nodes.get('n0'), before[1].nodes.n0);
    assert.deepEqual(tracks[3].captureState(), before[3], 'The requested subset does not restore other saved placements');
    assert.deepEqual(tracks[4].captureState(), before[4], 'Automatic placements are not saved overrides');
    assert.deepEqual(state.overrides, overrides);
    assert.equal(state.autoSlots.size, 0, 'Restoring saved poses does not allocate automatic slots');
    assert.equal(project.fileManager.revision, revision);
    const after = tracks.map(track => track.captureState());
    project.restorePcbPlacementOverrides(['part']);
    assert.deepEqual(tracks.map(track => track.captureState()), after);
    const all = project.restorePcbPlacementOverrides();
    assert.deepEqual([...all.keys()], ['part', 'outside'], 'Headless callers can restore every physical saved placement');
    assert.notDeepEqual(tracks[3].captureState(), before[3]);
    assert.deepEqual(tracks[4].captureState(), before[4]);
}
{
    const { project, state, tracks } = fixture({ side: 'bottom' });
    const before = tracks.map(track => track.captureState());
    const resolve = state.resolve.bind(state);
    state.resolve = components => {
        Object.defineProperty(components[1], 'pins', { get() { throw new Error('Invalid footprint'); } });
        return resolve(components);
    };
    assert.throws(() => project.restorePcbPlacementOverrides(), /Invalid footprint/);
    assert.deepEqual(tracks.map(track => track.captureState()), before, 'All restoration geometry resolves before mutation');
}
assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');

function element(tag = 'g') {
    const node = Object.assign(fakeElement(tag), { tag, attributes: new Map() });
    const setAttribute = node.setAttribute;
    const removeAttribute = node.removeAttribute;
    node.setAttribute = (name, value) => { setAttribute(name, value); node.attributes.set(name, String(value)); };
    node.removeAttribute = name => { removeAttribute(name); node.attributes.delete(name); };
    node.querySelectorAll = selector => {
        const matches = child => selector.split(',').some(part => {
            part = part.trim();
            return part.startsWith('.') ? (child.getAttribute('class') || '').split(' ').includes(part.slice(1))
                : part.startsWith('[') ? child.hasAttribute(part.slice(1, -1)) : child.tag === part;
        });
        return node.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    };
    node.querySelector = selector => node.querySelectorAll(selector)[0] || null;
    return node;
}
const fakeDocument = installFakeDom();
fakeDocument.createElementNS = (_, tag) => element(tag);
const { placementTransform } = await import('../../src/pcb/modules/track-commands.js');
const { project, state, tracks } = fixture({ side: 'top' });
const groups = new Map();
let refreshes = 0;
const app = {
    project, placements: new Map(),
    get tracks() { assert.fail('Restoration presentation cannot read track models'); },
    getLayerGroup(id) {
        if (!groups.has(id)) groups.set(id, element());
        return groups.get(id);
    },
    updateRatsnest: () => refreshes++, rerenderRef() {},
    renderFootprint: renderPcbFootprint,
    applyPlacementOverrides() { applyPlacementOverrides(this); },
};
const initial = project.resolvePcbLayout();
placeFootprints(app, initial.placements);
const untouched = app.placements.get('outside');
const automatic = app.placements.get('automatic');
state.overrides.delete('outside');
const background = element('rect');
app.getLayerGroup('board-outline').appendChild(background);

for (const side of ['bottom', 'top']) {
    const previous = app.placements.get('part');
    const oldElements = [...previous.elements, previous.lodEl];
    project.schematicDocument.components[0].definition = definition(side === 'bottom' ? 4 : 6);
    state.record('part', { x: Math.PI, y: -Math.E, side, rotation: 37.125, mirror: true,
        refVisible: side === 'top', refSize: side === 'bottom' ? 2.123456789 : undefined,
        refStrokeWidth: side === 'bottom' ? 0.23456789 : undefined });
    for (const key of ['pads', 'padOffsets', 'pasteOffsets']) Object.defineProperty(previous, key, {
        get() { assert.fail('Saved restoration cannot use stale rendered footprint geometry'); },
    });
    app.applyPlacementOverrides();
    const expected = project.restorePcbPlacementOverrides(['part']).get('part');
    const restored = app.placements.get('part');
    assert.deepEqual(captureResolvedPlacement(restored), captureResolvedPlacement(expected));
    assert.ok(oldElements.every(element => !element.parentNode), 'Old footprint artwork and LOD nodes are removed');
    assert.equal(app.placements.get('outside'), untouched);
    assert.equal(app.placements.get('automatic'), automatic);
    assert.equal(background.parentNode, groups.get('board-outline'), 'Restoring footprints does not clear unrelated layers');
    assert.equal(groups.get('fp-lod').children.length, 3, 'Restoration does not accumulate LOD placeholders');
    for (const element of restored.elements) assert.equal(element.getAttribute('transform'), placementTransform(restored));
    const reference = restored.elements.flatMap(element => element.querySelectorAll('[data-fp-ref]'))[0];
    assert.equal(reference.style.display || '', side === 'bottom' ? 'none' : '');
    assert.equal(Number(reference.getAttribute('data-ref-size')), expected.refSize);
    assert.equal(Number(reference.getAttribute('stroke-width')), expected.refStrokeWidth,
        'Restoration can return custom reference styling to defaults');
    const pad = restored.pads.get('1#2');
    assert.deepEqual(tracks[2].nodes.get('n0'), { x: pad.x, y: pad.y });
}
assert.equal(refreshes, 2);
const retained = [...app.placements.get('part').elements];
const resolve = state.resolve;
state.resolve = () => { throw new Error('Invalid restored layout'); };
assert.throws(() => app.applyPlacementOverrides(), /Invalid restored layout/);
assert.ok(retained.every(element => element.parentNode), 'Resolution failures preserve the existing presentation');
state.resolve = resolve;
console.log('PASS headless saved placement restoration, scoped bonds, current footprint geometry and isolated SVG projection');
