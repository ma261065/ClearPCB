globalThis.indexedDB = { open() { throw new Error('IndexedDB disabled in test'); } };
globalThis.localStorage = {
    getItem() { return null; },
    removeItem() {},
};
globalThis.window = {
    addEventListener() {},
    dispatchEvent() {},
};
globalThis.document = {
    body: { contains() { return false; } },
};

const { appendFlatStroke, collectCopperSubtractHoles, punchHolesInFlatMesh } =
    await import('../src/pcb/modules/board3d.js');
const { getBoard2DSolderMaskAppearance } = await import('../src/pcb/modules/board2d.js');
const { pointInPolygon } = await import('../src/core/geometry.js');

let failures = 0;
function check(name, condition) {
    if (condition) console.log(`PASS ${name}`);
    else {
        console.error(`FAIL ${name}`);
        failures++;
    }
}

check('covered copper uses a visibly opaque solder-mask coat',
    Math.abs(getBoard2DSolderMaskAppearance().opacity - 192 / 255) < 1e-9);

const meshArea = mesh => mesh.faces.reduce((sum, face) => {
    const [first, second, third] = face.idx.map(index => mesh.verts[index]);
    return sum + Math.abs((second.x - first.x) * (third.z - first.z)
        - (second.z - first.z) * (third.x - first.x)) / 2;
}, 0);
const meshContains = (mesh, point) => mesh.faces.some(face => pointInPolygon(point,
    face.idx.map(index => ({ x: mesh.verts[index].x, y: mesh.verts[index].z }))));
const curve = Array.from({ length: 65 }, (_, index) => ({
    x: 5 * Math.cos(index * Math.PI / 64), y: 5 * Math.sin(index * Math.PI / 64),
}));
const curveMesh = { verts: [], faces: [] };
appendFlatStroke(curveMesh, curve, false, 0.4, 1.6, '#ffffff');
const curveLength = curve.slice(1).reduce((sum, point, index) =>
    sum + Math.hypot(point.x - curve[index].x, point.y - curve[index].y), 0);
check('curved copper is triangulated once without overlapping ribbon and disc area',
    Math.abs(meshArea(curveMesh) - (curveLength * 0.4 + Math.PI * 0.2 ** 2)) < 0.005);
check('curved copper remains on its surface plane', curveMesh.verts.every(point => point.y === 1.6));
check('curved copper has no notches at the inner joins', curve.slice(1, -1).every(point =>
    meshContains(curveMesh, { x: point.x * 4.805 / 5, y: point.y * 4.805 / 5 })));
check('curved copper does not fill the inside of the bend', !meshContains(curveMesh, { x: 0, y: 0 }));
const closedMesh = { verts: [], faces: [] };
appendFlatStroke(closedMesh, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 8 }, { x: 0, y: 8 }],
    true, 0.4, 0, '#ffffff');
check('closed strokes preserve the hollow centre', !meshContains(closedMesh, { x: 5, y: 4 }));
check('closed strokes triangulate both boundaries without overlaps',
    Math.abs(meshArea(closedMesh) - (36 * 0.4 + (Math.PI - 4) * 0.2 ** 2)) < 0.005);

const removalRect = {
    kind: 'rect',
    points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }],
    lineWidth: 0.4,
    layer: 'bottom-copper',
    copperMode: 'remove-copper',
    filled: true,
};
const [bottomRemovalHole] = collectCopperSubtractHoles([removalRect]);
check('bottom copper removal carries a surface plane', Number.isFinite(bottomRemovalHole?.y));

const bottomY = bottomRemovalHole.y;
const topY = bottomY + 2;
const twoSideCopperMesh = {
    verts: [
        { x: 1, y: bottomY, z: 1 }, { x: 4, y: bottomY, z: 1 }, { x: 1, y: bottomY, z: 4 },
        { x: 1, y: topY, z: 1 }, { x: 4, y: topY, z: 1 }, { x: 1, y: topY, z: 4 },
    ],
    faces: [{ idx: [0, 1, 2] }, { idx: [3, 4, 5] }],
};
const sideCutMesh = punchHolesInFlatMesh(twoSideCopperMesh, [bottomRemovalHole]);
check('bottom copper removal leaves top copper faces intact',
    sideCutMesh.faces.length === 1
    && sideCutMesh.verts.every((vertex) => Math.abs(vertex.y - topY) < 1e-9));

const throughCutMesh = punchHolesInFlatMesh(twoSideCopperMesh, [
    { ring: bottomRemovalHole.ring },
]);
check('untagged drilled holes still cut both copper sides', throughCutMesh.faces.length === 0);

if (failures) process.exit(1);