import assert from 'node:assert/strict';
import { ProjectDocument } from '../../src/core/ProjectDocument.js';
import { SchematicDocument } from '../../src/core/SchematicDocument.js';
import { Component } from '../../src/components/Component.js';
import { Shape } from '../../src/shapes/shape.js';
import { viewOf, componentViewOf } from '../../src/schematic/render/shape-view-state.js';
import { validateProject, storableProject } from '../../src/core/project-format.js';
import { createShape } from '../../src/shapes/index.js';

assert.equal(typeof window, 'undefined');
assert.equal(typeof document, 'undefined');
Component.prototype.invalidate = () => assert.fail('Model mutation must not update component highlights');

const input = {
    type: 'clearpcb-project', version: '1.0',
    schematic: {
        settings: { gridSize: 1, paperSize: 'A4' },
        components: [
            { type: 'component', id: 'comp_900', dn: 'Resistor', x: 0, y: 0, ref: 'R1', val: '10k' },
            { type: 'component', id: 'comp_901', dn: 'Resistor', x: 10, y: 0, ref: 'R2', val: '20k' },
        ],
        shapes: [
            { id: 'shape_900', type: 'text', x: 0, y: -2, t: 'R1', cid: 'comp_900', fk: 'reference' },
            { id: 'shape_901', type: 'wire', n: 'SIGNAL',
                nd: { a: [-3.81, 0], b: [6.19, 0] }, ed: { e: ['a', 'b'] },
                pc: { a: { componentId: 'comp_900', pinNumber: '1' },
                    b: { componentId: 'comp_901', pinNumber: '1' } } },
            { id: 'shape_902', type: 'text', x: 5, y: -1, t: 'Signal',
                cid: 'shape_901', fk: 'label',
                att: { kind: 'wire', edgeId: 'e', t: 0.5, anchorX: 5, anchorY: 0, offsetX: 0, offsetY: -1 } },
        ],
    },
};
const original = structuredClone(input);
const project = new ProjectDocument();
await project.load(input);
const model = project.schematicDocument;
const component = model.components[0];
const field = model.shapes[0];
assert.equal(field.parentComponent, component);
assert.equal(component.refText, field);
assert.equal(model.shapes[2].parentComponent, model.shapes[1]);
assert.ok(model.shapes[1].attachedLabels.has(model.shapes[2]));
assert.equal(componentViewOf(component), undefined);
assert.equal(viewOf(field), undefined);
assert.deepEqual(project.getNetlist(), [
    { net: 'SIGNAL', pins: [{ componentId: 'comp_900', pinNumber: '1' }, { componentId: 'comp_901', pinNumber: '1' }] },
    { net: 'R1.2', pins: [{ componentId: 'comp_900', pinNumber: '2' }] },
    { net: 'R2.2', pins: [{ componentId: 'comp_901', pinNumber: '2' }] },
]);
const rename = project.createReferenceRenameCommand(component.id, ' R3 ');
assert.equal(component.reference, 'R1', 'Command creation does not mutate state');
rename.execute();
assert.equal(model.components[0], component, 'Rename preserves object identity');
assert.equal(component.reference, 'R3');
assert.equal(field.text, 'R3');
assert.equal(project.getNetlist()[1].net, 'R3.2');
rename.undo();
assert.equal(field.text, 'R1');
rename.execute();
assert.equal(field.text, 'R3');
assert.throws(() => model.createReferenceRenameCommand(component.id, 'r2'), /already used/);
assert.throws(() => model.createReferenceRenameCommand(component.id, ' '), /blank/);
component.locked = true;
assert.throws(() => model.createReferenceRenameCommand(component.id, 'R4'), /locked/);
component.locked = false;
const info = project.getComponentInfo(component.id);
info.reference = 'NOT-A-RENAME';
info.footprintShapes.push('NOT-A-FOOTPRINT');
assert.equal(component.reference, 'R3');
assert.notDeepEqual(info.footprintShapes, project.getComponentInfo(component.id).footprintShapes);
const serialized = project.serialize();
assert.doesNotThrow(() => validateProject(serialized));
assert.equal(serialized.schematic.components[0].ref, 'R3');
assert.equal(serialized.schematic.shapes[0].cid, component.id);
assert.equal(serialized.schematic.shapes[2].cid, model.shapes[1].id);
assert.deepEqual(serialized.schematic.settings, { gs: 1, ps: 'A4' }, 'Settings keep the existing compact file format');
const reloaded = new SchematicDocument();
reloaded.load(serialized);
assert.deepEqual(reloaded.serialize().schematic, serialized.schematic);
assert.deepEqual(reloaded.getNetlist(), project.getNetlist());
assert.deepEqual(input, original, 'Loading and editing never mutate the input document');
const invalid = structuredClone(input);
invalid.schematic.components[0].dn = 'Missing definition';
assert.throws(() => model.load(invalid), /Missing component definition/);
assert.equal(model.components[0], component, 'Failed preparation leaves live instances intact');
await assert.rejects(project.load(invalid), /Missing component definition/);
assert.equal(model.components[0], component, 'Project preparation also preserves instances on failure');
assert.ok(new Component(component.definition).id !== component.id, 'Loaded component IDs are reserved');
model.clear();
assert.deepEqual(model.components, []);
assert.deepEqual(model.shapes, []);
assert.throws(() => rename.undo(), /no longer available/, 'Stale commands fail explicitly');

for (const parentSize of [{ fs: 9 }, { fontSize: 12 }, { fs: 9, fontSize: 12 }]) {
    for (const savedTextSize of [undefined, 3.5]) {
        const data = {
            type: 'clearpcb-project', version: '1.0',
            schematic: { components: [], shapes: [
                { id: 'net_size_owner', type: 'net', x: 0, y: 0, n: 'VCC', ...parentSize },
                ...(savedTextSize === undefined ? [] : [{
                    id: 'net_size_text', type: 'text', x: 0, y: 0,
                    t: 'VCC', fs: savedTextSize, cid: 'net_size_owner', fk: 'net',
                }]),
            ] },
        };
        const original = structuredClone(data);
        const document = new SchematicDocument();
        document.load(data);
        const net = document.shapes.find(shape => shape.type === 'net');
        const text = net.labelText;
        assert.equal(text.parentComponent, net);
        assert.equal(text.fontSize, savedTextSize ?? 1.4, 'Ignore parent size even when no Text was saved');
        assert.equal(Object.hasOwn(net, 'fontSize'), false);
        assert.equal(Object.hasOwn(net.captureState(), 'fontSize'), false);
        assert.ok(!net.getPropertyDescriptors().some(prop => prop.key === 'fontSize'));
        text.fontSize = 4;
        net.syncLabelText();
        assert.equal(text.fontSize, 4, 'Net synchronization preserves Text size');
        const cloned = net.clone();
        assert.equal(cloned.labelText.fontSize, 4);
        assert.equal(cloned.labelText.parentComponent, cloned);
        const saved = storableProject(document.serialize());
        const parent = saved.schematic.shapes.find(shape => shape.type === 'net');
        assert.equal(Object.hasOwn(parent, 'fs'), false);
        assert.equal(Object.hasOwn(parent, 'fontSize'), false);
        assert.equal(saved.schematic.shapes.filter(shape => shape.fk === 'net').length, 1);
        assert.equal(saved.schematic.shapes.find(shape => shape.fk === 'net').fs, 4);
        assert.equal(Object.hasOwn(storableProject(data).schematic.shapes[0], 'fs'), false,
            'Storage also discards legacy parent size without constructing an editor');
        const reopened = new SchematicDocument();
        reopened.load(saved);
        assert.equal(reopened.shapes.find(shape => shape.type === 'net').labelText.fontSize, 4);
        assert.deepEqual(reopened.serialize().schematic, saved.schematic);
        assert.deepEqual(data, original, 'Ignoring legacy parent size never mutates the input');
    }
}
assert.equal(Object.hasOwn(createShape({ type: 'net', fs: 8 }), 'fontSize'), false);
for (const fontSize of [0.5, 1, 3.5, 50]) {
    const text = createShape({ type: 'text', fs: fontSize });
    assert.equal(text.fontSize, fontSize, 'Every Properties-supported Text size loads unchanged');
    assert.equal(createShape(text.toJSON()).fontSize, fontSize);
}
console.log('PASS: project-owned schematic load, rename/undo, connectivity and serialization without editors or DOM');
