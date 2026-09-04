import { strict as assert } from 'node:assert';
import { createShape } from './src/shapes/index.js';
import { Wire, WIRE_COLOR, WIRE_WIDTH } from './src/shapes/wire.js';

const wire = new Wire({
    graphNodes: { n0: [0, 0], n1: [10, 0] },
    graphEdges: { e0: ['n0', 'n1'] },
});
const json = wire.toJSON();

assert.equal(wire.color, WIRE_COLOR);
assert.equal(wire.lineWidth, WIRE_WIDTH);
assert.equal(Object.hasOwn(json, 'c'), false);
assert.equal(Object.hasOwn(json, 'f'), false);

const legacy = createShape({ ...json, c: '#008000', f: false });
assert.equal(legacy.color, '#008000');
assert.equal(legacy.fill, false);
assert.equal(Object.hasOwn(legacy.toJSON(), 'c'), false);
assert.equal(Object.hasOwn(legacy.toJSON(), 'f'), false);

console.log('wire serialization tests passed');