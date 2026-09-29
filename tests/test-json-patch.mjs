import assert from 'node:assert/strict';
import { applyJsonPatch } from '../src/core/json-patch.js';

const source = {
    type: 'clearpcb-project',
    schematic: {
        shapes: [{ id: 'a', type: 'circle', x: 1 }],
        components: [],
    },
};
const patched = applyJsonPatch(source, [
    { op: 'test', path: '/type', value: 'clearpcb-project' },
    { op: 'replace', path: '/schematic/shapes/0/x', value: 2 },
    { op: 'add', path: '/schematic/shapes/-', value: { id: 'b', type: 'text' } },
    { op: 'copy', from: '/schematic/shapes/0', path: '/schematic/shapes/-' },
    { op: 'move', from: '/schematic/shapes/1', path: '/schematic/shapes/0' },
    { op: 'remove', path: '/schematic/shapes/2' },
]);
assert.equal(patched.schematic.shapes[0].id, 'b');
assert.equal(patched.schematic.shapes[1].x, 2);
assert.equal(source.schematic.shapes[0].x, 1, 'patching does not mutate the live snapshot');
assert.throws(() => applyJsonPatch(source, [{ op: 'replace', path: '/missing', value: 1 }]), /operation 0/);
assert.throws(() => applyJsonPatch(source, [{ op: 'add', path: '/__proto__/polluted', value: true }]), /Unsafe/);
assert.throws(() => applyJsonPatch(source, [{ op: 'test', path: '/type', value: 'wrong' }]), /test failed/);
assert.throws(() => applyJsonPatch(source, [{ op: 'move', from: '/schematic', path: '/schematic/shapes/0' }]), /descendant/);

console.log('PASS: MCP JSON Patch operations are atomic, complete, and prototype-safe');
