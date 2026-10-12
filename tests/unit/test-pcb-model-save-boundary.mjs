import assert from 'node:assert/strict';
import { ProjectDocument } from '../../src/core/ProjectDocument.js';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { createPcbText } from '../../src/core/pcb-text.js';
import { normalizePcbSection } from '../../src/core/project-field-aliases.js';
import { defaultPcbStackup } from '../../src/core/project-format.js';

assert.equal(typeof document, 'undefined');
const project = new ProjectDocument();
const model = project.pcbDocument;
const loadedSettings = { gridSize: 0.254, gridStyle: 'dots', units: 'inch', gridVisible: true, snapToGrid: true };
model.load({ stackup: defaultPcbStackup(), settings: loadedSettings });
const text = createPcbText({ id: 'authored', content: 'Model-owned', x: 1.234567 });
model.texts.set(text.id, text);
let currentSettings;
const view = {
    getViewSettings() { return currentSettings; },
    serializeSection() { assert.fail('Project saves must not ask the PCB view to serialize authored state'); },
};
project.registerView('pcb', view);
const saved = () => normalizePcbSection(project.serialize().pcb);
assert.deepEqual(saved().settings, loadedSettings, 'Before viewport creation, retain loaded preferences');
assert.equal(saved().texts[0].content, text.content);
assert.equal(saved().texts[0].x, 1.2346, 'Existing authored save precision is unchanged');
assert.equal(text.x, 1.234567);
currentSettings = { ...loadedSettings, gridSize: 0.5, units: 'mm', gridVisible: false, snapToGrid: false };
const first = saved();
assert.deepEqual(first.settings, currentSettings, 'The live view supplies current preferences only');
assert.deepEqual(model.settings, loadedSettings, 'Saving does not rewrite loaded fallback preferences');
first.settings.gridSize = 100;
assert.equal(currentSettings.gridSize, 0.5);
currentSettings.gridSize = 1;
text.content = 'Changed in model';
assert.equal(saved().texts[0].content, 'Changed in model');
assert.equal(saved().settings.gridSize, 1, 'Every save reads current view preferences');
project.registerView('pcb', {});
assert.deepEqual(saved().settings, loadedSettings, 'A view without a preferences provider cannot hide model data');
assert.equal(saved().texts[0].content, 'Changed in model');
project.registerView('pcb', { getViewSettings() { throw new Error('Preference capture failed'); } });
assert.throws(() => project.serialize(), /Preference capture failed/, 'Preference errors must not silently lose settings');

const empty = new ProjectDocument();
empty.registerView('pcb', { getViewSettings: () => undefined });
assert.equal('pcb' in empty.serialize(), false, 'An unvisited empty editor does not invent a PCB section');
empty.pcbDocument.designSettings.update({ clearance: 0.123456 });
assert.equal('pcb' in empty.serialize(), false, 'Retained design defaults alone remain insufficient');
empty.registerView('pcb', { getViewSettings: () => currentSettings });
assert.deepEqual(normalizePcbSection(empty.serialize().pcb).settings, currentSettings,
    'An empty board with an existing viewport still persists its view preferences');
empty.pcbDocument.clear();
assert.ok(empty.serialize().pcb, 'New with an existing viewport keeps its current preferences');
empty.registerView('pcb', {});
assert.equal('pcb' in empty.serialize(), false);

const recovering = new ProjectDocument();
recovering.pcbDocument.load({ stackup: defaultPcbStackup(), settings: loadedSettings });
recovering.pcbDocument.ensureBoardOutline();
recovering.pcbDocument.texts.set(text.id, createPcbText(text));
let recoverySettings = { ...currentSettings };
let failOnce = true;
recovering.registerView('pcb', {
    getViewSettings: () => recoverySettings,
    serializeSection() { assert.fail('Recovery snapshots must also be model-owned'); },
    prepareSection: data => PcbDocument.prepare(data),
    loadSection(data, prepared) {
        recovering.pcbDocument.load(data, prepared);
        recoverySettings = { ...recovering.pcbDocument.settings };
        if (failOnce) {
            failOnce = false;
            throw new Error('Render failure after model adoption');
        }
    },
});
const previousPcb = recovering.serialize().pcb;
const replacement = recovering.serialize();
replacement.pcb.texts[0].t = 'Replacement';
replacement.pcb.settings.gs = 5;
await assert.rejects(recovering.load(replacement), /Render failure after model adoption/);
assert.deepEqual(recovering.serialize().pcb, previousPcb,
    'Registered-view failure restores model content and the captured live preferences');
assert.equal(recovering.fileManager.loading, false);

globalThis.window = { addEventListener() {} };
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');
const app = {
    pcbDocument: empty.pcbDocument, viewport: null,
    getViewSettings: PCBApp.prototype.getViewSettings,
    serializeSection: PCBApp.prototype.serializeSection,
};
empty.registerView('pcb', app);
assert.equal(app.serializeSection(), null);
assert.equal(app.getViewSettings(), undefined);
app.viewport = { ...currentSettings };
const preferences = app.getViewSettings();
assert.deepEqual(preferences, currentSettings);
preferences.gridSize = 999;
assert.equal(app.viewport.gridSize, currentSettings.gridSize);
assert.deepEqual(empty.serialize().pcb, app.serializeSection(), 'Project and direct editor section APIs agree');
assert.deepEqual(PCBApp.prototype.serialize.call(app), app.serializeSection());
app.pcbDocument.load({ stackup: defaultPcbStackup(), settings: loadedSettings,
    texts: [{ id: 'loaded', content: 'Loaded without rendering' }] });
app.viewport = null;
assert.deepEqual(empty.serialize().pcb, app.serializeSection());
assert.deepEqual(normalizePcbSection(app.serializeSection()).settings, loadedSettings);
app.viewport = { ...currentSettings };
assert.deepEqual(empty.serialize().pcb, app.serializeSection());
assert.deepEqual(normalizePcbSection(app.serializeSection()).settings, currentSettings);
assert.equal(app.pcbDocument.texts.get('loaded').content, 'Loaded without rendering');
assert.equal(typeof document, 'undefined', 'Saving never creates a viewport or touches the DOM');
delete globalThis.window;
console.log('PASS PCB model-owned saves, live/loaded view preferences, empty-section policy and direct editor API parity');
