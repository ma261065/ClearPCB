import assert from 'node:assert/strict';
import { MAX_PICTURE_CIRCLES, pictureShape, pictureContours, pictureTriangles, validatePictureArtwork } from '../src/pcb/modules/picture-raster.js';
import { pointInPolygon } from '../src/core/geometry.js';

const artwork = { width: 100, height: 80, circles: [{ x: 20, y: 30, radius: 5 }, { x: 70, y: 50, radius: 10 }] };
const shape = pictureShape(artwork, { widthMm: 5, layer: 'top-copper', center: { x: 2.5, y: 2 } });
assert.deepEqual(shape.artwork, artwork);
assert.notEqual(shape.artwork.circles, artwork.circles);
assert.equal(shape.artwork.contours, undefined);
assert.equal(pictureContours(shape).length, 2);
assert.ok(pictureTriangles(shape).length > 0);
assert.throws(() => validatePictureArtwork({ ...artwork, contours: [] }), /one representation/);
for (const circle of [{ x: NaN, y: 1, radius: 1 }, { x: 1, y: 1, radius: 0 }, { x: 1, y: 1, radius: 2 }]) {
    assert.throws(() => validatePictureArtwork({ ...artwork, circles: [circle] }), /circle/);
}
assert.throws(() => validatePictureArtwork({ ...artwork, circles: Array(MAX_PICTURE_CIRCLES + 1).fill(artwork.circles[0]) }), /20000/);
const many = { width: 512, height: 512, circles: Array.from({ length: 6400 }, (_, index) => ({
    x: index % 80 * 6 + 3, y: Math.floor(index / 80) * 6 + 3, radius: 2,
})) };
validatePictureArtwork(many);
assert.equal(many.circles.length, 6400, 'Circle artwork is independent of the 2000-contour limit');
const manyShape = pictureShape(many, { widthMm: 30, layer: 'top-silk' });
assert.equal(pictureContours(manyShape).length, 6400);
assert.ok(pictureContours(manyShape).flat().length > 50000, 'Derived circle geometry is not subject to the saved contour point cap');
assert.ok(JSON.stringify(many).length < JSON.stringify({ width: 512, height: 512, contours: pictureContours(manyShape) }).length / 5);
globalThis.window = { addEventListener() {} };
const { serializeBoardShapes, loadBoardShapes } = await import('../src/pcb/modules/board-shapes.js');
const { boardShapeClearanceOutlines } = await import('../src/pcb/modules/copper-fill-geom.js');
const { collectCopperArtwork } = await import('../src/pcb/modules/copper-artwork.js');
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
shape.id = 'pshape_1';
for (const invert of [false, true]) for (const flipHorizontal of [false, true]) for (const flipVertical of [false, true]) {
    shape.artwork = { ...artwork, invert, flipHorizontal, flipVertical };
    const saved = serializeBoardShapes({ boardShapes: [shape] });
    const loaded = { boardShapes: [], _shapeIdCounter: 1 };
    loadBoardShapes(loaded, saved, { strict: true, render: false });
    assert.deepEqual(serializeBoardShapes(loaded), saved);
    assert.deepEqual(loaded.boardShapes[0].artwork.circles, artwork.circles);
    assert.deepEqual(pictureContours(loaded.boardShapes[0]), pictureContours(shape));
    const copper = collectCopperArtwork({ boardShapes: [shape] });
    const occupied = point => copper.areas.some(area => pointInPolygon(point, area.outer)
        && !area.holes.some(hole => pointInPolygon(point, hole)));
    const center = { x: (flipHorizontal ? 80 : 20) / 20, y: (flipVertical ? 50 : 30) / 20 };
    assert.equal(occupied(center), !invert, 'Circle centres follow flips and inversion');
    assert.equal(occupied({ x: 2.5, y: 2 }), invert, 'Space between dots remains empty unless inverted');
    assert.ok(boardShapeClearanceOutlines(shape, 0.1).length > 0);
    const files = exportGerbers({ placements: new Map(), boardWidth: 10, boardHeight: 10,
        boardX: -1, boardY: -1, boardShapes: [shape] });
    assert.ok(files.get('board.gtl').includes('G36*'));
}
console.log('PASS compact circle artwork validation, geometry, and separate high-detail budget');
console.log('PASS circle artwork persistence, flips, inversion, copper gaps, clearance and Gerber export');