import assert from 'node:assert/strict';
import ClipperLib from './assets/vendor/clipper.esm.js';
import { punchHolesInFlatMesh } from './src/pcb/modules/board3d-mesh-ops.js';

globalThis.window = { addEventListener() {} };
globalThis.document = {};
const { boardShapeFilledRemovalOutlines } = await import('./src/pcb/modules/board-shapes.js');
const shape = {
    kind: 'polygon', layer: 'hole', filled: true, lineWidth: 1.85,
    nodeCornerRadii: { 0: 27, 2: 10, 3: 35 }, cornerRadius: 8,
    points: [
        { x: 72.39, y: -53.34 }, { x: 88.9, y: -90.17 },
        { x: 87.63, y: -35.56 }, { x: 36.83, y: -30.48 },
    ],
};
const ring = boardShapeFilledRemovalOutlines(shape)[0].map(point => ({ x: point.x, z: point.y }));
const mesh = { verts: [], faces: [] };
for (let column = 0; column < 100; column++) {
    for (let row = -80; row < 0; row++) {
        const base = mesh.verts.length;
        mesh.verts.push(
            { x: column, y: 1.6, z: row }, { x: column + 1, y: 1.6, z: row },
            { x: column + 1, y: 1.6, z: row + 1 }, { x: column, y: 1.6, z: row + 1 },
        );
        mesh.faces.push({ idx: [base, base + 1, base + 2], color: [1, 0, 0] },
            { idx: [base, base + 2, base + 3], color: [1, 0, 0] });
    }
}
const scale = 10000;
const toPath = points => points.map(point => ({ X: Math.round(point.x * scale), Y: Math.round(point.z * scale) }));
const clipper = new ClipperLib.Clipper();
clipper.AddPath(toPath([{ x: 0, z: -80 }, { x: 100, z: -80 }, { x: 100, z: 0 }, { x: 0, z: 0 }]),
    ClipperLib.PolyType.ptSubject, true);
clipper.AddPath(toPath(ring), ClipperLib.PolyType.ptClip, true);
const solution = new ClipperLib.Paths();
clipper.Execute(ClipperLib.ClipType.ctDifference, solution,
    ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
const expectedArea = solution.reduce((area, path) => area + ClipperLib.Clipper.Area(path), 0) / scale ** 2;

for (const reversed of [false, true]) {
    const startedAt = performance.now();
    const result = punchHolesInFlatMesh(mesh, [{ x: 62.5, z: -52.4, r: 40,
        ring: reversed ? [...ring].reverse() : ring }]);
    const elapsed = performance.now() - startedAt;
    let degenerateFaces = 0;
    const actualArea = result.faces.reduce((area, face) => {
        const [first, second, third] = face.idx.map(index => result.verts[index]);
        assert.equal(first.y, 1.6);
        assert.deepEqual(face.color, [1, 0, 0]);
        const faceArea = Math.abs((second.x - first.x) * (third.z - first.z)
            - (second.z - first.z) * (third.x - first.x)) / 2;
        if (faceArea < 1e-12) degenerateFaces++;
        return area + faceArea;
    }, 0);
    assert.ok(Math.abs(actualArea - expectedArea) < 0.001, `${actualArea} vs ${expectedArea}`);
    assert.ok(result.faces.length < mesh.faces.length * 2, 'Cutout fragments must not multiply across triangle boundaries');
    console.log(`PASS dense rounded cutout ${reversed ? 'reversed' : 'forward'}: ${elapsed.toFixed(1)} ms, ${result.faces.length} faces (${degenerateFaces} degenerate)`);
}

const verticalMesh = {
    verts: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 },
        { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }],
    faces: [{ idx: [0, 1, 2], color: [1, 0, 0] }, { idx: [0, 2, 3], color: [1, 0, 0] }],
};
const verticalResult = punchHolesInFlatMesh(verticalMesh, [{ x: 0.5, z: 0, r: 2,
    ring: [{ x: 0.25, z: -1 }, { x: 0.75, z: -1 }, { x: 0.75, z: 1 }, { x: 0.25, z: 1 }] }]);
const verticalArea = verticalResult.faces.reduce((area, face) => {
    const [first, second, third] = face.idx.map(index => verticalResult.verts[index]);
    return area + Math.abs((second.x - first.x) * (third.y - first.y)
        - (second.y - first.y) * (third.x - first.x)) / 2;
}, 0);
assert.ok(Math.abs(verticalArea - 0.5) < 1e-9, `Vertical faces lost: ${verticalArea}`);
console.log('PASS vertical surfaces survive fragment pruning');