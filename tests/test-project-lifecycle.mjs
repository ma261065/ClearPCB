import assert from 'node:assert/strict';
import { FileManager, readProjectFile } from '../src/core/FileManager.js';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { validateProject } from '../src/core/project-format.js';
import { zipSync, strToU8 } from '../assets/vendor/fflate.module.js';

const project = () => ({ type: 'clearpcb-project', version: '2.0', schematic: { shapes: [], components: [] } });
const manager = new FileManager();
const oldHandle = { name: 'old.cpcb' };
manager.fileHandle = oldHandle;
manager.setFileName(oldHandle.name);
manager.setDirty(true);
globalThis.window = { showSaveFilePicker: async () => ({ name: 'new.cpcb' }) };
manager.hasFileSystemAccess = () => true;
manager.saveToHandle = async () => ({ success: false, error: 'Disk full' });
assert.equal((await manager.saveAs(project())).success, false);
assert.equal(manager.fileHandle, oldHandle);
assert.equal(manager.fileName, oldHandle.name);
assert.equal(manager.isDirty, true);

let releaseSave;
let saved;
manager._saveCurrent = (data) => {
    saved = data;
    return new Promise((resolve) => { releaseSave = resolve; });
};
let cleared = 0;
manager.clearAutoSave = () => { cleared++; };
const input = project();
const pending = manager.save(input);
input.schematic.shapes.push({ id: 'later' });
manager.setDirty(true);
assert.equal((await manager.save(project())).success, false);
releaseSave({ success: true });
assert.equal((await pending).clean, false);
assert.equal(saved.schematic.shapes.length, 0);
assert.equal(manager.isDirty, true);
assert.equal(cleared, 0);
manager._saveCurrent = async () => ({ success: true });
assert.equal((await manager.save(project())).clean, true);
assert.equal(manager.isDirty, false);
assert.equal(cleared, 1);

assert.throws(() => validateProject({ ...project(), version: '99' }), /Unsupported/);
assert.throws(() => validateProject({ ...project(), pcb: { vias: [{ id: 'v' }, { id: 'v' }] } }), /Duplicate/);
assert.throws(() => validateProject({ ...project(), pcb: { tracks: [{ nd: { a: [0, 0] }, ed: { edge: ['a', 'missing'] } }] } }), /Dangling/);
assert.throws(() => validateProject({ ...project(), pcb: { board: { width: Infinity } } }), /Non-finite/);
const corruptZip = zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'clearpcb-zip', version: 99 })) });
await assert.rejects(readProjectFile(new Blob([corruptZip])), /manifest/);
const validZip = new Blob([zipSync({
    'manifest.json': strToU8(JSON.stringify({ format: 'clearpcb-zip', version: 1, models: {} })),
    'options.json': strToU8(JSON.stringify({ type: 'clearpcb-project', version: '2.0' })),
    'schematic.json': strToU8(JSON.stringify(project().schematic)),
})]);
const openedHandle = { name: 'opened.cpcb', getFile: async () => validZip };
window.showOpenFilePicker = async () => [openedHandle];
manager.setDirty(true);
const opened = await manager.open();
assert.equal(opened.success, true);
assert.equal(manager.fileHandle, oldHandle);
assert.equal(manager.isDirty, true);
manager._recordRecent = async () => {};
await manager.adoptOpen(opened);
assert.equal(manager.fileHandle, openedHandle);
assert.equal(manager.fileName, 'opened.cpcb');
assert.equal(manager.isDirty, false);

const owner = new ProjectDocument();
let current = project();
let pcbState = null;
let loads = 0;
owner.registerView('schematic', {
    serializeSection: () => structuredClone(current),
    prepareSection: () => ({}),
    loadSection: (data) => { current = structuredClone(data); loads++; },
});
const pcb = {
    serializeSection: () => pcbState,
    isSectionDirty: () => true,
    prepareSection: () => { throw new Error('Invalid PCB'); },
    loadSection: (data) => { pcbState = data; },
};
owner.registerView('pcb', pcb);
assert.equal(owner.isDirty, true);
await assert.rejects(owner.load(project()), /Invalid PCB/);
assert.equal(loads, 0);
assert.equal(owner.fileManager.loading, false);
pcb.prepareSection = () => ({});
pcb.loadSection = (data) => {
    if (data?.reject) throw new Error('Render failure');
    pcbState = data;
};
await assert.rejects(owner.load({ ...project(), pcb: { reject: true } }), /Render failure/);
assert.deepEqual(current, project());
assert.equal(pcbState, null);
assert.equal(owner.fileManager.loading, false);
window.addEventListener = () => {};
const { createComponentFromData, newFile, openFile, openRecentFile, importEasyEDA } = await import('../src/schematic/modules/files.js');
const embedded = { name: 'Example', symbol: { width: 10, height: 10, graphics: [], pins: [] } };
const component = createComponentFromData({ componentLibrary: {
    getDefinition() { throw new Error('Embedded definitions must take precedence.'); },
} }, { dn: 'Example', def: embedded, id: 'component_1', x: 0, y: 0 });
assert.notEqual(component.definition, embedded);
assert.equal(component.toJSON().def.name, 'Example');
assert.equal(embedded._source, undefined);
let prompts = 0;
const guardedApp = { project: { isDirty: true }, fileManager: { isDirty: false },
    _confirm: async () => { prompts++; return false; } };
await newFile(guardedApp);
await openFile(guardedApp);
await openRecentFile(guardedApp, 'ignored.cpcb');
await importEasyEDA(guardedApp);
assert.equal(prompts, 4);
console.log('PASS: project validation, save snapshots, dirty state, and load rollback');