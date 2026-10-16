import assert from 'node:assert/strict';
import { Component } from '../../src/components/Component.js';
import { BuiltInComponents } from '../../src/components/BuiltInComponents.js';
import { Wire } from '../../src/shapes/wire.js';
import { SchematicDocument } from '../../src/core/SchematicDocument.js';
import { FileManager, readProjectFile } from '../../src/core/FileManager.js';
import { validateProject } from '../../src/core/project-format.js';

const definition = (name, pinX, source = 'LCSC') => ({
    name, category: 'Test', defaultReference: 'C?', defaultValue: '10uF', _source: source,
    symbol: { graphics: [], pins: [
        { number: '1', x: 0, y: 0 }, { number: '2', x: pinX, y: 0 },
    ] },
});
const imported = definition('LCSC_C7171', 7.62, 'EasyEDA-Import');
const current = definition('LCSC_C7171', -7.62);
for (const reverse of [false, true]) {
    const document = new SchematicDocument();
    const old = new Component(imported, { id: 'imported', reference: 'C1', x: 80, y: 0 });
    const added = new Component(current, { id: 'added', reference: 'C6', x: 45.73, y: -31.75, rotation: 270 });
    const duplicate = new Component(structuredClone(current), { id: 'duplicate', reference: 'C7', x: 100, y: 0 });
    const reserved = new Component(definition('LCSC_C7171__2', 5), { id: 'reserved', reference: 'C8' });
    document.components = reverse ? [added, old, duplicate, reserved] : [old, added, duplicate, reserved];
    const pin = added.getPinPosition('2');
    assert.ok(Math.abs(pin.y + 24.13) < 1e-9, 'C6 uses the live library pin position');
    const wire = new Wire({ points: [pin, { x: pin.x, y: pin.y + 2.54 }] });
    wire.pinConnections.set([...wire.nodes.keys()][0], { componentId: added.id, pinNumber: '2' });
    document.shapes = [wire];
    const originalDefinitions = structuredClone(document.components.map(component => component.definition));
    const saved = document.serialize();
    assert.doesNotThrow(() => validateProject(saved), 'Same-name definitions must not substitute the wrong physical pin');
    const records = new Map(saved.schematic.components.map(component => [component.id, component]));
    assert.notEqual(records.get(old.id).dn, records.get(added.id).dn);
    assert.equal(records.get(added.id).dn, records.get(duplicate.id).dn, 'Identical definitions still deduplicate');
    assert.equal(records.get(reserved.id).dn, 'LCSC_C7171__2', 'Generated keys do not steal another definition name');
    assert.equal(Object.keys(saved.schematic.defs).length, 3);
    assert.deepEqual(document.components.map(component => component.definition), originalDefinitions,
        'Serialization does not rename or mutate live definitions');

    const checkReopen = data => {
        const reopened = new SchematicDocument();
        reopened.load(data);
        for (const before of document.components) {
            const after = reopened.components.find(component => component.id === before.id);
            for (const number of ['1', '2']) assert.deepEqual(after.getPinPosition(number), before.getPinPosition(number));
            assert.equal(after.definition.name, before.definition.name, 'Library identity survives project-local keys');
        }
        assert.deepEqual(reopened.getNetlist(), document.getNetlist());
        assert.deepEqual(reopened.serialize().schematic, saved.schematic, 'Keys remain stable after reopening');
    };
    checkReopen(saved);
    const storage = new Map();
    globalThis.localStorage = {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: key => storage.delete(key),
    };
    const manager = new FileManager();
    manager.autoSaveToStorage(saved);
    checkReopen(manager.loadAutoSave().data);
    let written;
    const result = await manager.saveToHandle(saved, { name: 'collisions.cpcb', async createWritable() {
        return { async write(blob) { written = blob; }, async close() {} };
    } });
    assert.equal(result.success, true, result.error);
    checkReopen(await readProjectFile(written));
}

{
    const document = new SchematicDocument();
    const bundled = new Component(BuiltInComponents.find(def => def.name === 'Resistor'),
        { id: 'bundled', reference: 'R1', x: 50, y: 0 });
    const custom = new Component(definition('Resistor', 7.62, 'User'), { id: 'custom', reference: 'C1' });
    document.components = [custom, bundled];
    const saved = document.serialize();
    assert.equal(saved.schematic.components[1].dn, 'Resistor');
    assert.notEqual(saved.schematic.components[0].dn, 'Resistor', 'Embedded definitions cannot shadow built-ins');
    assert.doesNotThrow(() => validateProject(saved));
    const reopened = new SchematicDocument();
    reopened.load(saved);
    assert.deepEqual(reopened.components[1].getPinPosition('1'), bundled.getPinPosition('1'));
    assert.deepEqual(reopened.components[0].getPinPosition('2'), custom.getPinPosition('2'));
}

{
    const document = new SchematicDocument();
    const first = { ...definition('SameSymbol', 7.62), footprintName: 'Original',
        model3dObj: 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3' };
    const second = { ...structuredClone(first), footprintName: 'Updated',
        model3dObj: 'v 0 0 0\nv 2 0 0\nv 0 2 0\nf 1 2 3' };
    document.components = [new Component(first, { reference: 'C1' }), new Component(second, { reference: 'C2' })];
    const saved = document.serialize();
    assert.equal(Object.keys(saved.schematic.defs).length, 2,
        'Matching pin geometry does not collapse distinct footprint/model definitions');
    let written;
    const result = await new FileManager().saveToHandle(saved, { name: 'models.cpcb', async createWritable() {
        return { async write(blob) { written = blob; }, async close() {} };
    } });
    assert.equal(result.success, true, result.error);
    const reopened = new SchematicDocument();
    reopened.load(await readProjectFile(written));
    for (const [index, original] of [first, second].entries()) {
        assert.equal(reopened.components[index].definition.footprintName, original.footprintName);
        assert.equal(reopened.components[index].definition.model3dObj, original.model3dObj,
            'ZIP model hoisting and restoration use the variant key');
    }
}
console.log('PASS same-name definition variants preserve pins, library names, deduplication, autosave and ZIP round trips');
