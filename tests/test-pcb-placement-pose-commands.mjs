import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { Component } from '../src/components/Component.js';
import { Track } from '../src/shapes/track.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { capturePlacementOverride } from '../src/core/PcbPlacementState.js';
import { MovePlacementCommand, RotatePlacementCommand, FlipPlacementCommand } from '../src/core/pcb-placement-commands.js';

assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
const definition = distance => ({
    name: 'BondedFootprint', _source: 'KiCad', symbol: { pins: [{ number: '1' }] },
    footprintShapes: [`PAD~RECT~-${distance}~0~1~1~1~both~1~0~0.5`,
        `PAD~RECT~${distance}~0~1~1~1~both~1~0~0.5`],
});
const seed = { x: Math.PI, y: -Math.E, rotation: 37.123456, refDx: 3.123456, refRot: 90, locked: true };
for (const side of ['top', 'bottom']) for (const mirror of [false, true]) {
    const project = new ProjectDocument();
    const component = new Component(definition(2), { id: 'part' });
    project.schematicDocument.components.push(component);
    const model = project.pcbDocument, state = model.placementState;
    state.record('part', { ...seed, side, mirror });
    state.record('other', { x: 50, y: 50 });
    const other = structuredClone(state.overrides.get('other'));
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
        padConnections: { n0: { componentId: 'part', pinNumber: '1' }, n1: { componentId: 'part', pinNumber: '1#2' } } });
    model.tracks.push(track);
    const untouched = new Track({ points: [{ x: 100, y: 100 }, { x: 101, y: 100 }],
        padConnections: { n0: { componentId: 'other', pinNumber: '1' } } });
    model.tracks.push(untouched);
    const untouchedGraph = untouched.captureState();
    const graphNodes = track.nodes, bonds = track.padConnections, overrides = state.overrides;
    const pose = () => state.overrides.get('part');
    const verify = (distance = 2) => {
        const current = pose();
        const radians = current.rotation * Math.PI / 180;
        const sign = current.mirror !== (current.side === 'bottom') ? -1 : 1;
        for (const [id, offset] of [['n0', -distance], ['n1', distance]]) {
            const node = track.nodes.get(id);
            assert.ok(Math.abs(node.x - (current.x + sign * offset * Math.cos(radians))) < 1e-12);
            assert.ok(Math.abs(node.y - (current.y + sign * offset * Math.sin(radians))) < 1e-12);
        }
        assert.equal(track.nodes, graphNodes);
        assert.equal(track.padConnections, bonds);
        assert.equal(state.overrides, overrides);
        assert.deepEqual(state.overrides.get('other'), other);
        assert.deepEqual(untouched.captureState(), untouchedGraph);
    };
    new MovePlacementCommand(project, 'part', seed.x, seed.y, seed.x, seed.y).execute();
    verify();
    const snapshot = () => ({ pose: structuredClone(pose()), graph: track.captureState() });
    const assertSnapshot = expected => {
        const actual = snapshot();
        assert.ok(Math.abs(actual.pose.rotation - expected.pose.rotation) < 1e-12);
        assert.deepEqual({ ...actual.pose, rotation: expected.pose.rotation }, expected.pose);
        for (const [id, point] of Object.entries(expected.graph.nodes)) {
            assert.ok(Math.abs(actual.graph.nodes[id].x - point.x) < 1e-12);
            assert.ok(Math.abs(actual.graph.nodes[id].y - point.y) < 1e-12);
        }
        assert.deepEqual({ ...actual.graph, nodes: expected.graph.nodes }, expected.graph);
    };
    const snapshots = [snapshot()];
    const history = new CommandHistory();
    for (const create of [
        () => new MovePlacementCommand(project, 'part', seed.x, seed.y, -4.234567, 5.345678),
        () => new RotatePlacementCommand(project, 'part', seed.rotation, -270.123456),
        () => new FlipPlacementCommand(project, 'part', 'H'),
        () => new FlipPlacementCommand(project, 'part', 'V'),
    ]) {
        track.getBounds();
        history.execute(create());
        verify();
        assert.equal(track._bounds, null, 'Model mutations invalidate track bounds without rendering');
        assert.equal(pose().refDx, seed.refDx);
        assert.equal(pose().locked, true);
        snapshots.push(snapshot());
    }
    assert.ok(Math.abs(snapshots[2].pose.rotation - 89.876544) < 1e-12);
    for (let cycle = 0; cycle < 2; cycle++) {
        for (let index = snapshots.length - 2; index >= 0; index--) {
            assert.equal(history.undo(), true);
            assertSnapshot(snapshots[index]);
            verify();
        }
        for (let index = 1; index < snapshots.length; index++) {
            assert.equal(history.redo(), true);
            assertSnapshot(snapshots[index]);
            verify();
        }
    }
    const beforePending = pose();
    const pending = new MovePlacementCommand(project, 'part', beforePending.x, beforePending.y, 7, 8);
    state.record('part', { ...pose(), rotation: 123.456789, refSize: 2.345678 });
    component.definition = definition(4);
    pending.execute();
    verify(4);
    pending.undo();
    verify(4);
    assert.equal(pose().rotation, 123.456789, 'Sparse pose edits preserve current unrelated authored fields');
    assert.equal(pose().refSize, 2.345678);
    assert.equal('elements' in pose(), false);
    assert.equal('_svgElements' in track, false);
    assert.equal(new ProjectDocument().pcbDocument.placementState.overrides.size, 0);
    const saved = model.placementState.serialize().part;
    assert.equal(saved.rotation, 123.4568);
    assert.equal(pose().rotation, 123.456789);
}

{
    const project = new ProjectDocument();
    const component = new Component(definition(2), { id: 'part' });
    project.schematicDocument.components.push(component);
    const state = project.pcbDocument.placementState;
    const artwork = {}; artwork.self = artwork;
    const initial = { ...seed, elements: [artwork], pads: new Map() };
    const baseline = capturePlacementOverride(initial);
    const move = new MovePlacementCommand(project, 'part', seed.x, seed.y, 10, 20, initial);
    assert.equal(project.pcbDocument.serializeSection(), null, 'Construction does not seed automatic placements');
    initial.refDx = 999;
    move.execute();
    move.undo();
    assert.deepEqual(state.overrides.get('part'), baseline);
    const stale = { ...baseline, rotation: 999, mirror: true };
    const flip = new FlipPlacementCommand(project, 'part', 'H', stale);
    flip.execute();
    flip.undo();
    assert.ok(Math.abs(state.overrides.get('part').rotation - baseline.rotation) < 1e-12);
    assert.deepEqual({ ...state.overrides.get('part'), rotation: baseline.rotation }, baseline,
        'Canonical pose takes precedence over a stale projection');
    const history = new CommandHistory();
    history.execute(move);
    project.schematicDocument.components.length = 0;
    history.undo();
    assert.equal(state.overrides.get('part').x, seed.x);
    assert.equal(state.overrides.get('part').y, seed.y);
    assert.equal(project.schematicDocument.components.length, 0, 'PCB undo never recreates a deleted schematic component');
    assert.equal(history.redoStack.length, 1);
    assert.equal(history.undoStack.length, 0);
    history.redo();
    assert.equal(project.schematicDocument.components.length, 0);
    assert.equal(state.overrides.get('part').x, 10);
    project.schematicDocument.components.push(component);
    assert.equal(project.resolvePcbLayout().placements.get('part').x, 10,
        'Restoring the schematic component uses the latest PCB history pose');
    const missing = new MovePlacementCommand(project, 'missing', 0, 0, 1, 1, { x: 0, y: 0 });
    assert.throws(() => history.execute(missing), /PCB footprint is no longer available: missing/);
    assert.equal(state.overrides.has('missing'), false);
    assert.equal(history.undoStack.length, 1);
}
assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
console.log('PASS headless physical placement commands, current footprints, bonded tracks and recoverable history failures');
