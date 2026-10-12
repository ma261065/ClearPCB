import assert from 'node:assert/strict';
import { getComputedFill } from '../../src/pcb/modules/computed-fill-cache.js';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { CopperFill } from '../../src/shapes/copper-fill.js';
import { cloneShapeGeometry, captureBoardShapeState, applyShapeGeometry } from '../../src/core/pcb-board-shapes.js';
import { AddBoardShapeCommand, RemoveBoardShapeCommand, MoveBoardShapeCommand,
    ModifyBoardShapeCommand } from '../../src/core/pcb-shape-commands.js';
import { rectangleBoardOutline } from '../../src/shared/pcb/board-outline.js';
import { pictureShape } from '../../src/shared/pcb/picture-raster.js';

assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
const point = { x: 1.23456789, y: -2.34567891 };
const points = [point, { x: 12, y: point.y }, { x: 12, y: -12 }, { x: point.x, y: -12 }];
const variants = [
    { kind: 'line', points: points.slice(0, 2) },
    { kind: 'rect', points },
    { kind: 'polygon', points },
    { kind: 'arc', start: point, end: { x: 10, y: -2 }, bulge: { x: 6, y: -5 } },
    { kind: 'circle', ...point, radius: 2.3456789 },
    pictureShape({ width: 2, height: 2, rectangles: [{ x: 0, y: 0, width: 2, height: 2 }] },
        { widthMm: 2, layer: 'top-silk' }),
];
function changeGeometry(geometry, dx) {
    if (geometry.points) for (const p of geometry.points) p.x += dx;
    else if (geometry.start) for (const p of [geometry.start, geometry.end, geometry.bulge]) p.x += dx;
    else geometry.x += dx;
}

for (const variant of variants) {
    const model = new PcbDocument();
    const other = new PcbDocument();
    const shapes = model.boardShapes;
    const fill = new CopperFill({ kind: 'circle', x: 50, y: -50, radius: 2 });
    shapes.push(fill);
    const shape = { id: `shape-${variant.kind}`, layer: 'top-silk', lineWidth: 0.2,
        ...structuredClone(variant) };
    const artwork = shape.artwork;
    const state = () => shapes.map(item => item === fill ? item.captureState() : captureBoardShapeState(item));
    const states = [state()];
    const history = new CommandHistory();
    const add = new AddBoardShapeCommand(model, shape);
    history.execute(add);
    add.execute();
    assert.equal(shapes.length, 2);
    states.push(state());
    const beforeMove = cloneShapeGeometry(shape);
    const afterMove = cloneShapeGeometry(shape);
    changeGeometry(afterMove, 3);
    const expectedMove = structuredClone(afterMove);
    const move = new MoveBoardShapeCommand(model, shape, beforeMove, afterMove);
    changeGeometry(beforeMove, 1000);
    changeGeometry(afterMove, 1000);
    history.execute(move);
    assert.deepEqual(cloneShapeGeometry(shape), expectedMove, `${shape.kind}: owned movement coordinates`);
    states.push(state());
    const before = captureBoardShapeState(shape);
    const after = { ...captureBoardShapeState(shape), layer: 'top-copper', net: 'GND',
        cornerRadius: 0.123456, nodeCornerRadii: { 0: 0.234567 },
        segmentWidths: { 0: 0.345678 }, segmentBulges: { 0: 0.123456 } };
    const modify = new ModifyBoardShapeCommand(model, shape, before, after);
    for (const snapshot of [before, after]) {
        changeGeometry(snapshot.geom, 2000);
        snapshot.nodeCornerRadii[0] = 999;
        snapshot.segmentWidths[0] = 999;
        snapshot.segmentBulges[0] = 999;
        snapshot.net = 'Caller changed snapshot';
    }
    history.execute(modify);
    assert.deepEqual(cloneShapeGeometry(shape), expectedMove);
    assert.equal(shape.net, 'GND');
    assert.equal(shape.segmentWidths[0], 0.345678);
    assert.equal(shape.segmentBulges[0], 0.123456);
    if (['line', 'rect', 'polygon'].includes(shape.kind)) assert.equal(shape.nodeCornerRadii[0], 0.234567);
    if (shape.kind === 'image') assert.equal(shape.artwork, artwork, 'Read-only artwork is not duplicated per edit');
    states.push(state());
    const mutated = cloneShapeGeometry(shape);
    changeGeometry(mutated, 3000);
    applyShapeGeometry(shape, mutated);
    if (['line', 'rect', 'polygon'].includes(shape.kind)) shape.nodeCornerRadii = { 0: 888 };
    shape.segmentWidths[0] = 888;
    shape.segmentBulges[0] = 888;
    modify.execute();
    assert.deepEqual(state(), states.at(-1), 'Applied state never exposes command snapshots to live edits');
    if (shape.kind === 'line') {
        assert.equal(model.serializeEntities().boardShapes[1].points[0].x, 4.2346);
        assert.equal(shape.points[0].x, point.x + 3, 'Only saved geometry is rounded');
    }
    const remove = new RemoveBoardShapeCommand(model, shape);
    history.execute(remove);
    states.push(state());
    for (let cycle = 0; cycle < 2; cycle++) {
        for (let index = states.length - 2; index >= 0; index--) {
            assert.equal(history.undo(), true);
            assert.deepEqual(state(), states[index], `${shape.kind}: undo step ${index}`);
            assert.equal(model.boardShapes, shapes);
            assert.equal(shapes[0], fill);
            if (index > 0) assert.equal(shapes[1], shape);
        }
        for (let index = 1; index < states.length; index++) {
            assert.equal(history.redo(), true);
            assert.deepEqual(state(), states[index], `${shape.kind}: redo step ${index}`);
            assert.equal(model.boardShapes, shapes);
            if (index < states.length - 1) assert.equal(shapes[1], shape);
        }
    }
    remove.execute();
    assert.deepEqual(shapes, [fill], 'Absent removal never removes a different entity');
    remove.undo();
    remove.undo();
    assert.deepEqual(shapes, [fill, shape]);
    assert.equal('_computed' in fill, false);
    assert.equal(getComputedFill(fill), null);
    assert.deepEqual(other.boardShapes, []);
}

{
    const model = new PcbDocument();
    const outline = rectangleBoardOutline(20, 10, 1);
    model.boardShapes.push(outline);
    model.syncBoardOutlineDimensions();
    const board = model.board;
    for (const Command of [AddBoardShapeCommand, RemoveBoardShapeCommand]) {
        const command = new Command(model, outline);
        command.execute();
        command.undo();
        assert.deepEqual(model.boardShapes, [outline], 'Generic commands cannot remove or duplicate the outline');
    }
    const initial = structuredClone(outline);
    const before = captureBoardShapeState(outline);
    const after = { ...before, kind: 'circle', geom: { x: 30, y: -40, radius: 3.123456 }, cornerRadius: 0 };
    const modify = new ModifyBoardShapeCommand(model, outline, before, after);
    for (let cycle = 0; cycle < 2; cycle++) {
        assert.equal(modify.execute(), true);
        assert.equal(model.board, board);
        assert.equal(model.serializeBoardDimensions().width, 6.2469, 'Headless outline edits update saved dimensions');
        assert.equal(model.board.radius, 1, 'Legacy corner-radius metadata matches the editor synchronization');
        assert.equal(outline.radius, 3.123456);
        assert.equal(modify.undo(), true);
        assert.deepEqual(model.board, { width: 20, height: 10, radius: 1 });
        assert.deepEqual(cloneShapeGeometry(outline), cloneShapeGeometry(initial));
    }
    const resized = cloneShapeGeometry(outline);
    for (const p of resized.points) p.x *= 2;
    const move = new MoveBoardShapeCommand(model, outline, cloneShapeGeometry(outline), resized);
    move.execute();
    assert.equal(model.board.width, 40);
    move.undo();
    assert.equal(model.board.width, 20);
    const unchanged = structuredClone(outline);
    const invalid = new ModifyBoardShapeCommand(model, outline, captureBoardShapeState(outline),
        { ...captureBoardShapeState(outline), kind: 'arc', geom: {
            start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, bulge: { x: 0.5, y: 1 },
        } });
    assert.equal(invalid.execute(), false);
    assert.deepEqual(outline, unchanged, 'Rejected outline edits leave no added geometry fields behind');
    const invalidMove = new MoveBoardShapeCommand(model, outline, cloneShapeGeometry(outline),
        { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] });
    assert.equal(invalidMove.execute(), false);
    assert.deepEqual(outline, unchanged);
    assert.deepEqual(model.board, { width: 20, height: 10, radius: 1 });
}
assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
console.log('PASS DOM-free board-shape history, snapshot ownership, precision, outline protection and dimensions');
