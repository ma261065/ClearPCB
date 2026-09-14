import assert from 'node:assert/strict';
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