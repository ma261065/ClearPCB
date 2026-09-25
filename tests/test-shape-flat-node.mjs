import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById() { return null; }, querySelector() { return null; },
    createElementNS() {
        return { style: {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, appendChild() {}, remove() {}, querySelectorAll() { return []; } };
    },
};
const { resolveBoardShapeGeometry, shapePathD, shapeOutline } = await import('../src/pcb/modules/board-shape-geometry.js');
const { startBoardShapeDrag, handleBoardShapeDrag, endBoardShapeDrag,
    serializeBoardShapes, loadBoardShapes, applyShapeSnapshot,
    setBoardShapeNodeCornerRadius } = await import('../src/pcb/modules/board-shapes.js');
const { CORNER_CHORD_TOLERANCE } = await import('../src/pcb/modules/board-geometry.js');

for (const radius of [0.05, 2, 50]) {
    const outline = shapeOutline({ kind: 'rect', cornerRadius: radius,
        points: [{ x: 0, y: 0 }, { x: radius * 4, y: 0 },
            { x: radius * 4, y: radius * 4 }, { x: 0, y: radius * 4 }] });
    const corner = outline.slice(0, outline.length / 4);
    assert.ok(corner.length >= 17, 'Rectangle corners use at least sixteen segments');
    for (let index = 0; index < corner.length - 1; index++) {
        const start = corner[index];
        const end = corner[index + 1];
        const chordRadius = Math.hypot((start.x + end.x) / 2 - radius, (start.y + end.y) / 2 - radius);
        assert.ok(radius - chordRadius <= CORNER_CHORD_TOLERANCE + 1e-12,
            'Rectangle chord error stays within the shared tolerance');
    }
}

{
    const shape = { id: 'rounded-line', kind: 'line', layer: 'top-silk', lineWidth: 0.2, cornerRadius: 2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] };
    const path = shapePathD(shape);
    assert.ok(path.includes('Q 10 0 10 2'));
    assert.ok(!path.includes('Z'), 'Rounded lines remain open');
    const before = { ...shape, geom: { points: shape.points.map(point => ({ ...point })) } };
    setBoardShapeNodeCornerRadius(shape, 1, 0);
    assert.ok(!shapePathD(shape).includes('Q'), 'A zero node radius overrides the line default');
    const restored = { boardShapes: [], _shapeIdCounter: 1 };
    loadBoardShapes(restored, serializeBoardShapes({ boardShapes: [shape] }), { render: false });
    assert.equal(restored.boardShapes[0].cornerRadius, 2);
    assert.equal(restored.boardShapes[0].nodeCornerRadii[1], 0);
    applyShapeSnapshot(shape, before);
    assert.equal(shapePathD(shape), path, 'Undo restores the overall line radius and removes the node override');
}

for (const reversed of [false, true]) {
    for (const commit of [false, true]) {
        const points = [{ x: 0, y: 0 }, { x: 100, y: -10 }, { x: 100, y: 10 }];
        if (reversed) points.reverse();
        const shape = { id: 'round-node', kind: 'polygon', layer: 'top-copper', lineWidth: 2, points };
        const original = resolveBoardShapeGeometry(shape).physicalContours;
        const originalCap = original.flat().filter(point => point.x < -0.2);
        assert.ok(originalCap.length > 5, 'Untouched nodes have round stroke joins by default');
        assert.ok(originalCap.every(point => Math.abs(Math.hypot(point.x, point.y) - 1) < 0.003),
            'Default joins follow the half-width circle without pointed miters');
        const commands = [];
        const app = { boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return null; },
            viewport: { scale: 1000, setCrosshair() {}, hideCrosshair() {} }, _snapToGrid(point) { return point; },
            history: { execute(command) { commands.push(command); command.execute(); } } };
        const node = reversed ? 2 : 0;
        startBoardShapeDrag(app, shape, { x: 0, y: 0 }, node);
        handleBoardShapeDrag(app, { x: 1, y: 0 });
        const dragged = resolveBoardShapeGeometry(shape).physicalContours;
        const cap = dragged.flat().filter(point => point.x < 0.8);
        assert.ok(cap.length > 5, 'Edited node exposes a sampled round cap, not a flat bevel');
        assert.ok(cap.every(point => Math.abs(Math.hypot(point.x - 1, point.y) - 1) < 0.003),
            'Visible cap follows the half-width circle around the centreline node');
        assert.ok(Math.abs(Math.min(...cap.map(point => point.x))) < 0.003,
            'Round cap extends only half the stroke width, with no miter spike');
        endBoardShapeDrag(app, commit);
        if (!commit) {
            assert.deepEqual(resolveBoardShapeGeometry(shape).physicalContours, original);
            continue;
        }
        assert.deepEqual(resolveBoardShapeGeometry(shape).physicalContours, dragged, 'Releasing the node preserves its round cap');
        commands[0].undo();
        assert.deepEqual(resolveBoardShapeGeometry(shape).physicalContours, original);
        commands[0].execute();
        assert.deepEqual(resolveBoardShapeGeometry(shape).physicalContours, dragged);
        const restored = { boardShapes: [], _shapeIdCounter: 1 };
        loadBoardShapes(restored, serializeBoardShapes(app), { render: false });
        assert.deepEqual(resolveBoardShapeGeometry(restored.boardShapes[0]).physicalContours, dragged);
    }
}
for (const moved of [false, true]) {
    const shape = { id: 'insert-round', kind: 'polygon', layer: 'top-copper', lineWidth: 2,
        points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 16 }, { x: 0, y: 16 }],
        nodeCornerRadii: { 2: 0 } };
    const app = { boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return null; },
        viewport: { scale: 1000, setCrosshair() {}, hideCrosshair() {} }, _snapToGrid(point) { return point; },
        history: { execute(command) { command.execute(); } } };
    startBoardShapeDrag(app, shape, { x: 10, y: 0 }, 'mid:0');
    assert.deepEqual(shape.nodeCornerRadii, { 3: 0 }, 'Insertion shifts existing node radii');
    handleBoardShapeDrag(app, { x: 10, y: moved ? -3 : 0 });
    endBoardShapeDrag(app, true);
    assert.deepEqual(shape.nodeCornerRadii, moved ? { 3: 0 } : { 2: 0 },
        'Collapsing an unmoved insertion restores the original node-radius indices');
}
for (const reversed of [false, true]) {
    const points = [{ x: 0, y: 20 }, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }];
    if (reversed) points.reverse();
    const shape = { id: 'inward-v', kind: 'polygon', layer: 'top-copper', lineWidth: 2, points };
    const app = { boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return null; },
        viewport: { scale: 1000, setCrosshair() {}, hideCrosshair() {} }, _snapToGrid(point) { return point; },
        history: { execute(command) { command.execute(); } } };
    startBoardShapeDrag(app, shape, { x: 10, y: 0 }, 2);
    for (const position of [{ x: 3, y: 6 }, { x: 17, y: 6 }, { x: 1, y: 12 }]) {
        handleBoardShapeDrag(app, position);
        const contours = resolveBoardShapeGeometry(shape).physicalContours;
        assert.ok(Math.min(...contours.flat().map(point => point.y)) >= -1.0001,
            'Dragging the middle node inward must not extend either adjacent corner into a spike');
    }
    endBoardShapeDrag(app, true);
}
console.log('PASS physical round caps without spikes through release, undo, redo, reload and midpoint edits');