import assert from 'node:assert/strict';
import { areDragOverlaysDeferred } from '../../src/pcb/modules/refresh-state.js';

const frames = new Map();
let frameId = 0;
globalThis.window = {
    addEventListener() {},
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
};
globalThis.document = {};
const { beginGroupDrag, scheduleGroupDrag, endGroupDrag, cancelGroupDrag } = await import('../../src/pcb/modules/box-select.js');
const { setPcbSelection } = await import('../../src/pcb/modules/selection-registry.js');
const { getTextPosePreviewTexts } = await import('../../src/pcb/modules/text-commands.js');
const text = { id: 'text', x: 10, y: 20 };
let redraws = 0;
const commands = [];
const app = {
    pcbDocument: { texts: new Map([[text.id, text]]) }, placements: new Map(),
    get texts() { return getTextPosePreviewTexts(this) || this.pcbDocument.texts; },
    viewport: { snapToGrid: true, gridVisible: true, gridSize: 1 },
    refreshText() { redraws++; },
    history: { execute(command) { commands.push(command); command.execute(); } },
};
const begin = () => {
    setPcbSelection(app, [{ kind: 'text', object: text }]);
    // Count drag redraws only; selecting redraws the text through its adapter.
    redraws = 0;
    beginGroupDrag(app, { x: 0, y: 0 });
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
assert.deepEqual([app.texts.get(text.id).x, app.texts.get(text.id).y, redraws], [30, 40, 1]);
assert.deepEqual([text.x, text.y], [10, 20], 'Scheduled preview does not author text');
scheduleGroupDrag(app, { x: 20.1, y: 20.1 });
flush();
assert.equal(redraws, 1, 'Same grid cell must not redraw');
scheduleGroupDrag(app, { x: 25, y: 30 });
endGroupDrag(app);
assert.deepEqual([text.x, text.y], [35, 50], 'Commit must apply the latest pending position');
assert.equal(frames.size, 0);
assert.equal(commands.length, 1);
assert.equal(areDragOverlaysDeferred(app), false);
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