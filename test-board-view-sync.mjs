import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBoardViewSync } from './src/pcb/modules/board-view-sync.js';

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
assert.deepEqual(seen3D, [10], 'A pending timer after the switch must not rebuild again');
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
console.log('PASS: visible-view refresh, deferred 3D catch-up, coalescing, retry, and reentrant invalidation');

const source = readFileSync(new URL('./src/pcb/modules/board3d.js', import.meta.url), 'utf8');
const scheduleStart = source.indexOf('    let syncTimer = 0;');
const scheduleEnd = source.indexOf('    // Public hook', scheduleStart);
assert.ok(scheduleStart >= 0 && scheduleEnd > scheduleStart);
const timers = new Map();
const panel = { closed: false, hidden: false, view: '3d' };
const app = { _suspendBoardViewRefresh: false };
let timerCount = 0;
let revision = 0;
const refreshed = [];
const scheduledSync = createBoardViewSync({
    refresh3D() { refreshed.push(revision); },
    refresh2D() {},
});
const schedule = new Function('window', 'panel', 'app', 'viewSync', 'surfaceBuilder',
    `${source.slice(scheduleStart, scheduleEnd)}\nreturn scheduleSync;`)(
    {
        setTimeout(callback, delay) {
            assert.equal(delay, 300);
            timers.set(++timerCount, callback);
            return timerCount;
        },
        clearTimeout(timer) { timers.delete(timer); },
    },
    panel, app, scheduledSync, { invalidate() {} },
);
const fireTimer = () => {
    assert.equal(timers.size, 1);
    const [timer, callback] = timers.entries().next().value;
    timers.delete(timer);
    callback();
};
for (revision = 1; revision <= 10; revision++) schedule();
assert.equal(timerCount, 10, 'Each edit must restart the debounce');
assert.equal(timers.size, 1, 'A burst must retain only the last timer');
assert.deepEqual(refreshed, []);
fireTimer();
assert.deepEqual(refreshed, [revision], 'The debounce must refresh the latest state');
app.copperFills = [{}];
for (const [target, property] of [[panel, 'hidden'], [panel, 'closed'],
    ...['_suspendBoardViewRefresh', '_deferDragOverlays', '_suspendFillRefresh',
        '_fillRefreshScheduled', '_fillRefreshPending'].map((property) => [app, property])]) {
    schedule();
    target[property] = true;
    const refreshCount = refreshed.length;
    fireTimer();
    assert.equal(refreshed.length, refreshCount, 'Visibility and suspension must be rechecked at execution');
    schedule();
    assert.equal(timers.size, 0, 'Hidden or suspended requests must not queue timers');
    target[property] = false;
    schedule();
    fireTimer();
    assert.equal(refreshed.length, refreshCount + 1);
}
schedule();
app._fillRefreshScheduled = true;
const beforePour = refreshed.length;
fireTimer();
assert.equal(refreshed.length, beforePour, 'A pour queued during the debounce must prevent stale 3D work');
revision++;
app._fillRefreshScheduled = false;
schedule();
fireTimer();
assert.equal(refreshed.length, beforePour + 1);
assert.equal(refreshed.at(-1), revision);
console.log('PASS: restored 300ms debounce, burst coalescing, and drag/pour/visibility guards');