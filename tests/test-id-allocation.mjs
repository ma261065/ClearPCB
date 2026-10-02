import assert from 'node:assert/strict';

const noop = () => {};
const element = () => ({
    style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, getAttribute: () => null, appendChild: child => child, removeChild: noop,
    addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
});
globalThis.window = { addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1 };
globalThis.document = {
    body: element(), documentElement: { getAttribute: () => 'dark' },
    createElement: element, createElementNS: element,
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop,
};
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };

const { IdAllocator } = await import('../src/core/id-allocator.js');
const { Shape, resetIdCounter } = await import('../src/shapes/shape.js');
const { Via, resetViaIdCounter } = await import('../src/shapes/via.js');
const { Pad, resetPadIdCounter } = await import('../src/shapes/pad.js');
const { CopperFill, resetFillIdCounter } = await import('../src/shapes/copper-fill.js');
const { Component } = await import('../src/components/Component.js');
const { BuiltInComponents } = await import('../src/components/BuiltInComponents.js');
const { ProjectDocument } = await import('../src/core/ProjectDocument.js');
const { preparePcbPaste } = await import('../src/pcb/modules/pcb-paste.js');

// The allocator: one above the highest observed number, per prefix.
{
    const ids = new IdAllocator('via');
    assert.deepEqual([ids.next(), ids.next()], ['via_1', 'via_2']);
    ids.observe('via_10');
    ids.observe('via_4');
    for (const foreign of ['pad_99', 'via_x', 'via_', 'xvia_50', 'via_7a', null, undefined, 42, `via_${'9'.repeat(30)}`]) {
        ids.observe(foreign);
    }
    assert.equal(ids.next(), 'via_11', 'Lower, foreign, malformed and unsafe numbers are ignored');
    assert.equal(ids.claim('via_20'), 'via_20');
    assert.equal(ids.claim(''), 'via_21', 'An empty ID is generated, matching the former `id || next` rule');
    assert.equal(ids.claim(undefined), 'via_22');
    ids.reset();
    assert.equal(ids.next(), 'via_1');
}

const definition = BuiltInComponents[0];
const kinds = [
    ['shape', id => new Shape({ id })],
    ['via', id => new Via({ id, x: 0, y: 0 })],
    ['pad', id => new Pad({ id })],
    ['fill', id => new CopperFill({ id, outline: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] })],
    ['comp', id => new Component(definition, { id })],
];

// Every entity kind: explicit IDs passed to constructors are observed, so later IDs skip past them.
for (const [prefix, create] of kinds) {
    const explicit = create(`${prefix}_900`);
    assert.equal(explicit.id, `${prefix}_900`);
    const generated = create(undefined).id;
    assert.match(generated, new RegExp(`^${prefix}_\\d+$`));
    assert.ok(Number(generated.split('_')[1]) > 900, `${prefix}: generated ${generated} follows an explicit ID`);
}

// Load, New and paste never reuse an ID present in the document.
const resetAll = () => { resetIdCounter(); resetViaIdCounter(); resetPadIdCounter(); resetFillIdCounter(); };
const source = new ProjectDocument();
source.pcbDocument.vias.push(new Via({ id: 'via_7', x: 1, y: 1 }), new Via({ id: 'via_3', x: 2, y: 2 }));
source.pcbDocument.pads.push(new Pad({ id: 'pad_12', x: 3, y: 3 }));
source.pcbDocument.boardShapes.push(new CopperFill({ id: 'fill_5', outline: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: -5 }] }));
source.schematicDocument.components.push(new Component(definition, { id: 'comp_1300', x: 0, y: 0 }));
const saved = source.serialize();
const loadedIds = (project) => new Set([
    ...project.pcbDocument.vias, ...project.pcbDocument.pads, ...project.pcbDocument.boardShapes,
    ...project.schematicDocument.components, ...project.schematicDocument.shapes,
].map(entity => entity.id));

resetAll();
const project = new ProjectDocument();
await project.load(structuredClone(saved));
const existing = loadedIds(project);
assert.ok(['via_7', 'via_3', 'pad_12', 'fill_5', 'comp_1300'].every(id => existing.has(id)), 'Fixture IDs survive loading');
for (const [prefix, create] of kinds) {
    const id = create(undefined).id;
    assert.ok(!existing.has(id), `${prefix}: ${id} is unique after loading`);
}
assert.equal(new Via({ x: 0, y: 0 }).id.startsWith('via_'), true);
assert.ok(Number(new Via({ x: 0, y: 0 }).id.split('_')[1]) > 7, 'Via IDs continue above the loaded maximum');

const clipboard = {
    vias: project.pcbDocument.vias.map(via => via.toJSON()),
    pads: project.pcbDocument.pads.map(pad => pad.toJSON()),
    fills: project.pcbDocument.copperFills.map(fill => fill.toJSON()),
};
const payload = preparePcbPaste({ pcbDocument: project.pcbDocument }, clipboard);
const pasted = [...payload.vias, ...payload.pads, ...payload.fills].map(entity => entity.id);
assert.equal(pasted.length, 4);
assert.equal(new Set(pasted).size, pasted.length, 'Pasted entities receive distinct IDs');
assert.ok(pasted.every(id => !existing.has(id)), 'Pasted copies never reuse an existing ID');

await project.reset();
const fresh = [new Via({ x: 0, y: 0 }).id, new Pad({}).id];
assert.deepEqual(fresh, ['via_1', 'pad_1'], 'New restarts the PCB entity sequences for the empty document');
await project.load(structuredClone(saved));
const reloaded = loadedIds(project);
for (const [prefix, create] of kinds) {
    const id = create(undefined).id;
    assert.ok(!reloaded.has(id), `${prefix}: ${id} is unique after New and reopening`);
}

console.log('PASS ID allocation: per-prefix sequence, explicit-ID observation, and uniqueness across load, New and paste');
