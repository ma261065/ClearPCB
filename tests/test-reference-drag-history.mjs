import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { capturePlacementOverride } from '../src/core/PcbPlacementState.js';
import { updatePlacementPadPositions } from '../src/core/pcb-placement-geometry.js';
import { Track } from '../src/shapes/track.js';
import { createRefTextSelectionAdapter } from '../src/pcb/modules/ref-text-selection.js';
import { getSelectionInteraction } from '../src/pcb/modules/selection-interaction.js';
import { getRefDrag } from '../src/pcb/modules/ref-text-selection.js';
import { handleRefDrag } from '../src/pcb/modules/ref-text-selection.js';
import { setPcbInteraction } from '../src/pcb/modules/pcb-interactions.js';

globalThis.window = { addEventListener() {} };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

function fixture({ saved = true, rotation = 37, side = 'bottom', mirror = true } = {}) {
    const pcbDocument = new PcbDocument();
    const placement = { x: Math.PI, y: -Math.E, rotation, side, mirror,
        refDx: 1.234567, refDy: -2.345678, refRot: 23.456789,
        padOffsets: [{ padId: '1', dx: 2, dy: 1, number: '1' }], pads: new Map() };
    updatePlacementPadPositions(placement);
    const pad = placement.pads.get('1');
    const track = new Track({ points: [{ x: pad.x, y: pad.y }, { x: 50, y: 60 }],
        padConnections: { n0: { componentId: 'part', pinNumber: '1' } } });
    pcbDocument.tracks.push(track);
    if (saved) pcbDocument.placementState.record('part', placement);
    const offsets = () => ({ refDx: placement.refDx, refDy: placement.refDy });
    const renders = [];
    placement.elements = [{
        setAttribute() { renders.push(offsets()); }, querySelector: () => null, querySelectorAll: () => [],
    }];
    const overlays = [];
    let dirty = 0, boardRefreshes = 0;
    const app = {
        pcbDocument, placementState: pcbDocument.placementState, tracks: pcbDocument.tracks,
        placements: new Map([['part', placement]]), _layerGroups: new Map(),
        _active: true, currentTool: 'select', history: new CommandHistory(),
        viewport: { svg: { style: { cursor: 'grabbing' } }, snapToGrid: false,
            gridVisible: true, scale: 4, gridSize: 10, hideCrosshair() {} },
        getLayerGroup: () => null,
        _drawRefOverlay: (id, withTether) => overlays.push({ id, withTether, ...offsets() }),
        _markDirty: () => dirty++, _board3d: { refresh: () => boardRefreshes++ },
        screenToWorld: event => ({ x: event.clientX, y: event.clientY }),
    };
    for (const method of [        '_worldToPlacementLocal', '_placementLocalToWorld', 'snapToGrid', 'handleKeyDown', '_clearCursorCrosshair']) {
        app[method] = PCBApp.prototype[method];
    }
    app.screenToWorld = event => ({ x: event.clientX, y: event.clientY });
    const adapter = createRefTextSelectionAdapter(app, 'part', 'reftext:part');
    const snapshot = () => ({
        pose: capturePlacementOverride(placement), pads: structuredClone(placement.pads),
        graph: track.captureState(), saved: structuredClone(app.placementState.overrides),
    });
    const begin = (shared = true) => {
        assert.equal(adapter.beginMove({ x: placement.x, y: placement.y }), true);
        if (shared) setPcbInteraction(app, '_pcbSelectionInteraction', { mode: 'move-adapter', entry: adapter });
    };
    return { app, adapter, placement, snapshot, begin, renders, overlays, offsets,
        dirty: () => dirty, boardRefreshes: () => boardRefreshes };
}

for (const saved of [false, true]) for (const shared of [true, false]) {
    for (const side of ['top', 'bottom']) for (const mirror of [false, true]) {
        const f = fixture({ saved, side, mirror });
        const original = f.snapshot();
        f.app.history.execute({ execute() {}, undo() {} });
        f.app.history.undo();
        const redo = [...f.app.history.redoStack];
        f.begin(shared);
        f.adapter.updateMove({ x: 10.123456, y: 20.234567 });
        assert.notEqual(f.placement.refDx, original.pose.refDx);
        assert.deepEqual(f.snapshot().pads, original.pads, 'Reference movement must not move physical pads');
        assert.deepEqual(f.snapshot().graph, original.graph, 'Reference movement must not move bonded copper');
        assert.equal(f.app.handleKeyDown({ key: 'Escape' }), true);
        assert.equal(getRefDrag(f.app), null, 'Escape must end the reference drag, not only its selection interaction');
        assert.equal(getSelectionInteraction(f.app) || null, null);
        assert.deepEqual(f.snapshot(), original, 'Cancel restores offsets without writing a placement override');
        assert.deepEqual(f.renders.at(-1), { refDx: original.pose.refDx, refDy: original.pose.refDy });
        assert.equal(f.overlays.at(-1).withTether, false);
        assert.equal(f.app.viewport.svg.style.cursor, 'default');
        assert.equal(f.app.history.canUndo(), false);
        assert.deepEqual(f.app.history.redoStack, redo);
        assert.equal(f.dirty(), 0);
        assert.equal(f.boardRefreshes(), 0);
    }
}

for (const shared of [true, false]) {
    const f = fixture();
    const original = f.snapshot();
    let prior = 0;
    f.app.history.execute({ execute() { prior = 1; }, undo() { prior = 0; } });
    f.begin(shared);
    f.adapter.updateMove({ x: 10, y: 20 });
    f.app.handleKeyDown({ key: 'z', ctrlKey: true });
    assert.equal(prior, 0);
    assert.deepEqual(f.snapshot(), original, 'Undo cancels the reference preview before undoing prior history');
    assert.equal(getRefDrag(f.app), null);
}

for (const saved of [false, true]) {
    const f = fixture({ saved });
    const original = f.snapshot();
    f.begin(false);
    handleRefDrag(f.app, { clientX: 12.345678, clientY: -9.876543, shiftKey: false });
    const final = f.offsets();
    const beforeDrop = f.renders.length, beforeOverlays = f.overlays.length;
    f.adapter.endMove(true);
    assert.deepEqual(f.renders.slice(beforeDrop), [final], 'Drop must render only the committed offsets, never a rollback');
    assert.equal(f.overlays.length - beforeOverlays, 1, 'The command owns the final overlay refresh');
    assert.equal(f.app.history.undoStack.length, 1);
    const committed = f.snapshot();
    f.app.history.undo();
    assert.deepEqual(f.snapshot(), { ...original, saved: new Map([['part', original.pose]]) },
        'Undo restores original offsets and the canonical baseline for an automatic placement');
    f.app.history.redo();
    assert.deepEqual(f.snapshot(), committed);
}

{
    const f = fixture({ saved: false, rotation: 0, side: 'top', mirror: false });
    const original = f.snapshot();
    f.begin(false);
    f.adapter.endMove(false);
    assert.deepEqual(f.snapshot(), original);
    assert.equal(f.renders.length, 0, 'A no-op cancel does not redraw the placement');
    f.begin(false);
    f.adapter.endMove(true);
    assert.equal(f.app.history.canUndo(), false, 'A no-op drop does not create history');
    f.begin(false);
    f.app.placements.delete('part');
    f.adapter.endMove(false);
    assert.equal(getRefDrag(f.app), null);
    assert.equal(f.overlays.at(-1).id, null, 'Missing placements clear the reference overlay');
    assert.equal(f.app.placementState.overrides.size, 0);
}

for (const legacy of [false, true]) for (const side of ['top', 'bottom']) {
    for (const mirror of [false, true]) {
        const f = fixture({ side, mirror });
        const original = f.snapshot();
        Object.assign(f.app.viewport, {
            snapToGrid: true, gridSize: 1, getEffectiveGridSize: () => 10,
        });
        f.begin(false);
        const moveTo = (x, y, shift = false) => {
            const point = f.app._placementLocalToWorld(f.placement,
                x - original.pose.refDx, y - original.pose.refDy);
            if (legacy) handleRefDrag(f.app, { clientX: point.x, clientY: point.y, shiftKey: shift });
            else {
                f.app.viewport.shiftHeld = shift;
                f.adapter.updateMove(point);
            }
        };
        for (let index = 0; index < 100; index++) moveTo(20 + index / 1000, 30 + index / 1000);
        assert.deepEqual(f.offsets(), { refDx: 20, refDy: 30 });
        assert.equal(f.renders.length, 1, '100 events attracted to one point render the reference pose once');
        assert.equal(f.overlays.length, 2, 'Only pickup and the changed position draw the tether overlay');
        assert.deepEqual(f.snapshot().saved, original.saved);
        assert.deepEqual(f.snapshot().pads, original.pads);
        assert.deepEqual(f.snapshot().graph, original.graph);
        assert.equal(f.app.history.canUndo(), false);
        assert.equal(f.dirty(), 0);
        assert.equal(f.boardRefreshes(), 0);

        for (let index = 0; index < 100; index++) {
            const x = 24 + index / 1000, y = 34 + index / 1000;
            moveTo(x, y);
            assert.ok(Math.abs(f.placement.refDx - x) < 1e-12 && Math.abs(f.placement.refDy - y) < 1e-12);
        }
        assert.equal(f.renders.length, 101, 'Every distinct free position still renders immediately');
        assert.equal(f.overlays.length, 102, 'Every distinct free position updates its overlay');
        moveTo(24.099, 34.099);
        assert.equal(f.renders.length, 101, 'An identical unsnapped position also reuses its presentation');
        moveTo(20.1, 30.1, true);
        assert.ok(Math.abs(f.placement.refDx - 20.1) < 1e-12 && Math.abs(f.placement.refDy - 30.1) < 1e-12);
        moveTo(20.1, 30.1);
        assert.deepEqual(f.offsets(), { refDx: 20, refDy: 30 }, 'Releasing Shift re-evaluates the same pointer');
        f.app.viewport.gridVisible = false;
        moveTo(20.1, 30.1);
        assert.ok(Math.abs(f.placement.refDx - 20.1) < 1e-12 && Math.abs(f.placement.refDy - 30.1) < 1e-12,
            'Hiding the grid releases the same pointer from attraction');
        f.adapter.endMove(false);
        assert.deepEqual(f.snapshot(), original);
        assert.equal(f.overlays.at(-1).withTether, false);

        f.begin(false);
        moveTo(24.123456, 34.234567);
        f.adapter.endMove(true);
        const committed = f.snapshot();
        assert.equal(f.app.history.undoStack.length, 1);
        f.app.history.undo();
        assert.deepEqual(f.snapshot(), original);
        f.app.history.redo();
        assert.deepEqual(f.snapshot(), committed);
    }
}

delete globalThis.window;
console.log('PASS reference drag cancellation, unchanged-pose reuse, free movement, physical isolation and history');
