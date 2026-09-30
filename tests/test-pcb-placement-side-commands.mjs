import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { Component } from '../src/components/Component.js';
import { Track } from '../src/shapes/track.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { MovePlacementCommand, SetPlacementSideCommand } from '../src/core/pcb-placement-commands.js';
import { capturePlacementOverride } from '../src/core/PcbPlacementState.js';

assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
const definition = (distance = 4) => ({
    name: 'SideFixture', _source: 'KiCad', symbol: { pins: [] },
    footprintShapes: [
        'PAD~RECT~2~0~1~1~1~top', 'PAD~RECT~0~2~1~1~2~bottom',
        `PAD~RECT~-${distance}~-2~1~1~3~both~1~0~0.5`,
        `PAD~RECT~${distance}~0~1~1~3~both~1~0~0.5`,
        'PAD~RECT~0~0~1~1~4~top',
        'PASTE~RECT~0~0~0.5~0.5~top', 'PASTE~RECT~0~0~0.5~0.5~bottom',
    ],
});
class ObservedSideCommand extends SetPlacementSideCommand {
    _apply(side, restore = false) {
        this.result = super._apply(side, restore);
        return this.result;
    }
}
for (const side of ['top', 'bottom']) for (const mirror of [false, true]) {
    const project = new ProjectDocument();
    const component = new Component(definition(), { id: 'part' });
    project.schematicDocument.components.push(component);
    const model = project.pcbDocument, state = model.placementState;
    const initial = { x: Math.PI, y: -Math.E, rotation: 37.123456, side, mirror, refDx: 1.234567, locked: true };
    state.record('part', initial);
    const current = () => state.overrides.get('part');
    const copper = side === 'top' ? 'top-copper' : 'bottom-copper';
    const opposite = side === 'top' ? 'bottom-copper' : 'top-copper';
    const attached = (pinNumber, layer, componentId = 'part') => new Track({
        points: [{ x: 0, y: 0 }, { x: 30, y: 0 }], layer,
        padConnections: { n0: { componentId, pinNumber } },
    });
    const top = attached('1', copper), bottom = attached('2', opposite);
    const through = attached('3', 'top-copper'), duplicate = attached('3#2', 'bottom-copper');
    const centre = attached('4', copper), mixed = attached('1', copper);
    const branch = mixed.addNode(20, 20);
    mixed.addEdge('n0', branch, { layer: opposite, width: 0.2, bulge: 0 });
    const isolated = new Track({ graphNodes: { a: { x: initial.x, y: initial.y } }, graphEdges: {}, layer: copper,
        padConnections: { a: { componentId: 'part', pinNumber: '4' } } });
    const combined = attached('1', copper);
    combined.padConnections.set('n1', { componentId: 'part', pinNumber: '3#2' });
    const unrelated = attached('1', copper, 'other');
    model.tracks.push(top, bottom, through, duplicate, centre, mixed, isolated, combined, unrelated);
    new MovePlacementCommand(project, 'part', initial.x, initial.y, initial.x, initial.y).execute();
    const before = model.tracks.map(track => track.captureState());
    const maps = model.tracks.map(track => track.padConnections);
    const poseBefore = structuredClone(current());
    const command = new ObservedSideCommand(project, 'part', side === 'top' ? 'bottom' : 'top',
        { ...initial, side: side === 'top' ? 'bottom' : 'top', x: 999 });
    assert.equal(command.before, side, 'Canonical side takes precedence over a stale generated placement');
    assert.equal(command._bonds, null);
    assert.deepEqual(model.tracks.map(track => track.captureState()), before, 'Construction is read-only');
    const history = new CommandHistory();
    const checkPosition = (track, dx, dy, nodeId = 'n0') => {
        const pose = current(), radians = pose.rotation * Math.PI / 180;
        const sign = pose.mirror !== (pose.side === 'bottom') ? -1 : 1;
        const node = track.nodes.get(nodeId);
        assert.ok(Math.abs(node.x - (pose.x + sign * dx * Math.cos(radians) - dy * Math.sin(radians))) < 1e-12);
        assert.ok(Math.abs(node.y - (pose.y + sign * dx * Math.sin(radians) + dy * Math.cos(radians))) < 1e-12);
    };
    for (let cycle = 0; cycle < 2; cycle++) {
        const borrowed = top.padConnections.get('n0');
        if (cycle === 0) history.execute(command);
        else history.redo();
        for (const track of [top, bottom, centre, isolated]) assert.equal(track.padConnections.size, 0);
        for (const track of [through, duplicate, mixed]) assert.equal(track.padConnections.size, 1);
        assert.deepEqual(top.nodes.get('n0'), before[0].nodes.n0, 'Disconnected SMD endpoints stay where they were');
        assert.deepEqual(bottom.nodes.get('n0'), before[1].nodes.n0);
        checkPosition(through, -4, -2);
        checkPosition(duplicate, 4, 0);
        checkPosition(mixed, 2, 0);
        assert.equal(combined.padConnections.has('n0'), false);
        assert.equal(combined.padConnections.has('n1'), true);
        assert.deepEqual(combined.nodes.get('n0'), before[7].nodes.n0);
        checkPosition(combined, 4, 0, 'n1');
        assert.deepEqual(command.result.tracks, new Set(model.tracks.slice(0, -1)),
            'Disconnection and movement on one track produce one touched-track entry');
        assert.deepEqual(unrelated.captureState(), before.at(-1));
        borrowed.pinNumber = 'changed-outside-history';
        history.undo();
        assert.deepEqual(model.tracks.map(track => track.captureState()), before, 'Undo owns copies of connection records');
        assert.deepEqual(current(), poseBefore);
        assert.ok(command.result.tracks.has(centre), 'Restored bonds redraw even when the endpoint did not move');
        assert.ok(command.result.tracks.has(isolated));
        assert.equal(command.result.tracks.has(unrelated), false, 'Unchanged unrelated tracks do not need redraw');
        for (const [index, track] of model.tracks.entries()) assert.equal(track.padConnections, maps[index]);
    }
    history.redo();
    component.definition = definition(6);
    state.record('part', { ...current(), refSize: 2.345678 });
    // Graph history can recreate the connection/node maps without replacing the track.
    through.applyState(through.captureState());
    history.undo();
    checkPosition(through, -6, -2);
    checkPosition(duplicate, 6, 0);
    assert.equal(current().refSize, 2.345678, 'Undo only changes the authored side field');
    assert.equal(current().refDx, initial.refDx);
    const added = attached('3#2', 'bottom-copper');
    model.tracks.push(added);
    history.redo();
    const refreshedSnapshot = command._bonds;
    const graphAfter = model.tracks.map(track => track.captureState());
    const poseAfter = structuredClone(current());
    project.schematicDocument.components.length = 0;
    assert.throws(() => history.undo(), /PCB footprint is no longer available: part/);
    assert.deepEqual(model.tracks.map(track => track.captureState()), graphAfter, 'Failed undo does not restore any bonds');
    assert.deepEqual(current(), poseAfter);
    assert.equal(command._bonds, refreshedSnapshot);
    assert.equal(history.undoStack.length, 1);
    project.schematicDocument.components.push(component);
    history.undo();
    assert.equal(added.padConnections.get('n0').pinNumber, '3#2', 'Redo takes a fresh snapshot of current bonds');
    project.schematicDocument.components.length = 0;
    const undone = model.tracks.map(track => track.captureState());
    assert.throws(() => history.redo(), /PCB footprint is no longer available: part/);
    assert.deepEqual(model.tracks.map(track => track.captureState()), undone);
    assert.equal(command._bonds, refreshedSnapshot, 'Failed redo does not replace its last good snapshot');
    assert.equal(history.redoStack.length, 1);
    project.schematicDocument.components.push(component);
    history.redo();
    assert.notEqual(command._bonds, refreshedSnapshot);
    assert.equal(model.placementState.serialize().part.refSize, 2.3457);
    assert.equal(current().refSize, 2.345678);
    assert.deepEqual(Object.keys(current()), Object.keys(capturePlacementOverride(initial)));
    assert.ok(model.tracks.every(track => !('_svgElements' in track)));
    assert.equal(new ProjectDocument().pcbDocument.placementState.overrides.size, 0);
}
{
    const project = new ProjectDocument();
    project.schematicDocument.components.push(new Component(definition(), { id: 'part' }));
    const artwork = {}; artwork.self = artwork;
    const seed = { x: Math.PI, y: -Math.E, side: 'top', elements: [artwork] };
    const expected = capturePlacementOverride(seed);
    const command = new SetPlacementSideCommand(project, 'part', 'bottom', seed);
    assert.equal(project.pcbDocument.serializeSection(), null, 'Construction does not seed automatic placements');
    seed.x = 999;
    command.execute();
    command.undo();
    assert.deepEqual(project.pcbDocument.placementState.overrides.get('part'), expected);
    assert.throws(() => new SetPlacementSideCommand(project, 'missing', 'bottom'), /PCB placement is no longer available/);
}
assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
console.log('PASS model side-change history, owned bonds, current footprints, isolation and recoverable failures');
