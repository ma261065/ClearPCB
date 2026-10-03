import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { SchematicDocument } from '../src/core/SchematicDocument.js';
import { Component } from '../src/components/Component.js';
import { Shape } from '../src/shapes/shape.js';
import { viewOf, componentViewOf } from '../src/schematic/render/shape-view-state.js';
import { validateProject } from '../src/core/project-format.js';

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
                nd: { a: [0, 0], b: [10, 0] }, ed: { e: ['a', 'b'] },
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
console.log('PASS: project-owned schematic load, rename/undo, connectivity and serialization without editors or DOM');
