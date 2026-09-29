import assert from 'node:assert/strict';
import { CopperFill } from '../src/shapes/copper-fill.js';

globalThis.window = { addEventListener() {} };
const { serializeBoardShapes, loadBoardShapes } = await import('../src/pcb/modules/board-shapes.js');
const { prepareFabricationSnapshot } = await import('../src/pcb/modules/fabrication-snapshot.js');
const { decodePictureArtwork } = await import('../src/pcb/modules/picture-storage.js');
const { validatePicturePoints } = await import('../src/pcb/modules/picture-raster.js');
const round4 = value => Math.round(value * 10000) / 10000 || 0;
const frameFields = ['x', 'y', 'width', 'height', 'rotation', 'reversed'];
const legacyRecord = (record, points) => ({
    ...Object.fromEntries(Object.entries(record).filter(([key]) => !frameFields.includes(key))), points,
});
function assertFrame(record, points) {
    const u = { x: points[1].x - points[0].x, y: points[1].y - points[0].y };
    const v = { x: points[3].x - points[0].x, y: points[3].y - points[0].y };
    assert.equal(Object.hasOwn(record, 'points'), false, 'Saved rectangles use parameters, not corner points');
    assert.deepEqual(Object.fromEntries(frameFields.filter(key => Object.hasOwn(record, key)).map(key => [key, record[key]])), {
        x: round4(points.reduce((sum, point) => sum + point.x / 4, 0)),
        y: round4(points.reduce((sum, point) => sum + point.y / 4, 0)),
        width: round4(Math.hypot(u.x, u.y)), height: round4(Math.hypot(v.x, v.y)),
        rotation: round4(((-Math.atan2(u.y, u.x) * 180 / Math.PI) % 360 + 360) % 360) % 360,
        ...(u.x * v.y - u.y * v.x < 0 ? { reversed: true } : {}),
    });
}
function assertCorners(actual, source) {
    validatePicturePoints(actual);
    const u = { x: actual[1].x - actual[0].x, y: actual[1].y - actual[0].y };
    const v = { x: actual[3].x - actual[0].x, y: actual[3].y - actual[0].y };
    assert.ok(Math.abs(u.x * v.x + u.y * v.y) < 1e-10 * Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y),
        'Reloaded corners are strictly perpendicular, not independently rounded');
    assert.ok(Math.hypot(actual[0].x + actual[2].x - actual[1].x - actual[3].x,
        actual[0].y + actual[2].y - actual[1].y - actual[3].y) < 1e-10);
    const radius = Math.hypot(source[2].x - source[0].x, source[2].y - source[0].y) / 2;
    // Centre error + half-size error + angular displacement from four-decimal parameters.
    const bound = Math.SQRT2 * 0.000075 + radius * 0.00005 * Math.PI / 180 + 1e-9;
    actual.forEach((point, index) => assert.ok(
        Math.hypot(point.x - source[index].x, point.y - source[index].y) <= bound,
        `Source corner ${index} must retain its index and drift by no more than ${bound} mm`));
}

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
assert.ok(saved.every(shape => !('geometryVersion' in shape)));
assert.equal(saved[0].radius, 6.8392);
assert.deepEqual(saved[1].points, [{ x: -74.93, y: 58.42 }, { x: -74.93, y: 11.43 }]);
assert.deepEqual(saved[1].segmentWidths, { 0: 0.3457 });
assert.deepEqual(saved[2].start, { x: 148.59, y: 35.56 });
assert.deepEqual(saved[2].end, { x: 187.96, y: 60.96 });
assert.deepEqual(saved[2].bulge, { x: 173.9791, y: 39.4187 });
for (const shape of saved.slice(3)) {
    assert.equal(shape.cornerRadius, 1.2346);
    assert.deepEqual(shape.nodeCornerRadii, { 1: 0.4568 });
}
assert.equal(saved[3].points[0].x, -74.93, 'Polygons still save rounded points');
assertFrame(saved[4], shapes[4].points);
assert.ok(saved.every(shape => shape.lineWidth === 0.2));
assert.deepEqual(shapes, before, 'saving does not mutate live geometry');
const restored = { boardShapes: [], _shapeIdCounter: 1 };
loadBoardShapes(restored, [...saved, fill.toJSON()], { render: false, strict: true });
assert.deepEqual(serializeBoardShapes(restored), [...saved, fill.toJSON()]);
assertCorners(restored.boardShapes[4].points, shapes[4].points);
const staleVersionCircle = { ...saved[0], geometryVersion: 1, radius: 5 };
const restoredStaleVersionCircle = { boardShapes: [], _shapeIdCounter: 1 };
loadBoardShapes(restoredStaleVersionCircle, [staleVersionCircle], { render: false, strict: true });
assert.equal(restoredStaleVersionCircle.boardShapes[0].radius, 5,
    'all circle radii are interpreted as outer radii regardless of stale metadata');
assert.equal('geometryVersion' in serializeBoardShapes(restoredStaleVersionCircle)[0], false);

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
assertFrame(savedImage, imagePoints);
assert.deepEqual(image, imageBefore, 'saving does not mutate live image geometry');
assert.deepEqual(decodePictureArtwork(savedImage.artwork), image.artwork, 'image source geometry remains lossless');
const restoredImage = { boardShapes: [], _shapeIdCounter: 1 };
loadBoardShapes(restoredImage, [savedImage], { render: false, strict: true });
assert.deepEqual(serializeBoardShapes(restoredImage), [savedImage]);
assertCorners(restoredImage.boardShapes[0].points, imagePoints);

for (const angle of [17.3, 33.1234567, 89.9, 137, 271.2]) for (const reversed of [false, true]) {
    const radians = angle * Math.PI / 180;
    const rotated = { ...image, points: [[0, 0], [30, 0], [30, 12.1289], [0, 12.1289]].map(([x, y]) => ({
        x: 50.812345 + x * Math.cos(radians) - y * Math.sin(radians),
        y: -77.476543 + x * Math.sin(radians) + y * Math.cos(radians),
    })) };
    if (reversed) rotated.points = [rotated.points[0], rotated.points[3], rotated.points[2], rotated.points[1]];
    validatePicturePoints(rotated.points);
    const beforeRotated = structuredClone(rotated);
    const savedRotated = JSON.parse(JSON.stringify(serializeBoardShapes({ boardShapes: [rotated] })));
    assertFrame(savedRotated[0], rotated.points);
    assert.deepEqual(rotated, beforeRotated, 'Frame persistence never mutates live image coordinates or artwork');
    const loadedRotated = { boardShapes: [], _shapeIdCounter: 1 };
    loadBoardShapes(loadedRotated, savedRotated, { render: false, strict: true });
    assertCorners(loadedRotated.boardShapes[0].points, rotated.points);
    assert.deepEqual(serializeBoardShapes(loadedRotated), savedRotated, `${angle}-degree frame reloads stably`);
    const rotatedRect = { ...shapes[4], points: rotated.points, segmentWidths: { 2: 0.456789 },
        segmentBulges: { 1: 0.123456 } };
    const beforeRect = structuredClone(rotatedRect);
    const savedRect = serializeBoardShapes({ boardShapes: [rotatedRect] });
    assertFrame(savedRect[0], rotatedRect.points);
    const loadedRect = { boardShapes: [], _shapeIdCounter: 1 };
    loadBoardShapes(loadedRect, savedRect, { render: false, strict: true });
    assertCorners(loadedRect.boardShapes[0].points, rotatedRect.points);
    assert.deepEqual(loadedRect.boardShapes[0].nodeCornerRadii, { 1: 0.4568 });
    assert.deepEqual(loadedRect.boardShapes[0].segmentWidths, { 2: 0.4568 });
    assert.deepEqual(loadedRect.boardShapes[0].segmentBulges, { 1: 0.1235 });
    assert.deepEqual(serializeBoardShapes(loadedRect), savedRect, 'Rotated/reversed rectangle metadata reloads stably');
    assert.deepEqual(rotatedRect, beforeRect);
    const rounded = [legacyRecord(savedRotated[0], rotated.points.map(point => ({
        x: Math.round(point.x * 10000) / 10000, y: Math.round(point.y * 10000) / 10000,
    })))];
    if (angle === 17.3) assert.throws(() => validatePicturePoints(rounded[0].points), /nonempty rectangle/,
        'Four-decimal rounding reproduces the original rejection without weakening runtime validation');
    const loadedRounded = { boardShapes: [], _shapeIdCounter: 1 };
    loadBoardShapes(loadedRounded, rounded, { render: false, strict: true });
    validatePicturePoints(loadedRounded.boardShapes[0].points);
    loadedRounded.boardShapes[0].points.forEach((point, index) => assert.ok(
        Math.hypot(point.x - rounded[0].points[index].x, point.y - rounded[0].points[index].y) < 0.00015,
        'Legacy normalization corrects only bounded corner-rounding noise'));
    const normalizedSave = JSON.parse(JSON.stringify(serializeBoardShapes(loadedRounded)));
    const reloadedRounded = { boardShapes: [], _shapeIdCounter: 1 };
    loadBoardShapes(reloadedRounded, normalizedSave, { render: false, strict: true });
    assert.deepEqual(serializeBoardShapes(reloadedRounded), normalizedSave,
        'Legacy rounded image bounds normalize once and then reload without drift');
    const malformed = structuredClone(rounded);
    malformed[0].points[2].x += 0.01;
    assert.throws(() => loadBoardShapes({ boardShapes: [] }, malformed, { render: false, strict: true }),
        /nonempty rectangle/, 'distortion beyond legacy rounding tolerance must still be rejected');
}
for (const kind of ['rect', 'image']) {
    const record = kind === 'rect' ? saved[4] : savedImage;
    assert.throws(() => loadBoardShapes({ boardShapes: [] }, [{ ...record, points: imagePoints }],
        { render: false, strict: true }), /both a frame and corner points/, 'Mixed representations are explicitly rejected');
    for (const field of ['x', 'y', 'width', 'height', 'rotation']) {
        const partial = { ...record };
        delete partial[field];
        assert.throws(() => loadBoardShapes({ boardShapes: [] }, [partial], { render: false, strict: true }),
            /Rectangle frame/, `Partial ${kind} frame missing ${field} is rejected`);
    }
    for (const invalid of [{ width: 0 }, { height: -1 }, { x: Infinity }, { rotation: NaN }, { reversed: 1 }]) {
        assert.throws(() => loadBoardShapes({ boardShapes: [] }, [{ ...record, ...invalid }],
            { render: false, strict: true }), /Rectangle frame/);
    }
}
for (const invalid of [
    [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    [{ x: 0, y: 0 }, { x: 0.0001, y: 0 }, { x: 0.0002, y: 0 }, { x: 0.0001, y: 0 }],
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 11, y: 10 }, { x: 1, y: 10 }],
]) {
    assert.throws(() => loadBoardShapes({ boardShapes: [] }, [legacyRecord(savedImage, invalid)],
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
assert.deepEqual(snapshot.boardShapes[4].points, shapes[4].points, 'Fabrication retains exact rectangle points');
assert.deepEqual(snapshot.boardShapes[4].nodeCornerRadii, shapes[4].nodeCornerRadii);
assert.deepEqual(snapshot.boardShapes.at(-1).artwork, image.artwork);
assert.deepEqual(snapshot.boardShapes.at(-1).points, image.points, 'fabrication retains full-precision image placement');
const raw = serializeBoardShapes({ boardShapes: [shapes[4], image] },
    { parametricRectangles: false, roundGeometry: false, compactArtwork: false });
assert.deepEqual(raw[0].points, shapes[4].points);
assert.deepEqual(raw[1].points, image.points);
assert.deepEqual(raw[1].artwork, image.artwork);
assert.deepEqual(shapes, before);
assert.deepEqual(image, imageBefore);
console.log('PASS: rectangle/image frames, bounded corner drift, legacy reads and exact fabrication geometry');

globalThis.document = { getElementById: () => null };
const { serializePcb, preparePcb } = await import('../src/pcb/modules/project-state.js');
const { serializePcbText } = await import('../src/pcb/modules/pcb-text.js');
const text = { id: 'text-2jbepmqe', content: 'Hello', x: 91.44000000000001, y: -69.85,
    size: 7.700000000000001, rotation: 30.123456, layer: 'top-copper', strokeWidth: 1.6000000000000003 };
const placement = { x: 27.939999999999998, y: -38.10000000000001, rotation: 45.123456,
    refDx: 1.234567, refDy: 22.860000000000003, refRot: 30.123456,
    refSize: 1.234567, refStrokeWidth: 0.234567, locked: true,
    mirror: true, side: 'bottom', refVisible: false };
const beforeText = structuredClone(text);
const beforePlacement = structuredClone(placement);
const app = { tracks: [], vias: [], boardShapes: [], texts: new Map([[text.id, text]]),
    _placementOverrides: new Map([['comp_4', placement]]),
    _boardWidth: 100.123456, _boardHeight: 80.00000000000001, _boardRadius: 1.234567,
    _getRoutingParams: () => ({ trackWidth: 0.20000000000000004, clearance: 0.123456,
        viaDiameter: 0.6000000000000001, viaDrill: 0.30000000000000004 }),
    _getRouterMode: () => 'pathfinder' };
const savedPcb = serializePcb(app);
assert.deepEqual(savedPcb.stackup, { cl: ['top-copper', 'bottom-copper'] });
assert.doesNotThrow(() => preparePcb(savedPcb), 'A saved two-layer board can be prepared again');
assert.throws(() => preparePcb({ ...savedPcb, stackup: {
    copperLayers: ['top-copper', 'inner-copper-1', 'inner-copper-2', 'bottom-copper'],
} }), /only two-layer/, 'Direct PCB preparation also rejects unsupported stacks');
savedPcb.stackup.cl.push('inner-copper-1');
assert.deepEqual(serializePcb(app).stackup, { cl: ['top-copper', 'bottom-copper'] },
    'Serialized stackup arrays are independent snapshots');
assert.deepEqual(savedPcb.texts, [{ id: text.id, t: 'Hello', x: 91.44, y: -69.85,
    s: 7.7, rot: 30.1235, l: 'top-copper', lw: 1.6 }]);
assert.deepEqual(savedPcb.placements.comp_4, { x: 27.94, y: -38.1, rot: 45.1235,
    rdx: 1.2346, rdy: 22.86, rr: 30.1235, rs: 1.2346, rw: 0.2346,
    lk: true, mir: true, sd: 'bottom', rv: false });
assert.deepEqual(savedPcb.board, { w: 100.1235, h: 80, r: 1.2346 });
assert.deepEqual(savedPcb.design, { tw: 0.2, cl: 0.1235, vd: 0.6,
    dr: 0.3, u: 'mm', rt: 'pathfinder' });
assert.deepEqual(text, beforeText);
assert.deepEqual(placement, beforePlacement);
assert.deepEqual(serializePcbText(text), beforeText, 'undo and clipboard snapshots retain full text precision');
savedPcb.placements.comp_4.x = 0;
savedPcb.texts[0].x = 0;
assert.deepEqual(text, beforeText);
assert.deepEqual(placement, beforePlacement);
console.log('PASS: PCB text, placement, reference, board and design values round only at the save boundary');