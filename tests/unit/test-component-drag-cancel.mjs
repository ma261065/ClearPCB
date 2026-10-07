import assert from 'node:assert/strict';
import { ProjectDocument } from '../../src/core/ProjectDocument.js';
import { Component } from '../../src/components/Component.js';
import { Track } from '../../src/shapes/track.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { updatePlacementPadPositions } from '../../src/core/pcb-placement-geometry.js';
import { createComponentSelectionAdapter, getComponentDrag, handleComponentDrag, scheduleComponentDragUpdate } from '../../src/pcb/modules/component-selection.js';
import { getSelectionInteraction, setSelectionInteraction } from '../../src/pcb/modules/selection-interaction.js';
import { areDragOverlaysDeferred } from '../../src/pcb/modules/refresh-state.js';
import { clearanceOverlayState } from '../../src/pcb/modules/clearance-overlay.js';
import { isEditorActive, setEditorActive } from '../../src/pcb/modules/pcb-editor-api.js';

const frames = new Map();
let frameId = 0;
globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
globalThis.window = { addEventListener() {} };
globalThis.CSS = { escape: value => value };
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');

function fixture(saved = true) {
    const project = new ProjectDocument();
    project.schematicDocument.components.push(new Component({
        name: 'CancelFixture', _source: 'KiCad', symbol: { pins: [{ number: '1' }] },
        footprintShapes: ['PAD~RECT~2~0~1~1~1~both~1~0~0.5'],
    }, { id: 'part' }));
    const footprint = project.getPcbFootprint('part');
    const placement = { x: Math.PI, y: -Math.E, rotation: 37, side: 'bottom', mirror: true,
        padOffsets: footprint.padOffsets, pads: new Map() };
    updatePlacementPadPositions(placement);
    const pad = placement.pads.get('1');
    const track = new Track({
        points: [{ x: pad.x, y: pad.y }, { x: 40, y: 50 }],
        padConnections: { n0: { componentId: 'part', pinNumber: '1' } },
    });
    project.pcbDocument.tracks.push(track);
    if (saved) project.pcbDocument.placementState.record('part', placement);
    const padHalo = { style: {}, setAttribute() {} };
    const trackHalo = { style: {} };
    const overlay = { style: {}, querySelectorAll: selector => selector.startsWith('.debug-clearance[') ? [trackHalo] : [] };
    const renders = [];
    placement.elements = [{ setAttribute() { renders.push({ x: placement.x, y: placement.y }); },
        querySelectorAll: () => [], querySelector: () => null }];
    let dirty = 0;
    let clearanceRefreshes = 0;
    const ratsnestUpdates = [];
    const app = {
        project, pcbDocument: project.pcbDocument,
        get tracks() { return Object.getOwnPropertyDescriptor(PCBApp.prototype, 'tracks').get.call(this); },
        placements: new Map([['part', placement]]), history: new CommandHistory(),
        netlist: [{ net: 'GND', pins: [{ componentId: 'part' }] }],
        currentTool: 'select',
        _layerGroups: new Map([['clearance-overlay', overlay]]),
        viewport: { svg: { style: {} }, snapToGrid: false, gridVisible: true, hideCrosshair() {} },
        getLayerGroup: id => id === 'clearance-overlay' ? overlay : null,
        updateRatsnest: options => ratsnestUpdates.push(options),
        screenToWorld: event => ({ x: event.clientX, y: event.clientY }),
        screenToWorld: event => ({ x: event.clientX, y: event.clientY }),
        _markDirty: () => dirty++,
        refreshClearanceHalos() {
            clearanceRefreshes++;
            padHalo.style.display = '';
            trackHalo.style.display = '';
        },
    };
    Object.assign(clearanceOverlayState(app), {
        clearancesVisible: true,
        padHaloGroups: new Map([['part', padHalo]]),
    });
    for (const method of ['snapToGrid', 'snapToGrid', 'handleKeyDown', '_clearCursorCrosshair']) {
        app[method] = PCBApp.prototype[method];
    }
    const adapter = createComponentSelectionAdapter(app, 'part', 'component:part');
    const snapshot = () => ({
        x: placement.x, y: placement.y, pads: structuredClone(placement.pads),
        graph: track.captureState(),
        saved: structuredClone(project.pcbDocument.placementState.overrides),
    });
    const begin = (shared = true) => {
        assert.equal(adapter.beginMove({ x: 0, y: 0 }), true);
        if (shared) setSelectionInteraction(app, { mode: 'move-adapter', entry: adapter });
    };
    return { app, adapter, placement, track, snapshot, begin, renders, padHalo, trackHalo, overlay, ratsnestUpdates,
        dirty: () => dirty, clearanceRefreshes: () => clearanceRefreshes };
}

for (const saved of [false, true]) for (const shared of [true, false]) {
    const f = fixture(saved);
    const { app, adapter, placement, track } = f;
    const original = f.snapshot();
    let priorValue = 0;
    app.history.execute({ execute() { priorValue = 1; }, undo() { priorValue = 0; } });
    app.history.undo();
    const redo = [...app.history.redoStack];
    f.begin(shared);
    assert.equal(areDragOverlaysDeferred(app), true);
    assert.equal(f.padHalo.style.display, 'none');
    assert.equal(f.trackHalo.style.display, 'none');
    adapter.updateMove({ x: 4.234567, y: -5.345678 });
    assert.notEqual(placement.x, original.x);
    assert.notDeepEqual(app.tracks[0].captureState(), original.graph, 'Live preview moves projected bonded tracks');
    assert.deepEqual(track.captureState(), original.graph, 'Live preview leaves authored copper untouched');
    track.getBounds();
    const cachedBounds = track._bounds;
    const beforeCancelRenders = f.renders.length;
    scheduleComponentDragUpdate(app, { clientX: 100, clientY: 200, shiftKey: false });
    assert.equal(frames.size, 1);
    assert.equal(app.handleKeyDown({ key: 'Escape' }), true);
    assert.equal(getComponentDrag(app), null, 'Escape must end the component drag, not only its selection interaction');
    assert.equal(getSelectionInteraction(app) || null, null);
    assert.deepEqual(f.snapshot(), original, 'Cancel restores pose, pads and bonded nodes without saving preview data');
    assert.equal(track._bounds, cachedBounds, 'Discarding a preview does not invalidate authored track bounds');
    assert.deepEqual(f.renders.slice(beforeCancelRenders), [{ x: original.x, y: original.y }],
        'Cancel discards the pending move and presents only the restored pose');
    assert.equal(frames.size, 0);
    assert.equal(areDragOverlaysDeferred(app), false);
    assert.equal(f.overlay.style.willChange, '');
    assert.equal(f.padHalo.style.display, '');
    assert.equal(f.trackHalo.style.display, '');
    assert.equal(f.clearanceRefreshes(), 1);
    assert.equal(f.dirty(), 0);
    assert.equal(app.history.undoStack.length, 0);
    assert.deepEqual(app.history.redoStack, redo, 'Cancel preserves existing redo history');
    assert.equal(priorValue, 0);
}

for (const shared of [true, false]) {
    const f = fixture();
    const original = f.snapshot();
    let priorValue = 0;
    f.app.history.execute({ execute() { priorValue = 1; }, undo() { priorValue = 0; } });
    f.begin(shared);
    f.adapter.updateMove({ x: 2, y: 3 });
    f.app.handleKeyDown({ key: 'z', ctrlKey: true });
    assert.deepEqual(f.snapshot(), original, 'Undo first cancels the live component preview');
    assert.equal(priorValue, 0, 'Undo still applies to the previously committed command');
    assert.equal(getComponentDrag(f.app), null);
}

{
    const f = fixture();
    const original = f.snapshot();
    f.begin(false);
    f.adapter.updateMove({ x: 2, y: 3 });
    scheduleComponentDragUpdate(f.app, { clientX: 7.123456, clientY: -8.234567, shiftKey: false });
    f.adapter.endMove(true);
    assert.equal(frames.size, 0, 'Commit cancels the queued frame after flushing its position');
    assert.equal(f.placement.x, original.x + 7.123456);
    assert.equal(f.placement.y, original.y - 8.234567);
    assert.equal(f.app.history.undoStack.length, 1);
    const committed = f.snapshot();
    f.app.history.undo();
    assert.deepEqual(f.snapshot(), original, 'Committed movement remains fully undoable');
    f.app.history.redo();
    assert.deepEqual(f.snapshot(), committed);
}

{
    const f = fixture(false);
    const original = f.snapshot();
    f.begin(false);
    scheduleComponentDragUpdate(f.app, { clientX: 100, clientY: 200, shiftKey: false });
    f.adapter.endMove(false);
    assert.deepEqual(f.snapshot(), original, 'Cancelling without movement does not author an automatic placement');
    assert.equal(frames.size, 0, 'Cancel before the first frame discards the pending move');
    assert.equal(f.renders.length, 0, 'A discarded preview is never applied or rendered');
    assert.equal(getComponentDrag(f.app), null);
    assert.equal(f.app.history.canUndo(), false);
    f.begin(false);
    f.adapter.endMove(true);
    assert.deepEqual(f.snapshot(), original, 'A subsequent click must not consume the cancelled move');
    assert.equal(f.app.history.canUndo(), false);
}

for (const legacy of [false, true]) {
    const f = fixture();
    const original = f.snapshot();
    Object.assign(f.app.viewport, {
        snapToGrid: true, scale: 4, gridSize: 1, getEffectiveGridSize: () => 10,
    });
    f.begin(false);
    const moveTo = (x, y, shift = false) => {
        const point = { x: x - original.x, y: y - original.y };
        if (legacy) handleComponentDrag(f.app, { clientX: point.x, clientY: point.y, shiftKey: shift });
        else {
            f.app.viewport.shiftHeld = shift;
            f.adapter.updateMove(point);
        }
    };
    for (let index = 0; index < 100; index++) moveTo(20 + index / 1000, 30 + index / 1000);
    assert.deepEqual([f.placement.x, f.placement.y], [20, 30]);
    assert.equal(f.renders.length, 1, '100 events attracted to one point apply the footprint pose once');
    assert.equal(f.ratsnestUpdates.length, 1, 'Unchanged poses do not repeat incremental ratsnest work');
    assert.deepEqual(f.ratsnestUpdates[0], { nets: new Set(['GND']) });
    assert.equal(f.app.history.canUndo(), false, 'Preview remains separate from committed history');
    assert.deepEqual(f.snapshot().saved, original.saved);
    const pad = f.placement.pads.get('1');
    const displayedTrack = f.app.tracks[0];
    assert.deepEqual({ x: displayedTrack.nodes.get('n0').x, y: displayedTrack.nodes.get('n0').y }, { x: pad.x, y: pad.y });
    assert.deepEqual(f.track.captureState(), original.graph, 'All pointer updates leave authored track geometry unchanged');
    const bounds = displayedTrack.getBounds();
    moveTo(20.1, 30.1);
    assert.equal(f.app.tracks[0], displayedTrack, 'Repeated updates reuse one projection');
    assert.equal(displayedTrack.getBounds(), bounds, 'Unchanged movement retains preview track bounds');
    assert.equal(f.renders.length, 1);

    for (let index = 0; index < 100; index++) {
        const x = 24 + index / 1000, y = 34 + index / 1000;
        moveTo(x, y);
        assert.ok(Math.abs(f.placement.x - x) < 1e-12 && Math.abs(f.placement.y - y) < 1e-12,
            'Every distinct position outside the grid magnet stays free');
    }
    assert.equal(f.renders.length, 101, 'Free movement is not quantized or throttled');
    assert.equal(f.ratsnestUpdates.length, 101);
    moveTo(20.1, 30.1, true);
    assert.ok(Math.abs(f.placement.x - 20.1) < 1e-12, 'Shift releases the magnet immediately');
    assert.ok(Math.abs(f.placement.y - 30.1) < 1e-12);
    moveTo(20.1, 30.1);
    assert.deepEqual([f.placement.x, f.placement.y], [20, 30], 'Releasing Shift restores attraction');

    f.placement.locked = true;
    const beforeLocked = f.renders.length;
    moveTo(24, 34);
    assert.equal(f.renders.length, beforeLocked, 'Both paths honor a newly locked placement');
    assert.deepEqual([f.placement.x, f.placement.y], [20, 30]);
    f.placement.locked = false;
    moveTo(24.123456, 34.234567);
    f.adapter.endMove(true);
    const committed = f.snapshot();
    assert.equal(f.app.history.undoStack.length, 1);
    f.app.history.undo();
    assert.deepEqual(f.snapshot(), original);
    f.app.history.redo();
    assert.deepEqual(f.snapshot(), committed);
}

for (const shared of [true, false]) {
    const f = fixture();
    const original = f.snapshot();
    f.app._cancelPosePreviews = PCBApp.prototype._cancelPosePreviews;
    f.app._cancelDrawingMode = () => false;
    f.begin(shared);
    f.adapter.updateMove({ x: 4, y: 5 });
    PCBApp.prototype.deactivate.call(f.app);
    assert.deepEqual(f.snapshot(), original, 'Leaving the PCB tab discards component movement previews');
    assert.equal(f.app.tracks, f.app.pcbDocument.tracks);
    assert.equal(getComponentDrag(f.app), null);
    assert.equal(isEditorActive(f.app), false);
}

delete globalThis.window;
delete globalThis.CSS;
delete globalThis.requestAnimationFrame;
delete globalThis.cancelAnimationFrame;
console.log('PASS component drag cancellation, unchanged-pose reuse, free movement, bonded geometry and history');
