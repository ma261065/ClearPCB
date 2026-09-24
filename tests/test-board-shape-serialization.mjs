import assert from 'node:assert/strict';
import { CopperFill } from '../src/shapes/copper-fill.js';

globalThis.window = { addEventListener() {} };
const { serializeBoardShapes, loadBoardShapes } = await import('../src/pcb/modules/board-shapes.js');
const { prepareFabricationSnapshot } = await import('../src/pcb/modules/fabrication-snapshot.js');
const { decodePictureArtwork } = await import('../src/pcb/modules/picture-storage.js');

const fill = new CopperFill({ id: 'fill_3', net: 'GND', outline: [
    { x: 0.3817427541407543, y: -80.50377231777516 },
    { x: 0.5128638294492713, y: -0.44270326854398157 },
    { x: 100.84286382944926, y: -0.44270326854398157 },
] });
const beforeFill = fill.captureState();
assert.deepEqual(fill.toJSON().pts, [[0.3817, -80.5038], [0.5129, -0.4427], [100.8429, -0.4427]]);
assert.deepEqual(fill.captureState(), beforeFill);
assert.deepEqual(CopperFill.fromJSON(fill.toJSON()).toJSON(), fill.toJSON());

const common = { layer: 'top-copper', lineWidth: 0.20000000000000004, copperMode: 'add', net: '' };
const points = [{ x: -74.93000000000004, y: 58.42 }, { x: -74.93000000000004, y: 11.430000000000014 },
    { x: -50, y: 11.430000000000014 }, { x: -50, y: 58.42 }];
const shapes = [
    { ...common, id: 'circle', kind: 'circle', x: 90.17, y: -49.53, radius: 6.839159305060828 },
    { ...common, id: 'line', kind: 'line', points: points.slice(0, 2), segmentWidths: { 0: 0.345678 } },
    { ...common, id: 'arc', kind: 'arc', start: { x: 148.58999999999997, y: 35.56 },
        end: { x: 187.95999999999998, y: 60.96000000000001 }, bulge: { x: 173.97907396143856, y: 39.41868535977021 } },
    ...['polygon', 'rect'].map(kind => ({ ...common, id: kind, kind, points,
        cornerRadius: 1.234567, nodeCornerRadii: { 1: 0.456789 } })),
];
const before = structuredClone(shapes);
const saved = serializeBoardShapes({ boardShapes: shapes });
assert.equal(saved[0].radius, 6.8392);
assert.deepEqual(saved[1].points, [{ x: -74.93, y: 58.42 }, { x: -74.93, y: 11.43 }]);
assert.deepEqual(saved[1].segmentWidths, { 0: 0.3457 });
assert.deepEqual(saved[2].start, { x: 148.59, y: 35.56 });
assert.deepEqual(saved[2].end, { x: 187.96, y: 60.96 });
assert.deepEqual(saved[2].bulge, { x: 173.9791, y: 39.4187 });
for (const shape of saved.slice(3)) {
    assert.equal(shape.cornerRadius, 1.2346);
    assert.deepEqual(shape.nodeCornerRadii, { 1: 0.4568 });
    assert.equal(shape.points[0].x, -74.93);
}
assert.ok(saved.every(shape => shape.lineWidth === 0.2));
assert.deepEqual(shapes, before, 'saving does not mutate live geometry');
const restored = { boardShapes: [], _shapeIdCounter: 1 };
loadBoardShapes(restored, [...saved, fill.toJSON()], { render: false, strict: true });
assert.deepEqual(serializeBoardShapes(restored), [...saved, fill.toJSON()]);

const imagePoints = [
    { x: 1.2700000000000102, y: -76.2 },
    { x: 19.75492310119924, y: -76.20000000000002 },
    { x: 19.754923101199296, y: -47.60700716672567 },
    { x: 1.2699999999991007, y: -47.60700716672557 },
];
const image = { ...common, id: 'image', kind: 'image', name: 'BeauBirthday.png', filled: true, points: imagePoints,
    artwork: { width: 20, height: 20, circles: [{ x: Math.PI, y: 5, radius: 1 / 3 }] } };
const imageBefore = structuredClone(image);
const [savedImage] = serializeBoardShapes({ boardShapes: [image] });
assert.deepEqual(savedImage.points, [
    { x: 1.27, y: -76.2 }, { x: 19.7549, y: -76.2 },
    { x: 19.7549, y: -47.607 }, { x: 1.27, y: -47.607 },
], 'image placement follows the four-decimal save convention');
assert.deepEqual(image, imageBefore, 'saving does not mutate live image geometry');
assert.deepEqual(decodePictureArtwork(savedImage.artwork), image.artwork, 'image source geometry remains lossless');
const restoredImage = { boardShapes: [], _shapeIdCounter: 1 };
loadBoardShapes(restoredImage, [savedImage], { render: false, strict: true });
assert.deepEqual(serializeBoardShapes(restoredImage), [savedImage]);

const { validatePicturePoints } = await import('../src/pcb/modules/picture-raster.js');
for (const angle of [17.3, 33, 89.9, 137, 271.2]) {
    const radians = angle * Math.PI / 180;
    const rotated = { ...image, points: [[0, 0], [30, 0], [30, 12.1289], [0, 12.1289]].map(([x, y]) => ({
        x: 50.812345 + x * Math.cos(radians) - y * Math.sin(radians),
        y: -77.476543 + x * Math.sin(radians) + y * Math.cos(radians),
    })) };
    validatePicturePoints(rotated.points);
    const savedRotated = serializeBoardShapes({ boardShapes: [rotated] });
    if (angle === 17.3) assert.throws(() => validatePicturePoints(savedRotated[0].points), /nonempty rectangle/,
        'strict runtime validation is not relaxed');
    const loadedRotated = { boardShapes: [], _shapeIdCounter: 1 };
    loadBoardShapes(loadedRotated, savedRotated, { render: false, strict: true });
    assert.deepEqual(serializeBoardShapes(loadedRotated), savedRotated, `rounded ${angle}-degree image reloads stably`);
    const malformed = structuredClone(savedRotated);
    malformed[0].points[2].x += 0.01;
    assert.throws(() => loadBoardShapes({ boardShapes: [] }, malformed, { render: false, strict: true }),
        /nonempty rectangle/, 'distortion beyond save rounding must still be rejected');
}
for (const invalid of [
    [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    [{ x: 0, y: 0 }, { x: 0.0001, y: 0 }, { x: 0.0002, y: 0 }, { x: 0.0001, y: 0 }],
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 11, y: 10 }, { x: 1, y: 10 }],
]) {
    assert.throws(() => loadBoardShapes({ boardShapes: [] }, [{ ...savedImage, points: invalid }],
        { render: false, strict: true }), /nonempty rectangle/);
}

const snapshot = await prepareFabricationSnapshot({
    placements: new Map(), tracks: [], vias: [], texts: new Map(), copperFills: [], boardShapes: [...shapes, image],
    _boardWidth: 200, _boardHeight: 100, _boardRadius: 0, _getRoutingParams: () => ({ clearance: 0.2 }),
});
assert.equal(snapshot.boardShapes[0].radius, shapes[0].radius);
assert.deepEqual(snapshot.boardShapes[1].points, shapes[1].points);
assert.deepEqual(snapshot.boardShapes[2].bulge, shapes[2].bulge);
assert.deepEqual(snapshot.boardShapes[3].nodeCornerRadii, shapes[3].nodeCornerRadii);
assert.deepEqual(snapshot.boardShapes.at(-1).artwork, image.artwork);
assert.deepEqual(snapshot.boardShapes.at(-1).points, image.points, 'fabrication retains full-precision image placement');
console.log('PASS: fill and board-shape saves use four decimals; live, image, and fabrication geometry remain unchanged');

globalThis.document = { getElementById: () => null };
const { serializePcb, preparePcb } = await import('../src/pcb/modules/project-state.js');
const { serializePcbText } = await import('../src/pcb/modules/pcb-text.js');
const text = { id: 'text-2jbepmqe', content: 'Hello', x: 91.44000000000001, y: -69.85,
    size: 7.700000000000001, rotation: 30.123456, layer: 'top-copper', strokeWidth: 1.6000000000000003 };
const placement = { x: 27.939999999999998, y: -38.10000000000001, rotation: 45.123456,
    refDx: 1.234567, refDy: 22.860000000000003, refRot: 30.123456,
    refSize: 1.234567, refStrokeWidth: 0.234567, mirror: true, side: 'bottom', refVisible: false };
const beforeText = structuredClone(text);
const beforePlacement = structuredClone(placement);
const app = { tracks: [], vias: [], boardShapes: [], texts: new Map([[text.id, text]]),
    _placementOverrides: new Map([['comp_4', placement]]),
    _boardWidth: 100.123456, _boardHeight: 80.00000000000001, _boardRadius: 1.234567,
    _getRoutingParams: () => ({ trackWidth: 0.20000000000000004, clearance: 0.123456,
        viaDiameter: 0.6000000000000001, viaDrill: 0.30000000000000004 }),
    _getRouterMode: () => 'pathfinder' };
const savedPcb = serializePcb(app);
assert.deepEqual(savedPcb.stackup, { copperLayers: ['top-copper', 'bottom-copper'] });
assert.doesNotThrow(() => preparePcb(savedPcb), 'A saved two-layer board can be prepared again');
assert.throws(() => preparePcb({ ...savedPcb, stackup: {
    copperLayers: ['top-copper', 'inner-copper-1', 'inner-copper-2', 'bottom-copper'],
} }), /only two-layer/, 'Direct PCB preparation also rejects unsupported stacks');
savedPcb.stackup.copperLayers.push('inner-copper-1');
assert.deepEqual(serializePcb(app).stackup, { copperLayers: ['top-copper', 'bottom-copper'] },
    'Serialized stackup arrays are independent snapshots');
assert.deepEqual(savedPcb.texts, [{ ...text, x: 91.44, size: 7.7, rotation: 30.1235, strokeWidth: 1.6 }]);
assert.deepEqual(savedPcb.placements.comp_4, { ...placement, x: 27.94, y: -38.1, rotation: 45.1235,
    refDx: 1.2346, refDy: 22.86, refRot: 30.1235, refSize: 1.2346, refStrokeWidth: 0.2346 });
assert.deepEqual(savedPcb.board, { width: 100.1235, height: 80, radius: 1.2346 });
assert.deepEqual(savedPcb.design, { trackWidth: 0.2, clearance: 0.1235, viaDiameter: 0.6,
    viaDrill: 0.3, units: 'mm', router: 'pathfinder' });
assert.deepEqual(text, beforeText);
assert.deepEqual(placement, beforePlacement);
assert.deepEqual(serializePcbText(text), beforeText, 'undo and clipboard snapshots retain full text precision');
savedPcb.placements.comp_4.x = 0;
savedPcb.texts[0].x = 0;
assert.deepEqual(text, beforeText);
assert.deepEqual(placement, beforePlacement);
console.log('PASS: PCB text, placement, reference, board and design values round only at the save boundary');