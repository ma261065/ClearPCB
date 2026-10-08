import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';

globalThis.window = { addEventListener() {} };
installFakeDom();
const { pcbEditorFixture } = await import('./pcb-editor-fixture.mjs');
const { CopperFill } = await import('../../src/shapes/copper-fill.js');
const { ModifyFillCommand } = await import('../../src/pcb/modules/copper-fill-commands.js');
const { getComputedFill, setComputedFill } = await import('../../src/pcb/modules/computed-fill-cache.js');
const { setDragOverlaysDeferred } = await import('../../src/pcb/modules/refresh-state.js');

// Copper computed for a pour's old outline must never be drawn at its new one. While the
// recompute waits (here, deferred), a reshaped pour has no computed copper; a change that
// leaves the copper's shape alone keeps it.
const app = pcbEditorFixture();
setDragOverlaysDeferred(app, true);
const fill = new CopperFill({ kind: 'circle', x: 25, y: -20, radius: 10, net: 'GND' });
app.pcbDocument.boardShapes.push(fill);
const stale = [{ outer: [{ x: 15, y: -20 }, { x: 25, y: -10 }, { x: 35, y: -20 }], holes: [] }];
const edit = change => {
    const before = fill.captureState();
    app.history.execute(new ModifyFillCommand(app, fill, before, { ...before, ...change }));
};

for (const [what, change] of [['a move', { x: 55, y: -25 }], ['a new radius', { radius: 4 }],
    ['another layer', { layer: 'bottom-copper' }], ['rounded corners', { kind: 'rect', cornerRadius: 1 }]]) {
    setComputedFill(fill, stale);
    edit(change);
    assert.equal(getComputedFill(fill), null, `${what} drops the copper computed for the old outline`);
}
// The lock comes last: a locked pour refuses further edits (the lock gate).
for (const [what, change] of [['a net', { net: 'VCC' }], ['visibility', { visible: false }], ['a lock', { locked: true }]]) {
    setComputedFill(fill, stale);
    edit(change);
    assert.equal(getComputedFill(fill), stale, `${what} change keeps the computed copper`);
}
setComputedFill(fill, stale);
app.history.undo();
assert.equal(getComputedFill(fill), stale, 'undoing a lock change keeps it too');
edit({ x: 70 });
setComputedFill(fill, stale);
app.history.undo();
assert.equal(getComputedFill(fill), null, 'undoing a move drops the copper of the moved outline');
console.log('PASS reshaping a pour drops its stale computed copper; net, lock and visibility changes keep it');
