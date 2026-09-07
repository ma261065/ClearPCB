import assert from 'node:assert/strict';

globalThis.localStorage = { getItem() { return null; }, removeItem() {} };
globalThis.window = { addEventListener() {}, dispatchEvent() {} };
globalThis.document = { body: { contains() { return false; } } };
const { punchHolesInFlatMesh } = await import('./src/pcb/modules/board3d.js');

const mesh = {
    verts: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }],
    faces: [{ idx: [0, 1, 2] }],
};
const holes = Array.from({ length: 30 }, (_, index) => ({
    x: 6 + index * 0.05, z: 6 + index * 0.03, r: 0.4,
}));
for (const indices of [[0, 1, 2], [2, 1, 0]]) {
    const input = { ...mesh, faces: [{ idx: indices }] };
    const output = punchHolesInFlatMesh(input, holes);
    assert.equal(output.faces.length, 1, 'Nonintersecting holes must not fragment a triangle');
    assert.deepEqual(output.verts, indices.map((index) => mesh.verts[index]));
    const cut = punchHolesInFlatMesh(input, [...holes, { x: 2, z: 2, r: 1 }]);
    const area = cut.faces.reduce((sum, face) => {
        const [first, second, third] = face.idx.map((index) => cut.verts[index]);
        return sum + Math.abs((second.x - first.x) * (third.z - first.z)
            - (second.z - first.z) * (third.x - first.x)) / 2;
    }, 0);
    assert.ok(Math.abs(area - (50 - 24 * Math.sin(2 * Math.PI / 48))) < 1e-8,
        'A genuine intersecting hole must still be subtracted');
}
console.log('PASS: disjoint cutouts preserve triangle count and real cuts retain area for both windings');