import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };

const wire = await import('./src/schematic/modules/wire.js');
const legacyWire = await import('./src/ui/modules/wire.js');
const { PIN_ATTACH_TOL } = await import('./src/ui/modules/pin-wire-connect.js');

assert.equal(wire.VERTEX_EPSILON, 0.15);
assert.equal(legacyWire.VERTEX_EPSILON, wire.VERTEX_EPSILON);
assert.equal(PIN_ATTACH_TOL, wire.VERTEX_EPSILON);
console.log('PASS: wire-first module initialization and shared pin tolerance');