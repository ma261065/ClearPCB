import assert from 'node:assert/strict';
import { Viewport } from '../src/core/Viewport.js';
import { snapToViewportGrid } from '../src/core/grid-snap.js';
import { updateBoardOutlineResize } from '../src/pcb/modules/board-outline-resize.js';
import { updateGroupDrag } from '../src/pcb/modules/box-select.js';
import { finishTextPosePreview } from '../src/pcb/modules/text-commands.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById: () => null };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

function fixture(viewport) {
    const text = { id: 'text', x: 0, y: 0, size: 1, strokeWidth: 0.1 };
    const placement = { x: 0, y: 0, pads: new Map(), refDx: 0, refDy: 0 };
    const app = {
        viewport, pcbDocument: { texts: new Map([[text.id, text]]) }, placements: new Map([['part', placement]]),
        tracks: [], _getLayerGroup: () => null,
        _refreshText() {}, _updateRatsnest() {}, _drawRefOverlay() {}, _drawBoardOutline() {},
        _screenToWorld: event => ({ x: event.clientX, y: event.clientY }),
        _textDrag: { textId: text.id, startWorld: { x: 0, y: 0 }, startPos: { x: 0, y: 0 } },
        _drag: { compId: 'part', startWorld: { x: 0, y: 0 }, startPos: { x: 0, y: 0 }, nets: new Set() },
        _refDrag: { compId: 'part', startWorld: { x: 0, y: 0 }, startDx: 0, startDy: 0 },
        _pasteDrop: { anchorWorld: { x: 0, y: 0 }, tracks: [], vias: [], pads: [], shapes: [],
            fills: [], texts: [{ text, x: 0, y: 0 }] },
        _groupDrag: { startWorld: { x: 0, y: 0 }, lastDx: 0, lastDy: 0,
            comps: [], tracks: [], vias: [], texts: [{ text, x: 0, y: 0 }], ratsnestNets: new Set() },
        _boardOutlineResize: { handle: 'both', start: { x: 0, y: 0 },
            before: { width: 100, height: 80 } },
        _boardWidth: 100, _boardHeight: 80,
    };
    Object.defineProperty(app, 'texts', Object.getOwnPropertyDescriptor(PCBApp.prototype, 'texts'));
    for (const method of ['_snapToGrid', '_snapPadPlacement', '_updateTextDrag', '_updateComponentDrag',
        '_handleDrag', '_updateRefTextDrag', '_handleRefDrag', '_worldToPlacementLocal', '_updatePasteDrop']) {
        app[method] = PCBApp.prototype[method];
    }
    return { app, text, placement };
}

function check(point, expected, options = {}) {
    let crosshair;
    const viewport = {
        gridSize: 1, scale: 4, snapToGrid: true, gridVisible: true, shiftHeld: false,
        getEffectiveGridSize: () => 10, getSnappedPosition: Viewport.prototype.getSnappedPosition,
        setCrosshair: value => { crosshair = value; }, ...options,
    };
    assert.deepEqual(viewport.getSnappedPosition(point), expected, 'Shared viewport policy');
    assert.deepEqual(snapToViewportGrid(point, viewport), expected, 'Plain viewport state uses the same policy');
    const { app, text, placement } = fixture(viewport);
    assert.deepEqual(app._snapToGrid(point), expected, 'PCB text/shape/fill/paste placement helper');
    app.currentTool = 'text';
    PCBApp.prototype._updateCursorCrosshair.call(app, point);
    assert.deepEqual(crosshair, app._snapToGrid(point),
        'Text placement crosshair uses the same snap policy as the new text origin');
    assert.deepEqual(app._snapPadPlacement(point), expected, 'Standalone pad placement');
    app._updateTextDrag(point);
    const displayed = app.texts.get(text.id);
    assert.deepEqual({ x: displayed.x, y: displayed.y }, expected, 'Text drag');
    finishTextPosePreview(app);
    app._updateComponentDrag(point);
    assert.deepEqual({ x: placement.x, y: placement.y }, expected, 'Component adapter drag');
    app._handleDrag({ clientX: point.x, clientY: point.y, shiftKey: viewport.shiftHeld });
    assert.deepEqual({ x: placement.x, y: placement.y }, expected, 'Legacy component pointer drag');
    placement.x = placement.y = 0;
    app._updateRefTextDrag(point);
    assert.deepEqual({ x: placement.refDx, y: placement.refDy }, expected, 'Reference adapter drag');
    app._handleRefDrag({ clientX: point.x, clientY: point.y, shiftKey: viewport.shiftHeld });
    assert.deepEqual({ x: placement.refDx, y: placement.refDy }, expected, 'Legacy reference pointer drag');
    app._updatePasteDrop(point);
    assert.deepEqual({ x: text.x, y: text.y }, expected, 'Floating pasted text/bundle');
    text.x = text.y = 0;
    updateGroupDrag(app, point);
    assert.deepEqual({ x: text.x, y: text.y }, expected, 'Group drag preserves shared-delta snapping');
    updateBoardOutlineResize(app, point);
    assert.equal(app._boardWidth, 100 + expected.x, 'Outline resize X');
    assert.equal(app._boardHeight, 80 - expected.y, 'Outline resize Y');
}

for (const [point, expected] of [
    [{ x: 4, y: 6 }, { x: 4, y: 6 }],
    [{ x: 1.5, y: 6 }, { x: 0, y: 6 }],
    [{ x: 4, y: 8.5 }, { x: 4, y: 10 }],
    [{ x: 2, y: 8 }, { x: 0, y: 10 }],
    [{ x: 2.001, y: 7.999 }, { x: 2.001, y: 7.999 }],
    [{ x: -4, y: -8.5 }, { x: -4, y: -10 }],
    [{ x: 3.1, y: 6.1 }, { x: 3.1, y: 6.1 }],
]) check(point, expected);

const near = { x: 1.5, y: 8.5 };
check(near, near, { shiftHeld: true });
check(near, near, { snapToGrid: false });
check(near, { x: 0, y: 10 }, { snapToGrid: false, shiftHeld: true });
check(near, near, { gridVisible: false });
check(near, near, { gridVisible: false, snapToGrid: false, shiftHeld: true });
for (const scale of [1, 4, 20]) {
    check({ x: 8 / scale, y: 50 - 8 / scale }, { x: 0, y: 50 },
        { scale, getEffectiveGridSize: () => 50 });
    const free = { x: 8.01 / scale, y: 50 - 8.01 / scale };
    check(free, free, { scale, getEffectiveGridSize: () => 50 });
}
check({ x: 0.45, y: 0.55 }, { x: 0.45, y: 0.55 },
    { scale: 1, getEffectiveGridSize: () => 1 });
check({ x: 0.4, y: 0.6 }, { x: 0, y: 1 },
    { scale: 1, getEffectiveGridSize: () => 1 });

// Use the real adaptive grid calculation as well as fixed-spacing fixtures.
check({ x: 0.45, y: 0.55 }, { x: 0.45, y: 0.55 },
    { gridSize: 0.01, scale: 4, getEffectiveGridSize: Viewport.prototype.getEffectiveGridSize });
delete globalThis.window;
delete globalThis.document;
console.log('PASS common magnetic grid across PCB text, placements, references, paste, groups and outline resize');
