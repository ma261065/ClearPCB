import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { Component } from '../src/components/Component.js';
import { Track } from '../src/shapes/track.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { updatePlacementPadPositions } from '../src/core/pcb-placement-geometry.js';
import { createComponentSelectionAdapter } from '../src/pcb/modules/component-selection.js';

const frames = new Map();
let frameId = 0;
globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
globalThis.window = { addEventListener() {} };
globalThis.CSS = { escape: value => value };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

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
    const app = {
        project, pcbDocument: project.pcbDocument, tracks: project.pcbDocument.tracks,
        placements: new Map([['part', placement]]), history: new CommandHistory(),
        _active: true, currentTool: 'select',
        _clearancesVisible: true, _padHaloGroups: new Map([['part', padHalo]]),
        _layerGroups: new Map([['clearance-overlay', overlay]]),
        viewport: { svg: { style: {} }, snapToGrid: false, gridVisible: true, hideCrosshair() {} },
        _getLayerGroup: () => null, _hoverComponent() {}, _hideNetTooltip() {},
        _netsForComponent: () => new Set(['GND']), _updateRatsnest() {},
        _screenToWorld: event => ({ x: event.clientX, y: event.clientY }),
        _markDirty: () => dirty++,
        _refreshClearanceHalos() {
            clearanceRefreshes++;
            padHalo.style.display = '';
            trackHalo.style.display = '';
        },
    };
    for (const method of ['_beginComponentDrag', '_updateComponentDrag', '_endDrag', '_snapToGrid',
        '_handleDrag', '_scheduleDragUpdate', 'handleKeyDown', '_clearCursorCrosshair']) {
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
        if (shared) app._pcbSelectionInteraction = { mode: 'move-adapter', entry: adapter };
    };
    return { app, adapter, placement, track, snapshot, begin, renders, padHalo, trackHalo, overlay,
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
    assert.equal(app._deferDragOverlays, true);
    assert.equal(f.padHalo.style.display, 'none');
    assert.equal(f.trackHalo.style.display, 'none');
    adapter.updateMove({ x: 4.234567, y: -5.345678 });
    assert.notEqual(placement.x, original.x);
    assert.notDeepEqual(track.captureState(), original.graph, 'Live preview moves bonded tracks');
    track.getBounds();
    const beforeCancelRenders = f.renders.length;
    app._scheduleDragUpdate({ clientX: 100, clientY: 200, shiftKey: false });
    assert.equal(frames.size, 1);
    assert.equal(app.handleKeyDown({ key: 'Escape' }), true);
    assert.equal(app._drag, null, 'Escape must end the component drag, not only its selection interaction');
    assert.equal(app._pcbSelectionInteraction || null, null);
    assert.deepEqual(f.snapshot(), original, 'Cancel restores pose, pads and bonded nodes without saving preview data');
    assert.equal(track._bounds, null, 'Restoring bonded nodes invalidates cached bounds');
    assert.deepEqual(f.renders.slice(beforeCancelRenders), [{ x: original.x, y: original.y }],
        'Cancel discards the pending move and presents only the restored pose');
    assert.equal(frames.size, 0);
    assert.equal(app._pendingDragEvent, null);
    assert.equal(app._deferDragOverlays, false);
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
    assert.equal(f.app._drag, null);
}

{
    const f = fixture();
    const original = f.snapshot();
    f.begin(false);
    f.adapter.updateMove({ x: 2, y: 3 });
    f.app._scheduleDragUpdate({ clientX: 7.123456, clientY: -8.234567, shiftKey: false });
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
    f.app._scheduleDragUpdate({ clientX: 100, clientY: 200, shiftKey: false });
    f.adapter.endMove(false);
    assert.deepEqual(f.snapshot(), original, 'Cancelling without movement does not author an automatic placement');
    assert.equal(frames.size, 0, 'Cancel before the first frame discards the pending move');
    assert.equal(f.renders.length, 0, 'A discarded preview is never applied or rendered');
    assert.equal(f.app._drag, null);
    assert.equal(f.app.history.canUndo(), false);
    f.begin(false);
    f.adapter.endMove(true);
    assert.deepEqual(f.snapshot(), original, 'A subsequent click must not consume the cancelled move');
    assert.equal(f.app.history.canUndo(), false);
}

delete globalThis.window;
delete globalThis.CSS;
delete globalThis.requestAnimationFrame;
delete globalThis.cancelAnimationFrame;
console.log('PASS component drag cancellation, bonded geometry, pending moves, overlays and model-owned history');
