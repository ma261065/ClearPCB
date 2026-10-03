import assert from 'node:assert/strict';

const noop = () => {};
globalThis.window = { addEventListener: noop, removeEventListener: noop };
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
globalThis.document = { getElementById: () => null };

const { default: SchematicApp } = await import('../src/ui/SchematicApp.js');
const { getShapeNodeFocus, setShapeNodeFocus, getShapeSegmentFocus, setShapeSegmentFocus } =
    await import('../src/schematic/modules/shape-focus.js');

function editor() {
    const app = Object.create(SchematicApp.prototype);
    const emitted = [];
    Object.assign(app, { eventBus: { emit: (name, shapes) => emitted.push([name, shapes.length]) }, selection: { getSelection: () => [] } });
    return { app, emitted };
}

const a = { id: 'a' }, b = { id: 'b' };

// Focus lives per editor and starts empty.
{
    const one = editor().app, two = editor().app;
    setShapeNodeFocus(one, { shapeId: 'a', nodeId: 'n0' });
    assert.equal(getShapeNodeFocus(two), null, 'Each editor has its own refined focus');
    setShapeNodeFocus(one, undefined);
    assert.equal(getShapeNodeFocus(one), null, 'Clearing stores null');
}

// Selecting the same single shape keeps its refined node and segment focus.
{
    const { app, emitted } = editor();
    setShapeNodeFocus(app, { shapeId: 'a', nodeId: 'n1' });
    setShapeSegmentFocus(app, { shapeId: 'a', edgeId: 'e1' });
    app._onSelectionChanged([a]);
    assert.deepEqual(getShapeNodeFocus(app), { shapeId: 'a', nodeId: 'n1' });
    assert.deepEqual(getShapeSegmentFocus(app), { shapeId: 'a', edgeId: 'e1' });
    assert.deepEqual(emitted, [['selectionChanged', 1]]);
}

// Selecting another shape, several shapes or nothing drops the focus.
for (const next of [[b], [a, b], []]) {
    const { app } = editor();
    setShapeNodeFocus(app, { shapeId: 'a', nodeId: 'n1' });
    setShapeSegmentFocus(app, { shapeId: 'a', edgeId: 'e1' });
    app._onSelectionChanged(next);
    assert.equal(getShapeNodeFocus(app), null, `node focus cleared for selection [${next.map(s => s.id)}]`);
    assert.equal(getShapeSegmentFocus(app), null, `segment focus cleared for selection [${next.map(s => s.id)}]`);
}

console.log('PASS schematic refined node/segment focus: per editor, kept for the same shape, cleared otherwise');
