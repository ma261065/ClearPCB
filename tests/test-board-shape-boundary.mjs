import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById() { return null; }, querySelector() { return null; },
    createElementNS() {
        const attributes = new Map();
        return { style: {}, setAttribute(name, value) { attributes.set(name, String(value)); },
            getAttribute(name) { return attributes.get(name); }, removeAttribute(name) { attributes.delete(name); },
            appendChild() {}, remove() {}, querySelectorAll() { return []; } };
    },
};
const { resolveBoardShapeGeometry, getBoardShapeAnchors, boardShapeHitTest,
    boardShapeBounds, serializeBoardShapes, loadBoardShapes, cloneShapeGeometry,
    createBoardShapeSelectionAdapter, startBoardShapeDrag, handleBoardShapeDrag, endBoardShapeDrag,
    showBoardShapeProperties } = await import('../src/pcb/modules/board-shapes.js');

for (const kind of ['rect', 'polygon']) {
    for (const reversed of [false, true]) {
        const points = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 16 }, { x: 0, y: 16 }];
        if (reversed) points.reverse();
        for (const filled of [false, true]) {
            const shape = { kind, points, filled, lineWidth: 2, layer: 'top-copper' };
            const contours = resolveBoardShapeGeometry(shape).physicalContours;
            assert.equal(contours.length, filled ? 1 : 2);
            assert.ok(contours.flat().every(point => point.x >= -1 && point.x <= 21 && point.y >= -1 && point.y <= 17));
            assert.ok(contours.some(contour => contour.some(point => point.x === -1 && point.y === -1)));
            if (!filled) assert.ok(contours.some(contour => contour.some(point => point.x === 1 && point.y === 1)));
            assert.deepEqual(boardShapeBounds(shape), { minX: -1, minY: -1, maxX: 21, maxY: 17 });
        }
    }
}
console.log('PASS rectangle and polygon strokes centred on editable paths');

for (const cornerRadius of [0, 2]) {
    const shape = { id: 'boundary', kind: 'polygon', layer: 'top-copper', filled: false, cornerRadius,
        lineWidth: 1, segmentWidths: { 0: 3 },
        points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 16 }, { x: 0, y: 16 }] };
    const anchors = getBoardShapeAnchors(shape);
    assert.deepEqual(anchors.slice(0, 4).map(({ x, y }) => ({ x, y })), shape.points);
    assert.deepEqual(anchors.slice(4).map(({ x, y }) => ({ x, y })),
        [{ x: 10, y: 0 }, { x: 20, y: 8 }, { x: 10, y: 16 }, { x: 0, y: 8 }]);
    assert.ok(boardShapeHitTest(shape, { x: 10, y: 1.4 }));
    assert.ok(boardShapeHitTest(shape, { x: 10, y: -1.4 }));
    assert.ok(!boardShapeHitTest(shape, { x: 10, y: 1.6 }));
    assert.ok(!boardShapeHitTest(shape, { x: 10, y: -1.6 }));
    assert.ok(!boardShapeHitTest(shape, { x: 10, y: 8 }));
    const bounds = boardShapeBounds(shape);
    assert.equal(bounds.minY, -1.5);
    assert.equal(bounds.maxY, 16.5);
    const before = cloneShapeGeometry(shape);
    const listeners = new Map();
    const input = { value: '5', valueAsNumber: 5, addEventListener(type, listener) { listeners.set(type, listener); } };
    const app = { boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return null; },
        _pcbPropsItems() { return { innerHTML: '' }; } };
    document.getElementById = id => id === 'pcbPropShapeLineWidth' ? input : null;
    showBoardShapeProperties(app, shape);
    listeners.get('input')();
    assert.deepEqual(cloneShapeGeometry(shape), before);
    assert.equal(shape.cornerRadius, cornerRadius);
    assert.deepEqual(getBoardShapeAnchors(shape), anchors);
    assert.equal(shape.lineWidth, 5);
    document.getElementById = () => null;
    const serialized = serializeBoardShapes(app);
    assert.equal(serialized[0].geometryVersion, 1);
    const loaded = { boardShapes: [], _shapeIdCounter: 1 };
    loadBoardShapes(loaded, serialized, { render: false });
    assert.deepEqual(serializeBoardShapes(loaded), serialized);
    assert.equal(createBoardShapeSelectionAdapter(app, shape, shape.id).getEditPath(), 'M 0 0 L 20 0 L 20 16 L 0 16 Z');
}

for (const filled of [false, true]) {
    const shape = { kind: 'circle', x: 0, y: 0, radius: 5, lineWidth: 2, layer: 'top-copper', filled };
    const geometry = resolveBoardShapeGeometry(shape);
    assert.equal(geometry.circle.outerRadius, 5);
    assert.equal(geometry.circle.radius, 4);
    assert.ok(boardShapeHitTest(shape, { x: 4.9, y: 0 }));
    assert.ok(!boardShapeHitTest(shape, { x: 5.1, y: 0 }));
    assert.equal(boardShapeHitTest(shape, { x: 0, y: 0 }), filled);
}

for (const shape of [
    { kind: 'line', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    { kind: 'arc', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, bulge: { x: 5, y: -5 } },
]) {
    Object.assign(shape, { id: shape.kind, layer: 'top-copper', lineWidth: 2, filled: false });
    const geometry = resolveBoardShapeGeometry(shape);
    assert.equal(geometry.physicalContours, null);
    assert.equal(geometry.lineWidth, 2);
    const anchors = getBoardShapeAnchors(shape);
    const expected = shape.kind === 'line' ? shape.points : [shape.start, shape.end, shape.bulge];
    assert.deepEqual(anchors.filter(anchor => !anchor.midpoint).map(({ x, y }) => ({ x, y })), expected);
}

const legacy = { boardShapes: [], _shapeIdCounter: 1 };
loadBoardShapes(legacy, [
    { id: 'legacy-rect', kind: 'rect', lineWidth: 2, points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 16 }, { x: 0, y: 16 }] },
    { id: 'legacy-circle', kind: 'circle', x: 0, y: 0, radius: 5, lineWidth: 2 },
    { id: 'legacy-line', kind: 'line', lineWidth: 2, points: [{ x: 0, y: 0 }, { x: 20, y: 0 }] },
], { render: false });
assert.deepEqual(legacy.boardShapes[0].points[0], { x: 0, y: 0 });
assert.equal(legacy.boardShapes[1].radius, 6);
assert.deepEqual(legacy.boardShapes[2].points, [{ x: 0, y: 0 }, { x: 20, y: 0 }]);
const migrated = serializeBoardShapes(legacy);
const reloaded = { boardShapes: [], _shapeIdCounter: 1 };
loadBoardShapes(reloaded, migrated, { render: false });
assert.deepEqual(serializeBoardShapes(reloaded), migrated);

for (const commit of [false, true]) {
    const shape = { id: 'split', kind: 'rect', layer: 'top-copper', lineWidth: 3,
        points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 16 }, { x: 0, y: 16 }] };
    const before = cloneShapeGeometry(shape);
    const commands = [];
    const app = { boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return null; },
        viewport: { scale: 100, setCrosshair() {}, hideCrosshair() {} }, _snapToGrid(point) { return point; },
        history: { execute(command) { commands.push(command); command.execute(); } } };
    startBoardShapeDrag(app, shape, { x: 10, y: 0 }, 'mid:0');
    handleBoardShapeDrag(app, { x: -4, y: -3 });
    assert.deepEqual(shape.points[1], { x: -4, y: -3 });
    assert.deepEqual(shape.points.filter((_point, index) => index !== 1), before.points);
    endBoardShapeDrag(app, commit);
    if (commit) {
        assert.equal(commands.length, 1);
        assert.equal(shape.kind, 'polygon');
        commands[0].undo();
        assert.equal(shape.kind, 'rect');
        assert.deepEqual(cloneShapeGeometry(shape), before);
        commands[0].execute();
        assert.deepEqual(shape.points[1], { x: -4, y: -3 });
    } else assert.deepEqual(cloneShapeGeometry(shape), before);
}
console.log('PASS centreline editing, symmetric hit tests, unchanged circles, migration and undo');

const { pointInPolygon } = await import('../src/core/geometry.js');
const crossedPoints = [{ x: 0, y: 0 }, { x: 0, y: 16 }, { x: 20, y: 16 },
    { x: 20, y: 0 }, { x: 10, y: 21 }];
const contains = (contours, point) => contours.reduce((inside, contour) =>
    inside !== pointInPolygon(point, contour), false);
for (const reversed of [false, true]) {
    for (const filled of [false, true]) {
        for (const lineWidth of [0.2, 1, 4]) {
            const shape = { kind: 'polygon', layer: 'top-copper', filled, lineWidth,
                points: reversed ? [...crossedPoints].reverse() : crossedPoints };
            const before = structuredClone(shape.points);
            const actual = resolveBoardShapeGeometry(shape).physicalContours;
            assert.ok(contains(actual, { x: 10, y: 16 - lineWidth / 4 }));
            assert.ok(contains(actual, { x: 10, y: 16 + lineWidth / 4 }));
            const expected = resolveBoardShapeGeometry({ ...shape, points: [...shape.points].reverse() }).physicalContours;
            for (let horizontal = -1; horizontal < 22; horizontal += 0.37) {
                for (let vertical = -1; vertical < 23; vertical += 0.41) {
                    const point = { x: horizontal, y: vertical };
                    assert.equal(contains(actual, point), contains(expected, point), 'Stroke is winding-independent');
                }
            }
            assert.deepEqual(shape.points, before, 'Resolving crossings never mutates editable nodes');
        }
    }
}
for (const reversed of [false, true]) {
    const points = [{ x: 0, y: 0 }, { x: 0, y: 16 }, { x: 20, y: 16 }, { x: 20, y: 0 }];
    if (reversed) points.reverse();
    const shape = { id: 'crossing-direction', kind: 'rect', layer: 'top-copper', lineWidth: 1, points };
    const commands = [];
    const app = { boardShapes: [shape], _shapeElements: new Map(), _getLayerGroup() { return null; },
        viewport: { scale: 100, setCrosshair() {}, hideCrosshair() {} }, _snapToGrid(point) { return point; },
        history: { execute(command) { commands.push(command); command.execute(); } } };
    const midpoint = getBoardShapeAnchors(shape).find(anchor => anchor.midpoint && anchor.y === 0);
    startBoardShapeDrag(app, shape, midpoint, midpoint.id);
    for (const height of [21, 40, 60, 21]) {
        handleBoardShapeDrag(app, { x: 10, y: height });
        const contours = resolveBoardShapeGeometry(shape).physicalContours;
        assert.ok(contains(contours, { x: 10, y: 15.6 }));
        assert.ok(contains(contours, { x: 10, y: 16.4 }));
    }
    endBoardShapeDrag(app, true);
    commands[0].undo();
    commands[0].execute();
    const saved = serializeBoardShapes(app);
    const restored = { boardShapes: [], _shapeIdCounter: 1 };
    loadBoardShapes(restored, saved, { render: false });
    assert.ok(!('strokeSide' in saved[0]));
    assert.deepEqual(resolveBoardShapeGeometry(restored.boardShapes[0]).physicalContours,
        resolveBoardShapeGeometry(shape).physicalContours);
}
console.log('PASS centred crossings through dragging, undo and reload');