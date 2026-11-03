import assert from 'node:assert/strict';
import { ComponentLibrary } from '../../src/components/ComponentLibrary.js';
import { createPcbFootprint } from '../../src/core/pcb-footprint.js';

const parser = Object.create(ComponentLibrary.prototype);
const pin = parser._parseEasyEDAPin(
    'P~show~0~A9~365~280~180~gge4A9~0'
    + '^^365~280'
    + '^^M365,280h10~#880000'
    + '^^1~378.7~284~0~VBUS~start~~~#0000FF'
    + '^^1~374.5~279~0~A09~end~~~#0000FF'
    + '^^0~372~280'
    + '^^0~M 375 283 L 378 280 L 375 277'
);

assert.equal(pin.number, 'A09', 'EasyEDA Number segment is the electrical pin identity');
assert.equal(pin.name, 'VBUS');
assert.equal(pin._key, 'gge4A9', 'EasyEDA element ID remains the stable graphic key');

const footprint = createPcbFootprint({
    footprint: 'usb-c',
    source: 'LCSC',
    pins: [
        pin,
        { number: 'SHELL', name: 'SHELL' },
    ],
    footprintShapes: [
        'PAD~RECT~0~0~1~1~1~1~A09~0~0~0',
        'PAD~OVAL~2~0~1~1~11~1~SHELL~0.25~0~0',
        'PAD~OVAL~4~0~1~1~11~1~SHELL~0.25~0~0',
    ],
});

assert.deepEqual(footprint.padOffsets.map(pad => pad.number), ['A09', 'SHELL', 'SHELL']);
assert.deepEqual(footprint.padOffsets.map(pad => pad.padId), ['A09', 'SHELL', 'SHELL#2']);

console.log('PASS EasyEDA symbol Number segment matches the exact footprint pad identity');
