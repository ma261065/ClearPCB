import assert from 'node:assert/strict';

const { buildRouteInput } = await import('../../src/pcb/modules/route-input.js');

// A board whose route input exercises each rule buildRouteInput applies.
const placements = new Map([
    ['U1', { x: 10, y: 10, pads: new Map([['1', { x: 10, y: 10 }]]), padOffsets: [
        { number: '1', dx: 0, dy: 0, width: 1, height: 1.5 },
        { number: '9', dx: 1, dy: 2, width: 3, height: 3 },
        { number: '9', dx: 1, dy: 4, width: 3, height: 3, layer: 'bottom', shape: 'ellipse' },
    ] }],
    ['R1', { x: 30, y: 12, pads: new Map([['1', { x: 30, y: 12 }], ['2', { x: 33, y: 12 }]]), padOffsets: [
        { number: '1', dx: 0, dy: 0 }, { number: '2', dx: 3, dy: 0, layer: 'both' },
    ] }],
]);
const netlist = [
    { net: 'A', pins: [{ componentId: 'U1', pinNumber: '1' }, { componentId: 'R1', pinNumber: '1' }] },
    { net: 'GND', pins: [{ componentId: 'U1', pinNumber: '9' }, { componentId: 'MISSING', pinNumber: '1' }] },
    { net: 'ALONE', pins: [{ componentId: 'R1', pinNumber: '2' }] },
];
const boardShapes = [
    { type: 'shape', kind: 'rect', layer: 'top-copper', net: 'GND', filled: true, copperMode: 'add', x: 40, y: 40, width: 6, height: 4, lineWidth: 0.2 },
    { type: 'shape', kind: 'rect', layer: 'top-copper', net: 'GND', filled: true, copperMode: 'remove-copper', x: 60, y: 60, width: 2, height: 2 },
    { type: 'fill', layer: 'top-copper', net: 'GND', filled: true },
];
const input = buildRouteInput({ placements, netlist, boardShapes, texts: new Map(),
    getRoutingParams: () => ({ trackWidth: 0.25, clearance: 0.2, viaDiameter: 0.6 }) });

assert.deepEqual(input.connections.map(c => c.net), ['A', 'GND'], 'Nets with fewer than two terminals are not routed');
const [a, gnd] = input.connections;
assert.deepEqual(a.pads[0], { x: 10, y: 10, width: 1, height: 1.5, layer: 'top', shape: 'rect' });
assert.deepEqual(a.pads[1], { x: 30, y: 12, width: 1, height: 1, layer: 'top', shape: 'rect' }, 'Pad defaults: 1 mm square, top');
assert.equal(gnd.pads.length, 2, 'A filled copper shape on the net is a terminal; removal shapes and pours are not');
assert.deepEqual(gnd.pads[0].alternates, [{ x: 11, y: 14, width: 3, height: 3, layer: 'bottom', shape: 'ellipse' }],
    'Extra pads sharing a pin number are alternates of the first');
assert.equal(input.allObstaclePads.length, 5, 'Every pad blocks, including unconnected ones');
assert.ok(Array.isArray(input.copperObstacles));
assert.deepEqual([input.trackWidth, input.clearance, input.viaDiameter, input.gridStep], [0.25, 0.2, 0.6, 0.5]);
assert.deepEqual(input.bounds, { minX: 5, minY: 5, maxX: 38, maxY: 17 }, 'Bounds pad every placed pad by 5 mm');

console.log('PASS route input: terminals, alternates, obstacles, rules and bounds');
