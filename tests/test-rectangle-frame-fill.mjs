import assert from 'node:assert/strict';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { rectangleFramePoints } from '../src/shapes/rectangle-frame.js';

const nearPoints = (actual, expected, tolerance = 1e-9) => {
    assert.equal(actual.length, expected.length);
    actual.forEach((point, index) => assert.ok(
        Math.hypot(point.x - expected[index].x, point.y - expected[index].y) < tolerance,
        `Point ${index} differs: ${JSON.stringify(point)} vs ${JSON.stringify(expected[index])}`));
};
const base = { type: 'fill', id: 'fill_42', kind: 'rect', l: 'bottom-copper', n: 'GND', lk: true, v: false };
const metadata = { cornerRadius: 0.5, nodeCornerRadii: { 0: 0.25, 2: 0.75 }, segmentBulges: { 1: 0.2, 3: -0.15 } };

for (const rotation of [0, 17.3, 90, 137, 271.2, 359.9999]) for (const reversed of [false, true]) {
    const frame = { x: 20.125, y: -14.375, width: 12.5, height: 7.25, rotation, reversed };
    const points = rectangleFramePoints(frame);
    const fill = new CopperFill({
        id: base.id, kind: 'rect', layer: base.l, net: base.n, locked: true, visible: false,
        outline: points, ...metadata,
    });
    const before = fill.captureState();
    const geometry = fill.getOutline();
    const saved = fill.toJSON();
    assert.deepEqual(saved, { ...base, ...metadata, x: frame.x, y: frame.y,
        w: frame.width, h: frame.height, rot: rotation, ...(reversed ? { rev: true } : {}) });
    assert.equal(Object.hasOwn(saved, 'pts'), false);
    assert.deepEqual(fill.captureState(), before, 'Saving does not mutate live geometry or circle-only fields');
    assert.deepEqual(fill.getOutline(), geometry);
    const loaded = CopperFill.fromJSON(JSON.parse(JSON.stringify(saved)));
    assert.deepEqual(loaded.toJSON(), saved, 'Canonical rectangle frames are stable on save/load');
    nearPoints(loaded.outline, points);
    nearPoints(loaded.getOutline(), geometry);
    assert.equal(loaded.x, 0, 'Persisted rectangle centres do not become circle-only runtime coordinates');
    assert.equal(loaded.y, 0);
    assert.equal(loaded.radius, 1);
    for (const key of ['cornerRadius', 'nodeCornerRadii', 'segmentBulges', 'layer', 'net', 'locked', 'visible']) {
        assert.deepEqual(loaded[key], fill[key], `${key} survives rectangle persistence`);
    }
    assert.equal(loaded.containsPoint(frame.x, frame.y), fill.containsPoint(frame.x, frame.y));
    assert.ok(Math.abs(loaded.distanceToEdge(frame.x, frame.y) - fill.distanceToEdge(frame.x, frame.y)) < 1e-9);
    const bounds = fill.getBounds(), loadedBounds = loaded.getBounds();
    for (const key of Object.keys(bounds)) assert.ok(Math.abs(bounds[key] - loadedBounds[key]) < 1e-9);

    const long = CopperFill.fromJSON({ type: 'fill', id: base.id, kind: 'rect',
        layer: base.l, net: base.n, locked: true, visible: false, ...metadata, ...frame });
    assert.deepEqual(long.toJSON(), saved, 'Normalized long field names decode identically');
    const tuples = points.map(point => [point.x, point.y]);
    for (const legacy of [{ pts: tuples }, { points: tuples }]) {
        const restored = CopperFill.fromJSON({ ...base, ...metadata, ...legacy });
        assert.deepEqual(restored.outline, points, 'Temporary legacy reading preserves live corners and order');
        assert.deepEqual(restored.toJSON(), saved, 'Legacy rectangles migrate to canonical frames');
        nearPoints(restored.getOutline(), geometry);
    }

    const snapshot = loaded.captureState();
    loaded.move(3, -2);
    loaded.applyState(snapshot);
    assert.deepEqual(loaded.captureState(), snapshot, 'Undo state remains point-based and exact');
    assert.deepEqual(loaded.toJSON(), saved);
    const clone = loaded.clone();
    assert.notEqual(clone.id, loaded.id);
    assert.deepEqual(clone.outline, loaded.outline);
    assert.notEqual(clone.nodeCornerRadii, loaded.nodeCornerRadii);
    assert.notEqual(clone.segmentBulges, loaded.segmentBulges);
    nearPoints(clone.getOutline(), geometry);
}

const canonical = { ...base, x: 10, y: -8, w: 6, h: 4, rot: 33 };
const legacyPoints = rectangleFramePoints({ x: 10, y: -8, width: 6, height: 4, rotation: 33 })
    .map(point => [Math.round(point.x * 10000) / 10000, Math.round(point.y * 10000) / 10000]);
const migrated = CopperFill.fromJSON({ ...base, pts: legacyPoints });
assert.deepEqual(CopperFill.fromJSON(migrated.toJSON()).toJSON(), migrated.toJSON(),
    'Legacy four-decimal rotated corners settle into a stable frame');
nearPoints(CopperFill.fromJSON(migrated.toJSON()).outline,
    legacyPoints.map(([x, y]) => ({ x, y })), 0.00015);
for (let start = 0; start < 4; start++) {
    const points = [...legacyPoints.slice(start), ...legacyPoints.slice(0, start)];
    const fill = CopperFill.fromJSON({ ...base, ...metadata, pts: points });
    const restored = CopperFill.fromJSON(fill.toJSON());
    nearPoints(restored.outline, points.map(([x, y]) => ({ x, y })), 0.00015);
    nearPoints(restored.getOutline(), fill.getOutline(), 0.00015);
    assert.deepEqual(restored.nodeCornerRadii, metadata.nodeCornerRadii,
        'Indexed corner metadata remains attached to its source corner');
    assert.deepEqual(restored.segmentBulges, metadata.segmentBulges,
        'Indexed edge metadata remains attached to its source edge');
}
for (const missing of ['x', 'y', 'w', 'h', 'rot']) {
    const partial = { ...canonical };
    delete partial[missing];
    assert.throws(() => CopperFill.fromJSON(partial), /Rectangle frame/);
}
for (const invalid of [
    { ...base }, { ...base, rev: true },
    { ...canonical, pts: legacyPoints }, { ...canonical, points: legacyPoints },
    { ...base, pts: legacyPoints, x: 10 }, { ...base, pts: legacyPoints, rev: true },
    { ...base, pts: legacyPoints, points: legacyPoints },
    { ...canonical, width: 6 }, { ...canonical, height: 4 }, { ...canonical, rotation: 33 },
    { ...canonical, rev: true, reversed: true },
    { ...canonical, w: 0 }, { ...canonical, h: -1 }, { ...canonical, x: NaN },
    { ...canonical, y: Infinity }, { ...canonical, rot: '33' }, { ...canonical, rev: 1 },
    { ...base, pts: [] }, { ...base, pts: null }, { ...base, pts: [[0, 0], [1, 0], [1, 1]] },
    { ...base, pts: [[0, 0], [0, 0], [0, 0], [0, 0]] },
    { ...base, pts: [[0, 0], [1, 0], [2, 1], [0, 1]] },
    { ...base, pts: [[0, 0], [1, 0], [1, '1'], [0, 1]] },
    { ...base, pts: [[0, 0], [1, 0], [1, 1, 2], [0, 1]] },
]) assert.throws(() => CopperFill.fromJSON(invalid), /[Rr]ectang|[Aa]mbiguous/);
assert.throws(() => new CopperFill({ kind: 'rect',
    outline: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 1 }],
}).toJSON(), /rectangle/, 'Invalid live rectangles are not silently converted to different geometry');

for (const fill of [
    new CopperFill({ kind: 'circle', x: 2.125, y: -3.25, radius: 1.5 }),
    new CopperFill({ kind: 'polygon', outline: [{ x: 0, y: 0 }, { x: 2, y: -1 }, { x: 0, y: -2 }], ...metadata }),
]) {
    const saved = fill.toJSON();
    assert.ok(Array.isArray(saved.pts), 'Circle/polygon persistence retains points');
    assert.equal(Object.hasOwn(saved, 'w'), false);
    assert.equal(Object.hasOwn(saved, 'rot'), false);
    assert.deepEqual(CopperFill.fromJSON(saved).captureState(), fill.captureState());
    assert.deepEqual(CopperFill.fromJSON(saved).toJSON(), saved);
}
globalThis.window = { addEventListener() {} };
const { prepareFabricationSnapshot } = await import('../src/pcb/modules/fabrication-snapshot.js');
const precise = new CopperFill({ kind: 'rect',
    outline: rectangleFramePoints({ x: 20.1234567, y: -14.7654321, width: 12.3456789, height: 6.8765432,
        rotation: 17.2345678, reversed: true }),
    cornerRadius: 0.3456789, nodeCornerRadii: { 0: 0.456789 }, segmentBulges: { 1: 0.2345678 },
});
const beforeSnapshot = precise.captureState();
const geometry = precise.getOutline();
const savedPrecise = precise.toJSON();
assert.equal(savedPrecise.cornerRadius, 0.3457);
assert.deepEqual(savedPrecise.nodeCornerRadii, { 0: 0.4568 });
assert.deepEqual(savedPrecise.segmentBulges, { 1: 0.2346 });
assert.deepEqual(CopperFill.fromJSON(savedPrecise).toJSON(), savedPrecise,
    'Full-precision live geometry saves as a stable four-decimal frame');
const snapshot = await prepareFabricationSnapshot({ placements: new Map(), tracks: [], vias: [], texts: new Map(),
    boardShapes: [precise], copperFills: [precise], board: { width: 100, height: 80 , radius: 0 }}, { computeFills: false });
assert.deepEqual(snapshot.fills[0].outline, geometry, 'Fabrication keeps full-precision derived geometry');
assert.notEqual(snapshot.fills[0].outline, precise.outline);
snapshot.fills[0].outline[0].x += 5;
assert.deepEqual(precise.captureState(), beforeSnapshot, 'Persistence and fabrication snapshots do not mutate live state');
console.log('PASS rectangular copper-fill frames, legacy migration, validation, metadata and live geometry');
