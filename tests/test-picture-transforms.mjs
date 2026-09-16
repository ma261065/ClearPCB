import assert from 'node:assert/strict';
import { pictureShape, pictureRegions, pictureTriangles, validatePictureArtwork } from '../src/pcb/modules/picture-raster.js';
import { pointInPolygon } from '../src/core/geometry.js';

const raster = { width: 4, height: 3, rectangles: [{ x: 0, y: 0, width: 1, height: 1 }] };
const image = pictureShape(raster, { widthMm: 4, layer: 'top-copper' });
const originalArtwork = image.artwork;
const originalPoints = structuredClone(image.points);
for (const invert of [false, true]) {
    for (const flipHorizontal of [false, true]) {
        for (const flipVertical of [false, true]) {
            image.artwork = { ...originalArtwork, invert, flipHorizontal, flipVertical };
            const regions = pictureRegions(image);
            for (let row = 0; row < 3; row++) {
                for (let column = 0; column < 4; column++) {
                    const point = { x: column - 1.5, y: row - 1 };
                    const filled = column === (flipHorizontal ? 3 : 0) && row === (flipVertical ? 2 : 0);
                    assert.equal(regions.some(region => pointInPolygon(point, region.outer)
                        && !region.holes.some(hole => pointInPolygon(point, hole))), invert ? !filled : filled);
                }
            }
            assert.ok(pictureTriangles(image).length > 0);
            assert.deepEqual(image.points, originalPoints);
            assert.deepEqual(originalArtwork, raster);
        }
    }
}
console.log('PASS image inversion and local horizontal/vertical flips, combinations and cache invalidation');
const solid = pictureShape({ width: 2, height: 2, rectangles: [{ x: 0, y: 0, width: 2, height: 2 }] },
    { widthMm: 2, layer: 'top-silk' });
solid.artwork = { ...solid.artwork, invert: true };
assert.deepEqual(pictureRegions(solid), []);
assert.deepEqual(pictureTriangles(solid), []);
solid.artwork = { ...solid.artwork, invert: false };
assert.equal(pictureRegions(solid).length, 1);
for (const property of ['invert', 'flipHorizontal', 'flipVertical']) {
    assert.throws(() => validatePictureArtwork({ ...raster, [property]: 'false' }), /expected a boolean/);
}
globalThis.window = { addEventListener() {} };
const { serializeBoardShapes, loadBoardShapes } = await import('../src/pcb/modules/board-shapes.js');
image.id = 'pshape_1';
for (const invert of [false, true]) {
    for (const flipHorizontal of [false, true]) {
        for (const flipVertical of [false, true]) {
            image.artwork = { ...originalArtwork, invert, flipHorizontal, flipVertical };
            const saved = serializeBoardShapes({ boardShapes: [image] });
            const loaded = { boardShapes: [], _shapeIdCounter: 1 };
            loadBoardShapes(loaded, saved, { strict: true, render: false });
            assert.deepEqual(serializeBoardShapes(loaded), saved);
            assert.deepEqual(pictureRegions(loaded.boardShapes[0]), pictureRegions(image));
        }
    }
}
console.log('PASS transform flag validation, empty inversion recovery and save/load persistence');