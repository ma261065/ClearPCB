import assert from 'node:assert/strict';
import { pictureShape, pictureRegions, validatePictureArtwork } from '../src/pcb/modules/picture-raster.js';
import { pointInPolygon } from '../src/core/geometry.js';
import { tracePicture } from '../src/pcb/modules/picture-trace.js';

const traced = { width: 100, height: 100, contours: [
    [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
    [{ x: 25, y: 25 }, { x: 75, y: 25 }, { x: 75, y: 75 }, { x: 25, y: 75 }],
] };
const image = pictureShape(traced, { widthMm: 5, layer: 'top-copper' });
const contains = (shape, point) => pictureRegions(shape).some(region => pointInPolygon(point, region.outer)
    && !region.holes.some(hole => pointInPolygon(point, hole)));
assert.equal(contains(image, { x: 0, y: 0 }), false, 'Traced holes remain empty regardless of ring winding');
assert.equal(contains(image, { x: 2, y: 0 }), true);
image.artwork = { ...image.artwork, invert: true };
assert.equal(contains(image, { x: 0, y: 0 }), true);
assert.equal(contains(image, { x: 2, y: 0 }), false);
assert.throws(() => validatePictureArtwork({ ...traced, contours: [[{ x: NaN, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }]] }));
assert.throws(() => validatePictureArtwork({ ...traced, contours: [] }), /empty/);
assert.throws(() => validatePictureArtwork({ ...traced, rectangles: [] }), /one representation/);
console.log('PASS traced artwork geometry, holes, inversion, sub-0.1mm sampling and validation');
const width = 64;
const mask = new Uint8Array(width * width);
for (let row = 0; row < width; row++) {
    for (let column = 0; column < width; column++) {
        const distance = Math.hypot(column + 0.5 - 32, row + 0.5 - 32);
        mask[row * width + column] = distance < 25 && distance > 10 ? 1 : 0;
    }
}
const ring = tracePicture({ width, height: width, mask });
const ringShape = pictureShape(ring, { widthMm: width, layer: 'top-silk' });
assert.equal(contains(ringShape, { x: 0, y: 0 }), false);
assert.equal(contains(ringShape, { x: 18, y: 0 }), true);
assert.equal(contains(ringShape, { x: 30, y: 0 }), false);
assert.ok(ring.contours.flat().length < 150, 'Curves replace the hundreds of stair-step corners');
for (const row of [1, 2]) for (const column of [1, 2]) mask[row * width + column] = 1;
const speckled = tracePicture({ width, height: width, mask }, { despeckle: 0 });
const cleaned = tracePicture({ width, height: width, mask }, { despeckle: 16 });
assert.ok(cleaned.contours.length < speckled.contours.length, 'Despeckling removes isolated marks');
assert.throws(() => tracePicture({ width, height: width, mask: new Uint8Array(width * width) }), /empty/);
console.log('PASS ImageTracerJS curve fitting, hole preservation, white-material polarity and noise filtering');
globalThis.window = { addEventListener() {} };
const { serializeBoardShapes, loadBoardShapes } = await import('../src/pcb/modules/board-shapes.js');
const { boardShapeClearanceOutlines } = await import('../src/pcb/modules/copper-fill-geom.js');
const { collectCopperArtwork } = await import('../src/pcb/modules/copper-artwork.js');
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
ringShape.id = 'pshape_1';
ringShape.layer = 'top-copper';
for (const invert of [false, true]) {
    for (const flipHorizontal of [false, true]) {
        for (const flipVertical of [false, true]) {
            ringShape.artwork = { ...ring, invert, flipHorizontal, flipVertical };
            const saved = serializeBoardShapes({ boardShapes: [ringShape] });
            const loaded = { boardShapes: [], _shapeIdCounter: 1 };
            loadBoardShapes(loaded, saved, { strict: true, render: false });
            assert.deepEqual(serializeBoardShapes(loaded), saved);
            assert.deepEqual(pictureRegions(loaded.boardShapes[0]), pictureRegions(ringShape));
        }
    }
}
ringShape.artwork = ring;
const copper = collectCopperArtwork({ boardShapes: [ringShape] });
assert.equal(copper.areas.some(area => pointInPolygon({ x: 0, y: 0 }, area.outer)
    && !area.holes.some(hole => pointInPolygon({ x: 0, y: 0 }, hole))), false, 'Tracing holes remain absent copper');
assert.ok(copper.areas.some(area => pointInPolygon({ x: 18, y: 0 }, area.outer)
    && !area.holes.some(hole => pointInPolygon({ x: 18, y: 0 }, hole))));
assert.ok(boardShapeClearanceOutlines(ringShape, 0.1).length > 0);
const files = exportGerbers({ placements: new Map(), boardWidth: 100, boardHeight: 100,
    boardX: -50, boardY: -50, boardShapes: [ringShape] });
assert.ok(files.get('board.gtl').includes('G36*'), 'Traced artwork exports as Gerber regions');
console.log('PASS traced image transform persistence, copper holes, clearance and Gerber output');
const sourceWidth = 1302;
const sourceHeight = 64;
const sourceMask = new Uint8Array(sourceWidth * sourceHeight);
for (let row = 20; row < 23; row++) sourceMask.fill(1, row * sourceWidth + 10, row * sourceWidth + 1290);
const sourceArtwork = tracePicture({ width: sourceWidth, height: sourceHeight, mask: sourceMask });
const sourceShape = pictureShape(sourceArtwork, { widthMm: sourceWidth / 10, layer: 'top-silk' });
for (let column = 20; column < 1280; column += 20) {
    assert.ok(contains(sourceShape, { x: (column - sourceWidth / 2) / 10, y: (21.5 - sourceHeight / 2) / 10 }), 'Thin wire remains continuous');
}
assert.ok(sourceArtwork.contours.flat().every(point => point.y >= 20 && point.y <= 23), 'Straight wire edges do not overshoot');
sourceShape.id = 'pshape_1';
const sourceSaved = serializeBoardShapes({ boardShapes: [sourceShape] });
const sourceLoaded = { boardShapes: [], _shapeIdCounter: 1 };
loadBoardShapes(sourceLoaded, sourceSaved, { strict: true, render: false });
assert.deepEqual(serializeBoardShapes(sourceLoaded), sourceSaved);
assert.throws(() => validatePictureArtwork({ width: 513, height: 1, rectangles: [{ x: 0, y: 0, width: 513, height: 1 }] }), /512/);
assert.throws(() => validatePictureArtwork({ ...sourceArtwork, width: 2049 }), /2048/);
console.log('PASS source-resolution thin wires, contour persistence and separate resolution limits');