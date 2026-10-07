import assert from 'node:assert/strict';
import {
    pictureShape,
    pictureContours,
    resizePicturePoints,
    validatePictureArtwork,
    validatePicturePoints,
    MAX_PICTURE_REGIONS,
} from '../../src/shared/pcb/picture-raster.js';

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
assert.throws(() => validatePictureArtwork({ ...raster, rectangles: [] }),
    /Image artwork is empty: no pixels remain after conversion/);
const detailedArtwork = { width: 100, height: 100, rectangles: Array.from({ length: MAX_PICTURE_REGIONS }, (_, index) => ({
    x: (index % 50) * 2, y: Math.floor(index / 50) * 2, width: 1, height: 1,
})) };
assert.doesNotThrow(() => validatePictureArtwork(detailedArtwork));
detailedArtwork.rectangles.push({ x: 0, y: 80, width: 1, height: 1 });
assert.throws(() => validatePictureArtwork(detailedArtwork),
    { message: `Image artwork has ${MAX_PICTURE_REGIONS + 1} rectangles; the limit is ${MAX_PICTURE_REGIONS}. Reduce resolution or adjust the threshold to simplify the artwork.` });
assert.throws(() => validatePictureArtwork({ ...raster, width: 513 }), /Invalid image artwork data/);
console.log('PASS single image object, internal artwork contours and proportional resizing');

globalThis.window = { addEventListener() {} };
const { boardShapeHitTest, boardShapeBounds, resolveBoardShapeGeometry } = await import('../../src/shared/pcb/board-shape-geometry.js');
const { getBoardShapeAnchors,
    serializeBoardShapes, loadBoardShapes, applyBoardShapeVertexResize } = await import('../../src/pcb/modules/board-shapes.js');
image.id = 'pshape_1';
assert.equal(getBoardShapeAnchors(image).length, 4, 'Image exposes only bounding-box resize handles');
assert.ok(getBoardShapeAnchors(image).every(anchor => !anchor.midpoint));
assert.equal(boardShapeHitTest(image, { x: 0, y: 0 }), true, 'Transparent interior belongs to the selectable object');
assert.deepEqual(boardShapeBounds(image), { minX: -2, minY: -1, maxX: 2, maxY: 1 });
assert.deepEqual(resolveBoardShapeGeometry(image).physicalContours, pictureContours(image));
applyBoardShapeVertexResize(image, { before: { points: image.points }, handle: 2 }, { x: 6, y: 3 });
assert.deepEqual(image.points, resized);
const saved = serializeBoardShapes({ boardShapes: [image] });
assert.deepEqual(Object.fromEntries(['x', 'y', 'width', 'height', 'rotation'].map(key => [key, saved[0][key]])),
    { x: 2, y: 1, width: 8, height: 4, rotation: 0 });
assert.equal(Object.hasOwn(saved[0], 'points'), false);
const loaded = { boardShapes: [], shapeIdCounter: 1 };
loadBoardShapes(loaded, saved, { render: false, strict: true });
assert.deepEqual(serializeBoardShapes(loaded), saved);
assert.equal(loaded.boardShapes.length, 1);
assert.deepEqual(loaded.boardShapes[0].points, resized, 'Axis-aligned frame preserves the source corner order');
validatePicturePoints(loaded.boardShapes[0].points);
const angle = 37 * Math.PI / 180;
const rotated = image.points.map(point => ({
    x: 12.3456789 + point.x * Math.cos(angle) - point.y * Math.sin(angle),
    y: -9.8765432 + point.x * Math.sin(angle) + point.y * Math.cos(angle),
}));
image.points = resizePicturePoints(rotated, 2, { x: rotated[2].x + 3.1415926, y: rotated[2].y + 2.7182818 });
const beforeSave = structuredClone(image);
const transformedSaved = serializeBoardShapes({ boardShapes: [image] });
const frame = transformedSaved[0];
const round4 = value => Math.round(value * 10000) / 10000;
const width = Math.hypot(image.points[1].x - image.points[0].x, image.points[1].y - image.points[0].y);
const height = Math.hypot(image.points[3].x - image.points[0].x, image.points[3].y - image.points[0].y);
assert.equal(Object.hasOwn(frame, 'points'), false);
assert.deepEqual(Object.fromEntries(['x', 'y', 'width', 'height', 'rotation'].map(key => [key, frame[key]])), {
    x: round4((image.points[0].x + image.points[2].x) / 2),
    y: round4((image.points[0].y + image.points[2].y) / 2),
    width: round4(width), height: round4(height), rotation: 323,
});
assert.equal(Object.hasOwn(frame, 'reversed'), false);
assert.deepEqual(image, beforeSave, 'Autosave does not mutate live image bounds or artwork');
const transformedLoaded = { boardShapes: [], shapeIdCounter: 1 };
loadBoardShapes(transformedLoaded, transformedSaved, { render: false, strict: true });
assert.deepEqual(serializeBoardShapes(transformedLoaded), transformedSaved,
    'Rounded frame parameters round-trip unchanged');
const reloaded = transformedLoaded.boardShapes[0];
validatePicturePoints(reloaded.points);
const driftBound = Math.SQRT2 * 0.000075 + Math.hypot(width, height) / 2 * 0.00005 * Math.PI / 180 + 1e-9;
reloaded.points.forEach((point, index) => assert.ok(
    Math.hypot(point.x - image.points[index].x, point.y - image.points[index].y) <= driftBound,
    `Transformed source corner ${index} stays within ${driftBound} mm after parameter rounding`));
const u = { x: reloaded.points[1].x - reloaded.points[0].x, y: reloaded.points[1].y - reloaded.points[0].y };
const v = { x: reloaded.points[3].x - reloaded.points[0].x, y: reloaded.points[3].y - reloaded.points[0].y };
assert.ok(Math.abs(u.x * v.x + u.y * v.y) < 1e-10 * width * height,
    'Reconstructed bounds are strictly rectangular');
const sourceContours = pictureContours(image);
pictureContours(reloaded).forEach((contour, index) => contour.forEach((point, vertex) => {
    const source = sourceContours[index][vertex];
    assert.ok(Math.hypot(point.x - source.x, point.y - source.y) <= driftBound,
        'Artwork retains its source orientation and position within the parameter-rounding bound');
}));
assert.deepEqual(reloaded.artwork, image.artwork, 'Source artwork remains lossless');
const legacyRecord = (record, points) => ({
    ...Object.fromEntries(Object.entries(record).filter(([key]) =>
        !['x', 'y', 'width', 'height', 'rotation', 'reversed'].includes(key))), points,
});
const legacyRounded = [legacyRecord(frame, image.points.map(point => ({
    x: Math.round(point.x * 10000) / 10000,
    y: Math.round(point.y * 10000) / 10000,
})))];
const recovered = { boardShapes: [], shapeIdCounter: 1 };
loadBoardShapes(recovered, legacyRounded, { render: false, strict: true });
assert.doesNotThrow(() => validatePicturePoints(recovered.boardShapes[0].points),
    'Rounded legacy autosaves recover to exact rectangular bounds');
recovered.boardShapes[0].points.forEach((point, index) => assert.ok(
    Math.hypot(point.x - legacyRounded[0].points[index].x, point.y - legacyRounded[0].points[index].y) < 0.00015,
    'Legacy recovery stays within the bounded corner-rounding allowance'));
const migrated = serializeBoardShapes(recovered);
const reloadedLegacy = { boardShapes: [], shapeIdCounter: 1 };
loadBoardShapes(reloadedLegacy, migrated, { render: false, strict: true });
assert.deepEqual(serializeBoardShapes(reloadedLegacy), migrated, 'Legacy records migrate once to stable frames');
assert.throws(() => loadBoardShapes({ boardShapes: [] }, [{ ...frame, points: image.points }],
    { render: false, strict: true }), /both a frame and corner points/);
assert.throws(() => loadBoardShapes({ boardShapes: [] }, [{ ...saved[0], artwork: null }], { render: false, strict: true }));
assert.throws(() => loadBoardShapes({ boardShapes: [] }, [legacyRecord(saved[0],
    [{ x: Infinity, y: 0 }, ...image.points.slice(1)])], { render: false, strict: true }), /four finite corners/);
assert.throws(() => loadBoardShapes({ boardShapes: [] }, [legacyRecord(saved[0],
    image.points.map(() => ({ x: 0, y: 0 })))], { render: false, strict: true }), /nonempty rectangle/);
console.log('PASS image selection, resize handles, physical artwork and single-object persistence');
for (const layer of ['top-document', 'bottom-document']) {
    const documentImage = { ...pictureShape(raster, { widthMm: 4, layer, net: 'GND' }), id: 'pshape_2' };
    assert.equal(documentImage.layer, layer);
    assert.equal(documentImage.net, '', 'Document artwork is not assigned to a copper net');
    const documentSaved = serializeBoardShapes({ boardShapes: [documentImage] });
    const documentLoaded = { boardShapes: [], shapeIdCounter: 1 };
    loadBoardShapes(documentLoaded, documentSaved, { render: false, strict: true });
    assert.deepEqual(serializeBoardShapes(documentLoaded), documentSaved);
}
console.log('PASS document-layer image creation and persistence');