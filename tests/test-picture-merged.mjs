import assert from 'node:assert/strict';
import { pictureShape, pictureContours, pictureRegions, pictureTriangles, rasterizePicture } from '../src/pcb/modules/picture-raster.js';
import ClipperLib from '../assets/vendor/clipper.esm.js';
import { pointInPolygon } from '../src/core/geometry.js';
const execute = ClipperLib.Clipper.prototype.Execute;
let unions = 0;
ClipperLib.Clipper.prototype.Execute = function (...args) { unions++; return execute.apply(this, args); };
const artwork = { width: 3, height: 3, rectangles: [
    { x: 0, y: 0, width: 3, height: 1 }, { x: 0, y: 1, width: 1, height: 1 },
    { x: 2, y: 1, width: 1, height: 1 }, { x: 0, y: 2, width: 3, height: 1 },
] };
const image = pictureShape(artwork, { widthMm: 3, layer: 'top-copper' });
assert.equal(pictureRegions(image).length, 1);
assert.equal(pictureRegions(image)[0].holes.length, 1);
assert.equal(pictureContours(image).length, 2);
assert.equal(pictureContours(image).flat().length, 8, 'Internal run edges disappear');
const contours = pictureContours(image);
assert.equal(pictureContours(image), contours, 'Unchanged geometry reuses cached contours');
const area = triangle => Math.abs((triangle[1].x - triangle[0].x) * (triangle[2].y - triangle[0].y)
    - (triangle[1].y - triangle[0].y) * (triangle[2].x - triangle[0].x)) / 2;
assert.equal(pictureTriangles(image).reduce((sum, triangle) => sum + area(triangle), 0), 8);
image.points = image.points.map(point => ({ x: point.x * 2 + 10, y: point.y * 2 }));
assert.notEqual(pictureContours(image), contours);
assert.equal(pictureTriangles(image).reduce((sum, triangle) => sum + area(triangle), 0), 32);
for (let index = 0; index < 100; index++) {
    image.points[0].x += 0.001;
    pictureContours(image);
    pictureRegions(image);
    pictureTriangles(image);
}
assert.equal(unions, 1, 'Union runs only once, not on redraw or geometry changes');
ClipperLib.Clipper.prototype.Execute = execute;
let seed = 12345;
for (let sample = 0; sample < 24; sample++) {
    const size = 12;
    const data = new Uint8ClampedArray(size * size * 4);
    for (let row = 0; row < size; row++) {
        for (let column = 0; column < size; column++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            const depth = Math.min(row, column, size - 1 - row, size - 1 - column);
            const dark = sample === 0 ? depth % 2 === 0 : sample === 1 ? (row + column) % 2 === 0 : seed % 3 !== 0;
            data.set(dark ? [0, 0, 0, 255] : [255, 255, 255, 255], (row * size + column) * 4);
        }
    }
    const raster = rasterizePicture({ width: size, height: size, data });
    const shape = pictureShape(raster, { widthMm: size, layer: 'top-silk', center: { x: size / 2, y: size / 2 } });
    const regions = pictureRegions(shape);
    for (let row = 0; row < size; row++) {
        for (let column = 0; column < size; column++) {
            const point = { x: column + 0.5, y: row + 0.5 };
            const filled = regions.some(region => pointInPolygon(point, region.outer)
                && !region.holes.some(hole => pointInPolygon(point, hole)));
            assert.equal(filled, !!raster.mask[row * size + column], `sample ${sample}, pixel ${column},${row}`);
        }
    }
    assert.equal(pictureTriangles(shape).reduce((sum, triangle) => sum + area(triangle), 0),
        raster.mask.reduce((sum, pixel) => sum + pixel, 0));
}
console.log('PASS merged image outlines, holes, cached geometry and transformed triangulation');