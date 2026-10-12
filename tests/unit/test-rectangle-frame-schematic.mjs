import assert from 'node:assert/strict';
import { Polyline, createRect } from '../../src/shapes/polyline.js';
import { createShape } from '../../src/shapes/index.js';
import { rectangleFramePoints } from '../../src/shapes/rectangle-frame.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';

const nodeIds = ['corner-c', 'corner-a', 'corner-d', 'corner-b'];
const graphEdges = {
    bottom: [nodeIds[1], nodeIds[0]],
    right: [nodeIds[1], nodeIds[2]],
    top: [nodeIds[3], nodeIds[2]],
    left: [nodeIds[0], nodeIds[3]],
};
const nearPoints = (actual, expected, tolerance = 0.0005) => {
    assert.equal(actual.length, expected.length);
    actual.forEach((point, index) => assert.ok(
        Math.hypot(point.x - expected[index].x, point.y - expected[index].y) < tolerance,
        `Corner ${index}: ${JSON.stringify(point)} differs from ${JSON.stringify(expected[index])}`));
};

for (const rotation of [0, 30, 90, 137.1234, 180, 270, 359.9999]) {
    for (const reversed of [false, true]) {
        const points = rectangleFramePoints({ x: 13.125, y: -7.75, width: 9.25, height: 3.5, rotation, reversed });
        const rectangle = new Polyline({
            id: `rect-${rotation}-${reversed}`, closed: true, isRect: true,
            graphNodes: Object.fromEntries(nodeIds.map((id, index) => [id, points[index]])),
            graphEdges, edgeWidths: { bottom: 0.7, top: 0.45 },
            lineWidth: 0.3, cornerRadius: 0.4, nodeCornerRadii: { [nodeIds[1]]: 0, [nodeIds[3]]: 0.8 },
            fill: true, fillAlpha: 0.65, layer: 'bottom', color: '#123456', visible: false, locked: true,
        });
        const before = rectangle.captureState();
        const record = rectangle.toJSON();
        assert.equal(Object.hasOwn(record, 'nd'), false, 'Rectangle saves no redundant coordinate graph');
        assert.equal(Object.hasOwn(record, 'pts'), false);
        assert.deepEqual(record.cn, nodeIds);
        assert.deepEqual(record.ed, graphEdges, 'Edge IDs and original directions survive serialization');
        assert.deepEqual([record.x, record.y, record.w, record.h, record.rot], [13.125, -7.75, 9.25, 3.5, rotation]);
        assert.equal(record.rev, reversed ? true : undefined);
        assert.deepEqual(record.ew, { bottom: 0.7, top: 0.45 });
        assert.deepEqual(record.ncr, { [nodeIds[1]]: 0, [nodeIds[3]]: 0.8 });
        assert.deepEqual(rectangle.captureState(), before, 'Serialization never mutates runtime geometry');

        const loaded = createShape(JSON.parse(JSON.stringify(record)));
        assert.deepEqual(loaded.toJSON(), record, 'Frame save/load/save is stable');
        assert.equal(loaded.isRect, true);
        assert.equal(loaded.id, rectangle.id);
        assert.deepEqual(loaded.getOrderedNodeIds(), nodeIds);
        nearPoints(nodeIds.map(id => loaded.nodes.get(id)), points);
        assert.deepEqual(loaded.getAnchors().filter(anchor => !anchor.midpoint).map(anchor => anchor.id), nodeIds);
        const clone = loaded.clone();
        assert.notEqual(clone.id, loaded.id);
        assert.deepEqual({ ...clone.toJSON(), id: loaded.id }, record, 'Cloning preserves graph and frame metadata');
        clone.move(2, -3);
        nearPoints(nodeIds.map(id => clone.nodes.get(id)), points.map(point => ({ x: point.x + 2, y: point.y - 3 })));
        nearPoints(nodeIds.map(id => loaded.nodes.get(id)), points);

        const history = new CommandHistory();
        const initial = loaded.captureState();
        loaded.moveAnchor(nodeIds[0], points[0].x - 1, points[0].y - 2);
        const resized = loaded.captureState();
        const resizedRecord = loaded.toJSON();
        loaded.applyState(initial);
        history.execute({ execute() { loaded.applyState(resized); }, undo() { loaded.applyState(initial); } });
        assert.deepEqual(loaded.toJSON(), resizedRecord);
        history.undo();
        assert.deepEqual(loaded.toJSON(), record, 'Undo restores the same frame and identities');
        history.redo();
        assert.deepEqual(loaded.toJSON(), resizedRecord, 'Redo restores the resized rectangle');

        const { id, ...clipboardRecord } = record;
        const pasted = createShape({ ...structuredClone(clipboardRecord), x: record.x + 12, y: record.y - 4 });
        assert.notEqual(pasted.id, id);
        assert.deepEqual(pasted.toJSON().ed, record.ed);
        assert.deepEqual(pasted.toJSON().cn, record.cn);
        nearPoints(nodeIds.map(nodeId => pasted.nodes.get(nodeId)),
            points.map(point => ({ x: point.x + 12, y: point.y - 4 })));
    }
}

const legacy = {
    id: 'legacy-rectangle', type: 'polyline', cl: true, ir: true,
    nd: { c: [3, 4], a: [11, 4], d: [11, 10], b: [3, 10] },
    ed: { edge3: ['a', 'c'], edge1: ['a', 'd'], edge9: ['b', 'd'], edge2: ['c', 'b'] },
    ew: { edge9: 0.8 }, cr: 1, ncr: { a: 0 }, f: false,
};
const migrated = createShape(legacy);
assert.deepEqual(migrated.toJSON().cn, ['c', 'a', 'd', 'b']);
assert.deepEqual(migrated.toJSON().ed, legacy.ed);
assert.deepEqual(migrated.toJSON().ew, legacy.ew);
assert.deepEqual(migrated.toJSON().ncr, legacy.ncr);
assert.deepEqual([migrated.toJSON().x, migrated.toJSON().y, migrated.toJSON().w, migrated.toJSON().h], [7, 7, 8, 6]);
assert.equal(Object.hasOwn(migrated.toJSON(), 'nd'), false);
assert.deepEqual(createShape(migrated.toJSON()).captureState(), migrated.captureState());
assert.deepEqual(legacy.nd.c, [3, 4], 'Legacy input remains untouched');

const created = createRect({ x: 2, y: 3, width: 8, height: 6 });
assert.deepEqual([created.toJSON().x, created.toJSON().y, created.toJSON().w, created.toJSON().h], [6, 6, 8, 6],
    'The drawing factory retains its top-left runtime API but saves centre coordinates');
const precisePoints = rectangleFramePoints({
    x: 13.123456, y: -7.654321, width: 9.876543, height: 3.456789, rotation: 27.123456,
});
const precise = new Polyline({ points: precisePoints, closed: true, isRect: true });
const roundedRecord = precise.toJSON();
assert.deepEqual([roundedRecord.x, roundedRecord.y, roundedRecord.w, roundedRecord.h, roundedRecord.rot],
    [13.1235, -7.6543, 9.8765, 3.4568, 27.1235], 'Saved frame parameters use four decimal places');
nearPoints(createShape(roundedRecord).getOrderedPoints(), precisePoints);
assert.deepEqual(precise.getOrderedPoints(), precisePoints, 'Saving rounded parameters does not round live nodes');
const general = createShape({ ...legacy, ir: false, bg: { edge3: 0.5 } });
assert.deepEqual(general.toJSON().nd, legacy.nd);
assert.deepEqual(general.toJSON().bg, { edge3: 0.5 });
assert.equal(Object.hasOwn(general.toJSON(), 'cn'), false);

for (const mutate of [
    shape => { shape.closed = false; },
    shape => { shape.setEdgeAttr('edge3', 'bulge', 0.2); },
    shape => { shape.nodes.get('a').x += 2; },
    shape => { shape.edges.delete('edge2'); },
    shape => { shape.nodes.set('extra', { x: 1, y: 2 }); },
]) {
    const invalid = createShape(legacy);
    mutate(invalid);
    const before = invalid.captureState();
    assert.throws(() => invalid.toJSON(), /Rectangle/);
    assert.deepEqual(invalid.captureState(), before, 'Rejecting a falsely flagged rectangle never loses its graph');
}
const valid = migrated.toJSON();
for (const invalid of [
    { ...valid, cn: ['c', 'a', 'd', 'c'] },
    { ...valid, cn: ['c', 'a', 'd'] },
    { ...valid, w: 0 },
    { ...valid, rot: NaN },
    { ...valid, nd: legacy.nd },
    { ...valid, nd: null },
    { ...valid, pts: [] },
    { ...valid, cn: undefined },
    { ...valid, bg: { edge3: 0.2 } },
    { ...valid, cl: false },
    { ...valid, cl: 1 },
    { ...valid, ir: false },
    { ...valid, ir: 'true' },
    { ...valid, ed: { edge3: ['a', 'c'] } },
    { ...valid, ed: { ...valid.ed, duplicate: ['c', 'a'] } },
    { ...valid, ed: { ...valid.ed, edge9: ['c', 'a'] } },
    { ...valid, ed: { ...valid.ed, edge9: ['b', 'd', 'c'] } },
    { ...valid, ed: { ...valid.ed, edge9: null } },
    { ...valid, ed: { ...valid.ed, edge9: { from: 'b', to: 'd' } } },
    { ...valid, ed: { edge3: ['c', 'd'], edge1: ['d', 'a'], edge9: ['a', 'b'], edge2: ['b', 'c'] } },
    { ...valid, ed: { edge3: ['a', 'c'], edge1: ['a', 'd'], edge9: ['b', 'd'], edge2: ['c', 'missing'] } },
]) assert.throws(() => createShape(invalid), /Rectangle/);
const { cn, ...missingCorners } = valid;
assert.throws(() => createShape(missingCorners), /Rectangle/);
assert.throws(() => createShape({ ...missingCorners, ir: false, nd: legacy.nd }), /Rectangle/);
assert.throws(() => createShape({ ...missingCorners, pts: [0, 0, 1, 0, 1, 1, 0, 1] }), /Rectangle/);

console.log('PASS schematic rectangle frames: new/legacy round trips, rotation, winding, metadata, clone/history and clipboard records');
