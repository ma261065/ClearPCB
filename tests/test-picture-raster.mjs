import assert from 'node:assert/strict';
import { rasterizePicture, pictureShape, pictureContours } from '../src/pcb/modules/picture-raster.js';

const data = new Uint8ClampedArray([
    255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0,
]);
const raster = rasterizePicture({ width: 3, height: 2, data });
assert.deepEqual([...raster.mask], [1, 1, 0, 1, 1, 0], 'White pixels create material; black and transparent pixels remain empty');
assert.deepEqual(raster.rectangles, [{ x: 0, y: 0, width: 2, height: 2 }]);
assert.deepEqual([...rasterizePicture({ width: 3, height: 2, data }, { invert: true }).mask], [0, 0, 1, 0, 0, 0]);
assert.equal(rasterizePicture({ width: 3, height: 2, data }, { threshold: 255 }).mask[5], 0);
const image = pictureShape(raster, { widthMm: 3, layer: 'top-copper', center: { x: 10, y: 20 }, net: ' GND ' });
assert.equal(image.kind, 'image');
assert.equal(image.net, 'GND');
assert.deepEqual(image.points[0], { x: 8.5, y: 19 });
assert.deepEqual(image.points[2], { x: 11.5, y: 21 });
assert.ok(pictureContours(image)[0].some(point => point.x === 10.5 && point.y === 21));
assert.equal(pictureShape(raster, { widthMm: 3, layer: 'bottom-silk', net: 'GND' }).net, '');
assert.throws(() => pictureShape(raster, { widthMm: 0.1, layer: 'top-copper' }));
assert.throws(() => pictureShape(raster, { widthMm: 3, layer: 'hole' }));
assert.throws(() => pictureShape({ ...raster, rectangles: [] }, { widthMm: 3, layer: 'top-silk' }));
assert.throws(() => pictureShape({ ...raster, rectangles: Array(2001).fill(raster.rectangles[0]) }, { widthMm: 3, layer: 'top-silk' }));
console.log('PASS picture threshold, transparency, run merging, dimensions, layers and limits');