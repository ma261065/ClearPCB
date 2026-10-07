import assert from 'node:assert/strict';
import { Viewport } from '../src/core/Viewport.js';
import { snapToViewportGrid } from '../src/core/grid-snap.js';
import { beginBoardOutlineResize, initializeBoardOutlineState, setBoardOutlineSelected, updateBoardOutlineResize } from '../src/pcb/modules/board-outline-resize.js';
import { beginGroupDrag, updateGroupDrag, cancelGroupDrag } from '../src/pcb/modules/box-select.js';
import { setPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { finishPlacementPreview } from '../src/pcb/modules/track-commands.js';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { finishTextPosePreview } from '../src/pcb/modules/text-commands.js';
import { getBoardOutlineResize } from '../src/pcb/modules/board-outline-resize.js';
import { setPcbInteraction } from '../src/pcb/modules/pcb-interactions.js';
import { updateComponentDrag, handleComponentDrag } from '../src/pcb/modules/component-selection.js';
import { updateTextDrag } from '../src/pcb/modules/pcb-text-selection.js';
import { updateRefTextDrag, handleRefDrag } from '../src/pcb/modules/ref-text-selection.js';
import { snapPadPlacement } from '../src/pcb/modules/pad-tool.js';
import { updateCursorCrosshair } from '../src/pcb/modules/cursor-state.js';
import { beginPcbPaste, cancelPcbPaste, updatePcbPaste } from '../src/pcb/modules/pcb-paste.js';
import { boardDimensions } from '../src/shared/pcb/board-outline.js';

globalThis.window = { addEventListener() {} };
globalThis.document = {
    documentElement: { getAttribute: () => 'dark' },
    createElementNS: () => ({
        attributes: new Map(), children: [], dataset: {}, style: {},
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        getAttribute(name) { return this.attributes.get(name) ?? null; },
        appendChild(child) { this.children.push(child); child.parentNode = this; },
        remove() { this.parentNode?.removeChild?.(this); },
    }),
    getElementById: () => null,
};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

function fixture(viewport) {
    const text = { id: 'text', content: 'T', x: 0, y: 0, size: 1, strokeWidth: 0.1, layer: 'top-silk' };
    const pcbDocument = new PcbDocument();
    pcbDocument.texts.set(text.id, text);
    const placement = { x: 0, y: 0, pads: new Map(), refDx: 0, refDy: 0 };
    const app = {
        _active: true, viewport, pcbDocument, placements: new Map([['part', placement]]),
        tracks: [], getLayerGroup: () => ({ querySelector: () => null, querySelectorAll: () => [], appendChild() {} }),
        refreshText() {}, updateRatsnest() {}, drawRefOverlay() {}, syncClipboardButtons() {}, clearProperties() {},
        screenToWorld: event => ({ x: event.clientX, y: event.clientY }),
    };
    initializeBoardOutlineState(app, true);
    setBoardOutlineSelected(app, true);
    setPcbInteraction(app, '_textDrag', { textId: text.id, startWorld: { x: 0, y: 0 }, startPos: { x: 0, y: 0 } });
    setPcbInteraction(app, '_drag', { compId: 'part', startWorld: { x: 0, y: 0 }, startPos: { x: 0, y: 0 }, nets: new Set() });
    setPcbInteraction(app, '_refDrag', { compId: 'part', startWorld: { x: 0, y: 0 }, startDx: 0, startDy: 0 });
    Object.defineProperty(app, 'texts', Object.getOwnPropertyDescriptor(PCBApp.prototype, 'texts'));
    for (const method of ['snapToGrid', '_worldToPlacementLocal']) {
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
    assert.deepEqual(app.snapToGrid(point), expected, 'PCB text/shape/fill/paste placement helper');
    app.currentTool = 'text';
    updateCursorCrosshair(app, point);
    assert.deepEqual(crosshair, app.snapToGrid(point),
        'Text placement crosshair uses the same snap policy as the new text origin');
    assert.deepEqual(snapPadPlacement(app, point), expected, 'Standalone pad placement');
    updateTextDrag(app, point);
    const displayed = app.texts.get(text.id);
    assert.deepEqual({ x: displayed.x, y: displayed.y }, expected, 'Text drag');
    finishTextPosePreview(app);
    updateComponentDrag(app, point);
    assert.deepEqual({ x: placement.x, y: placement.y }, expected, 'Component adapter drag');
    handleComponentDrag(app, { clientX: point.x, clientY: point.y, shiftKey: viewport.shiftHeld });
    assert.deepEqual({ x: placement.x, y: placement.y }, expected, 'Legacy component pointer drag');
    finishPlacementPreview(app);
    placement.x = placement.y = 0;
    updateRefTextDrag(app, point);
    assert.deepEqual({ x: placement.refDx, y: placement.refDy }, expected, 'Reference adapter drag');
    handleRefDrag(app, { clientX: point.x, clientY: point.y, shiftKey: viewport.shiftHeld });
    assert.deepEqual({ x: placement.refDx, y: placement.refDy }, expected, 'Legacy reference pointer drag');
    const pastedText = { ...text, id: 'pasted', layer: 'top-silk' };
    beginPcbPaste(app, { texts: [pastedText] });
    updatePcbPaste(app, point);
    assert.deepEqual({ x: pastedText.x, y: pastedText.y }, expected, 'Floating pasted text/bundle');
    assert.deepEqual({ x: text.x, y: text.y }, { x: 0, y: 0 }, 'Floating paste never moves the authored source');
    cancelPcbPaste(app);
    setPcbSelection(app, [{ kind: 'text', object: text }]);
    beginGroupDrag(app, { x: 0, y: 0 });
    updateGroupDrag(app, point);
    const groupText = app.texts.get(text.id);
    assert.deepEqual({ x: groupText.x, y: groupText.y }, expected, 'Group drag preserves shared-delta snapping');
    assert.deepEqual({ x: text.x, y: text.y }, { x: 0, y: 0 }, 'Group snap preview leaves canonical text unchanged');
    cancelGroupDrag(app);
    assert.ok(beginBoardOutlineResize(app, { x: 100, y: -80 }));
    // Keep threshold deltas exact rather than introducing cancellation error at (100, -80).
    getBoardOutlineResize(app).start = { x: 0, y: 0 };
    updateBoardOutlineResize(app, point);
    assert.equal(boardDimensions(app).width, 100 + expected.x, 'Outline resize X');
    assert.equal(boardDimensions(app).height, 80 - expected.y, 'Outline resize Y');
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
