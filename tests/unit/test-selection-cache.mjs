import assert from 'node:assert/strict';
import { SelectionManager } from '../../src/core/SelectionManager.js';

let calls = 0;
const shape = (id) => ({
    id,
    visible: true,
    selected: false,
    getBounds() {
        return { minX: 0, minY: 0, maxX: 2, maxY: 2 };
    },
    hitTest() {
        calls++;
        return true;
    },
    invalidate() {},
});

const below = shape('below');
const top = shape('top');
const selection = new SelectionManager();
selection.setShapes([below, top]);

assert.deepEqual(selection.hitTest({ x: 1, y: 1 }, true), [top, below]);
const callsAfterAll = calls;
assert.equal(selection.hitTest({ x: 1, y: 1 }), top);
assert.equal(calls, callsAfterAll, 'single hit reuses the hover query at the same point');

selection.select(below);
assert.equal(selection.hitTest({ x: 1, y: 1 }), below,
    'selection changes invalidate the cached topmost result');
assert.ok(calls > callsAfterAll);

console.log('PASS: selection hit cache is reused and invalidated when priority changes');
