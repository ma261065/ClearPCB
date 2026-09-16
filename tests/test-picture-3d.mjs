import assert from 'node:assert/strict';
import Clipper from '../assets/vendor/clipper.esm.js';
import { pictureShape } from '../src/pcb/modules/picture-raster.js';
import { pointInPolygon } from '../src/core/geometry.js';

globalThis.indexedDB = { open() { throw new Error('IndexedDB disabled in test'); } };
globalThis.localStorage = { getItem() { return null; }, removeItem() {} };
globalThis.window = { addEventListener() {}, dispatchEvent() {} };
globalThis.document = { body: { contains() { return false; } } };
const { imageArtworkMesh } = await import('../src/pcb/modules/board3d.js');
const image = pictureShape({ width: 3, height: 1, rectangles: [
    { x: 0, y: 0, width: 1, height: 1 }, { x: 2, y: 0, width: 1, height: 1 },
] }, { widthMm: 3, layer: 'top-silk' });
for (const elevation of [-1, 1]) {
    const mesh = imageArtworkMesh(image, elevation, '#ffffff');
    assert.equal(mesh.faces.length, 4);
    assert.ok(mesh.verts.every(vertex => vertex.y === elevation));
    const polygons = mesh.faces.map(face => face.idx.map(index => ({ x: mesh.verts[index].x, y: mesh.verts[index].z })));
    assert.equal(polygons.some(polygon => pointInPolygon({ x: 0, y: 0 }, polygon)), false);
    assert.equal(polygons.some(polygon => pointInPolygon({ x: -1.2, y: 0 }, polygon)), true);
}
console.log('PASS image 3D artwork regions preserve empty pixels on both board faces');
const ring = pictureShape({ width: 3, height: 3, rectangles: [
    { x: 0, y: 0, width: 3, height: 1 }, { x: 0, y: 1, width: 1, height: 1 },
    { x: 2, y: 1, width: 1, height: 1 }, { x: 0, y: 2, width: 3, height: 1 },
] }, { widthMm: 3, layer: 'top-silk' });
const ringMesh = imageArtworkMesh(ring, 1, '#ffffff');
assert.ok(ringMesh.faces.every(face => !pointInPolygon({ x: 0, y: 0 },
    face.idx.map(index => ({ x: ringMesh.verts[index].x, y: ringMesh.verts[index].z })))));
console.log('PASS merged image hole stays open in 3D triangulation');
const dots = pictureShape({ width: 1000, height: 500, circles: Array.from({ length: 20000 }, (_, index) => ({
    x: index % 200 * 5 + 2.5, y: Math.floor(index / 200) * 5 + 2.5, radius: 2,
})) }, { widthMm: 100, layer: 'top-silk', center: { x: 50, y: 25 } });
const originalExecute = Clipper.Clipper.prototype.Execute;
try {
    Clipper.Clipper.prototype.Execute = () => { throw new Error('3D separated dots must not run polygon union'); };
    const mesh = imageArtworkMesh(dots, -1, '#ffffff');
    assert.equal(mesh.verts.length, 20000 * 12);
    assert.equal(mesh.faces.length, 20000 * 10);
    assert.ok(mesh.verts.every(vertex => vertex.y === -1));
    assert.ok(mesh.faces.every(face => face.idx.every(index => Math.floor(index / 12) === Math.floor(face.idx[0] / 12))),
        'Triangles never bridge between dots');
    const flipped = { ...dots, artwork: { ...dots.artwork, flipHorizontal: true, flipVertical: true },
        points: [{ x: 10, y: 20 }, { x: 10, y: 120 }, { x: -40, y: 120 }, { x: -40, y: 20 }] };
    const rotated = imageArtworkMesh(flipped, 1, '#ffffff');
    assert.ok(Math.abs(rotated.verts[0].x - (-39.75)) < 1e-9);
    assert.ok(Math.abs(rotated.verts[0].z - 119.95) < 1e-9);
} finally {
    Clipper.Clipper.prototype.Execute = originalExecute;
}
console.log('PASS 20000-dot direct 3D mesh bypasses Clipper and preserves gaps, flips and rotation');