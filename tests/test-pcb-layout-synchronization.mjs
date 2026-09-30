import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { Component } from '../src/components/Component.js';
import { Track } from '../src/shapes/track.js';

assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
const definition = {
    name: 'SyncFixture', _source: 'KiCad', symbol: { pins: [{ number: '1' }, { number: '2' }] },
    footprintShapes: [
        'PAD~RECT~-2~1~1~1~1~top',
        'PAD~RECT~2~-1~1~1~1~both~1~0~0.5',
        'PAD~RECT~0~3~1~1~2~bottom',
    ],
};
function fixture(pose) {
    const project = new ProjectDocument();
    project.schematicDocument.components.push(new Component(structuredClone(definition), { id: 'part' }));
    project.pcbDocument.placementState.record('part', { x: Math.PI, y: -Math.E, ...pose });
    const copper = pose.side === 'bottom' ? 'bottom-copper' : 'top-copper';
    const opposite = copper === 'top-copper' ? 'bottom-copper' : 'top-copper';
    const connected = (pinNumber, layer, componentId = 'part') => new Track({
        points: [{ x: 100, y: 200 }, { x: 300, y: 400 }], layer,
        padConnections: { n0: { componentId, pinNumber } },
    });
    const tracks = [
        connected('1', copper), connected('1', opposite), connected('1#2', opposite),
        connected('2', opposite), connected('1', copper, 'other'),
    ];
    project.pcbDocument.tracks.push(...tracks);
    return { project, tracks };
}
for (const pose of [
    {}, { rotation: 37.123456789 }, { mirror: true }, { side: 'bottom' },
    { refDx: Math.PI }, { refDy: -Math.E }, { refRot: 23.123456789 },
    { side: 'bottom', mirror: true, rotation: 37.123456789, refDx: Math.PI },
]) {
    const { project, tracks } = fixture(pose);
    const before = tracks.map(track => track.captureState());
    const maps = tracks.map(track => ({ nodes: track.nodes, bonds: track.padConnections }));
    const overrides = structuredClone(project.pcbDocument.placementState.overrides);
    const revision = project.fileManager.revision;
    project.views.set('pcb', new Proxy({}, { get() { assert.fail('Model synchronization must not access an editor'); } }));
    project.resolvePcbLayout();
    assert.deepEqual(tracks.map(track => track.captureState()), before, 'Resolving layout remains a track-read-only query');
    const changes = tracks.map(track => {
        let count = 0;
        const invalidate = track.invalidate.bind(track);
        track.invalidate = () => { count++; invalidate(); };
        track.getBounds();
        return () => count;
    });
    const result = project.synchronizePcbLayout();
    assert.deepEqual(result.netlist, project.getNetlist());
    const placement = result.placements.get('part');
    const moves = Object.keys(pose).length > 0;
    for (const [index, track] of tracks.entries()) {
        assert.equal(track.nodes, maps[index].nodes);
        assert.equal(track.padConnections, maps[index].bonds);
        const disconnected = index === 1 && pose.side === 'bottom';
        assert.equal(track.padConnections.size, disconnected ? 0 : 1);
        if (index < 4 && moves && !disconnected) {
            const pad = placement.pads.get(track.padConnections.get('n0').pinNumber);
            assert.deepEqual(track.nodes.get('n0'), { x: pad.x, y: pad.y });
            assert.equal(track._bounds, null, 'Model synchronization invalidates moved track bounds');
        } else {
            assert.deepEqual(track.nodes.get('n0'), before[index].nodes.n0,
                'Unrelated, disconnected and default-pose endpoints preserve the existing rebuild policy');
        }
        assert.deepEqual(track.nodes.get('n1'), before[index].nodes.n1);
        if (index === 4 || !moves) assert.equal(changes[index](), 0);
    }
    assert.deepEqual(project.pcbDocument.placementState.overrides, overrides, 'Synchronization does not create pose edits');
    assert.equal(project.fileManager.revision, revision, 'Existing schematic change notifications retain dirty ownership');
    const after = tracks.map(track => track.captureState());
    const invalidations = changes.map(count => count());
    project.synchronizePcbLayout();
    assert.deepEqual(tracks.map(track => track.captureState()), after);
    assert.deepEqual(changes.map(count => count()), invalidations, 'Repeated synchronization does no redundant physical work');
    assert.equal(typeof document, 'undefined');
    assert.equal(typeof window, 'undefined');
}

{
    const { project, tracks } = fixture({ side: 'bottom' });
    project.schematicDocument.components.push(new Component(structuredClone(definition), { id: 'broken' }));
    const before = tracks.map(track => track.captureState());
    const state = project.pcbDocument.placementState;
    const resolve = state.resolve.bind(state);
    state.resolve = components => {
        Object.defineProperty(components[1], 'pins', { get() { throw new Error('Invalid footprint'); } });
        return resolve(components);
    };
    assert.throws(() => project.synchronizePcbLayout(), /Invalid footprint/);
    assert.deepEqual(tracks.map(track => track.captureState()), before,
        'Every footprint must resolve before any existing bond or endpoint is changed');
    assert.equal(state.autoSlots.size, 0);
    project.schematicDocument.getNetlist = () => { throw new Error('Invalid connectivity'); };
    assert.throws(() => project.synchronizePcbLayout(), /Invalid connectivity/);
    assert.deepEqual(tracks.map(track => track.captureState()), before);
}

globalThis.window = { addEventListener() {} };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
{
    const { project, tracks } = fixture({ side: 'bottom', rotation: 37.123456789 });
    let persistentRenders = 0, footprintRenders = 0;
    const app = {
        project, _active: true, boardShapes: [], _hasContent: true, _ensureViewport() {},
        _clearPCBContent() {
            assert.equal(tracks[1].padConnections.size, 0, 'Bond updates precede even clearing the old presentation');
        },
        _renderPersistentObjects() {
            persistentRenders++;
            const pad = project.resolvePcbLayout().placements.get('part').pads.get('1');
            assert.deepEqual(tracks[0].nodes.get('n0'), { x: pad.x, y: pad.y },
                'Persistent tracks render directly at their synchronized endpoints');
        },
        _placeFootprints(placements) {
            footprintRenders++;
            assert.equal(placements.get('part').side, 'bottom');
        },
        _getLayerGroup: () => null, _refreshClearanceHalos() {}, _updateRatsnest() {}, _setStatus() {},
    };
    PCBApp.prototype._syncFromSchematic.call(app);
    assert.equal(persistentRenders, 1);
    assert.equal(footprintRenders, 1);
    assert.deepEqual(app.netlist, project.getNetlist());
}
console.log('PASS headless layout/bond synchronization, preserved rebuild policy, idempotence and render ordering');
