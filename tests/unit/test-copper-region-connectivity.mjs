import assert from 'node:assert/strict';
import { setComputedFill } from '../../src/pcb/modules/computed-fill-cache.js';
import { pictureShape } from '../../src/shared/pcb/picture-raster.js';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';

installFakeDom();
const { reconcileRatsnest } = await import('../../src/pcb/modules/ratsnest.js');
const rectangle = (left, top, right, bottom) => [
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
];
function ratlines(options) {
    const lines = [];
    reconcileRatsnest({ ...pcbEditorStubs(), boardShapes: [], copperFills: [], tracks: [], vias: [], placements: new Map(), netlist: [],
        get pcbDocument() { return this; },
        getLayerGroup: () => ({ children: [], appendChild(line) { lines.push(line); } }), ...options });
    return lines.length;
}
const image = pictureShape({ width: 10, height: 10, rectangles: [{ x: 0, y: 0, width: 1, height: 1 }] },
    { widthMm: 10, center: { x: 20, y: -20 }, layer: 'top-copper', net: 'GND' });
image.id = 'image';
const via = (id, x, y) => ({ id, x, y, diameter: 0.6, drill: 0.3, net: 'GND' });
assert.equal(ratlines({ boardShapes: [image], vias: [via('gap', 20, -20)] }), 0,
    'the picture frame is solid logical copper, including gaps in the artwork');
assert.equal(ratlines({ boardShapes: [image], vias: [via('material', 15.5, -24.5)] }), 0);
const islands = pictureShape({ width: 10, height: 10, rectangles: [
    { x: 0, y: 0, width: 1, height: 1 }, { x: 9, y: 9, width: 1, height: 1 },
] }, { widthMm: 10, layer: 'top-copper', net: 'GND' });
assert.equal(ratlines({ boardShapes: [islands] }), 0, 'a picture never creates ratlines between its own dots');
const pour = { id: 'pour', net: 'GND', layer: 'top-copper' };
setComputedFill(pour, [{ outer: rectangle(10, -10, 30, -30), holes: [rectangle(18, -18, 22, -22)] }]);
assert.equal(ratlines({ vias: [via('inside', 20, -20), via('outside', 16, -16)], copperFills: [pour] }), 1);
console.log('PASS pictures are solid logical rectangles while pour holes remain electrically separate');