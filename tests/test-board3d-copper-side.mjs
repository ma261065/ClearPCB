import assert from 'node:assert/strict';
import * as THREE from '../assets/vendor/three.module.js';

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

const { appendFlatStroke, collectCopperSubtractHoles, punchHolesInFlatMesh, updateBoardCameraClipping } =
    await import('../src/pcb/modules/board3d.js');
const { getBoard2DSolderMaskAppearance } = await import('../src/pcb/modules/board2d.js');
const { pointInPolygon } = await import('../src/core/geometry.js');

const camera = new THREE.PerspectiveCamera(45, 1, 0.193, 1929);
const bounds = new THREE.Box3(new THREE.Vector3(0, 0, -80), new THREE.Vector3(100, 12, 0));
for (const distance of [200, 500, 1000]) {
    for (const side of [-1, 1]) {
        camera.position.set(50, side * distance, -40);
        camera.lookAt(50, 0.8, -40);
        const position = camera.position.toArray();
        const orientation = camera.quaternion.toArray();
        updateBoardCameraClipping(camera, bounds);
        assert.ok(camera.near > 0.193, 'Near plane follows zoom-out');
        assert.ok(camera.near < distance / 10, 'Clipping does not over-amplify coplanar geometry errors');
        assert.deepEqual(camera.position.toArray(), position, 'Clipping does not move the camera');
        assert.deepEqual(camera.quaternion.toArray(), orientation, 'Clipping does not rotate the camera');
        for (const x of [0, 100]) for (const y of [0, 12]) for (const z of [-80, 0]) {
            const depth = -new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse).z;
            assert.ok(depth > camera.near && depth < camera.far, 'Scene corners remain inside clipping planes');
        }
        const topDepth = new THREE.Vector3(50, 1.6, -40).project(camera).z;
        const bottomDepth = new THREE.Vector3(50, 0, -40).project(camera).z;
        const depthUnits = Math.abs(topDepth - bottomDepth) / 2 * (2 ** 24 - 1);
        assert.ok(depthUnits > 80 * 10, 'Opposite board faces remain well beyond the largest decal bias');
        const displacedDepth = new THREE.Vector3(50, 1.600001, -40).project(camera).z;
        assert.ok(Math.abs(displacedDepth - topDepth) / 2 * (2 ** 24 - 1) < 1,
            'Sub-micron surface errors stay smaller than a depth-buffer step');
    }
}
camera.position.set(50, 12.5, -40);
camera.lookAt(50, 0.8, -40);
updateBoardCameraClipping(camera, bounds);
assert.ok(camera.near > 0 && camera.near < 0.5, 'Close-up components are not clipped');
camera.position.set(50, 5, -40);
camera.lookAt(100, 5, -40);
updateBoardCameraClipping(camera, bounds);
assert.equal(camera.near, 0.01, 'Bounds crossing the camera plane use the near-plane floor');

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