import assert from 'node:assert/strict';
import earcut from '../assets/vendor/earcut.module.js';
import { clipMeshToOutline, punchHolesInFlatMesh } from '../src/pcb/modules/board3d-mesh-ops.js';
import { meshToGeometry } from '../src/shared/3d/model-rendering.js';

// Exhaustive concave path: every outline triangle receives every source face.
function exhaustiveClip(mesh, outline) {
    const indices = earcut(outline.flatMap(point => [point.x, point.z]));
    const combined = { verts: [], faces: [] };
    for (let index = 0; index < indices.length; index += 3) {
        const region = [outline[indices[index]], outline[indices[index + 1]], outline[indices[index + 2]]];
        const clipped = clipMeshToOutline(mesh, region);
        const base = combined.verts.length;
        for (const vertex of clipped.verts) combined.verts.push(vertex);
        for (const face of clipped.faces) combined.faces.push({
            ...face, idx: face.idx.map(vertexIndex => vertexIndex + base),
        });
    }
    return combined;
}

function compare(mesh, outline, name) {
    const before = structuredClone({ mesh, outline });
    const actual = clipMeshToOutline(mesh, outline);
    const expected = exhaustiveClip(mesh, outline);
    assert.deepEqual(actual, expected, `${name}: exact vertices, face order, winding and colors`);
    assert.deepEqual({ mesh, outline }, before, `${name}: inputs stay immutable`);
    const actualGeometry = meshToGeometry(actual);
    const expectedGeometry = meshToGeometry(expected);
    for (const attribute of ['position', 'normal', 'color']) {
        assert.deepEqual(actualGeometry.getAttribute(attribute).array, expectedGeometry.getAttribute(attribute).array,
            `${name}: identical ${attribute} buffers at every view angle`);
    }
    actualGeometry.dispose();
    expectedGeometry.dispose();
}

const notch = [
    { x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 3 }, { x: 6, z: 3 },
    { x: 6, z: 7 }, { x: 10, z: 7 }, { x: 10, z: 10 }, { x: 0, z: 10 },
];
const curvedNotch = [{ x: 0, z: 0 }, { x: 10, z: 0 },
    ...Array.from({ length: 33 }, (_, index) => {
        const angle = -Math.PI / 2 - index * Math.PI / 32;
        return { x: 10 + 3 * Math.cos(angle), z: 5 + 3 * Math.sin(angle) };
    }), { x: 10, z: 10 }, { x: 0, z: 10 }];
const mesh = { verts: [], faces: [] };
function addFace(points, color) {
    const base = mesh.verts.length;
    mesh.verts.push(...points.map(([x, z, y = 1.6]) => ({ x, y, z })));
    mesh.faces.push({ idx: points.map((_, index) => base + index), color });
}
addFace([[-1, -1], [11, -1], [11, 11], [-1, 11]], [80, 120, 160]);
addFace([[6, 3, 0], [10, 3, 0], [10, 3, 2], [6, 3, 2]], [255, 0, 0]);
addFace([[6, 3], [6, 7], [6, 5]], [1, 2, 3]);
addFace([[10, 10], [11, 10], [10, 11]], [3, 2, 1]);
addFace([[0, 0, -0], [0, 1, 3], [-1e-12, 0, 4]], undefined);
addFace([[6 - 1e-12, 3], [6 + 1e-12, 3], [6, 7]], [10, 20, 30]);
addFace([[40, 40], [41, 40], [40, 41]], [0, 0, 0]);
mesh.faces.push({ idx: [] }, { idx: [0, 1] }, { idx: [0, 1, 99999, 2, 3] }, {});
let seed = 417;
const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);
for (let index = 0; index < 150; index++) {
    const x = random() * 16 - 3, z = random() * 16 - 3;
    addFace([[x, z, random() * 3], [x + random() * 3, z, random() * 3],
        [x, z + random() * 3, random() * 3]], [index, index % 23, 255 - index]);
}
for (const [name, boundary] of [['notch', notch], ['rounded', curvedNotch]]) {
    for (const reversed of [false, true]) {
        for (const offset of [0, -1e4, 1e6]) {
            const outline = (reversed ? [...boundary].reverse() : boundary)
                .map(point => ({ x: point.x + offset, z: point.z - offset }));
            const translated = { ...mesh, verts: mesh.verts.map(point =>
                ({ ...point, x: point.x + offset, z: point.z - offset })) };
            compare(translated, outline, `${name}/${reversed}/${offset}`);
        }
    }
}
compare({ verts: [], faces: [] }, notch, 'empty');
const punched = punchHolesInFlatMesh({
    verts: mesh.verts, faces: mesh.faces.filter(face => face.idx?.length === 3 && face.idx.every(i => mesh.verts[i])),
}, [{ x: 4, z: 5, r: 0.8 }, { x: 7, z: 2, r: 1.2 }]);
compare(punched, curvedNotch, 'drilled surfaces');

const dense = { verts: [], faces: [] };
let visits = 0;
for (let z = 0; z < 100; z++) for (let x = 0; x < 100; x++) {
    const base = dense.verts.length;
    dense.verts.push({ x: x / 10, z: z / 10, y: 1.6 },
        { x: (x + 0.5) / 10, z: z / 10, y: 1.6 },
        { x: x / 10, z: (z + 0.5) / 10, y: 1.6 });
    const idx = [base, base + 1, base + 2];
    dense.faces.push({ get idx() { visits++; return idx; }, color: [30, 60, 90] });
}
const baselineStart = performance.now();
const expected = exhaustiveClip(dense, curvedNotch);
const baselineMs = performance.now() - baselineStart;
const baselineVisits = visits;
visits = 0;
const start = performance.now();
const actual = clipMeshToOutline(dense, curvedNotch);
const elapsed = performance.now() - start;
assert.deepEqual(actual, expected, 'Dense artwork retains exact ordered output');
assert.ok(visits < baselineVisits * 0.4, `${visits} vs ${baselineVisits}: conservative bounds remove at least 60% of face visits`);
console.log(`PASS concave clipping parity, borders, vertical/sloped faces, buffers and sparse visits: ${visits}/${baselineVisits}; ${elapsed.toFixed(1)} vs ${baselineMs.toFixed(1)} ms`);
