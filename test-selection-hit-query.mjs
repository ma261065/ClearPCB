import assert from 'node:assert/strict';
import { getPcbSelectionHits, hitTestPcbSelection, syncPcbSelection }
    from './src/pcb/modules/selection-registry.js';
import { createComponentSelectionAdapter } from './src/pcb/modules/component-selection.js';

const point = { x: 0, y: 0 };
let scans = 0;
let winner = 'component-199';
const app = {
    placements: new Map(Array.from({ length: 200 }, (_, index) => [`component-${index}`, {
        x: 0, y: 0, refVisible: false, bounds: { x: -1, y: -1, width: 2, height: 2 },
    }])),
    viewport: { scale: 10 },
    _hitTestComponent() { scans++; return winner; },
};
syncPcbSelection(app);
const hits = () => getPcbSelectionHits(app, point, null, { sync: false }).map((hit) => hit.object);
assert.deepEqual(hits(), [winner]);
assert.equal(scans, 1, 'All 200 adapters must share one component scan');
winner = 'component-0';
assert.deepEqual(hits(), [winner]);
assert.equal(scans, 2, 'Edits at the same pointer must receive a fresh result');
winner = null;
assert.deepEqual(hits(), []);
assert.equal(scans, 3, 'A cached miss must also avoid repeated scans');
winner = 'component-42';
assert.equal(hitTestPcbSelection(app, point, 'component'), winner);
assert.equal(scans, 4, 'Single-hit selection must use the same query cache');

const adapter = createComponentSelectionAdapter(app, 'component-42', 'direct');
assert.equal(adapter.hitTest(point), true);
winner = null;
assert.equal(adapter.hitTest(point), false);
assert.equal(scans, 6, 'Direct adapter calls must not retain a previous query result');

app._hitTestComponent = () => { throw new Error('hit-test failure'); };
assert.throws(hits, /hit-test failure/);
app._hitTestComponent = () => { scans++; return 'component-42'; };
assert.equal(adapter.hitTest(point), true);
assert.deepEqual(hits(), ['component-42']);
assert.equal(scans, 8, 'A failed query must release its cache');

const nestedPoint = { x: 0.1, y: 0.1 };
let nesting = false;
app._hitTestComponent = () => {
    scans++;
    if (nesting) return 'component-7';
    nesting = true;
    try {
        assert.deepEqual(getPcbSelectionHits(app, nestedPoint, null, { sync: false })
            .map((hit) => hit.object), ['component-7']);
    } finally {
        nesting = false;
    }
    return 'component-42';
};
assert.deepEqual(hits(), ['component-42']);
assert.equal(scans, 10, 'Nested queries must restore the outer query cache');

const otherApp = { ...app, _pcbSelection: undefined, _hitTestComponent: () => 'component-9' };
assert.equal(hitTestPcbSelection(otherApp, point, 'component'), 'component-9');
assert.deepEqual(hits(), ['component-42']);
console.log('PASS: one component scan per selection query, fresh hits/misses, direct calls, errors, nesting, and app isolation');