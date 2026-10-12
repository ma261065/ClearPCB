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

let scale = 10;
const screenSpaceSelection = new SelectionManager({
    tolerance: 0,
    screenTolerancePx: 6,
    getScale: () => scale,
});
assert.equal(screenSpaceSelection._effectiveTolerance() * scale, 6,
    'A zero world tolerance permits a fixed screen-space hit margin');
scale = 500;
assert.equal(screenSpaceSelection._effectiveTolerance() * scale, 6,
    'Fixed screen-space hit margin does not expand at high zoom');

console.log('PASS: selection hit cache is reused and invalidated when priority changes');
