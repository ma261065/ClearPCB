import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { Circle } from '../src/shapes/circle.js';
import { Component } from '../src/components/Component.js';
import { normalizeProjectAliases } from '../src/core/project-field-aliases.js';

assert.equal(typeof document, 'undefined');
const project = new ProjectDocument();
const model = project.schematicDocument;
const loadedSettings = { gridSize: 0.254, gridStyle: 'dots', units: 'inch', gridVisible: true,
    snapToGrid: true, paperSize: 'A4', paperOrientation: 'portrait', titleBlock: true,
    titleBlockInfo: true, titleBlockData: { title: 'Loaded title', company: 'Loaded company' } };
model.load({ type: 'clearpcb-project', version: '1.0',
    schematic: { settings: loadedSettings, shapes: [], components: [] } });
const shape = new Circle({ x: 1.234567, y: 2, radius: 3 });
model.shapes.push(shape);
const definition = { name: 'Save fixture', _source: 'User',
    symbol: { width: 10, height: 10, pins: [], graphics: [] } };
model.components.push(new Component(definition, { id: 'part1', reference: 'U1' }),
    new Component(definition, { id: 'part2', reference: 'U2' }));
let currentSettings;
const view = {
    getViewSettings: () => currentSettings,
    serializeSection() { assert.fail('Project must not ask the schematic view to serialize authored state'); },
};
project.registerView('schematic', view);
const saved = () => normalizeProjectAliases(project.serialize()).schematic;
assert.deepEqual(saved().settings, loadedSettings);
assert.equal(saved().shapes[0].id, shape.id);
assert.deepEqual(Object.keys(saved().defs), ['Save fixture'], 'Model serialization still deduplicates definitions');
assert.equal(saved().components.length, 2);
currentSettings = { ...loadedSettings, units: 'mm', gridSize: 0.5, paperOrientation: 'landscape',
    titleBlockData: { title: 'Live title', company: 'Live company' } };
const snapshot = saved();
assert.deepEqual(snapshot.settings, currentSettings);
snapshot.settings.titleBlockData.title = 'Snapshot edit';
assert.equal(currentSettings.titleBlockData.title, 'Live title', 'Saved title-block data is detached');
currentSettings.titleBlockData.title = 'Later title';
shape.move(5, 6);
model.components[0].reference = 'U10';
assert.equal(saved().settings.titleBlockData.title, 'Later title');
assert.equal(saved().components[0].ref, 'U10');
assert.notDeepEqual(saved().shapes, snapshot.shapes);
assert.deepEqual(model.settings, loadedSettings, 'Live preferences do not replace the loaded fallback');
project.registerView('schematic', {});
assert.deepEqual(saved().settings, loadedSettings);
assert.equal(saved().components[0].ref, 'U10', 'A view without preference support cannot hide model content');
project.registerView('schematic', { getViewSettings() { throw new Error('Preference capture failed'); } });
assert.throws(() => project.serialize(), /Preference capture failed/);

const recovering = new ProjectDocument();
recovering.schematicDocument.load(model.serialize());
let recoverySettings = structuredClone(currentSettings);
let failOnce = true;
let loadCount = 0;
recovering.registerView('schematic', {
    getViewSettings: () => recoverySettings,
    serializeSection() { assert.fail('Recovery snapshots must also be model-owned'); },
    prepareSection: data => recovering.schematicDocument.prepare(data),
    loadSection(data, prepared) {
        loadCount++;
        recovering.schematicDocument.load(data, prepared);
        recoverySettings = structuredClone(recovering.schematicDocument.settings);
        if (failOnce) {
            failOnce = false;
            throw new Error('Render failure after schematic adoption');
        }
    },
    clearSection() { recovering.schematicDocument.clear(); },
});
const previous = recovering.serialize();
const replacement = recovering.serialize();
replacement.schematic.shapes[0].x += 10;
replacement.schematic.settings.td.title = 'Replacement title';
await assert.rejects(recovering.load(replacement), /Render failure after schematic adoption/);
assert.equal(loadCount, 2, 'One adoption attempt and one recovery dispatch');
assert.deepEqual(recovering.serialize().schematic, previous.schematic,
    'Registered-view failure restores authored content and captured live preferences');
assert.equal(recovering.fileManager.loading, false);
let recoverySave;
recovering.fileManager.autoSaveToStorage = data => { recoverySave = data; };
await recovering.reset();
assert.deepEqual(recoverySave.schematic.shapes, []);
assert.deepEqual(recoverySave.schematic.components, []);
assert.equal(recoverySave.schematic.defs, undefined);
assert.deepEqual(recoverySave.schematic.settings, previous.schematic.settings,
    'New saves an empty model with the retained live view preferences');

globalThis.window = { addEventListener() {} };
const { default: SchematicApp } = await import('../src/ui/SchematicApp.js');
const { serializeDocument } = await import('../src/schematic/modules/files.js');
const app = { document: model, viewport: null,
    getViewSettings: SchematicApp.prototype.getViewSettings,
    serializeSection: SchematicApp.prototype.serializeSection };
project.registerView('schematic', app);
assert.equal(app.getViewSettings(), undefined);
assert.deepEqual(app.serializeSection().schematic, project.serialize().schematic);
for (const [paperSize, orientation] of [[{ width: 297, height: 210 }, 'landscape'],
    [{ width: 210, height: 297 }, 'portrait'], [null, null]]) {
    app.viewport = { ...currentSettings, paperSizeKey: 'A4', paperSize,
        showTitleBlock: true, showTitleBlockInfo: false, titleBlockData: { title: 'Viewport title' } };
    const preferences = app.getViewSettings();
    assert.equal(preferences.paperOrientation, orientation);
    assert.equal(preferences.paperSize, 'A4');
    assert.equal(preferences.titleBlock, true);
    assert.equal(preferences.titleBlockInfo, false);
    preferences.titleBlockData.title = 'Caller edit';
    assert.equal(app.viewport.titleBlockData.title, 'Viewport title', 'Preference capture itself is detached');
    assert.deepEqual(project.serialize().schematic, app.serializeSection().schematic);
    assert.deepEqual(serializeDocument(app).schematic, app.serializeSection().schematic,
        'Standalone schematic serialization uses the same model and preferences');
}
app.viewport = {};
assert.deepEqual(normalizeProjectAliases(app.serializeSection()).schematic.settings,
    { gridSize: undefined, gridStyle: undefined, units: undefined, gridVisible: undefined, snapToGrid: undefined,
        paperSize: null, paperOrientation: null, titleBlock: false, titleBlockInfo: false, titleBlockData: {} });
model.clear();
assert.equal(project.serialize().schematic.shapes.length, 0);
assert.equal(project.serialize().schematic.components.length, 0);
app.viewport = null;
assert.deepEqual(project.serialize().schematic.settings, {});
assert.equal(typeof document, 'undefined', 'Saving does not create a viewport or touch SVG');
delete globalThis.window;
console.log('PASS schematic model-owned saves, detached grid/paper/title preferences, definitions and direct APIs');
