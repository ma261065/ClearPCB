import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { getComputedFill, setComputedFill } from '../src/pcb/modules/computed-fill-cache.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById() { return null; } };
const { commitFillEdit, deleteFillNode, addFillGeometryProperties } =
    await import('../src/pcb/modules/copper-fill-edit.js');

function fixture(options = {}) {
    const fill = new CopperFill({
        outline: [{ x: Math.PI, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: Math.PI, y: 10 }],
        cornerRadius: 0.123456789, net: 'GND', ...options,
    });
    const model = new PcbDocument();
    model.boardShapes.push(fill);
    const app = { pcbDocument: model, boardShapes: model.boardShapes, placements: new Map(),
        history: new CommandHistory(), viewport: { scale: 100 }, _getLayerGroup() { return null; } };
    return { app, model, fill };
}

{
    const { app, fill } = fixture();
    const before = fill.captureState();
    assert.throws(() => commitFillEdit(app, fill, (target = fill) => {
        target.outline[0].x = 123;
        throw new Error('Rejected candidate mutation');
    }), /Rejected candidate mutation/);
    assert.deepEqual(fill.captureState(), before, 'A failed candidate mutation must not alter authored fill geometry');
    assert.equal(app.history.canUndo(), false);
}

for (const mode of ['changed', 'no-op', 'invalid', 'command-failure']) {
    const { app, model, fill } = fixture();
    const before = fill.captureState(), serialized = model.serialize(), geometry = model.captureGeometry();
    const references = [fill.outline, fill.nodeCornerRadii, fill.segmentBulges];
    const pour = [{ outer: fill.outline.map(point => ({ ...point })), holes: [] }];
    setComputedFill(fill, pour);
    const verifyUntouched = () => {
        assert.deepEqual(fill.captureState(), before);
        assert.deepEqual(model.serialize(), serialized);
        assert.deepEqual(model.captureGeometry(), geometry);
        [fill.outline, fill.nodeCornerRadii, fill.segmentBulges].forEach((value, index) => assert.equal(value, references[index]));
        assert.equal(getComputedFill(fill), pour);
    };
    const execute = app.history.execute.bind(app.history);
    app.history.execute = command => {
        verifyUntouched();
        if (mode === 'command-failure') throw new Error('Command unavailable');
        execute(command);
    };
    const mutate = candidate => {
        assert.notEqual(candidate, fill);
        assert.equal(candidate.id, fill.id);
        assert.notEqual(candidate.outline, fill.outline);
        assert.notEqual(candidate.nodeCornerRadii, fill.nodeCornerRadii);
        assert.notEqual(candidate.segmentBulges, fill.segmentBulges);
        if (mode === 'invalid') candidate.outline = [];
        else if (mode !== 'no-op') {
            candidate.cornerRadius = 0.987654321;
            candidate.nodeCornerRadii[1] = 0.456789123;
        }
        verifyUntouched();
    };
    if (mode === 'command-failure') {
        assert.throws(() => commitFillEdit(app, fill, mutate), /Command unavailable/);
        verifyUntouched();
    } else if (mode === 'changed') {
        assert.equal(commitFillEdit(app, fill, mutate), true);
        const after = fill.captureState();
        assert.equal(fill.cornerRadius, 0.987654321);
        assert.equal(app.history.undoStack.length, 1);
        app.history.undo();
        assert.deepEqual(fill.captureState(), before);
        app.history.redo();
        assert.deepEqual(fill.captureState(), after);
    } else {
        Object.freeze(fill);
        Object.freeze(fill.outline);
        for (const point of fill.outline) Object.freeze(point);
        assert.equal(commitFillEdit(app, fill, mutate), false);
        verifyUntouched();
        assert.equal(app.history.canUndo(), false);
    }
}

for (const [id, value, focus, options] of [
    ['pcbPropFillNodeRadius', 0.75, { node: 0 }, {}],
    ['pcbPropFillBulge', 0.2, { segment: 0 }, {}],
    ['pcbPropFillCornerRadius', 0.75, {}, {}],
    ['pcbPropFillWidth', 30.123456789, {}, {}],
    ['pcbPropFillHeight', 15.123456789, {}, {}],
    ['pcbPropFillDiameter', 15.123456789, {}, { kind: 'circle', x: 5, y: 5, radius: 4 }],
    ['pcbPropFillKind', 'circle', {}, {}],
    ['pcbPropFillKind', 'polygon', {}, {}],
    ['pcbPropFillKind', 'rect', {}, { kind: 'circle', x: 5, y: 5, radius: 4 }],
]) {
    const { app, fill } = fixture(options);
    app._fillEdit = { fillId: fill.id, ...focus };
    const before = fill.captureState(), originalOutline = fill.outline;
    let handler;
    const input = { value, valueAsNumber: value, addEventListener(type, callback) { if (type === 'change') handler = callback; } };
    addFillGeometryProperties(app, fill, {
        insertAdjacentHTML() {},
        querySelector: selector => selector === `#${id}` ? input : null,
    });
    const execute = app.history.execute.bind(app.history);
    app.history.execute = command => {
        assert.deepEqual(fill.captureState(), before, `${id}: candidate preparation is read-only`);
        assert.equal(fill.outline, originalOutline, `${id}: no authored restore/reallocation before command`);
        execute(command);
    };
    assert.equal(typeof handler, 'function');
    handler();
    assert.equal(app.history.undoStack.length, 1, `${id}: one canonical command`);
    const after = fill.captureState();
    assert.notDeepEqual(after, before);
    app.history.undo();
    assert.deepEqual(fill.captureState(), before);
    app.history.redo();
    assert.deepEqual(fill.captureState(), after);
}

{
    const { app, fill } = fixture({ cornerRadius: 0, nodeCornerRadii: { 3: 0.5 }, segmentBulges: { 2: 0.1 } });
    const before = fill.captureState();
    const execute = app.history.execute.bind(app.history);
    app.history.execute = command => { assert.deepEqual(fill.captureState(), before); execute(command); };
    assert.equal(deleteFillNode(app, fill, 1), true);
    assert.equal(fill.outline.length, 3);
    app.history.undo();
    assert.deepEqual(fill.captureState(), before);
}
console.log('PASS detached fill command preparation, thrown mutations, frozen no-ops, geometry fields, node deletion and exact history');
