globalThis.indexedDB = { open() { throw new Error('IndexedDB disabled in test'); } };
globalThis.localStorage = { getItem() { return null; }, removeItem() {} };
globalThis.window = { addEventListener() {}, dispatchEvent() {} };
globalThis.document = { body: { contains() { return false; } } };

const { resolveBoardShapeGeometry } = await import('./src/pcb/modules/board-shapes.js');
const { boardSlabWithCutouts, punchHolesInFlatMesh } = await import('./src/pcb/modules/board3d.js');
const { loadClipper } = await import('./src/pcb/modules/copper-fill-geom.js');

await loadClipper();

const shape = {
    kind: 'polygon',
    layer: 'hole',
    lineWidth: 1.85,
    filled: true,
    nodeCornerRadii: { 0: 27, 2: 10, 3: 35 },
    cornerRadius: 8,
    points: [
        { x: 72.39, y: -53.34 },
        { x: 88.9, y: -90.17 },
        { x: 87.63, y: -35.56 },
        { x: 36.83, y: -30.48 },
    ],
};
const ring = resolveBoardShapeGeometry(shape).path.map((point) => ({ x: point.x, z: point.y }));
const board = [
    { x: 0, z: -80 }, { x: 100, z: -80 },
    { x: 100, z: 0 }, { x: 0, z: 0 },
];
const mesh = boardSlabWithCutouts(board, [], [ring], 0, 1.6, 0, 0);

const topArea = mesh.faces.reduce((area, face) => {
    if (face.idx.length !== 3) return area;
    const [a, b, c] = face.idx.map((index) => mesh.verts[index]);
    if (![a, b, c].every((point) => Math.abs(point.y - 1.6) < 1e-9)) return area;
    return area + Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) / 2;
}, 0);

// Clipper's difference output area is the independent expected value before
// Earcut and mesh assembly can distort the slab.
const C = (await import('./assets/vendor/clipper.esm.js')).default;
const scale = 10000;
const toPath = (points) => points.map((point) => ({
    X: Math.round(point.x * scale), Y: Math.round(point.z * scale),
}));
const clipper = new C.Clipper();
clipper.AddPath(toPath(board), C.PolyType.ptSubject, true);
clipper.AddPath(toPath(ring), C.PolyType.ptClip, true);
const solution = new C.Paths();
clipper.Execute(C.ClipType.ctDifference, solution, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
const expectedArea = Math.abs(C.Clipper.Area(solution[0])) / (scale * scale);

if (Math.abs(topArea - expectedArea) > 1e-4) {
    console.error(`FAIL rounded edge cutout top area: expected ${expectedArea}, got ${topArea}`);
    process.exit(1);
}
console.log(`PASS rounded edge cutout top area (${topArea.toFixed(4)} mm2, ${ring.length} outline points)`);

const flatBoard = {
    verts: board.map((point) => ({ x: point.x, y: 1.6, z: point.z })),
    faces: [{ idx: [0, 1, 2] }, { idx: [0, 2, 3] }],
};
const punched = punchHolesInFlatMesh(flatBoard, [{ x: 62.5, z: -52.4, r: 40, ring }]);
const punchedArea = punched.faces.reduce((area, face) => {
    const [a, b, c] = face.idx.map((index) => punched.verts[index]);
    return area + Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) / 2;
}, 0);
if (Math.abs(punchedArea - expectedArea) > 1e-3) {
    console.error(`FAIL rounded edge cutout surface area: expected ${expectedArea}, got ${punchedArea}`);
    process.exit(1);
}
console.log(`PASS rounded edge cutout surface area (${punchedArea.toFixed(4)} mm2)`);