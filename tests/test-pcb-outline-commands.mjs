import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { SetBoardOutlineCommand } from '../src/core/pcb-outline-commands.js';
import { defaultPcbStackup } from '../src/core/project-format.js';
import { getBoardOutline, rectangleBoardOutline, boardBoundary } from '../src/pcb/modules/board-outline.js';

assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
for (const legacy of [false, true]) {
    const model = new PcbDocument();
    if (legacy) model.load({ stackup: defaultPcbStackup(), board: { width: 42.123456, height: 31.234567, radius: 2 } });
    const shapes = model.boardShapes, board = model.board;
    const original = { ...board };
    const artwork = { id: 'artwork', kind: 'circle', layer: 'top-silk', x: 5, y: -5, radius: 1 };
    shapes.push(artwork);
    assert.equal(getBoardOutline(model), null);
    const before = { ...board }, after = { width: 37.123456, height: 28.234567, radius: 1.234567 };
    const expected = rectangleBoardOutline(after.width, after.height, after.radius);
    const command = new SetBoardOutlineCommand(model, before, after);
    before.width = after.width = 999;
    const history = new CommandHistory();
    history.execute(command);
    const outline = getBoardOutline(model);
    assert.deepEqual(outline, expected, 'Setup creates complete authored geometry without a renderer');
    assert.equal(model.serializeBoardDimensions().width, 37.1235);
    assert.equal(outline.points[1].x, 37.123456, 'Saving never rounds live geometry');
    for (let cycle = 0; cycle < 2; cycle++) {
        history.undo();
        assert.deepEqual(outline, rectangleBoardOutline(original.width, original.height, original.radius),
            'Initial setup undo retains the previous-dimension rectangle, matching existing editor behavior');
        history.redo();
        assert.deepEqual(outline, expected);
        assert.equal(model.boardShapes, shapes);
        assert.equal(model.board, board);
        assert.deepEqual(shapes, [artwork, outline]);
        assert.equal(getBoardOutline(model), outline);
    }
    assert.equal(model.ensureBoardOutline(), outline, 'Repeated initialization never duplicates an outline');
}

for (const source of [
    { id: 'custom-circle', kind: 'circle', layer: 'board-outline', x: 35.123456, y: -23.456789, radius: 7.123456 },
    { ...rectangleBoardOutline(25, 18, 1), points: [
        { x: 10, y: 10 }, { x: 30, y: 20 }, { x: 25, y: 30 }, { x: 5, y: 20 },
    ] },
    { id: 'custom-polygon', kind: 'polygon', layer: 'board-outline', lineWidth: 0.2,
        points: [{ x: 10, y: -20 }, { x: 30, y: -20 }, { x: 35, y: -5 }, { x: 10, y: 0 }],
        nodeCornerRadii: { 2: 0.345678 }, segmentBulges: { 0: 0.123456 } },
]) {
    const model = new PcbDocument();
    const expectedOriginal = structuredClone(source);
    const outline = model.setBoardOutline(source);
    assert.notEqual(outline, source);
    if (source.points) source.points[0].x = 999;
    else source.x = 999;
    if (source.segmentBulges) source.segmentBulges[0] = 999;
    assert.deepEqual(outline, expectedOriginal, 'Installing an outline detaches nested caller data');
    assert.equal(model.setBoardOutline(outline), outline, 'Self-adoption preserves the canonical object');
    assert.deepEqual(outline, expectedOriginal);
    assert.equal(model.ensureBoardOutline(), outline, 'Initialization preserves nonrectangular and offset geometry');
    const board = model.board, shapes = model.boardShapes;
    const state = () => ({ outline: structuredClone(outline), board: { ...board } });
    const states = [state()];
    const history = new CommandHistory();
    for (const dimensions of [
        { width: 45.123456, height: 32.234567, radius: 2.345678 },
        { width: 60.234567, height: 40.345678, radius: 0 },
    ]) {
        history.execute(new SetBoardOutlineCommand(model, { ...board }, dimensions));
        states.push(state());
    }
    outline.points[0].x = 888;
    history.undo();
    assert.deepEqual(state(), states[1], 'Later live geometry cannot corrupt captured undo state');
    history.redo();
    assert.deepEqual(state(), states[2]);
    for (let cycle = 0; cycle < 2; cycle++) {
        for (let index = 1; index >= 0; index--) {
            history.undo();
            assert.deepEqual(state(), states[index]);
            assert.equal(getBoardOutline(model), outline);
        }
        for (let index = 1; index < states.length; index++) {
            history.redo();
            assert.deepEqual(state(), states[index]);
            assert.equal(model.board, board);
            assert.equal(model.boardShapes, shapes);
        }
    }
    history.undo();
    history.undo();
    assert.deepEqual(outline, expectedOriginal, 'Undo removes obsolete rectangle fields and restores original IDs and metadata');
    const bounds = boardBoundary(model);
    assert.equal(board.width, bounds.w);
    assert.equal(board.height, bounds.h);
}

{
    const model = new PcbDocument();
    const other = new PcbDocument();
    const otherBefore = other.serializeSection();
    const outline = model.ensureBoardOutline();
    assert.deepEqual(outline, rectangleBoardOutline(100, 80));
    const snapshot = model.serialize();
    for (const invalid of [
        { ...outline, layer: 'top-copper' },
        { ...outline, kind: 'line' },
        { ...outline, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] },
        { kind: 'circle', layer: 'board-outline', x: NaN, y: 0, radius: 1 },
    ]) {
        assert.throws(() => model.setBoardOutline(invalid), /one closed rectangle, polygon, or circle/);
        assert.equal(getBoardOutline(model), outline);
        assert.deepEqual(model.serialize(), snapshot, 'Invalid replacement leaves geometry and dimension metadata untouched');
    }
    const history = new CommandHistory();
    const invalid = new SetBoardOutlineCommand(model, { ...model.board }, { width: 10, height: 0, radius: 0 });
    assert.throws(() => history.execute(invalid), /one closed rectangle, polygon, or circle/);
    assert.equal(history.undoStack.length, 0);
    assert.deepEqual(model.serialize(), snapshot);
    assert.deepEqual(other.serializeSection(), otherBefore);
}
assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
console.log('PASS headless board-outline setup, initialization, validation, identity, precision and complete history');
