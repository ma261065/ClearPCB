import assert from 'node:assert/strict';
import { encodePictureArtwork, decodePictureArtwork } from '../src/pcb/modules/picture-storage.js';

const artworks = [
    { width: 100, height: 100, rectangles: [{ x: 1, y: 2, width: 3, height: 4 }] },
    { width: 100, height: 100, contours: [[{ x: 1 / 3, y: Math.PI }, { x: 50.1234567890123, y: 2 }, { x: 90, y: 80 }]] },
    { width: 100, height: 100, circles: [{ x: Math.PI * 10, y: 20, radius: 1 / 3 }] },
    { width: 512, height: 512, circles: Array.from({ length: 6400 }, (_, index) => ({
        x: index % 80 * 6 + 3, y: Math.floor(index / 80) * 6 + 3, radius: 2,
    })) },
];
for (const original of artworks) {
    for (const invert of [undefined, false, true]) {
        const artwork = { ...original, ...(invert === undefined ? {} : { invert }), flipHorizontal: false, flipVertical: true };
        const encoded = encodePictureArtwork(artwork);
        assert.deepEqual(decodePictureArtwork(JSON.parse(JSON.stringify(encoded))), artwork, 'coordinates round-trip without rounding');
        assert.throws(() => decodePictureArtwork(artwork), /Unsupported image storage encoding/);
        assert.deepEqual(encodePictureArtwork(decodePictureArtwork(encoded)), encoded, 'encoding is deterministic');
        assert.ok(JSON.stringify(encoded).length < JSON.stringify(artwork).length);
    }
}
const large = artworks[3];
const encoded = encodePictureArtwork(large);
assert.equal(encoded.encoding, 'deflate-tuples-v1');
assert.ok(JSON.stringify(encoded).length < JSON.stringify(large).length / 5);
large.circles[0].radius = 1.23456789012345;
assert.deepEqual(decodePictureArtwork(encodePictureArtwork(large)), large, 'in-place edits invalidate cached compression');
const before = encodePictureArtwork(large);
before.data = 'corrupted snapshot';
assert.deepEqual(decodePictureArtwork(encodePictureArtwork(large)), large, 'snapshot mutation does not poison the cache');
for (const invalid of [
    null, undefined, {},
    { encoding: 'unknown' }, { ...encoded, bytes: 1000000000 }, { ...encoded, bytes: 0 },
    { ...encoded, data: '!' }, { encoding: 'tuples-v1', data: [1, 1, 2, 0, [0, 0]] },
    { encoding: 'tuples-v1', data: [1, 1, 2, 2, [0.5, 0.5, 0.1]] },
]) assert.throws(() => decodePictureArtwork(invalid));
console.log(`PASS: lossless image storage; 6400-dot fixture ${JSON.stringify(artworks[3]).length} -> ${JSON.stringify(encoded).length} JSON bytes`);

globalThis.window = { addEventListener() {} };
const { pictureShape } = await import('../src/pcb/modules/picture-raster.js');
const { serializeBoardShapes, loadBoardShapes } = await import('../src/pcb/modules/board-shapes.js');
const first = { ...pictureShape(large, { widthMm: 20, layer: 'top-silk' }), id: 'pshape_1' };
const second = { ...pictureShape(large, { widthMm: 30, layer: 'bottom-silk', center: { x: 5, y: 7 } }), id: 'pshape_2' };
const saved = serializeBoardShapes({ boardShapes: [first, second] });
assert.equal(saved[0].artwork.encoding, 'deflate-tuples-v1');
assert.deepEqual(saved[1].artwork, { encoding: 'reference-v1', index: 0 });
const load = data => {
    const app = { boardShapes: [], _shapeIdCounter: 1 };
    loadBoardShapes(app, JSON.parse(JSON.stringify(data)), { strict: true, render: false });
    return app;
};
const restored = load(saved);
assert.deepEqual(serializeBoardShapes(restored), saved);
assert.deepEqual(restored.boardShapes[0].artwork, first.artwork);
assert.deepEqual(restored.boardShapes[1].points, second.points);
restored.boardShapes[0].artwork.circles[0].radius = 0.1;
assert.equal(restored.boardShapes[1].artwork.circles[0].radius, large.circles[0].radius, 'loaded duplicates are independently editable');
assert.throws(() => load([{ ...saved[0], artwork: large }]), /Unsupported image storage encoding/,
    'legacy board images are rejected');
for (const reference of [-1, 0, 1, 0.5, '0']) {
    assert.throws(() => load([{ ...saved[0], artwork: { encoding: 'reference-v1', index: reference } }]));
}
const reordered = serializeBoardShapes({ boardShapes: [second, first] });
assert.deepEqual(reordered[1].artwork, { encoding: 'reference-v1', index: 0 }, 'references are rebuilt after reordering');
assert.deepEqual(load(serializeBoardShapes({ boardShapes: [second] })).boardShapes[0].artwork, large,
    'deleting the first instance cannot leave dangling references');
console.log('PASS: compact board serialization, duplicate-image references, legacy rejection, and independent edits');

const { prepareFabricationSnapshot } = await import('../src/pcb/modules/fabrication-snapshot.js');
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
const exportImage = { ...pictureShape(artworks[2], { widthMm: 5, layer: 'top-copper', center: { x: 5, y: -5 } }), id: 'export-image' };
const exportApp = { placements: new Map(), tracks: [], vias: [], texts: new Map(), copperFills: [],
    boardShapes: [exportImage], _boardWidth: 10, _boardHeight: 10, _boardY: -10 };
const snapshot = await prepareFabricationSnapshot(exportApp);
assert.deepEqual(snapshot.boardShapes[0].artwork, exportImage.artwork, 'manufacturing snapshot uses decoded geometry');
assert.notEqual(snapshot.boardShapes[0].artwork, exportImage.artwork, 'manufacturing geometry remains detached');
assert.ok(exportGerbers(snapshot).get('board.gtl').includes('G36*'), 'image still reaches Gerber through the fabrication snapshot');
console.log('PASS: compact storage does not leak into manufacturing snapshots or Gerber');