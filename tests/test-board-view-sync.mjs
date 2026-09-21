import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBoardViewSync } from '../src/pcb/modules/board-view-sync.js';

{
    const pcbSource = readFileSync(new URL('../src/ui/PCBApp.js', import.meta.url), 'utf8');
    const start = pcbSource.indexOf('    _renderPersistentObjects(');
    const end = pcbSource.indexOf('\n    /**', start);
    assert.ok(start >= 0 && end > start);
    const elements = new Set();
    const renderShape = (board, shape) => {
        elements.delete(board._shapeElements.get(shape.id));
        const element = { id: shape.id, geometry: shape.geometry };
        elements.add(element);
        board._shapeElements.set(shape.id, element);
    };
    const rebuild = new Function('renderBoardShape', 'getPcbSelection',
        `return ({ ${pcbSource.slice(start, end)} })._renderPersistentObjects;`)(renderShape, () => []);
    const outline = { id: 'board-outline', geometry: 'rectangle' };
    const artwork = { id: 'artwork', geometry: 'circle' };
    const board = {
        _boardOutlineDrawn: true,
        boardShapes: [outline, artwork],
        _shapeElements: new Map(), _textElements: new Map(), texts: new Map(),
        tracks: [], vias: [], copperFills: [],
        _drawBoardOutline() { renderShape(this, outline); },
    };
    for (const renderShapes of [true, false, true]) {
        rebuild.call(board, { renderShapes });
        assert.equal([...elements].filter(element => element.id === outline.id).length, 1,
            'A rebuild must not orphan the outline rendered before the other shapes');
        assert.ok(elements.has(board._shapeElements.get(outline.id)), 'The visible outline remains registered');
    }
    outline.geometry = 'polygon-with-inserted-node';
    renderShape(board, outline);
    assert.equal(elements.size, 2, 'Editing replaces the outline without leaving its old geometry behind');
    assert.equal([...elements].some(element => element.geometry === 'rectangle'), false);
}

let sourceRevision = 0;
const seen3D = [], seen2D = [];
const sync = createBoardViewSync({
    refresh3D() { seen3D.push(sourceRevision); },
    refresh2D() { seen2D.push(sourceRevision); },
});
sync.flush('3d');
assert.deepEqual(seen3D, []);
for (let edit = 1; edit <= 10; edit++) {
    sourceRevision = edit;
    sync.invalidate();
    sync.flush(edit % 2 ? 'top' : 'bottom');
}
assert.equal(seen2D.length, 10);
assert.equal(seen2D.at(-1), 10);
assert.deepEqual(seen3D, [], 'Flat-view edits must not rebuild 3D');
sync.flush('3d');
assert.deepEqual(seen3D, [10], 'Switching back catches up once with current data');
sync.flush('3d');
assert.deepEqual(seen3D, [10], 'A pending frame after the switch must not rebuild again');
sourceRevision = 11;
sync.invalidate();
sync.flush('3d');
assert.deepEqual(seen3D, [10, 11]);
assert.equal(seen2D.length, 10, '3D edits must not refresh the hidden flat view');
for (let edit = 12; edit <= 20; edit++) {
    sourceRevision = edit;
    sync.invalidate();
}
sync.flush('3d');
assert.deepEqual(seen3D, [10, 11, 20], 'Hidden or suspended edits coalesce into one catch-up');

let attempts = 0;
const retry = createBoardViewSync({ refresh2D() {}, refresh3D() {
    if (++attempts === 1) throw new Error('refresh failed');
} });
retry.invalidate();
assert.throws(() => retry.flush('3d'), /refresh failed/);
retry.flush('3d');
retry.flush('3d');
assert.equal(attempts, 2);

let reentrantCalls = 0;
const reentrant = createBoardViewSync({ refresh2D() {}, refresh3D() {
    if (++reentrantCalls === 1) reentrant.invalidate();
} });
reentrant.invalidate();
reentrant.flush('3d');
reentrant.flush('3d');
reentrant.flush('3d');
assert.equal(reentrantCalls, 2, 'Invalidation during a refresh must survive for the next pass');

const completions = [];
const settled = [];
const delayed = createBoardViewSync({
    refresh2D() {},
    refresh3D(revision) {
        return new Promise(resolve => completions.push({ revision, resolve }));
    },
    on3DSettled(result) { settled.push(result); },
});
delayed.invalidate();
const firstBuild = delayed.flush('3d');
delayed.invalidate();
const latestBuild = delayed.flush('3d');
assert.deepEqual(completions.map(item => item.revision), [1, 2]);
completions[1].resolve(false);
await latestBuild;
assert.equal(delayed.is3DDirty(), true, 'Discarding the newest build keeps its revision pending');
completions[0].resolve(true);
await firstBuild;
assert.equal(delayed.is3DDirty(), true, 'An older completion cannot acknowledge a newer edit');
const retryBuild = delayed.flush('3d');
assert.deepEqual(completions.map(item => item.revision), [1, 2, 2]);
completions[2].resolve(true);
await retryBuild;
assert.equal(delayed.is3DDirty(), false, 'A successful retry acknowledges the latest revision');
assert.deepEqual(settled.map(item => [item.revision, item.applied]), [[2, false], [1, true], [2, true]]);
console.log('PASS: visible-view refresh, deferred 3D catch-up, coalescing, retry, and reentrant invalidation');

const source = readFileSync(new URL('../src/pcb/modules/board3d.js', import.meta.url), 'utf8');
const scheduleStart = source.indexOf('    let syncFrame = 0;');
const scheduleEnd = source.indexOf('    // Public hook', scheduleStart);
assert.ok(scheduleStart >= 0 && scheduleEnd > scheduleStart);
const cleanup = source.match(/if \(syncFrame\) \{ window.cancelAnimationFrame\(syncFrame\); syncFrame = 0; \}/);
assert.ok(cleanup, 'Closing the view must cancel the pending animation frame');
const frames = new Map();
const panel = { closed: false, hidden: false, view: '3d' };
const app = { _suspendBoardViewRefresh: false };
let frameCount = 0;
let revision = 0;
const refreshed = [];
const scheduledSync = createBoardViewSync({
    refresh3D() { refreshed.push(revision); },
    refresh2D() {},
});
const { schedule, cancel } = new Function('window', 'panel', 'app', 'viewSync', 'surfaceBuilder',
    `${source.slice(scheduleStart, scheduleEnd)}\nreturn { schedule: scheduleSync, cancel() { ${cleanup[0]} } };`)(
    {
        requestAnimationFrame(callback) {
            frames.set(++frameCount, callback);
            return frameCount;
        },
        cancelAnimationFrame(frame) { frames.delete(frame); },
    },
    panel, app, scheduledSync, { invalidate() {} },
);
assert.match(source.slice(scheduleStart, scheduleEnd),
    /surfaceBuilder\.invalidate\(\{ cancelActive: true \}\)/,
    'Committed edits preempt obsolete 3D worker jobs');
const fireFrame = () => {
    assert.equal(frames.size, 1);
    const [frame, callback] = frames.entries().next().value;
    frames.delete(frame);
    callback();
};
for (revision = 1; revision <= 10; revision++) schedule();
assert.equal(frameCount, 1, 'A burst must reuse the queued animation frame');
assert.equal(frames.size, 1, 'A burst must queue only one frame');
assert.deepEqual(refreshed, []);
fireFrame();
assert.deepEqual(refreshed, [revision], 'The next frame must refresh the latest state');
app.copperFills = [{}];
for (const [target, property] of [[panel, 'hidden'], [panel, 'closed'],
    ...['_suspendBoardViewRefresh', '_deferDragOverlays', '_suspendFillRefresh',
        '_fillRefreshScheduled', '_fillRefreshPending'].map((property) => [app, property])]) {
    schedule();
    target[property] = true;
    const refreshCount = refreshed.length;
    fireFrame();
    assert.equal(refreshed.length, refreshCount, 'Visibility and suspension must be rechecked at execution');
    schedule();
    assert.equal(frames.size, 0, 'Hidden or suspended requests must not queue frames');
    target[property] = false;
    schedule();
    fireFrame();
    assert.equal(refreshed.length, refreshCount + 1);
}
schedule();
app._fillRefreshScheduled = true;
const beforePour = refreshed.length;
fireFrame();
assert.equal(refreshed.length, beforePour, 'A pour queued before the frame must prevent stale 3D work');
revision++;
app._fillRefreshScheduled = false;
schedule();
fireFrame();
assert.equal(refreshed.length, beforePour + 1);
assert.equal(refreshed.at(-1), revision);
schedule();
const beforeCancel = refreshed.length;
cancel();
assert.equal(frames.size, 0, 'Close must remove the queued frame');
assert.equal(refreshed.length, beforeCancel, 'Cancellation must not refresh');
schedule();
fireFrame();
assert.equal(refreshed.length, beforeCancel + 1, 'Cancellation must clear the pending frame handle');
console.log('PASS: next-frame coalescing, drag/pour/visibility guards, and cancellation');