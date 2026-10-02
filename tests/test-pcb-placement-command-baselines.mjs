import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { Component } from '../src/components/Component.js';
import { Track } from '../src/shapes/track.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { capturePlacementOverride } from '../src/core/PcbPlacementState.js';
import * as modelCommands from '../src/core/pcb-placement-commands.js';
import * as editorCommands from '../src/pcb/modules/track-commands.js';

assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');

const definition = {
    name: 'BaselineFixture', _source: 'KiCad', symbol: { pins: [{ number: '1' }, { number: '2' }] },
    footprintShapes: [
        'PAD~RECT~-2~0~1~1~1~both~1~0~0.5',
        'PAD~RECT~2~0~1~1~1~both~1~0~0.5',
        'PAD~RECT~0~2~1~1~2~top',
    ],
};
const cases = [
    { name: 'MovePlacementCommand', physical: true,
        args: p => [p.x, p.y, Math.PI, -Math.E], patch: () => ({ x: Math.PI, y: -Math.E }) },
    { name: 'RotatePlacementCommand', physical: true,
        args: p => [p.rotation, 90.125], patch: () => ({ rotation: 90.125 }) },
    ...['H', 'V'].map(axis => ({ name: 'FlipPlacementCommand', physical: true,
        args: () => [axis], patch: p => ({
            mirror: !p.mirror, rotation: axis === 'H' ? (360 - p.rotation) % 360 : (540 - p.rotation) % 360,
        }) })),
    { name: 'SetPlacementSideCommand', physical: true,
        args: p => [p.side === 'top' ? 'bottom' : 'top'],
        patch: p => ({ side: p.side === 'top' ? 'bottom' : 'top' }) },
    { name: 'SetPlacementLockedCommand', args: () => [true], patch: () => ({ locked: true }) },
    { name: 'SetPlacementRefVisibleCommand', args: () => [false], patch: () => ({ refVisible: false }) },
    { name: 'MoveRefTextCommand', args: p => [p.refDx, p.refDy, Math.PI, -Math.E],
        patch: () => ({ refDx: Math.PI, refDy: -Math.E }) },
    { name: 'RotateRefTextCommand', args: p => [p.refRot, 90.125], patch: () => ({ refRot: 90.125 }) },
    { name: 'SetRefStyleCommand',
        args: p => [{ refSize: p.refSize, refStrokeWidth: p.refStrokeWidth },
            { refSize: Math.PI, refStrokeWidth: 0.123456789 }],
        patch: () => ({ refSize: Math.PI, refStrokeWidth: 0.123456789 }) },
];

for (const saved of [false, true]) for (const mode of ['headless', 'stale-seed', 'editor']) for (const test of cases) {
    const project = new ProjectDocument();
    project.schematicDocument.components.push(new Component(structuredClone(definition), { id: 'part' }),
        new Component(structuredClone(definition), { id: 'other' }));
    const state = project.pcbDocument.placementState;
    if (saved) state.record('part', {
        x: 7.123456789, y: -6.123456789, rotation: 37.125, side: 'bottom', mirror: true,
        refDx: 1.23456789, refDy: -2.3456789, refRot: 23.125, refSize: 1.23456789, refStrokeWidth: 0.23456789,
    });
    const placements = project.resolvePcbLayout().placements;
    const baseline = capturePlacementOverride(placements.get('part'));
    const slotsBefore = structuredClone(state.autoSlots);
    const overridesBefore = structuredClone(state.overrides);
    const revision = project.fileManager.revision;
    const pads = placements.get('part').pads;
    const track = new Track({
        points: [...pads.values()].map(({ x, y }) => ({ x, y })), layer: `${baseline.side}-copper`,
        padConnections: {
            n0: { componentId: 'part', pinNumber: '1' },
            n1: { componentId: 'part', pinNumber: '1#2' },
            n2: { componentId: 'part', pinNumber: '2' },
        },
    });
    project.pcbDocument.tracks.push(track);
    const graphBefore = track.captureState();
    const stale = {};
    for (const key of Object.keys(baseline)) Object.defineProperty(stale, key, {
        get() { assert.fail(`A model-resolved command must not read preview field ${key}`); },
    });
    let dirty = 0;
    const app = {
        project, pcbDocument: project.pcbDocument, placementState: state,
        placements: new Map([['part', stale]]), tracks: project.pcbDocument.tracks,
        getLayerGroup: () => null, _markDirty: () => dirty++,
    };
    const api = mode === 'editor' ? editorCommands : modelCommands;
    const owner = mode === 'editor' ? app : test.physical ? project : state;
    const command = new api[test.name](owner, 'part', ...test.args(baseline),
        mode === 'stale-seed' ? stale : undefined);
    assert.deepEqual(command.initial, baseline, `${test.name} starts from the model, including automatic defaults`);
    assert.deepEqual(state.overrides, overridesBefore, 'Constructing a command does not create an override');
    assert.deepEqual(state.autoSlots, slotsBefore, 'Constructing a command does not allocate or move slots');
    assert.deepEqual(track.captureState(), graphBefore);
    assert.equal(project.fileManager.revision, revision);
    if (!saved) {
        state.autoSlots.get('part').x = 999;
        assert.equal(command.initial.x, baseline.x, 'History owns a detached automatic baseline');
        state.autoSlots.get('part').x = baseline.x;
    }
    app.placements = placements;
    const history = new CommandHistory();
    history.execute(command);
    const expected = { ...baseline, ...test.patch(baseline) };
    assert.deepEqual(state.overrides.get('part'), expected, 'Only the requested fields become authored changes');
    const graphAfter = track.captureState();
    if (test.physical) {
        const resolvedPads = project.resolvePcbLayout().placements.get('part').pads;
        for (const [id, connection] of track.padConnections) {
            const pad = resolvedPads.get(connection.pinNumber);
            assert.deepEqual(track.nodes.get(id), { x: pad.x, y: pad.y });
        }
        assert.equal(track.padConnections.has('n2'), test.name !== 'SetPlacementSideCommand',
            'Side changes still detach incompatible SMD bonds');
    } else {
        assert.deepEqual(graphAfter, graphBefore, 'Metadata commands do not move copper or change bonds');
    }
    for (let cycle = 0; cycle < 2; cycle++) {
        assert.equal(history.undo(), true);
        assert.deepEqual(state.overrides.get('part'), baseline, 'First-edit undo retains the canonical baseline');
        assert.deepEqual(track.captureState(), graphBefore);
        assert.equal(history.redo(), true);
        assert.deepEqual(state.overrides.get('part'), expected);
        assert.deepEqual(track.captureState(), graphAfter);
    }
    assert.deepEqual(state.autoSlots, slotsBefore);
    assert.equal(state.overrides.has('other'), false);
    assert.equal(dirty, mode === 'editor' ? 5 : 0, 'Editor history retains exactly one dirty notification per operation');
    assert.equal(typeof document, 'undefined');
    assert.equal(typeof window, 'undefined');
}

{
    const project = new ProjectDocument();
    project.schematicDocument.components.push(new Component(structuredClone(definition), { id: 'part' }));
    const state = project.pcbDocument.placementState;
    project.resolvePcbLayout();
    const pending = new modelCommands.SetPlacementLockedCommand(state, 'part', true);
    const latest = state.record('part', { x: Math.PI, y: -Math.E, rotation: 37.125, refDx: 3.456789 });
    pending.execute();
    assert.deepEqual(state.overrides.get('part'), { ...latest, locked: true },
        'Pending automatic commands preserve unrelated fields committed after construction');
    pending.undo();
    assert.deepEqual(state.overrides.get('part'), latest);
    state.load({});
    assert.throws(() => new modelCommands.SetPlacementLockedCommand(state, 'part', true),
        /PCB placement is no longer available: part/, 'Load discards the old automatic baseline');
}
console.log('PASS model-owned automatic command baselines, preview-free capture, bonded copper and headless/editor history');
