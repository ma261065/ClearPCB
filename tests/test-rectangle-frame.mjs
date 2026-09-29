import assert from 'node:assert/strict';
import { rectangleFrameFromPoints, rectangleFramePoints, validateRectanglePoints } from '../src/shapes/rectangle-frame.js';
import { validateProject } from '../src/core/project-format.js';
import { compactProjectAliases } from '../src/core/project-field-aliases.js';
import { FileManager, readProjectFile } from '../src/core/FileManager.js';
import { createShape } from '../src/shapes/index.js';

globalThis.window = { addEventListener() {} };
const { serializeBoardShapes, loadBoardShapes } = await import('../src/pcb/modules/board-shapes.js');
const { preparePcb } = await import('../src/pcb/modules/project-state.js');
const { decodePictureArtwork } = await import('../src/pcb/modules/picture-storage.js');
const { pictureContours } = await import('../src/pcb/modules/picture-raster.js');
const { prepareFabricationSnapshot } = await import('../src/pcb/modules/fabrication-snapshot.js');
const project = shapes => ({
    type: 'clearpcb-project', version: '1.0', schematic: { shapes: [], components: [] },
    pcb: { stackup: { copperLayers: ['top-copper', 'bottom-copper'] },
        board: { width: 100, height: 80, radius: 0 },
        design: { trackWidth: 0.2, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3, units: 'mm', router: 'maze' },
        boardShapes: shapes },
});
const load = records => {
    const app = { boardShapes: [], _shapeIdCounter: 1 };
    loadBoardShapes(app, records, { render: false, strict: true });
    return app;
};
const closePoints = (actual, expected, tolerance = 0.0002) => {
    assert.equal(actual.length, expected.length);
    actual.forEach((point, index) => assert.ok(
        Math.hypot(point.x - expected[index].x, point.y - expected[index].y) < tolerance,
        `Corner ${index} changed beyond parameter quantization: ${JSON.stringify({ point, expected: expected[index] })}`));
};
const artwork = { width: 20, height: 10, rectangles: [{ x: 1, y: 2, width: 3, height: 4 }],
    flipHorizontal: true, flipVertical: false };

for (const rotation of [0, 17.3, 33, 89.9, 137, 180, 271.2]) {
    for (const reversed of [false, true]) {
        const frame = { x: 50.812345, y: -47.476543, width: 30.123456, height: 12.128967, rotation, reversed };
        const corners = rectangleFramePoints(frame);
        for (let first = 0; first < 4; first++) {
            const points = [...corners.slice(first), ...corners.slice(0, first)];
            for (const kind of ['rect', 'image']) {
                const shape = { id: 'framed', kind, layer: 'top-copper', lineWidth: 0.2,
                    filled: true, copperMode: 'add', plated: false, net: 'GND', points,
                    ...(kind === 'image' ? { artwork, name: 'Image' } : {
                        cornerRadius: 0.4, nodeCornerRadii: { 1: 0.2 }, segmentWidths: { 2: 0.3 },
                    }) };
                const original = structuredClone(shape);
                const saved = JSON.parse(JSON.stringify(serializeBoardShapes({ boardShapes: [shape] })));
                assert.equal(Object.hasOwn(saved[0], 'points'), false);
                assert.ok(['x', 'y', 'width', 'height', 'rotation'].every(key => Number.isFinite(saved[0][key])));
                const restored = load(saved);
                validateRectanglePoints(restored.boardShapes[0].points);
                closePoints(restored.boardShapes[0].points, points);
                assert.deepEqual(serializeBoardShapes(restored), saved, 'Frame saves stabilize after one quantization');
                assert.deepEqual(shape, original, 'Saving leaves editable state untouched');
                if (kind === 'image') {
                    assert.deepEqual(decodePictureArtwork(saved[0].artwork), artwork, 'Placement migration does not alter artwork flags');
                    const before = pictureContours(shape), after = pictureContours(restored.boardShapes[0]);
                    assert.equal(after.length, before.length);
                    before.forEach((contour, index) => closePoints(after[index], contour));
                } else {
                    assert.deepEqual(restored.boardShapes[0].nodeCornerRadii, shape.nodeCornerRadii);
                    assert.deepEqual(restored.boardShapes[0].segmentWidths, shape.segmentWidths);
                }
                const compact = compactProjectAliases(project(saved));
                assert.equal(Object.hasOwn(compact.pcb.boardShapes[0], 'pts'), false);
                assert.ok(['x', 'y', 'w', 'h', 'rot'].every(key => Number.isFinite(compact.pcb.boardShapes[0][key])));
                const normalized = validateProject(compact);
                const prepared = preparePcb(normalized.pcb);
                assert.deepEqual(prepared.boardShapes[0].points, restored.boardShapes[0].points);
                const legacy = { ...saved[0], points };
                for (const key of ['x', 'y', 'width', 'height', 'rotation', 'reversed']) delete legacy[key];
                const migrated = serializeBoardShapes(load([legacy]));
                assert.deepEqual(migrated, saved, 'Old corner records migrate to the same frame without changing indexed orientation');
            }
        }
    }
}

const base = { id: 'frame', kind: 'rect', layer: 'top-silk', lineWidth: 0.2, filled: false,
    copperMode: 'add', plated: false, net: '', x: 5, y: -5, width: 10, height: 6, rotation: 17.3 };
for (const invalid of [
    { ...base, width: 0 }, { ...base, height: -1 }, { ...base, rotation: Infinity },
    { ...base, x: NaN }, { ...base, y: '5' }, { ...base, reversed: 1 },
    { ...base, points: rectangleFramePoints(base) }, { ...base, height: undefined },
    { ...base, x: 1e308 }, { ...base, width: 1e-12 },
]) {
    assert.throws(() => load([invalid]), /Rectangle|rectangle/);
    assert.throws(() => validateProject(project([invalid])), /Rectangle|rectangle/);
}
for (const point of [null, { x: Infinity, y: 0 }]) {
    assert.throws(() => rectangleFrameFromPoints([point, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]));
}
assert.throws(() => rectangleFrameFromPoints([{ x: 0, y: 0 }, { x: 10, y: 0 },
    { x: 12, y: 10 }, { x: 2, y: 10 }]), /nonempty rectangle/);
assert.throws(() => rectangleFrameFromPoints(rectangleFramePoints({ ...base, width: 0.00001 })),
    /positive width\/height/, 'Quantization must reject collapsed dimensions rather than save an unloadable frame');
assert.deepEqual(rectangleFramePoints({ ...base, rotation: 1e308 }),
    rectangleFramePoints({ ...base, rotation: 1e308 % 360 }), 'Finite rotations cannot overflow angle conversion');

const outline = { ...base, layer: 'board-outline', id: 'board-outline' };
assert.equal(preparePcb(project([outline]).pcb).boardShapes[0].points.length, 4,
    'Board-outline validation accepts the new frame before rendering');
const image = { ...base, kind: 'image', artwork, points: rectangleFramePoints(base) };
for (const key of ['x', 'y', 'width', 'height', 'rotation']) delete image[key];
const snapshot = await prepareFabricationSnapshot({
    placements: new Map(), tracks: [], vias: [], pads: [], texts: new Map(), copperFills: [],
    boardShapes: [image], _boardWidth: 100, _boardHeight: 80,
}, { computeFills: false });
assert.deepEqual(snapshot.boardShapes[0].points, image.points, 'Fabrication snapshots retain exact live geometry');
assert.deepEqual(snapshot.boardShapes[0].artwork, artwork);

const legacyRect = { ...image, id: 'legacy-rectangle', kind: 'rect' };
delete legacyRect.artwork;
const legacyFill = { type: 'fill', id: 'legacy-fill', k: 'rect', l: 'top-copper',
    pts: image.points.map(point => [point.x, point.y]), n: 'GND' };
const legacySchematic = {
    type: 'polyline', id: 'legacy-schematic', ir: true, cl: true,
    nd: Object.fromEntries(image.points.map((point, i) => [`n${i}`, [point.x, point.y]])),
    ed: { e0: ['n0', 'n1'], e1: ['n1', 'n2'], e2: ['n2', 'n3'], e3: ['n3', 'n0'] },
};
const legacyImage = serializeBoardShapes({ boardShapes: [image] }, { parametricRectangles: false })[0];
const legacyProject = project([legacyImage, legacyRect, legacyFill]);
legacyProject.schematic.shapes = [legacySchematic];
const normalizedLegacy = validateProject(legacyProject);
const migratedProject = project(serializeBoardShapes(preparePcb(normalizedLegacy.pcb)));
migratedProject.schematic.shapes = normalizedLegacy.schematic.shapes.map(shape => createShape(shape).toJSON());
const expectedDisk = compactProjectAliases(migratedProject);
for (const record of expectedDisk.pcb.boardShapes) {
    assert.equal('pts' in record, false);
    assert.ok(Number.isFinite(record.rot));
}
assert.equal('nd' in expectedDisk.schematic.shapes[0], false);
const storage = new Map();
globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
};
const manager = new FileManager();
manager.autoSaveToStorage(migratedProject, { revision: 1, fileName: 'frames.cpcb' });
assert.deepEqual(JSON.parse(storage.get('clearpcb_autosave_frames.cpcb')).data, expectedDisk);
let written;
const result = await manager.saveToHandle(migratedProject, {
    name: 'frames.cpcb',
    async createWritable() {
        return { async write(blob) { written = blob; }, async close() {} };
    },
});
assert.equal(result.success, true, result.error);
const disk = await readProjectFile(written);
assert.deepEqual(disk, expectedDisk, 'ZIP persistence retains all frame variants without coordinate maps');
const reopened = validateProject(disk);
const prepared = preparePcb(reopened.pcb);
assert.deepEqual(compactProjectAliases(project(serializeBoardShapes(prepared))).pcb, disk.pcb);
assert.deepEqual(createShape(reopened.schematic.shapes[0]).toJSON(), disk.schematic.shapes[0]);
console.log('PASS rectangle/image frames, winding, metadata, legacy migration, aliases, validation, fabrication and ZIP/autosave round trips');
