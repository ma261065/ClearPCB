import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
globalThis.window = { addEventListener() {} };
const inputs = new Map([
    ['pcbPropBoardW', { value: '100' }], ['pcbPropBoardH', { value: '80' }],
]);
globalThis.document = { getElementById: id => inputs.get(id) || null };
const { boardOutlineHandles, renderBoardOutlineHandles, beginBoardOutlineResize, updateBoardOutlineResize, endBoardOutlineResize } =
    await import('./src/pcb/modules/board-outline-resize.js');
const { PCB_LAYERS } = await import('./src/pcb/modules/layers.js');
const commands = [];
const source = readFileSync(new URL('./src/ui/PCBApp.js', import.meta.url), 'utf8');
const syncStart = source.indexOf('    _syncBoardOutlineInputs() {');
const syncEnd = source.indexOf('\n    /**', syncStart);
assert.ok(syncStart >= 0 && syncEnd > syncStart);
const syncInputs = new Function(`return ({ ${source.slice(syncStart, syncEnd)} })._syncBoardOutlineInputs;`)();
let redraws = 0;
let fills = 0;
const fillDimensions = [];
const app = {
    _boardOutlineSelected: true, _boardOutlineDrawn: true,
    _boardWidth: 100, _boardHeight: 80, _boardRadius: 3,
    viewport: { scale: 10, snapToGrid: true, gridSize: 1 },
    _drawBoardOutline() { redraws++; },
    _refreshFills() {
        fills++;
        fillDimensions.push([this._boardWidth, this._boardHeight, this._boardRadius]);
    },
    _syncBoardOutlineInputs: syncInputs,
    history: { execute(command) { commands.push(command); command.execute(); } },
};
assert.equal(boardOutlineHandles(app).length, 3);
assert.ok(beginBoardOutlineResize(app, { x: 100, y: -80 }));
updateBoardOutlineResize(app, { x: 110.2, y: -85.2 });
assert.deepEqual([app._boardWidth, app._boardHeight, app._boardRadius], [110, 85, 3]);
assert.deepEqual([...inputs.values()].map(input => input.value), ['110.00', '85.00'], 'Spinners update before mouse-up');
assert.equal(commands.length, 0, 'Updating spinners must not commit the active drag');
assert.equal(app._suspendBoardViewRefresh, true);
assert.equal(fills, 0);
updateBoardOutlineResize(app, { x: 110.3, y: -85.3 });
assert.equal(redraws, 1);
endBoardOutlineResize(app);
assert.equal(commands.length, 1);
assert.equal(fills, 1);
assert.deepEqual(fillDimensions, [[110, 85, 3]], 'Commit refreshes pours once with the new dimensions');
assert.equal(app._suspendBoardViewRefresh, false);
commands[0].undo();
assert.equal(fills, 2, 'Undo refreshes pours once');
assert.deepEqual(fillDimensions.at(-1), [100, 80, 3], 'Undo refresh uses the restored dimensions');
assert.deepEqual([app._boardWidth, app._boardHeight], [100, 80]);
assert.deepEqual([...inputs.values()].map(input => input.value), ['100.00', '80.00'], 'Undo updates the dimension spinners');
commands[0].execute();
assert.equal(fills, 3, 'Redo refreshes pours once');
assert.deepEqual(fillDimensions.at(-1), [110, 85, 3], 'Redo refresh uses the reapplied dimensions');
assert.deepEqual([app._boardWidth, app._boardHeight], [110, 85]);
assert.deepEqual([...inputs.values()].map(input => input.value), ['110.00', '85.00'], 'Redo updates the dimension spinners');
assert.ok(beginBoardOutlineResize(app, { x: 110, y: -42.5 }));
updateBoardOutlineResize(app, { x: -10, y: -60 });
assert.deepEqual([app._boardWidth, app._boardHeight], [5, 85]);
assert.deepEqual([...inputs.values()].map(input => input.value), ['5.00', '85.00'], 'Spinners reflect minimum size and the unchanged axis');
endBoardOutlineResize(app, false);
assert.deepEqual([app._boardWidth, app._boardHeight], [110, 85]);
assert.equal(fills, 3, 'Cancelled preview does not trigger another pour rebuild');
assert.equal(commands.length, 1);
assert.ok(beginBoardOutlineResize(app, { x: 55, y: -85 }));
updateBoardOutlineResize(app, { x: 90, y: -95 });
assert.deepEqual([app._boardWidth, app._boardHeight], [110, 95]);
endBoardOutlineResize(app);
app.viewport.snapToGrid = false;
assert.ok(beginBoardOutlineResize(app, { x: 110, y: -95 }));
updateBoardOutlineResize(app, { x: 110.12345, y: -95.98765 });
assert.deepEqual([...inputs.values()].map(input => input.value), ['110.12', '95.99'], 'Unsnapped dimensions display two decimal places');
assert.deepEqual([app._boardWidth, app._boardHeight], [110.12345, 95.98765], 'Display formatting preserves geometry precision');
endBoardOutlineResize(app, false);
app.viewport.snapToGrid = true;
const layer = PCB_LAYERS.find(layer => layer.id === 'board-outline');
layer.locked = true;
assert.deepEqual(boardOutlineHandles(app), []);
assert.equal(beginBoardOutlineResize(app, { x: 110, y: -95 }), false);
layer.locked = false;
app._boardOutlineSelected = false;
assert.deepEqual(boardOutlineHandles(app), []);
const makeElement = () => ({
    attributes: new Map(), children: [], style: {}, parent: null,
    setAttribute(name, value) { this.attributes.set(name, value); },
    appendChild(child) { child.parent = this; this.children.push(child); },
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); },
    querySelectorAll() { return [...this.children]; },
});
globalThis.document = { createElementNS: makeElement, getElementById: id => inputs.get(id) || null };
const overlay = makeElement();
app._getLayerGroup = () => overlay;
app._boardOutlineSelected = true;
for (const scale of [10, 20]) {
    app.viewport.scale = scale;
    renderBoardOutlineHandles(app);
    assert.equal(overlay.children.length, 1, 'Redraw replaces old handles');
    assert.equal(overlay.children[0].children.length, 3);
    for (const handle of overlay.children[0].children) {
        assert.equal(Number(handle.attributes.get('width')) * scale, 8, 'Handles remain 8 screen pixels');
    }
}
layer.visible = false;
renderBoardOutlineHandles(app);
assert.equal(overlay.children.length, 0);
assert.equal(beginBoardOutlineResize(app, { x: 110, y: -95 }), false);
layer.visible = true;
renderBoardOutlineHandles(app);
app._boardOutlineSelected = false;
renderBoardOutlineHandles(app);
assert.equal(overlay.children.length, 0);
app._boardOutlineSelected = true;
assert.ok(beginBoardOutlineResize(app, { x: 110, y: -95 }));
updateBoardOutlineResize(app, { x: 120, y: -100 });
layer.locked = true;
updateBoardOutlineResize(app, { x: 125, y: -105 });
assert.equal(app._boardOutlineResize, null);
assert.deepEqual([app._boardWidth, app._boardHeight], [110, 95], 'Locking during a drag restores original dimensions');
layer.locked = false;
console.log('PASS board resize handles, snapping, minimum dimensions, undo/redo, cancellation, and locks');