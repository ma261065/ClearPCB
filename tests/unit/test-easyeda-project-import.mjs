import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ComponentLibrary } from '../../src/components/ComponentLibrary.js';
import { importEasyEDASchematic } from '../../src/easyeda/schematic-importer.js';
import { ProjectDocument } from '../../src/core/ProjectDocument.js';
import { readProjectFile } from '../../src/core/FileManager.js';
import { validateEditableProject } from '../../src/core/project-format.js';

// EasyEDAScmTest.json is a local design kept out of the repository (.gitignore), so CI skips this check.
const fixtureUrl = new URL('../../EasyEDAScmTest.json', import.meta.url);
if (existsSync(fixtureUrl)) await checkFixture(JSON.parse(readFileSync(fixtureUrl, 'utf8')));
else console.log('SKIP EasyEDA fixture import: EasyEDAScmTest.json is not present (git-ignored local design)');

async function checkFixture(fixture) {
    const imported = importEasyEDASchematic(fixture, Object.create(ComponentLibrary.prototype));
    assert.equal(imported.schematic.components.length, 42);
    assert.equal(imported.schematic.shapes.length, 181);
    assert.doesNotThrow(() => validateEditableProject(imported));
    const definitions = Object.values(imported.schematic.defs);
    assert.ok(definitions.some(definition => definition.defaultProperties.mpn === 'PCM5102APWR'));
    assert.ok(definitions.some(definition => definition.footprintName));
    for (const definition of definitions) {
        assert.equal('mpn' in definition, false, 'Manufacturer data uses canonical default properties');
        assert.equal('package' in definition, false, 'Package metadata uses the canonical footprint name');
    }
    const project = new ProjectDocument();
    await project.load(imported);
    const metadata = owner => owner.schematicDocument.components.map(component => ({
        id: component.id, reference: component.reference, value: component.value,
        properties: component.properties, footprintName: component.definition.footprintName,
        supplier: component.definition.supplier_part_numbers,
    }));
    const expectedMetadata = structuredClone(metadata(project));
    const expectedNetlist = project.getNetlist();
    let written;
    const saved = await project.fileManager.saveToHandle(project.serialize(), {
        name: 'imported.cpcb',
        async createWritable() {
            return { async write(blob) { written = blob; }, async close() {} };
        },
    });
    assert.equal(saved.success, true, saved.error);
    const reopened = new ProjectDocument();
    await reopened.load(await readProjectFile(written));
    assert.deepEqual(metadata(reopened), expectedMetadata);
    assert.deepEqual(reopened.getNetlist(), expectedNetlist);
    assert.equal(reopened.schematicDocument.shapes.length, 181);

    const storage = new Map();
    globalThis.localStorage = {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: key => storage.delete(key),
    };
    project.fileManager.autoSaveToStorage(project.serialize());
    const recovered = new ProjectDocument();
    await recovered.load(project.fileManager.loadAutoSave().data);
    assert.deepEqual(metadata(recovered), expectedMetadata);
    assert.deepEqual(recovered.getNetlist(), expectedNetlist);
    console.log('PASS EasyEDA fixture import, canonical metadata, ZIP reopen and autosave recovery');
}
