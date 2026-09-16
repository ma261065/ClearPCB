import assert from 'node:assert/strict';
import { installVTracerEnvironment } from './helpers/vtracer-environment.mjs';
import { tracePicture } from '../src/pcb/modules/picture-vtrace.js';
import { pictureShape, pictureContours } from '../src/pcb/modules/picture-raster.js';
import { flattenSvgPath } from '../src/pcb/modules/board-geometry.js';

const environment = installVTracerEnvironment();
function raster(width, height, material) {
    return { width, height, mask: Uint8Array.from({ length: width * height }, (_, index) =>
        Number(material(index % width, Math.floor(index / width)))) };
}
function contains(contours, point) {
    let inside = false;
    for (const contour of contours) {
        for (let index = 0, previous = contour.length - 1; index < contour.length; previous = index++) {
            const start = contour[index], end = contour[previous];
            if ((start.y > point.y) !== (end.y > point.y)
                && point.x < (end.x - start.x) * (point.y - start.y) / (end.y - start.y) + start.x) inside = !inside;
        }
    }
    return inside;
}
const ring = raster(64, 64, (column, row) => {
    const distance = Math.hypot(column - 32, row - 32);
    return distance < 26 && distance > 15 || distance < 4;
});
const [artwork, repeated] = await Promise.all([tracePicture(ring), tracePicture(ring)]);
assert.equal(environment.loads, 1, 'Concurrent callers share one local WASM load');
assert.deepEqual(artwork, repeated);
assert.equal(artwork.contours.length, 3, 'Outer ring, hole, and nested island survive');
assert.equal(contains(artwork.contours, { x: 32, y: 32 }), true);
assert.equal(contains(artwork.contours, { x: 32, y: 42 }), false);
assert.equal(contains(artwork.contours, { x: 32, y: 52 }), true);
assert.equal(contains(artwork.contours, { x: 1, y: 1 }), false);
const shape = pictureShape(artwork, { widthMm: 6.4, layer: 'top-copper', center: { x: 3.2, y: 3.2 } });
const geometry = pictureContours(shape);
assert.equal(contains(geometry, { x: 3.2, y: 4.2 }), false, 'Shared copper geometry retains holes');
assert.equal(contains(geometry, { x: 3.2, y: 5.2 }), true);
assert.deepEqual(structuredClone(artwork), artwork);
const wire = await tracePicture(raster(1302, 64, (column, row) => row >= 30 && row < 34), { smooth: 0 });
assert.equal(wire.width, 1302);
for (const column of [1, 600, 1301]) assert.ok(contains(wire.contours, { x: column, y: 32 }));
const noise = raster(64, 64, (column, row) => column >= 8 && column < 40 && row >= 8 && row < 40
    || column >= 50 && column < 52 && row >= 50 && row < 52);
assert.equal((await tracePicture(noise)).contours.length, 2);
assert.equal((await tracePicture(noise, { speckle: 4 })).contours.length, 1);
await assert.rejects(tracePicture(raster(8, 8, () => false)), /empty/);
await assert.rejects(tracePicture({ width: 2049, height: 1, mask: new Uint8Array(2049) }), /pixels/);
await assert.rejects(tracePicture(ring, { smooth: NaN }), /settings/);
await assert.rejects(tracePicture(ring, { speckle: -1 }), /settings/);
const cubic = 'M0,0C0,2048,2048,2048,2048,0';
assert.equal(flattenSvgPath(cubic)[0].length, 17);
const points = flattenSvgPath(cubic, 16, 0.125)[0];
const steps = points.length - 1;
for (let index = 0; index < steps; index++) {
    const ratio = (index + 0.5) / steps, remaining = 1 - ratio;
    const actual = { x: 3 * remaining * ratio ** 2 * 2048 + ratio ** 3 * 2048, y: 3 * remaining * ratio * 2048 };
    const midpoint = { x: (points[index].x + points[index + 1].x) / 2, y: (points[index].y + points[index + 1].y) / 2 };
    assert.ok(Math.hypot(actual.x - midpoint.x, actual.y - midpoint.y) <= 0.125);
}
console.log('PASS real VTracer WASM loading, polarity, nested holes, source-resolution wires, speckles and curve tolerance');