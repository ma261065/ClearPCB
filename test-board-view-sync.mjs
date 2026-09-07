import assert from 'node:assert/strict';
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