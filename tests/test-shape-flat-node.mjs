import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById() { return null; }, querySelector() { return null; },
    createElementNS() {
        return { style: {}, setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, appendChild() {}, remove() {}, querySelectorAll() { return []; } };
    },
};
const { resolveBoardShapeGeometry, startBoardShapeDrag, handleBoardShapeDrag, endBoardShapeDrag,
    serializeBoardShapes, loadBoardShapes } = await import('../src/pcb/modules/board-shapes.js');

for (const reversed of [false, true]) {
    for (const commit of [false, true]) {
        const points = [{ x: 0, y: 0 }, { x: 100, y: -10 }, { x: 100, y: 10 }];
        if (reversed) points.reverse();
        const shape = { id: 'flat-node', kind: 'polygon', layer: 'top-copper', lineWidth: 2, points };
        const original = resolveBoardShapeGeometry(shape).physicalContours;
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
        assert.deepEqual(shape.nodeFlatJoins, { 0: true, 1: true, 2: true }, 'Both neighbouring corners also suppress pointed miters');
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
    const shape = { id: 'insert-flat', kind: 'polygon', layer: 'top-copper', lineWidth: 2,
        points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 16 }, { x: 0, y: 16 }],
        nodeFlatJoins: { 2: true } };
    const app = { boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return null; },
        viewport: { scale: 1000, setCrosshair() {}, hideCrosshair() {} }, _snapToGrid(point) { return point; },
        history: { execute(command) { command.execute(); } } };
    startBoardShapeDrag(app, shape, { x: 10, y: 0 }, 'mid:0');
    assert.deepEqual(shape.nodeFlatJoins, { 3: true }, 'Insertion shifts existing node settings');
    handleBoardShapeDrag(app, { x: 10, y: moved ? -3 : 0 });
    endBoardShapeDrag(app, true);
    assert.deepEqual(shape.nodeFlatJoins, moved ? { 0: true, 1: true, 2: true, 3: true } : { 2: true },
        'Moved insertion and neighbours suppress miters; collapsing an unmoved insertion restores the original indices');
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
        assert.deepEqual(shape.nodeFlatJoins, { 1: true, 2: true, 3: true }, 'Unconnected corners retain their existing joins');
    }
    endBoardShapeDrag(app, true);
    assert.deepEqual(shape.nodeFlatJoins, { 1: true, 2: true, 3: true });
}
console.log('PASS physical round caps without spikes through release, undo, redo, reload and midpoint edits');