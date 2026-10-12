import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { SetBoardOutlineCommand } from '../../src/core/pcb-outline-commands.js';
import { defaultPcbStackup } from '../../src/core/project-format.js';
import { getBoardOutline, rectangleBoardOutline, boardBoundary } from '../../src/shared/pcb/board-outline.js';

assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
{
    const model = new PcbDocument();
    const before = { ...model.board };
    const outline = { id: 'board-outline', kind: 'circle', layer: 'board-outline',
        lineWidth: 0.2, filled: false, x: 20, y: -20, radius: 20 };
    const expected = structuredClone(outline);
    const command = new SetBoardOutlineCommand(model, before,
        { width: 40, height: 40, radius: 0, outline });
    outline.radius = 999;
    command.execute();
    assert.deepEqual(getBoardOutline(model), expected, 'Explicit outline is captured independently of caller data');
    assert.deepEqual(model.board, { width: 40, height: 40, radius: 0 });
    command.undo();
    assert.deepEqual(getBoardOutline(model), rectangleBoardOutline(before.width, before.height, before.radius));
    command.execute();
    assert.deepEqual(getBoardOutline(model), expected);
}
{
    const model = new PcbDocument();
    const artwork = { id: 'board-outline', kind: 'circle', layer: 'top-silk', x: 3, y: -3, radius: 1 };
    const input = { stackup: defaultPcbStackup(),
        board: { width: 47.123456, height: 29.234567, radius: 1.234567 }, boardShapes: [artwork] };
    const original = structuredClone(input);
    const prepared = PcbDocument.prepare(input);
    assert.deepEqual(input, original, 'Legacy normalization must not mutate caller-owned data');
    assert.equal(model.serializeSection(), null, 'Preparing a replacement does not alter the live document');
    const outline = getBoardOutline(prepared);
    assert.ok(outline, 'Explicit legacy dimensions produce a complete outline during preparation');
    assert.equal(outline.id, 'pshape_1', 'Normalization must not collide with an existing artwork ID');
    assert.equal(prepared.shapeIdCounter, 2);
    assert.deepEqual(outline, { ...rectangleBoardOutline(47.123456, 29.234567, 1.234567), id: 'pshape_1' });
    model.load(input, prepared);
    assert.equal(getBoardOutline(model), outline, 'Load adopts the prepared outline without rendering');
    assert.equal(model.board.width, 47.123456);
    assert.equal(model.board.height, 29.234567);
    assert.equal(model.board.radius, 1.234567);
    const saved = model.serialize();
    const copy = new PcbDocument();
    copy.load(saved);
    assert.deepEqual(copy.serialize(), saved, 'The normalized representation is stable across save/load');
    assert.equal(copy.boardShapes.filter(shape => shape.layer === 'board-outline').length, 1);
    assert.equal(model.board.width, 47.123456, 'Serialization retains full live precision');
    const custom = { id: 'custom', kind: 'circle', layer: 'board-outline', x: 20, y: -20, radius: 7 };
    model.load({ ...input, boardShapes: [artwork, custom] });
    for (const [key, value] of Object.entries(custom)) {
        assert.deepEqual(getBoardOutline(model)[key], value, 'Explicit geometry wins over legacy dimension metadata');
    }
    assert.equal(model.board.width, 14);
    assert.equal(model.boardShapes.length, 2);
    const beforeInvalid = model.serialize();
    assert.throws(() => model.load({ ...input, boardShapes: [],
        board: { width: 0.000001, height: 0.000001, radius: 0 } }), /one closed rectangle, polygon, or circle/);
    assert.deepEqual(model.serialize(), beforeInvalid, 'Invalid normalized geometry fails before model adoption');
    for (const data of [null, { stackup: defaultPcbStackup() },
        { stackup: defaultPcbStackup(), design: { trackWidth: 0.3 } }]) {
        model.load(data);
        assert.equal(getBoardOutline(model), null, 'No outline is invented without explicit dimensions or geometry');
    }
    model.clear();
    assert.equal(model.serializeSection(), null, 'New remains a genuinely empty PCB');
}
for (const legacy of [false, true]) {
    const model = new PcbDocument();
    if (legacy) model.load({ stackup: defaultPcbStackup(), board: { width: 42.123456, height: 31.234567, radius: 2 } });
    const shapes = model.boardShapes, board = model.board;
    const original = { ...board };
    const artwork = { id: 'artwork', kind: 'circle', layer: 'top-silk', x: 5, y: -5, radius: 1 };
    shapes.push(artwork);
    assert.deepEqual(getBoardOutline(model), legacy
        ? rectangleBoardOutline(original.width, original.height, original.radius) : null);
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
        assert.deepEqual(shapes, legacy ? [outline, artwork] : [artwork, outline]);
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
