import assert from 'node:assert/strict';

const frames = new Map();
let frameId = 0;
globalThis.window = {
    addEventListener() {},
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
};
globalThis.document = {};
const { scheduleGroupDrag, endGroupDrag, cancelGroupDrag } = await import('./src/pcb/modules/box-select.js');
const text = { id: 'text', x: 10, y: 20 };
let redraws = 0;
const commands = [];
const app = {
    placements: new Map(), texts: new Map([[text.id, text]]),
    viewport: { snapToGrid: true, gridSize: 1 },
    _refreshText() { redraws++; },
    history: { execute(command) { commands.push(command); } },
};
const begin = () => {
    app._deferDragOverlays = true;
    app._groupDrag = {
        startWorld: { x: 0, y: 0 }, lastDx: 0, lastDy: 0,
        previousDeferDragOverlays: false,
        comps: [], vias: [], tracks: [], shapes: [], fills: [],
        texts: [{ text, x: text.x, y: text.y }], ratsnestNets: new Set(),
    };
};
const flush = () => {
    assert.equal(frames.size, 1);
    const [id, callback] = frames.entries().next().value;
    frames.delete(id);
    callback();
};
begin();
for (let index = 1; index <= 20; index++) scheduleGroupDrag(app, { x: index, y: index });
assert.equal(frameId, 1);
assert.equal(redraws, 0);
flush();
assert.deepEqual([text.x, text.y, redraws], [30, 40, 1]);
scheduleGroupDrag(app, { x: 20.1, y: 20.1 });
flush();
assert.equal(redraws, 1, 'Same grid cell must not redraw');
scheduleGroupDrag(app, { x: 25, y: 30 });
endGroupDrag(app);
assert.deepEqual([text.x, text.y], [35, 50], 'Commit must apply the latest pending position');
assert.equal(frames.size, 0);
assert.equal(commands.length, 1);
assert.equal(app._deferDragOverlays, false);
begin();
scheduleGroupDrag(app, { x: 5, y: 5 });
flush();
scheduleGroupDrag(app, { x: 50, y: 50 });
const staleCallback = frames.values().next().value;
cancelGroupDrag(app);
assert.deepEqual([text.x, text.y], [35, 50], 'Cancel must restore starting geometry');
assert.equal(frames.size, 0);
begin();
staleCallback();
assert.deepEqual([text.x, text.y], [35, 50], 'An old callback must not move a new drag');
cancelGroupDrag(app);
console.log('PASS group drag frame coalescing, grid-cell reuse, pending commit, cancellation, and stale callback guard');