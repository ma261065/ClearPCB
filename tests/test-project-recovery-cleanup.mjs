import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { ComponentLibrary } from '../src/components/ComponentLibrary.js';
import { zipSync, strToU8 } from '../assets/vendor/fflate.module.js';

globalThis.window = { addEventListener() {}, showSaveFilePicker: async () => {} };
const { openFile, openRecentFile, importEasyEDA } = await import('../src/schematic/modules/files.js');
const storage = new Map();
globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
};
const blank = () => ({ version: '1.0', type: 'clearpcb-project',
    schematic: { shapes: [], components: [] } });
const project = new ProjectDocument();
const manager = project.fileManager;
const alerts = [];
const app = {
    fileManager: manager, project, _loadDocument: data => project.load(data),
    componentLibrary: Object.create(ComponentLibrary.prototype),
    _updateTitle() {}, _confirm: async () => true,
    _alert: message => alerts.push(message),
};
const blob = new Blob([zipSync({
    'manifest.json': strToU8(JSON.stringify({ format: 'clearpcb-zip', version: 1, models: {} })),
    'options.json': strToU8(JSON.stringify({ type: 'clearpcb-project', version: '1.0' })),
    'schematic.json': strToU8(JSON.stringify(blank().schematic)),
})]);
const seed = name => manager.autoSaveToStorage(blank(), { revision: manager.revision, fileName: name });
const names = ['A.cpcb', 'B.cpcb', 'C.cpcb', 'imported.cpcb'];
const assertRecovery = (present, absent = []) => {
    for (const name of present) assert.ok(manager.loadAutoSave(name), `Preserve ${name} recovery`);
    for (const name of absent) assert.equal(manager.loadAutoSave(name), null, `Clear only ${name} recovery`);
};
for (const name of names) seed(name);
manager.setFileName('A.cpcb');
manager.setDirty(true);
window.showOpenFilePicker = async () => [{ name: 'C.cpcb', getFile: async () => blob }];
await openFile(app);
assert.deepEqual(alerts, []);
assert.equal(manager.fileName, 'C.cpcb');
assertRecovery(['A.cpcb', 'B.cpcb', 'imported.cpcb'], ['C.cpcb']);

seed('C.cpcb');
// Without IndexedDB the production recent-file API falls back to the picker.
await openRecentFile(app, 'C.cpcb');
assert.deepEqual(alerts, []);
assertRecovery(['A.cpcb', 'B.cpcb', 'imported.cpcb'], ['C.cpcb']);

seed('C.cpcb');
window.showOpenFilePicker = async () => { throw new DOMException('Cancelled', 'AbortError'); };
await openFile(app);
assertRecovery(names);
window.showOpenFilePicker = async () => [{ name: 'C.cpcb', getFile: async () => new Blob(['invalid']) }];
await openFile(app);
assert.equal(alerts.length, 1);
assertRecovery(names);

// EasyEDAScmTest.json is a local design kept out of the repository (.gitignore), so CI skips the Import check.
const fixtureUrl = new URL('../EasyEDAScmTest.json', import.meta.url);
if (existsSync(fixtureUrl)) {
    const source = readFileSync(fixtureUrl, 'utf8');
    globalThis.document = {
        createElement() {
            return { click() { void this.onchange({ target: { files: [{ text: async () => source }] } }); } };
        },
    };
    await importEasyEDA(app);
    assert.equal(alerts.length, 1, 'Import succeeds without another alert');
    assert.equal(project.schematicDocument.components.length, 42);
    assert.equal(manager.fileName, 'imported.cpcb');
    assert.equal(manager.fileHandle, null);
    assert.equal(manager.isDirty, true);
    assertRecovery(names);
} else {
    console.log('SKIP EasyEDA Import recovery check: EasyEDAScmTest.json is not present (git-ignored local design)');
}
console.log('PASS scoped Open/Open Recent recovery cleanup; cancelled/failed Open and Import preserve other snapshots');
