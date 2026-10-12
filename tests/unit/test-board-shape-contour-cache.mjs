/** Board-shape contour memo: in-place edits invalidate it, results match fresh geometry and stay immutable. */
import assert from 'node:assert/strict';
import { resolveBoardShapeGeometry, boardShapeBounds, boardShapeHitTest, boardShapeFilledRemovalOutlines }
    from '../../src/shared/pcb/board-shape-geometry.js';

const contours = shape => resolveBoardShapeGeometry(shape).physicalContours;
// A structured clone is a new object, so it never shares the original's memo entry.
const fresh = shape => structuredClone(shape);
const plain = value => JSON.parse(JSON.stringify(value));

const shape = {
    id: 'poly', kind: 'polygon', layer: 'top-copper', lineWidth: 0.2, filled: false,
    points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }],
};

const first = contours(shape);
assert.equal(contours(shape), first, 'unchanged shapes reuse their contours');
assert.ok(Object.isFrozen(first) && Object.isFrozen(first[0]) && Object.isFrozen(first[0][0]), 'shared contours are frozen');
assert.throws(() => { first[0][0].x = 99; }, TypeError, 'callers cannot corrupt the shared contours');

const edits = [
    ['move a node', s => { s.points[1].x = 25; }],
    ['replace the points', s => { s.points = s.points.map(p => ({ x: p.x + 1, y: p.y })); }],
    ['add a node', s => { s.points.splice(2, 0, { x: 30, y: 5 }); }],
    ['shared corner radius', s => { s.cornerRadius = 3; }],
    ['node corner radius', s => { s.nodeCornerRadii = { 1: 6 }; }],
    ['edit node corner radius in place', s => { s.nodeCornerRadii[1] = 2; }],
    ['segment bulge', s => { s.segmentBulges = { 0: 0.4 }; }],
    ['segment width', s => { s.segmentWidths = { 2: 1.5 }; }],
    ['line width', s => { s.lineWidth = 0.8; }],
    ['fill', s => { s.filled = true; }],
    ['hole layer forces fill', s => { s.filled = false; s.layer = 'hole'; }],
    ['kind', s => { s.kind = 'rect'; s.points = [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 6 }, { x: 0, y: 6 }]; }],
];
for (const [name, edit] of edits) {
    const before = contours(shape);
    edit(shape);
    const after = contours(shape);
    assert.notEqual(after, before, `${name}: contours are rebuilt`);
    assert.deepEqual(plain(after), plain(contours(fresh(shape))), `${name}: contours match fresh geometry`);
    assert.deepEqual(boardShapeBounds(shape), boardShapeBounds(fresh(shape)), `${name}: bounds match fresh geometry`);
}

{
    // Filled-removal outlines use a second variant of the same shape; both stay cached.
    const outline = { kind: 'polygon', layer: 'top-copper', lineWidth: 0.4, filled: false, cornerRadius: 2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] };
    const stroke = contours(outline);
    const removal = boardShapeFilledRemovalOutlines(outline);
    assert.notEqual(stroke, removal);
    assert.equal(contours(outline), stroke, 'stroke variant survives a filled query');
    assert.equal(boardShapeFilledRemovalOutlines(outline), removal, 'filled variant is reused too');
    assert.equal(boardShapeHitTest(outline, { x: 5, y: 5 }, 0), false, 'unfilled interior is not hit');
    outline.filled = true;
    assert.equal(boardShapeHitTest(outline, { x: 5, y: 5 }, 0), true, 'filling the shape updates hit testing');
}

{
    const bounds = boardShapeBounds(shape);
    bounds.minX = -1000;
    assert.notEqual(boardShapeBounds(shape).minX, -1000, 'callers get their own bounds object');
}

console.log(`PASS board-shape contour memo: ${edits.length} in-place edits invalidate it, fresh-geometry parity, frozen sharing`);
