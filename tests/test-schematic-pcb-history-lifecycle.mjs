import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { Component } from '../src/components/Component.js';
import { SelectionManager } from '../src/core/SelectionManager.js';
import { Track } from '../src/shapes/track.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { AddTrackCommand } from '../src/core/pcb-track-commands.js';
import { DeleteComponentsCommand } from '../src/schematic/modules/commands.js';
import { capturePlacementOverride } from '../src/core/PcbPlacementState.js';
import * as placementCommands from '../src/pcb/modules/track-commands.js';
import { ensureComponentView } from '../src/schematic/render/shape-view-state.js';

globalThis.window = { addEventListener() {} };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { runPcbHistoryAction } = await import('../src/pcb/modules/editor-actions.js');
const definition = {
    name: 'LifecycleFixture', _source: 'KiCad', symbol: { pins: [{ number: '1' }] },
    footprintShapes: ['PAD~RECT~2~0~1~1~1~both~1~0~0.5'],
};
function schematicView(project) {
    return {
        components: project.schematicDocument.components, shapes: project.schematicDocument.shapes,
        viewport: { contentLayer: {}, addComponentContent() {} }, selection: new SelectionManager(),
        _updateSelectableItems() {}, fileManager: project.fileManager,
    };
}
const padPoint = (layout, id) => {
    const { x, y } = layout.placements.get(id).pads.get('1');
    return { x, y };
};

for (const routed of [false, true]) for (const overridden of [false, true]) {
    const project = new ProjectDocument();
    for (const id of ['A', 'B', 'C', 'D']) {
        project.schematicDocument.components.push(new Component(structuredClone(definition), { id, reference: id }));
    }
    const initial = project.synchronizePcbLayout();
    const start = padPoint(initial, 'B');
    const track = new Track({
        points: [start, { x: start.x + 5, y: start.y }],
        padConnections: { n0: { componentId: 'B', pinNumber: '1' } },
    });
    if (routed) new AddTrackCommand(project.pcbDocument, track).execute();
    const schematic = schematicView(project);
    new DeleteComponentsCommand(schematic, [schematic.components[0]]).execute();
    const state = project.pcbDocument.placementState;
    if (overridden) state.record('D', { ...initial.placements.get('D'), x: 77, locked: true, refSize: 2, refDx: 3 });
    const before = project.synchronizePcbLayout();
    const overrides = structuredClone(state.overrides);
    const slots = structuredClone(state.autoSlots);
    const saved = project.serialize();
    assert.deepEqual(state.overrides, overrides, 'Saving does not promote derived positions in the live model');
    assert.deepEqual(state.autoSlots, slots);
    const copy = new ProjectDocument();
    await copy.load(saved);
    const after = copy.synchronizePcbLayout();
    for (const [id, placement] of before.placements) {
        assert.deepEqual(capturePlacementOverride(after.placements.get(id)), capturePlacementOverride(placement),
            'Deletion must not reflow surviving placements after reopening, even before routing');
    }
    assert.equal(after.placements.has('A'), false, 'Remembered automatic positions do not resurrect components');
    if (routed) {
        assert.deepEqual(copy.pcbDocument.tracks[0].captureState(), track.captureState());
        assert.deepEqual(copy.pcbDocument.tracks[0].nodes.get('n0'), padPoint(after, 'B'));
    }
}

for (const [name, args] of [
    ['MovePlacementCommand', [10, -10, 30, 20]],
    ['RotatePlacementCommand', [0, 90]],
    ['FlipPlacementCommand', ['H']],
    ['SetPlacementSideCommand', ['bottom']],
]) {
    const project = new ProjectDocument();
    const part = new Component(structuredClone(definition), { id: 'part' });
    ensureComponentView(part).element = {};
    project.schematicDocument.components.push(part);
    const initial = project.resolvePcbLayout();
    const start = padPoint(initial, 'part');
    const bonded = new Track({ points: [start, { x: start.x + 5, y: start.y }],
        padConnections: { n0: { componentId: 'part', pinNumber: '1' } } });
    project.pcbDocument.tracks.push(bonded);
    const baseline = bonded.captureState();
    const pcb = {
        project, pcbDocument: project.pcbDocument, tracks: project.pcbDocument.tracks,
        _active: false, placements: new Map(), _layerGroups: new Map(), boardShapes: [],
        history: new CommandHistory(), _ensureViewport() {}, _renderPersistentObjects() {},
        _placeFootprints(placements) { this.placements = placements; },
        getLayerGroup: () => null, refreshClearanceHalos() {}, updateRatsnest() {},
        setStatus() {}, _hasContent: true,
        _clearPCBContent: PCBApp.prototype._clearPCBContent,
        _syncFromSchematic: PCBApp.prototype._syncFromSchematic,
        onSchematicChanged: PCBApp.prototype.onSchematicChanged,
    };
    project.registerView('pcb', pcb);
    const earlier = new Track({ points: [{ x: 100, y: 100 }, { x: 105, y: 100 }] });
    pcb.history.execute(new AddTrackCommand(project.pcbDocument, earlier));
    pcb.history.execute(new placementCommands[name](pcb, 'part', ...args));
    const applied = bonded.captureState();
    const appliedPose = structuredClone(project.pcbDocument.placementState.overrides.get('part'));
    const schematic = schematicView(project);
    const schematicHistory = new CommandHistory({ onChanged: () => project.notifySchematicChanged() });
    schematicHistory.execute(new DeleteComponentsCommand(schematic, [part]));
    pcb._active = true;
    pcb._syncFromSchematic();
    assert.equal(pcb.placements.size, 0);
    for (let cycle = 0; cycle < 2; cycle++) {
        assert.equal(runPcbHistoryAction(pcb, 'undo'), true);
        assert.deepEqual(bonded.captureState(), baseline, `${name}: missing-component undo restores bonded geometry`);
        assert.equal(runPcbHistoryAction(pcb, 'undo'), true);
        assert.equal(project.pcbDocument.tracks.includes(earlier), false, 'Earlier independent PCB history stays reachable');
        assert.equal(runPcbHistoryAction(pcb, 'redo'), true);
        assert.equal(runPcbHistoryAction(pcb, 'redo'), true);
        assert.deepEqual(bonded.captureState(), applied);
        assert.deepEqual(project.pcbDocument.placementState.overrides.get('part'), appliedPose);
        assert.equal(project.schematicDocument.components.length, 0, 'PCB history leaves schematic deletion intact');
        assert.equal(project.resolvePcbLayout().placements.size, 0);
    }
    schematicHistory.undo();
    pcb._syncFromSchematic();
    assert.deepEqual(bonded.nodes.get('n0'), padPoint(project.resolvePcbLayout(), 'part'),
        'Schematic undo restores the component at its independently redone PCB pose');
}
console.log('PASS automatic placement round trips and independent schematic/PCB history across component deletion');
