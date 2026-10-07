import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { createPcbText } from '../../src/core/pcb-text.js';
import { beginTextDrag, createPcbTextSelectionAdapter, endTextDrag, handleTextDrag } from '../../src/pcb/modules/pcb-text-selection.js';
import { cancelPictureCopperRefresh } from '../../src/pcb/modules/picture-refresh.js';
import { areDragOverlaysDeferred, isPictureCopperRefreshPending, setDragOverlaysDeferred } from '../../src/pcb/modules/refresh-state.js';
import { getTextDrag } from '../../src/pcb/modules/pcb-text-selection.js';

globalThis.window = { addEventListener() {} };
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');

function fixture(options = {}) {
    const text = createPcbText({ id: 'moving-text', content: 'Move', x: 10, y: 20, ...options });
    const pcbDocument = new PcbDocument();
    pcbDocument.texts.set(text.id, text);
    const renders = [];
    const crosshairs = [];
    let hiddenCrosshairs = 0;
    let historyChanges = 0;
    const app = {
        pcbDocument,
        history: new CommandHistory({ onChanged: () => historyChanges++ }),
        viewport: {
            svg: { style: { cursor: 'grabbing' } }, gridSize: 1, snapToGrid: true,
            gridVisible: true, shiftHeld: false,
            setCrosshair: point => crosshairs.push(point),
            hideCrosshair: () => hiddenCrosshairs++,
        },
        screenToWorld: event => ({ x: event.clientX, y: event.clientY }),
        refreshText: () => renders.push({ ...app.texts.get(text.id) }),
    };
    Object.defineProperty(app, 'texts', Object.getOwnPropertyDescriptor(PCBApp.prototype, 'texts'));
    for (const name of ['snapToGrid', '_snapActive']) app[name] = PCBApp.prototype[name];
    const adapter = createPcbTextSelectionAdapter(app, text, text.id);
    return { app, text, adapter, renders, crosshairs,
        hiddenCrosshairs: () => hiddenCrosshairs, historyChanges: () => historyChanges };
}

{
    const { app, text, adapter, renders, crosshairs, hiddenCrosshairs, historyChanges } = fixture();
    try {
        const original = { ...text };
        assert.equal(adapter.beginMove({ x: 0, y: 0 }), true);
        assert.deepEqual(crosshairs.at(-1), { x: text.x, y: text.y },
            'Pickup crosshair marks the same text origin that snapping uses');
        assert.equal(areDragOverlaysDeferred(app), true);
        for (let index = 0; index < 100; index++) {
            adapter.updateMove({ x: 5 + index / 1000, y: 7 + index / 1000 });
        }
        assert.deepEqual([adapter.object.x, adapter.object.y], [15, 27]);
        assert.deepEqual(text, original, 'Live movement leaves authored text unchanged');
        assert.deepEqual(crosshairs.at(-1), { x: 15, y: 27 },
            'Drag crosshair lies on the snapped grid point without a font-height offset');
        assert.equal(renders.length, 1, '100 pointer events inside the same grid magnet render once');
        assert.equal(crosshairs.length, 2, 'Crosshair updates only at pickup and a changed position');
        assert.equal(historyChanges(), 0, 'Preview does not notify committed history');
        assert.equal(app.history.canUndo(), false);
        adapter.updateMove({ x: 6, y: 8 });
        assert.equal(renders.length, 2, 'Entering another cell renders immediately');
        const final = { ...adapter.object };
        const beforeDrop = renders.length;
        adapter.endMove(true);
        assert.deepEqual(renders.slice(beforeDrop), [final],
            'Drop renders the committed position once, never the rollback position');
        assert.equal(getTextDrag(app), null);
        assert.equal(areDragOverlaysDeferred(app), false);
        assert.equal(hiddenCrosshairs(), 1);
        assert.equal(app.viewport.svg.style.cursor, 'default');
        assert.equal(app.history.undoStack.length, 1);
        assert.equal(historyChanges(), 1);
        assert.equal(isPictureCopperRefreshPending(app), true, 'Commit still schedules derived refresh');
        app.history.undo();
        assert.deepEqual(text, original);
        assert.deepEqual(renders.at(-1), original);
        app.history.redo();
        assert.deepEqual(text, final);
        assert.deepEqual(renders.at(-1), final);
        assert.equal(app.pcbDocument.texts.get(text.id), text);
    } finally { cancelPictureCopperRefresh(app); }
}

{
    const { app, text, adapter, renders } = fixture({ x: 0, y: 0 });
    try {
        app.viewport.scale = 4;
        app.viewport.getEffectiveGridSize = () => 10;
        adapter.beginMove({ x: 0, y: 0 });
        for (let index = 0; index < 100; index++) {
            const point = { x: 4 + index / 1000, y: 6 + index / 1000 };
            adapter.updateMove(point);
            assert.deepEqual(adapter.getPosition(), point, 'Movement between grid lines remains free');
        }
        assert.equal(renders.length, 100, 'Every distinct free position renders, even within one grid cell');
        adapter.endMove(true);
        app.history.undo();
        assert.deepEqual({ x: text.x, y: text.y }, { x: 0, y: 0 });
        app.history.redo();
        assert.deepEqual({ x: text.x, y: text.y }, { x: 4.099, y: 6.099 });
    } finally { cancelPictureCopperRefresh(app); }
}

for (const layer of ['top-silk', 'bottom-silk']) {
    for (const rotation of [0, 37, 90, 180]) {
        const { app, text, adapter, crosshairs } = fixture({
            layer, rotation, size: 2.34567, strokeWidth: 0.234567, border: true,
        });
        try {
            app.viewport.scale = 4;
            app.viewport.getEffectiveGridSize = () => 10;
            adapter.beginMove({ x: 0, y: 0 });
            assert.deepEqual(crosshairs.at(-1), { x: text.x, y: text.y });
            for (const point of [{ x: 4, y: 6 }, { x: 1.5, y: 8.5 }]) {
                adapter.updateMove(point);
                assert.deepEqual(crosshairs.at(-1), adapter.getPosition(),
                    'Free and magnetic motion share one origin regardless of rotation, side or style');
            }
            adapter.endMove(false);
        } finally { cancelPictureCopperRefresh(app); }
    }
}

for (const previousDefer of [false, true]) {
    const { app, text, adapter, renders } = fixture();
    try {
        setDragOverlaysDeferred(app, previousDefer);
        const original = { ...text };
        adapter.beginMove({ x: 0, y: 0 });
        adapter.updateMove({ x: 5, y: 6 });
        adapter.endMove(false);
        assert.deepEqual(text, original, 'Cancel restores the starting model position');
        assert.deepEqual(renders.at(-1), original);
        assert.equal(areDragOverlaysDeferred(app), previousDefer);
        assert.equal(app.history.canUndo(), false);
        adapter.beginMove({ x: 0, y: 0 });
        adapter.updateMove({ x: 3, y: 4 });
        adapter.updateMove({ x: 0, y: 0 });
        const beforeDrop = renders.length;
        adapter.endMove(true);
        assert.deepEqual(text, original);
        assert.equal(renders.length, beforeDrop, 'An out-and-back drag needs no commit repaint');
        assert.equal(app.history.canUndo(), false);
        assert.equal(areDragOverlaysDeferred(app), previousDefer);
        adapter.beginMove({ x: 0, y: 0 });
        adapter.updateMove({ x: 0.01, y: -0.01 });
        adapter.endMove(true);
        assert.equal(renders.length, beforeDrop, 'A click within the initial grid magnet needs no repaint');
        assert.equal(app.history.canUndo(), false);
    } finally { cancelPictureCopperRefresh(app); }
}

{
    const { app, text, renders } = fixture({ x: Math.PI, y: -Math.E });
    try {
        const original = { ...text };
        beginTextDrag(app, text, { x: 0, y: 0 });
        handleTextDrag(app, { clientX: 0.1234567, clientY: 0.7654321, shiftKey: true });
        const final = { ...app.texts.get(text.id) };
        assert.equal(final.x, original.x + 0.1234567, 'Shift disables snapping on a visible grid');
        assert.equal(final.y, original.y + 0.7654321);
        endTextDrag(app);
        assert.deepEqual(renders, [final, final], 'Unsnapped drag also avoids the rollback repaint');
        app.history.undo();
        assert.deepEqual(text, original, 'Undo preserves unrounded starting coordinates');
        app.history.redo();
        assert.deepEqual(text, final, 'Redo preserves unrounded final coordinates');
        beginTextDrag(app, text, { x: 0, y: 0 });
        handleTextDrag(app, { clientX: 1, clientY: 2, shiftKey: false });
        assert.equal(app.texts.get(text.id).x, Math.round(final.x + 1));
        assert.equal(app.texts.get(text.id).y, Math.round(final.y + 2));
        endTextDrag(app, false);
        assert.deepEqual(text, final);
    } finally { cancelPictureCopperRefresh(app); }
}

{
    const { app, text, adapter } = fixture();
    assert.equal(beginTextDrag(app, null, { x: 0, y: 0 }), false);
    adapter.beginMove({ x: 0, y: 0 });
    app.texts.delete(text.id);
    adapter.updateMove({ x: 10, y: 20 });
    adapter.endMove(true);
    assert.equal(getTextDrag(app), null);
    assert.equal(areDragOverlaysDeferred(app), false);
    assert.equal(app.history.canUndo(), false, 'Disappeared text is not recreated on drop');
}

delete globalThis.window;
console.log('PASS PCB text drag grid-cell reuse, single-position drop, cancel, history and precision');
