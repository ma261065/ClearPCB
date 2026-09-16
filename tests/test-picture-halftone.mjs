import assert from 'node:assert/strict';
import { halftonePicture } from '../src/pcb/modules/picture-halftone.js';
import { pictureShape, pictureContours } from '../src/pcb/modules/picture-raster.js';

function image(width, height, shade, alpha = 255) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < width * height; index++) data.set([shade, shade, shade, alpha], index * 4);
    return { width, height, data };
}
const settings = { widthMm: 6.4, dotSizeMm: 1.44 };
const full = halftonePicture(image(64, 64, 255), settings);
const dim = halftonePicture(image(64, 64, 64), settings);
const radius = artwork => artwork.circles[0].radius;
const rounded = artwork => artwork.circles.map(circle => ({
    ...circle, radius: Math.round(circle.radius * 1e9) / 1e9,
}));
assert.equal(full.circles.length, 16);
assert.ok(Math.abs(radius(dim) ** 2 / radius(full) ** 2 - 64 / 255) < 1e-10, 'Dot area, not radius, follows tone');
assert.ok(radius(full) < 8, 'Neighbouring dots remain separate');
assert.deepEqual(halftonePicture(image(64, 64, 0), { ...settings, invert: true }), full);
assert.throws(() => halftonePicture(image(64, 64, 0)), /empty/);
assert.throws(() => halftonePicture(image(64, 64, 255), { invert: true }), /empty/);
assert.throws(() => halftonePicture(image(64, 64, 255, 0)), /empty/);
assert.throws(() => halftonePicture(image(64, 64, 0, 0), { invert: true }), /empty/);
const translucent = halftonePicture(image(64, 64, 255, 64), settings);
assert.deepEqual(rounded(translucent), rounded(dim), 'Alpha reduces coverage and transparent colour cannot produce dots');
const mixed = image(64, 64, 0);
for (let row = 0; row < 64; row++) for (let column = 0; column < 64; column += 2) mixed.data.set([128, 128, 128, 255], (row * 64 + column) * 4);
assert.deepEqual(rounded(halftonePicture(mixed, settings)), rounded(dim), 'Each cell averages original grayscale, not a thresholded mask');
assert.equal(halftonePicture(image(128, 64, 255), settings).circles.length, 8);
assert.equal(halftonePicture(image(8, 8, 255)).circles.length, 64, 'Density never subdivides beyond source pixels');
assert.equal(halftonePicture(image(128, 128, 255), { dotSizeMm: 0.05 }).circles.length, 16384);
assert.throws(() => halftonePicture(image(256, 256, 255), { dotSizeMm: 0.05 }), /Increase dot size/);
assert.throws(() => halftonePicture(image(8, 8, 255), { dotSizeMm: NaN }), /settings/);
assert.throws(() => halftonePicture(image(8, 8, 255), { dotSizeMm: 0 }), /settings/);
assert.throws(() => halftonePicture(image(8, 8, 255), { widthMm: 0 }), /settings/);
assert.throws(() => halftonePicture(image(8, 8, 255), { widthMm: 1, dotSizeMm: 1 }), /too large/);
assert.throws(() => halftonePicture({ width: 2049, height: 1, data: new Uint8ClampedArray(8196) }), /pixels/);
const large = halftonePicture(image(2048, 2048, 255), { widthMm: 32, dotSizeMm: 0.9 });
assert.equal(large.circles.length, 1024);
assert.equal(large.contours, undefined, 'Halftones store circles, not sampled vertices');
const shape = pictureShape(full, { widthMm: 6.4, layer: 'top-copper', center: { x: 0, y: 0 } });
assert.equal(pictureContours(shape).length, 16);
assert.deepEqual(structuredClone(shape.artwork), full);
function maximumDiameterMm(artwork, widthMm) {
    return 2 * artwork.circles[0].radius * widthMm / artwork.width;
}
assert.ok(Math.abs(maximumDiameterMm(full, settings.widthMm) - settings.dotSizeMm) < 1e-10);
const wider = halftonePicture(image(64, 64, 255), { ...settings, widthMm: 12.8 });
assert.ok(wider.circles.length > full.circles.length, 'Larger physical images use more dots at the same dot size');
assert.ok(Math.abs(maximumDiameterMm(wider, 12.8) - settings.dotSizeMm) < 1e-10);
const biggerDots = halftonePicture(image(64, 64, 255), { ...settings, dotSizeMm: 2.88 });
assert.ok(biggerDots.circles.length < full.circles.length);
assert.ok(Math.abs(maximumDiameterMm(biggerDots, settings.widthMm) - 2.88) < 1e-10);
console.log('PASS halftone area/brightness, cell averaging, polarity, alpha, source resolution, budgets and shared artwork geometry');