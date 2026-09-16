import assert from 'node:assert/strict';
import { Via } from '../src/shapes/via.js';

const via = new Via({
    id: 'via_36', x: -19.049999999999994, y: 119.38,
    diameter: 5.950000000000001, drill: 0.30000000000000004,
    net: 'GND', locked: true, visible: false,
});
const before = via.captureState();
const saved = JSON.parse(JSON.stringify(via));
assert.deepEqual(saved, {
    type: 'via', id: 'via_36', x: -19.05, y: 119.38,
    d: 5.95, dr: 0.3, n: 'GND', lk: true, v: false,
});
assert.deepEqual(via.captureState(), before, 'serialization does not change runtime or undo geometry');
assert.deepEqual(Via.fromJSON(saved).toJSON(), saved, 'saved geometry round-trips stably');

const fine = new Via({ x: 1.23456, y: -1.23456, diameter: 0.61234, drill: 0.31234 });
assert.deepEqual(fine.toJSON(), {
    type: 'via', id: fine.id, x: 1.2346, y: -1.2346, d: 0.6123, dr: 0.3123,
});
console.log('PASS: via serialization removes arithmetic residue and retains four-decimal precision without runtime mutation');