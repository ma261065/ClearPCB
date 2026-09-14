import assert from 'node:assert/strict';
import { pictureShape, pictureContours, resizePicturePoints, validatePictureArtwork } from '../src/pcb/modules/picture-raster.js';

const raster = { width: 4, height: 2, rectangles: [{ x: 0, y: 0, width: 1, height: 2 }, { x: 3, y: 0, width: 1, height: 2 }] };
const image = pictureShape(raster, { widthMm: 4, layer: 'top-silk' });
assert.equal(image.kind, 'image');
assert.equal(image.points.length, 4);
assert.equal(pictureContours(image).length, 2);
assert.deepEqual(image.points, [{ x: -2, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 1 }, { x: -2, y: 1 }]);
const resized = resizePicturePoints(image.points, 2, { x: 6, y: 3 });
assert.deepEqual(resized[0], image.points[0]);
assert.deepEqual(resized[2], { x: 6, y: 3 });
assert.ok(pictureContours({ ...image, points: resized }).some(contour =>
    contour.length === 4 && contour.every(point => [-2, 0].includes(point.x) && [-1, 3].includes(point.y))));
assert.deepEqual(image.artwork, raster, 'Resize never alters the pixel artwork');
assert.notEqual(image.artwork.rectangles, raster.rectangles);
assert.throws(() => validatePictureArtwork({ ...raster, rectangles: [{ x: 3, y: 0, width: 2, height: 1 }] }));
console.log('PASS single image object, internal artwork contours and proportional resizing');

globalThis.window = { addEventListener() {} };
const { getBoardShapeAnchors, boardShapeHitTest, boardShapeBounds, resolveBoardShapeGeometry,
    serializeBoardShapes, loadBoardShapes, applyBoardShapeVertexResize } = await import('../src/pcb/modules/board-shapes.js');
image.id = 'pshape_1';
assert.equal(getBoardShapeAnchors(image).length, 4, 'Image exposes only bounding-box resize handles');
assert.ok(getBoardShapeAnchors(image).every(anchor => !anchor.midpoint));
assert.equal(boardShapeHitTest(image, { x: 0, y: 0 }), true, 'Transparent interior belongs to the selectable object');
assert.deepEqual(boardShapeBounds(image), { minX: -2, minY: -1, maxX: 2, maxY: 1 });
assert.deepEqual(resolveBoardShapeGeometry(image).physicalContours, pictureContours(image));
applyBoardShapeVertexResize(image, { before: { points: image.points }, handle: 2 }, { x: 6, y: 3 });
assert.deepEqual(image.points, resized);
const saved = serializeBoardShapes({ boardShapes: [image] });
const loaded = { boardShapes: [], _shapeIdCounter: 1 };
loadBoardShapes(loaded, saved, { render: false, strict: true });
assert.deepEqual(serializeBoardShapes(loaded), saved);
assert.equal(loaded.boardShapes.length, 1);
assert.throws(() => loadBoardShapes({ boardShapes: [] }, [{ ...saved[0], artwork: null }], { render: false, strict: true }));
assert.throws(() => loadBoardShapes({ boardShapes: [] }, [{ ...saved[0], points: [{ x: Infinity, y: 0 }, ...image.points.slice(1)] }], { render: false, strict: true }));
assert.throws(() => loadBoardShapes({ boardShapes: [] }, [{ ...saved[0], points: image.points.map(() => ({ x: 0, y: 0 })) }], { render: false, strict: true }));
console.log('PASS image selection, resize handles, physical artwork and single-object persistence');
for (const layer of ['top-document', 'bottom-document']) {
    const documentImage = { ...pictureShape(raster, { widthMm: 4, layer, net: 'GND' }), id: 'pshape_2' };
    assert.equal(documentImage.layer, layer);
    assert.equal(documentImage.net, '', 'Document artwork is not assigned to a copper net');
    const documentSaved = serializeBoardShapes({ boardShapes: [documentImage] });
    const documentLoaded = { boardShapes: [], _shapeIdCounter: 1 };
    loadBoardShapes(documentLoaded, documentSaved, { render: false, strict: true });
    assert.deepEqual(serializeBoardShapes(documentLoaded), documentSaved);
}
console.log('PASS document-layer image creation and persistence');