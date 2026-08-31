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

const { collectCopperSubtractHoles, punchHolesInFlatMesh } =
    await import('./src/pcb/modules/board3d.js');
const { getBoard2DSolderMaskAppearance } = await import('./src/pcb/modules/board2d.js');

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