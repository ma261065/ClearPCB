import assert from 'node:assert/strict';
import { resizeRectanglePoints } from '../src/shapes/path-operations.js';
import { rectangleFramePoints, validateRectanglePoints } from '../src/shapes/rectangle-frame.js';
import { createShape } from '../src/shapes/index.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { closedShapeOutline } from '../src/shapes/closed-outline.js';
import { resizePicturePoints, pictureContours } from '../src/pcb/modules/picture-raster.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { distanceToSegment } from '../src/core/geometry.js';
import { CORNER_CHORD_TOLERANCE } from '../src/shapes/rounded-path.js';

globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById() { return null; }, querySelector() { return null; },
    createElementNS() {
        return { style: {}, classList: { add() {}, remove() {} }, setAttribute() {},
            appendChild() {}, remove() {}, querySelectorAll() { return []; } };
    },
};
const { applyBoardShapeVertexResize, startBoardShapeDrag, handleBoardShapeDrag, endBoardShapeDrag,
    serializeBoardShapes, loadBoardShapes } = await import('../src/pcb/modules/board-shapes.js');
const { beginFillEdit, updateFillEdit, endFillEdit } = await import('../src/pcb/modules/copper-fill-edit.js');
const { cancelPictureCopperRefresh } = await import('../src/pcb/modules/picture-refresh.js');
const { rectCornerRadius } = await import('../src/pcb/modules/board-shape-geometry.js');
const { commitAnchorDrag } = await import('../src/ui/modules/drag.js');

const near = (actual, expected, tolerance = 1e-9) =>
    assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < tolerance,
        `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
const nearPoints = (actual, expected, tolerance) => {
    assert.equal(actual.length, expected.length);
    actual.forEach((point, index) => near(point, expected[index], tolerance));
};
const frame = { x: 25, y: -30, width: 8, height: 4 };
const graphEdges = { e0: ['n0', 'n1'], e1: ['n2', 'n1'], e2: ['n2', 'n3'], e3: ['n0', 'n3'] };
const schematic = (rotation, reversed) => createShape({
    id: 'schematic-rect', type: 'polyline', ir: true, cl: true,
    x: frame.x, y: frame.y, w: frame.width, h: frame.height, rot: rotation, rev: reversed,
    cn: ['n0', 'n1', 'n2', 'n3'], ed: graphEdges, ew: { e1: 0.3 }, ncr: { n2: 0.2 },
});
const resizeTarget = (points, index, firstScale, secondScale) => {
    const fixed = points[(index + 2) % 4], first = points[(index + 1) % 4], second = points[(index + 3) % 4];
    const along = { x: (first.x - fixed.x) * firstScale, y: (first.y - fixed.y) * firstScale };
    const across = { x: (second.x - fixed.x) * secondScale, y: (second.y - fixed.y) * secondScale };
    return {
        target: { x: fixed.x + along.x + across.x, y: fixed.y + along.y + across.y },
        first: { x: fixed.x + along.x, y: fixed.y + along.y },
        second: { x: fixed.x + across.x, y: fixed.y + across.y },
    };
};

for (const rotation of [0, 17.3, 30, 45, 89.999, 90, 137.5, 180, 270, 359.9999]) {
    for (const reversed of [false, true]) {
        const points = rectangleFramePoints({ ...frame, rotation, reversed });
        const original = structuredClone(points);
        for (let index = 0; index < 4; index++) {
            const shape = schematic(rotation, reversed);
            const opposite = points[(index + 2) % 4];
            const diagonal = { x: points[index].x - opposite.x, y: points[index].y - opposite.y };
            const imageTarget = { x: opposite.x + diagonal.x * 1.4 - diagonal.y * 0.3,
                y: opposite.y + diagonal.y * 1.4 + diagonal.x * 0.3 };
            nearPoints(resizePicturePoints(points, index, imageTarget), points.map(point => ({
                x: opposite.x + (point.x - opposite.x) * 1.4, y: opposite.y + (point.y - opposite.y) * 1.4,
            })), 1e-12);
            for (const scales of [[1.7, 0.65], [-0.4, 1.2], [0.8, -0.6], [-0.9, -1.1], [0.0002, 0.7]]) {
                const { target, first, second } = resizeTarget(points, index, ...scales);
                const resized = resizeRectanglePoints(points, index, target);
                assert.deepEqual(resized[index], target, 'Dragged corner follows the target exactly');
                assert.deepEqual(resized[(index + 2) % 4], points[(index + 2) % 4], 'Opposite corner stays fixed');
                near(resized[(index + 1) % 4], first);
                near(resized[(index + 3) % 4], second);
                validateRectanglePoints(resized);
                shape.moveAnchor(`n${index}`, target.x, target.y);
                nearPoints([...shape.nodes.values()], resized);
                const saved = shape.toJSON();
                assert.deepEqual(saved.ed, graphEdges);
                assert.deepEqual(saved.ew, { e1: 0.3 });
                assert.deepEqual(saved.ncr, { n2: 0.2 });
                validateRectanglePoints([...createShape(saved).nodes.values()]);
            }
            // A transient zero-size rectangle must still recover the same axes on the next move.
            const fixed = points[(index + 2) % 4];
            shape.moveAnchor(`n${index}`, fixed.x, fixed.y);
            const { target } = resizeTarget(points, index, 1.2, 0.8);
            shape.moveAnchor(`n${index}`, target.x, target.y);
            nearPoints([...shape.nodes.values()], resizeRectanglePoints(points, index, target));
        }
        assert.deepEqual(points, original, 'Resize must not mutate its drag-start geometry');
    }
}

function appFor(shape) {
    return {
        boardShapes: [shape], shapes: [shape], components: [], _shapeElements: new Map(),
        placements: new Map(), tracks: [], vias: [], texts: new Map(),
        history: new CommandHistory(), _getLayerGroup() { return null; }, renderShapes() {},
        _refreshFills() {}, _refreshFillProperties() {},
        _captureShapeState: item => item.captureState(), _applyShapeState: (item, state) => item.applyState(state),
        viewport: { scale: 20, shiftHeld: true, setCrosshair(point) { this.crosshair = { x: point.x, y: point.y }; },
            hideCrosshair() { this.crosshair = null; } },
    };
}
const artwork = { width: 4, height: 2, rectangles: [{ x: 0, y: 0, width: 1, height: 2 }],
    flipHorizontal: true, flipVertical: false };
for (const rotation of [30, 90, 137.5]) {
    for (const reversed of [false, true]) {
        const points = rectangleFramePoints({ ...frame, rotation, reversed });
        for (let index = 0; index < 4; index++) {
            const fixed = points[(index + 2) % 4];
            for (const kind of ['rect', 'image']) {
                const shape = { id: 'board-resize', kind, points: structuredClone(points),
                    layer: 'top-silk', lineWidth: 0.2, filled: true, copperMode: 'add', plated: false, net: '',
                    ...(kind === 'image' ? { name: 'Image', artwork: structuredClone(artwork) }
                        : { nodeCornerRadii: { 2: 0.2 }, segmentWidths: { 1: 0.3 } }) };
                const app = appFor(shape);
                const { target } = resizeTarget(points, index, 1.7, kind === 'image' ? 1.7 : 0.65);
                const expected = kind === 'image' ? resizePicturePoints(points, index, target)
                    : resizeRectanglePoints(points, index, target);
                for (const commit of [false, true]) {
                    assert.equal(startBoardShapeDrag(app, shape, points[index], index), true);
                    handleBoardShapeDrag(app, target);
                    nearPoints(shape.points, expected);
                    near(app.viewport.crosshair, shape.points[index]);
                    near(shape.points[(index + 2) % 4], fixed);
                    endBoardShapeDrag(app, commit);
                    if (!commit) assert.deepEqual(shape.points, points);
                }
                const after = structuredClone(shape.points);
                app.history.undo();
                assert.deepEqual(shape.points, points);
                app.history.redo();
                assert.deepEqual(shape.points, after);
                const saved = serializeBoardShapes(app);
                const reloaded = { boardShapes: [], _shapeIdCounter: 1 };
                loadBoardShapes(reloaded, saved, { strict: true, render: false });
                validateRectanglePoints(reloaded.boardShapes[0].points);
                assert.deepEqual(serializeBoardShapes(reloaded), saved);
                if (kind === 'image') {
                    assert.deepEqual(shape.artwork, artwork);
                    const sourceContours = pictureContours({ ...shape, points });
                    pictureContours(shape).forEach((contour, contourIndex) => nearPoints(contour,
                        sourceContours[contourIndex].map(point => ({
                            x: fixed.x + (point.x - fixed.x) * 1.7, y: fixed.y + (point.y - fixed.y) * 1.7,
                        }))));
                    for (const factor of [0, -1]) {
                        applyBoardShapeVertexResize(shape, { before: { points }, handle: index }, {
                            x: fixed.x + (points[index].x - fixed.x) * factor,
                            y: fixed.y + (points[index].y - fixed.y) * factor,
                        });
                        nearPoints(shape.points, points.map(point => ({
                            x: fixed.x + (point.x - fixed.x) * 0.01, y: fixed.y + (point.y - fixed.y) * 0.01,
                        })), 1e-12);
                        validateRectanglePoints(shape.points);
                    }
                }
                cancelPictureCopperRefresh(app);
            }

            const fill = new CopperFill({ kind: 'rect', outline: points, cornerRadius: 0.2 });
            const fillApp = appFor(fill), before = fill.captureState();
            const { target } = resizeTarget(points, index, 1.7, 0.65);
            beginFillEdit(fillApp, fill, points[index], index);
            updateFillEdit(fillApp, target);
            nearPoints(fill.outline, resizeRectanglePoints(points, index, target));
            endFillEdit(fillApp, false);
            assert.deepEqual(fill.captureState(), before);
            beginFillEdit(fillApp, fill, points[index], index);
            updateFillEdit(fillApp, target);
            endFillEdit(fillApp, true);
            assert.equal(fill.kind, 'rect', 'Resizing a rotated rectangular fill must not turn it into a free polygon');
            const after = fill.captureState();
            fillApp.history.undo();
            assert.deepEqual(fill.captureState(), before);
            fillApp.history.redo();
            assert.deepEqual(fill.captureState(), after);
            assert.deepEqual(CopperFill.fromJSON(fill.toJSON()).toJSON(), fill.toJSON());

            const graph = schematic(rotation, reversed), graphApp = appFor(graph);
            const graphBefore = graph.captureState(), originalRecord = graph.toJSON();
            graph.moveAnchor(`n${index}`, target.x, target.y);
            assert.equal(commitAnchorDrag(graphApp, graph, graphBefore), true);
            const graphAfter = graph.toJSON();
            assert.equal(graph.isRect, true);
            graphApp.history.undo();
            assert.deepEqual(graph.toJSON(), originalRecord);
            graphApp.history.redo();
            assert.deepEqual(graph.toJSON(), graphAfter);
        }
    }
}

for (const radius of [0.005, 0.5, 20]) {
    const axisPoints = rectangleFramePoints({ ...frame, rotation: 0 });
    const axisOutline = closedShapeOutline({ kind: 'rect', points: axisPoints, cornerRadius: radius });
    for (const rotation of [17.3, 30, 137.5]) {
        const angle = -rotation * Math.PI / 180;
        const rotate = point => ({
            x: frame.x + (point.x - frame.x) * Math.cos(angle) - (point.y - frame.y) * Math.sin(angle),
            y: frame.y + (point.x - frame.x) * Math.sin(angle) + (point.y - frame.y) * Math.cos(angle),
        });
        const shape = { kind: 'rect', points: axisPoints.map(rotate), cornerRadius: radius };
        assert.ok(Math.abs(rectCornerRadius(shape) - Math.min(radius, frame.height / 2)) < 1e-9);
        const actual = closedShapeOutline(shape), expected = axisOutline.map(rotate);
        for (const [source, target] of [[actual, expected], [expected, actual]]) {
            for (const point of source) {
                const distance = Math.min(...target.map((start, index) =>
                    distanceToSegment(point, start, target[(index + 1) % target.length])));
                assert.ok(distance <= CORNER_CHORD_TOLERANCE + 1e-9,
                    'Rounded outlines must rotate with the rectangle within their chord tolerance');
            }
        }
    }
}
console.log('PASS rotated rectangle/image resizing: all corners and windings, fixed axes, crossings, history, save/load and rounded outlines');
