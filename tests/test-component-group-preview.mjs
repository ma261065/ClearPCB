import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { Component } from '../src/components/Component.js';
import { Track } from '../src/shapes/track.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { capturePlacementOverride } from '../src/core/PcbPlacementState.js';
import { getPlacementPreviewTracks } from '../src/pcb/modules/track-commands.js';
import { setPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { beginGroupDrag, updateGroupDrag, scheduleGroupDrag, endGroupDrag, cancelGroupDrag, getGroupDrag } from '../src/pcb/modules/box-select.js';
import { getSelectionInteraction, setSelectionInteraction } from '../src/pcb/modules/selection-interaction.js';
import { renderTrack, hasTrackElements } from '../src/pcb/modules/track-render.js';
import { loadPcb } from '../src/pcb/modules/project-state.js';
import { areDragOverlaysDeferred, setDragOverlaysDeferred } from '../src/pcb/modules/refresh-state.js';

class Element {
    constructor(tag) { this.tag = tag; this.attributes = new Map(); this.dataset = {}; this.children = []; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
    remove() { this.parentNode?.removeChild(this); }
}
globalThis.document = { createElementNS: (_, tag) => new Element(tag) };
const frames = new Map();
let frameId = 0;
globalThis.window = {
    addEventListener() {},
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
function fixture(saved) {
    const project = new ProjectDocument();
    for (const id of ['a', 'b', 'unselected']) project.schematicDocument.components.push(new Component({
        name: 'GroupFixture', _source: 'KiCad', symbol: { pins: [{ number: '1' }] },
        footprintShapes: ['PAD~RECT~2~1~1~1~1~both~1~0~0.5', 'PAD~RECT~-2~-1~1~1~1~both~1~0~0.5'],
    }, { id }));
    const state = project.pcbDocument.placementState;
    if (saved) {
        state.record('a', { x: Math.PI, y: -Math.E, rotation: 37.125, side: 'bottom', mirror: true });
        state.record('b', { x: 40.123456789, y: 25.123456789, rotation: 90.125, mirror: true });
    }
    const placements = project.resolvePcbLayout().placements;
    const first = placements.get('a').pads.get('1'), last = placements.get('b').pads.get('1#2');
    const shared = new Track({
        points: [{ x: first.x, y: first.y }, { x: 25, y: 0 }, { x: last.x, y: last.y }],
        padConnections: { n0: { componentId: 'a', pinNumber: '1' }, n2: { componentId: 'b', pinNumber: '1#2' } },
    });
    const unrelated = new Track({ points: [{ x: 90, y: 90 }, { x: 100, y: 100 }] });
    project.pcbDocument.tracks.push(shared, unrelated);
    const copper = new Element('g');
    let trackRenders = 0;
    const app = {
        project, pcbDocument: project.pcbDocument, placementState: state, placements,
        get tracks() { return getPlacementPreviewTracks(this) || this.pcbDocument.tracks; },
        vias: [], pads: [], boardShapes: [], texts: new Map(), history: new CommandHistory(),
        netlist: [{ net: 'N', pins: [{ componentId: 'a' }, { componentId: 'b' }] }],
        _layerGroups: new Map(),
        viewport: { scale: 10, gridVisible: false, snapToGrid: false, svg: { style: {} },
            getVisibleBounds: () => ({ minX: -100, minY: -100, maxX: 150, maxY: 150 }) },
        existingLayerGroups() { return this._layerGroups; },
        getLayerGroup(id) {
            if (id !== 'top-copper') return null;
            trackRenders++;
            return copper;
        },
        _cancelPosePreviews: PCBApp.prototype._cancelPosePreviews, _cancelDrawingMode: () => false,
    };
    setPcbSelection(app, [{ kind: 'component', object: 'a' }, { kind: 'component', object: 'b' }]);
    for (const track of app.tracks) renderTrack(track, id => app.getLayerGroup(id));
    trackRenders = 0;
    return { app, project, shared, unrelated, trackRenders: () => trackRenders,
        lines: () => copper.children.filter(element => element.tag === 'polyline').length };
}
for (const saved of [false, true]) for (const finish of ['commit', 'cancel', 'no-op', 'deactivate', 'legacy-deactivate', 'failure']) {
    const f = fixture(saved), { app, project, shared, unrelated } = f;
    const original = project.pcbDocument.captureGeometry();
    const serialized = project.pcbDocument.serialize();
    const graph = shared.captureState(), bounds = shared.getBounds();
    const poses = new Map([...app.placements].map(([id, pose]) => [id, capturePlacementOverride(pose)]));
    const other = app.placements.get('unselected');
    const lines = f.lines();
    const verifyBonds = () => {
        const displayed = app.tracks[0];
        for (const [node, componentId, padId] of [['n0', 'a', '1'], ['n2', 'b', '1#2']]) {
            const pad = app.placements.get(componentId).pads.get(padId);
            assert.deepEqual(displayed.nodes.get(node), { x: pad.x, y: pad.y });
        }
    };
    beginGroupDrag(app, { x: 0, y: 0 });
    assert.equal(getGroupDrag(app).posePreview, true);
    assert.equal(getPlacementPreviewTracks(app), undefined, 'Picking up a group does not clone tracks');
    updateGroupDrag(app, { x: 3, y: -4 }, { snap: false });
    const projected = app.tracks[0];
    assert.notEqual(projected, shared);
    assert.equal(app.tracks[1], unrelated);
    assert.equal(f.trackRenders(), 1, 'Both moving endpoints share one preview track render');
    assert.equal(f.lines(), lines, 'Preview replaces canonical artwork without duplicate tracks');
    verifyBonds();
    for (let step = 1; step <= 100; step++) {
        updateGroupDrag(app, { x: 3 + step / 1000, y: -4 }, { snap: false });
        assert.equal(app.tracks[0], projected);
        assert.equal(f.lines(), lines);
        verifyBonds();
    }
    assert.equal(f.trackRenders(), 101, 'Each distinct group position renders the shared track once');
    updateGroupDrag(app, { x: 3.1, y: -4 }, { snap: false });
    assert.equal(f.trackRenders(), 101, 'An unchanged group position does no preview work');
    assert.deepEqual(project.pcbDocument.captureGeometry(), original);
    assert.deepEqual(project.pcbDocument.serialize(), serialized);
    assert.equal(shared._bounds, bounds);
    assert.equal(app.placements.get('unselected'), other);
    assert.equal(app.history.canUndo(), false);
    if (finish === 'commit') {
        scheduleGroupDrag(app, { x: 7.123456789, y: -8.123456789 });
        endGroupDrag(app);
        assert.equal(frames.size, 0, 'Drop flushes the final queued position');
        assert.equal(app.history.undoStack.length, 1);
        verifyBonds();
        for (const id of ['a', 'b']) {
            assert.equal(app.placements.get(id).x, poses.get(id).x + 7.123456789);
            assert.equal(app.placements.get(id).y, poses.get(id).y - 8.123456789);
        }
        const committed = shared.captureState();
        for (let cycle = 0; cycle < 2; cycle++) {
            app.history.undo();
            assert.deepEqual(shared.captureState(), graph);
            for (const id of ['a', 'b']) assert.deepEqual(capturePlacementOverride(app.placements.get(id)), poses.get(id));
            app.history.redo();
            assert.deepEqual(shared.captureState(), committed);
        }
    } else {
        if (finish === 'no-op') {
            updateGroupDrag(app, { x: 0, y: 0 }, { snap: false });
            endGroupDrag(app);
        } else if (finish.endsWith('deactivate')) {
            if (finish === 'deactivate') setSelectionInteraction(app, { mode: 'move' });
            PCBApp.prototype.deactivate.call(app);
            if (finish === 'deactivate') assert.equal(getSelectionInteraction(app), null);
        } else if (finish === 'failure') {
            project.schematicDocument.components = project.schematicDocument.components.filter(component => component.id !== 'b');
            assert.throws(() => endGroupDrag(app), /PCB footprint is no longer available: b/);
        } else {
            scheduleGroupDrag(app, { x: 50, y: 50 });
            cancelGroupDrag(app);
            assert.equal(frames.size, 0, 'Cancel discards queued motion');
        }
        assert.deepEqual(project.pcbDocument.captureGeometry(), original);
        assert.deepEqual(project.pcbDocument.serialize(), serialized, 'Cancel/no-op/failure authors neither component');
        for (const id of ['a', 'b']) assert.deepEqual(capturePlacementOverride(app.placements.get(id)), poses.get(id));
        assert.equal(app.history.canUndo(), false);
    }
    assert.equal(app.tracks, project.pcbDocument.tracks);
    assert.equal(getPlacementPreviewTracks(app), undefined);
    assert.equal(getGroupDrag(app), null);
    assert.equal(areDragOverlaysDeferred(app), false);
    assert.equal(f.lines(), lines);
    assert.ok(hasTrackElements(shared));
    assert.equal(hasTrackElements(projected), false);
}

for (const finish of ['commit', 'cancel', 'no-op']) {
    const { app } = fixture(false);
    setDragOverlaysDeferred(app, true);
    app.viewport.gridVisible = app.viewport.snapToGrid = true;
    app.viewport.gridSize = 1;
    const poses = new Map([...app.placements].map(([id, pose]) => [id, capturePlacementOverride(pose)]));
    const redo = { execute() {}, undo() {} };
    app.history.execute(redo);
    app.history.undo();
    beginGroupDrag(app, { x: 0, y: 0 });
    updateGroupDrag(app, { x: 0.1, y: 0.1 });
    assert.equal(getPlacementPreviewTracks(app), undefined, 'Unchanged snapped delta does not allocate a projection');
    updateGroupDrag(app, { x: 1.1, y: 2.1 });
    for (const id of ['a', 'b']) {
        assert.equal(app.placements.get(id).x, poses.get(id).x + 1);
        assert.equal(app.placements.get(id).y, poses.get(id).y + 2);
    }
    if (finish === 'cancel') cancelGroupDrag(app);
    else {
        if (finish === 'no-op') updateGroupDrag(app, { x: 0.1, y: 0.1 });
        endGroupDrag(app);
    }
    assert.equal(areDragOverlaysDeferred(app), true, 'Group completion preserves outer overlay deferral');
    assert.equal(app.history.canRedo(), finish !== 'commit');
    if (finish !== 'commit') assert.equal(app.history.redoStack[0], redo);
}

{
    const { app } = fixture(false);
    app._active = false;
    app._ensureViewport = () => {};
    app.markSectionClean = () => {};
    app._shapeElements = new Map();
    beginGroupDrag(app, { x: 0, y: 0 });
    updateGroupDrag(app, { x: 3, y: 4 }, { snap: false });
    const projected = app.tracks[0];
    scheduleGroupDrag(app, { x: 5, y: 6 });
    loadPcb(app, null);
    assert.equal(getPlacementPreviewTracks(app), undefined);
    assert.equal(hasTrackElements(projected), false);
    assert.equal(app.pcbDocument.tracks.length, 0);
    assert.equal(app.placements.size, 0);
    assert.equal(getGroupDrag(app), null);
    assert.equal(frames.size, 0);
}

{
    const { app, shared } = fixture(false);
    setPcbSelection(app, [{ kind: 'component', object: 'a' }, { kind: 'track', object: shared }]);
    beginGroupDrag(app, { x: 0, y: 0 });
    assert.equal(getGroupDrag(app).posePreview, true, 'Groups with directly selected tracks also isolate preview ownership');
    cancelGroupDrag(app);
}
console.log('PASS component-only group preview isolation, shared-track reuse, pending movement, cancellation, failure preflight and history');
