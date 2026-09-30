import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { capturePlacementOverride } from '../src/core/PcbPlacementState.js';
import { updatePlacementPadPositions } from '../src/core/pcb-placement-geometry.js';
import { Track } from '../src/shapes/track.js';
import { createRefTextSelectionAdapter } from '../src/pcb/modules/ref-text-selection.js';

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
        _getLayerGroup: () => null,
        _drawRefOverlay: (id, withTether) => overlays.push({ id, withTether, ...offsets() }),
        _markDirty: () => dirty++, _board3d: { refresh: () => boardRefreshes++ },
        _screenToWorld: event => ({ x: event.clientX, y: event.clientY }),
    };
    for (const method of ['_beginRefTextDrag', '_updateRefTextDrag', '_handleRefDrag', '_endRefDrag',
        '_worldToPlacementLocal', '_placementLocalToWorld', '_snapToGrid', 'handleKeyDown', '_clearCursorCrosshair']) {
        app[method] = PCBApp.prototype[method];
    }
    const adapter = createRefTextSelectionAdapter(app, 'part', 'reftext:part');
    const snapshot = () => ({
        pose: capturePlacementOverride(placement), pads: structuredClone(placement.pads),
        graph: track.captureState(), saved: structuredClone(app.placementState.overrides),
    });
    const begin = (shared = true) => {
        assert.equal(adapter.beginMove({ x: placement.x, y: placement.y }), true);
        if (shared) app._pcbSelectionInteraction = { mode: 'move-adapter', entry: adapter };
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
        assert.equal(f.app._refDrag, null, 'Escape must end the reference drag, not only its selection interaction');
        assert.equal(f.app._pcbSelectionInteraction || null, null);
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
    assert.equal(f.app._refDrag, null);
}

for (const saved of [false, true]) {
    const f = fixture({ saved });
    const original = f.snapshot();
    f.begin(false);
    f.app._handleRefDrag({ clientX: 12.345678, clientY: -9.876543, shiftKey: false });
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
    assert.equal(f.app._refDrag, null);
    assert.equal(f.overlays.at(-1).id, null, 'Missing placements clear the reference overlay');
    assert.equal(f.app.placementState.overrides.size, 0);
}

delete globalThis.window;
console.log('PASS reference drag cancellation, physical geometry isolation, precise history and single-position drop');
