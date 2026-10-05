import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { getComputedFill, setComputedFill } from '../src/pcb/modules/computed-fill-cache.js';
import { installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
const { renderPropertyFields } = await import('../src/shared/ui/property-fields.js');
const { commitFillEdit, deleteFillNode, addFillGeometryProperties } =
    await import('../src/pcb/modules/copper-fill-edit.js');
const { setBoardShapeNodeFocus, setBoardShapeSegmentFocus } = await import('../src/pcb/modules/board-shape-state.js');

function fixture(options = {}) {
    const fill = new CopperFill({
        outline: [{ x: Math.PI, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: Math.PI, y: 10 }],
        cornerRadius: 0.123456789, net: 'GND', ...options,
    });
    const model = new PcbDocument();
    model.boardShapes.push(fill);
    const app = { pcbDocument: model, boardShapes: model.boardShapes, placements: new Map(),
        history: new CommandHistory(), viewport: { scale: 100 }, getLayerGroup() { return null; } };
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
    if (focus.node != null) setBoardShapeNodeFocus(app, { shapeId: fill.id, index: focus.node });
    else setBoardShapeNodeFocus(app, null);
    if (focus.segment != null) setBoardShapeSegmentFocus(app, { shapeId: fill.id, segment: focus.segment });
    else setBoardShapeSegmentFocus(app, null);
    const before = fill.captureState(), originalOutline = fill.outline;
    const field = addFillGeometryProperties(app, fill).find(field => field.id === id);
    const execute = app.history.execute.bind(app.history);
    app.history.execute = command => {
        assert.deepEqual(fill.captureState(), before, `${id}: candidate preparation is read-only`);
        assert.equal(fill.outline, originalOutline, `${id}: no authored restore/reallocation before command`);
        execute(command);
    };
    assert.equal(typeof field?.commit, 'function');
    field.commit(value);
    assert.equal(app.history.undoStack.length, 1, `${id}: one canonical command`);
    const after = fill.captureState();
    assert.notDeepEqual(after, before);
    app.history.undo();
    assert.deepEqual(fill.captureState(), before);
    app.history.redo();
    assert.deepEqual(fill.captureState(), after);
}

// Spinner steps coalesce: one pour recomputation and one undo step once the value settles.
{
    const { app, fill } = fixture({});
    setBoardShapeNodeFocus(app, null);
    setBoardShapeSegmentFocus(app, null);
    const field = addFillGeometryProperties(app, fill).find(field => field.id === 'pcbPropFillCornerRadius');
    const container = document.body.appendChild(document.createElement('div'));
    const input = renderPropertyFields(container, [field]).get(field.key);
    const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
    const pending = new Map();
    let nextTimer = 1;
    globalThis.setTimeout = (callback, delay) => { pending.set(nextTimer, { callback, delay }); return nextTimer++; };
    globalThis.clearTimeout = id => pending.delete(id);
    try {
        for (const step of [0.05, 0.1, 0.15]) {
            input.value = String(step);
            input.dispatchEvent({ type: 'change' });
        }
        assert.equal(app.history.canUndo(), false, 'Spinner steps do not commit while the value is changing');
        assert.equal(pending.size, 1, 'Each step restarts one settle timer');
        const [{ callback, delay }] = pending.values();
        assert.ok(delay >= 200, 'The settle delay outlasts a spinner step');
        callback();
        assert.equal(app.history.undoStack.length, 1, 'The settled value commits once');
        assert.equal(fill.cornerRadius, 0.15);
    } finally {
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearTimeout = realClearTimeout;
    }
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
