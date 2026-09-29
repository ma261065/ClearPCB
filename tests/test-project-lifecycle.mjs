import assert from 'node:assert/strict';
import { FileManager, parseProjectJSON, readProjectFile } from '../src/core/FileManager.js';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { validateProject, validateEditableProject, defaultPcbStackup } from '../src/core/project-format.js';
import { zipSync, strToU8 } from '../assets/vendor/fflate.module.js';

const project = () => ({ type: 'clearpcb-project', version: '1.0', schematic: { shapes: [], components: [] } });
const design = () => ({ trackWidth: 0.2, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3,
    units: 'mm', router: 'maze' });
const pcbSection = (overrides = {}) => ({ stackup: defaultPcbStackup(), design: design(), ...overrides });
const track = (overrides = {}) => ({ id: 'track-1', type: 'track', c: '#fff',
    nd: { a: [0, 0], b: [1, 0] }, ed: { edge: ['a', 'b'] }, f: false, ...overrides });
const via = (overrides = {}) => ({ type: 'via', id: 'v', x: 0, y: 0, d: 0.6, dr: 0.3, ...overrides });
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

for (const errorName of ['NotAllowedError', 'SecurityError']) {
    const deniedManager = new FileManager();
    const deniedHandle = {
        name: 'denied.cpcb',
        queryPermission: async () => 'granted',
        createWritable: async () => { throw new DOMException('Write blocked', errorName); },
    };
    deniedManager.fileHandle = deniedHandle;
    deniedManager.setFileName(deniedHandle.name);
    deniedManager.setDirty(true);
    deniedManager.clearAutoSave = () => { throw new Error('A failed write must preserve recovery data'); };
    const deniedResult = await deniedManager.save(project());
    assert.equal(deniedResult.success, false);
    assert.equal(deniedResult.errorName, errorName);
    assert.equal(deniedManager.fileHandle, deniedHandle);
    assert.equal(deniedManager.fileName, deniedHandle.name);
    assert.equal(deniedManager.isDirty, true);
    assert.equal(deniedManager.saving, false, 'A fresh Save As can run after a denied write');
}

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
assert.throws(() => validateProject({ ...project(), version: '2.0' }), /Unsupported/);
assert.doesNotThrow(() => validateEditableProject(project()));
assert.doesNotThrow(() => validateProject({ ...project(), schematic: { shapes: [
    { id: 'shape-bordered-text', type: 'text', x: 0, y: 0, t: 'Label', bd: true },
    { id: 'shape-bordered-net', type: 'net', x: 0, y: 0, n: 'GND', bd: true },
], components: [] }, pcb: pcbSection({ texts: [{
    id: 'pcb-bordered-text', content: 'REV A', x: 0, y: 0, size: 1, rotation: 0,
    layer: 'top-silk', strokeWidth: 0.15, border: true,
}] }) }));
assert.doesNotThrow(() => validateEditableProject({ ...project(), pcb: pcbSection({
    vias: [via({ span: { from: 'top-copper', to: 'bottom-copper' } })] }) }));
const multilayer = { ...project(), pcb: pcbSection({
    stackup: { copperLayers: ['top-copper', 'inner-copper-1', 'inner-copper-2', 'bottom-copper'] },
    tracks: [track({ l: 'inner-copper-1', el: { edge: 'inner-copper-2' } })],
    boardShapes: [{ id: 'shape-1', kind: 'line', layer: 'inner-copper-2', lineWidth: 0.2,
        filled: false, copperMode: 'add', plated: false, net: '', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }],
    vias: [via({ id: 'v1', span: { from: 'top-copper', to: 'inner-copper-1' } }),
        via({ id: 'v2', span: { from: 'inner-copper-1', to: 'inner-copper-2' } }), via({ id: 'v3' })],
}) };
const multilayerOriginal = structuredClone(multilayer);
assert.doesNotThrow(() => validateProject(multilayer), 'Multilayer is valid format 1.0');
assert.throws(() => validateEditableProject(multilayer), /only two-layer/);
assert.deepEqual(multilayer, multilayerOriginal, 'Validation does not change multilayer data');
for (const copperLayers of [[], ['bottom-copper', 'top-copper'], ['top-copper', 'inner-copper-1', 'inner-copper-1', 'bottom-copper'],
    ['top-copper', 'unknown', 'bottom-copper']]) {
    assert.throws(() => validateProject({ ...project(), pcb: pcbSection({ stackup: { copperLayers } }) }), /copper layers/);
}
assert.throws(() => validateProject({ ...project(), pcb: { design: design() } }), /field "stackup"/);
assert.throws(() => validateProject({ ...project(), pcb: { stackup: defaultPcbStackup() } }), /field "design"/);
assert.throws(() => validateProject({ ...project(), pcb: pcbSection({ stackup: {} }) }), /copperLayers/);
assert.throws(() => validateProject({ ...project(), pcb: pcbSection({
    tracks: [track({ el: { edge: 'inner-copper-1' } })] }) }), /Undeclared/);
for (const span of [null, { from: 'bottom-copper', to: 'top-copper' },
    { from: 'top-copper', to: 'top-copper' }, { from: 'missing', to: 'bottom-copper' }]) {
    assert.throws(() => validateProject({ ...multilayer, pcb: { ...multilayer.pcb, vias: [via({ span })] } }), /via copper-layer span/);
}
assert.throws(() => validateProject({ ...project(), pcb: pcbSection({ vias: [via(), via()] }) }), /Duplicate/);
assert.throws(() => validateProject({ ...project(), pcb: pcbSection({
    tracks: [track({ ed: { edge: ['a', 'missing'] } })] }) }), /missing node/);
assert.throws(() => validateProject({ ...project(), pcb: pcbSection({ board: { width: Infinity } }) }), /Non-finite/);
const longForm = { ...project(), schematic: { shapes: [
    { id: 'shape-1', type: 'text', c: '#fff', x: 0, y: 0, t: 'Label', componentId: 'comp-1' },
], components: [] } };
const normalizedLongForm = validateProject(longForm);
assert.equal(normalizedLongForm.schematic.shapes[0].cid, 'comp-1');
assert.equal('componentId' in normalizedLongForm.schematic.shapes[0], false);
assert.throws(() => validateProject({ ...project(), extra: true }), /Unknown field "extra"/);
assert.throws(() => validateProject({ ...project(), schematic: {
    shapes: [{ id: 'shape-1', type: 'polyline', nd: { n0: { x: 0, y: 0 } }, ed: {} }], components: [],
} }), /canonical \[x, y\] tuple/);
assert.throws(() => validateProject({ ...project(), schematic: {
    shapes: [{ id: 'shape-1', type: 'polyline', points: [[0, 0], [1, 0]] }], components: [],
} }), /Unknown field "points"/);
for (const type of ['line', 'polygon', 'rect', 'Net']) {
    assert.throws(() => validateProject({ ...project(), schematic: {
        shapes: [{ id: 'shape-1', type }], components: [],
    } }), /Unknown schematic shape type/);
}
assert.throws(() => validateProject({ ...project(), pcb: pcbSection({ fills: [] }) }), /Unknown field "fills"/);
assert.doesNotThrow(() => validateProject({ ...project(), pcb: pcbSection({
    vias: [{ type: 'via', id: 'v', x: 0, y: 0, diameter: 0.8, drill: 0.3 }],
}) }));
assert.throws(() => validateProject({ ...project(), pcb: pcbSection({
    vias: [via({ d: 0.6, diameter: 0.8 })],
}) }), /Conflicting fields "d" and "diameter"/);
const fill = { type: 'fill', id: 'fill-1', l: 'top-copper', pts: [[0, 0], [1, 0], [0, 1]], kind: 'polygon' };
assert.throws(() => validateProject({ ...project(), pcb: pcbSection({
    boardShapes: [{ ...fill, outline: [] }],
}) }), /Unknown field "outline"/);
const { kind: _fillKind, ...fillWithoutKind } = fill;
assert.throws(() => validateProject({ ...project(), pcb: pcbSection({
    boardShapes: [fillWithoutKind],
}) }), /field "kind"/);
const boardShape = { id: 'shape-1', kind: 'rect', layer: 'top-copper', lineWidth: 0.2,
    filled: true, copperMode: 'add', plated: false, net: '',
    points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] };
for (const copperMode of ['remove', 'remove-mask']) {
    assert.throws(() => validateProject({ ...project(), pcb: pcbSection({
        boardShapes: [{ ...boardShape, copperMode }],
    }) }), /Copper mode must be/);
}
assert.doesNotThrow(() => validateProject({ ...project(), pcb: pcbSection({
    boardShapes: [{ ...boardShape, copperMode: 'remove-copper-mask' }],
}) }));
assert.throws(() => validateProject({ ...project(), pcb: pcbSection({
    boardShapes: [{ ...boardShape, strokeSide: 'inside' }],
}) }), /Unknown field "strokeSide"/);
assert.throws(() => validateProject({ ...project(), pcb: pcbSection({
    panelization: { tabsPerEdge: 2 },
}) }), /Unknown field "tabsPerEdge"/);
assert.throws(() => validateProject({ ...project(), pcb: pcbSection({
    panelization: { tabOffset: 0 },
}) }), /Unknown field "tabOffset"/);
assert.throws(() => validateProject({ ...project(), schematic: {
    settings: { units: 'mil' }, shapes: [], components: [],
} }), /Units must be/);
const corruptZip = zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 'clearpcb-zip', version: 99 })) });
await assert.rejects(readProjectFile(new Blob([corruptZip])), /manifest/);
const malformedJson = '{"type":"clearpcb-project","schematic":{"shapes":[],"components":[]},BROKEN}';
assert.throws(() => parseProjectJSON(malformedJson, 'pcb.json'), error =>
    /Invalid JSON in pcb\.json/.test(error.message)
    && /Location: line 1, column \d+ \(character \d+\)/.test(error.message)
    && /Faulty source:\n1 \| /.test(error.message)
    && /\n  \| +\^/.test(error.message));
const largeMalformedJson = `{"items":[${'0,'.repeat(4000)},BROKEN]}`;
assert.throws(() => parseProjectJSON(largeMalformedJson, 'pcb.json'), error =>
    /Invalid JSON in pcb\.json/.test(error.message)
    && /Location: line 1, column \d+ \(character \d+\)/.test(error.message)
    && /…/.test(error.message)
    && /BROKEN/.test(error.message)
    && /\n  \| +\^/.test(error.message));
const malformedZip = zipSync({
    'manifest.json': strToU8(JSON.stringify({ format: 'clearpcb-zip', version: 1, models: {} })),
    'options.json': strToU8(JSON.stringify({ type: 'clearpcb-project', version: '1.0' })),
    'schematic.json': strToU8(JSON.stringify(project().schematic)),
    'pcb.json': strToU8('{\n  "stackup": {},\n  "design": {,\n    "units": "mm"\n  }\n}'),
});
await assert.rejects(readProjectFile(new Blob([malformedZip])), error =>
    /Invalid JSON in pcb\.json/.test(error.message)
    && /Location: line 3, column 14/.test(error.message)
    && /2 \|   "stackup"/.test(error.message)
    && /3 \|   "design": \{,/.test(error.message)
    && /\n  \| +\^/.test(error.message));
const validZip = new Blob([zipSync({
    'manifest.json': strToU8(JSON.stringify({ format: 'clearpcb-zip', version: 1, models: {} })),
    'options.json': strToU8(JSON.stringify({ type: 'clearpcb-project', version: '1.0' })),
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
const loadingStates = [];
owner.onLoadingChange = loading => { loadingStates.push(loading); };
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
const beforeUnsupportedLoad = structuredClone(current);
const beforeUnsupportedRevision = owner.fileManager.revision;
await assert.rejects(owner.load(multilayer), /only two-layer/);
await assert.rejects(owner.load({ ...project(), version: '2.0' }), /Unsupported/);
assert.deepEqual(current, beforeUnsupportedLoad);
assert.equal(owner.fileManager.revision, beforeUnsupportedRevision);
assert.equal(loads, 0);
assert.deepEqual(loadingStates, [], 'Unsupported projects are rejected before touching editor state');
await assert.rejects(owner.load(project()), /Invalid PCB/);
assert.equal(loads, 0);
assert.equal(owner.fileManager.loading, false);
assert.deepEqual(loadingStates, [true, false]);
pcb.prepareSection = () => ({});
let rejectPcbLoad = false;
let restoredPcbDirty;
pcb.restoreSectionDirty = dirty => { restoredPcbDirty = dirty; };
pcb.loadSection = (data) => {
    if (rejectPcbLoad && data) throw new Error('Render failure');
    pcbState = data;
};
rejectPcbLoad = true;
await assert.rejects(owner.load({ ...project(), pcb: pcbSection() }), /Render failure/);
assert.deepEqual(current, project());
assert.equal(pcbState, null);
assert.equal(restoredPcbDirty, true, 'Rollback restores dirtiness through the public view hook');
assert.equal(owner.fileManager.loading, false);
assert.deepEqual(loadingStates, [true, false, true, false]);
window.addEventListener = () => {};
const { createComponentFromData, newFile, openFile, openRecentFile, importEasyEDA, saveFile } = await import('../src/schematic/modules/files.js');
const retryEvents = [];
let allowRetry = false;
let serializations = 0;
const retryApp = {
    _serializeDocument() { serializations++; return project(); },
    fileManager: {
        save: async () => ({ success: false, error: 'Write blocked', errorName: 'NotAllowedError' }),
        saveAs: async data => {
            assert.equal(data.version, '1.0');
            retryEvents.push('saveAs');
            return { success: true, clean: true, fileName: 'copy.cpcb' };
        },
    },
    _confirm: async (message, options) => {
        assert.equal(options.okText, 'Save As');
        assert.match(message, /unsaved/);
        return allowRetry;
    },
    _alert() { throw new Error('Permission failure should offer recovery instead of a generic alert'); },
    _updateTitle() { retryEvents.push('title'); },
    _showSaveToast() { retryEvents.push('toast'); },
    project: { markAllSectionsClean() { retryEvents.push('clean'); } },
};
assert.equal((await saveFile(retryApp)).success, false);
assert.deepEqual(retryEvents, [], 'Cancelling recovery does not save or mark any view clean');
allowRetry = true;
assert.equal((await saveFile(retryApp)).success, true);
assert.equal(serializations, 3, 'Save As takes a fresh snapshot after the permission prompt');
assert.deepEqual(retryEvents, ['saveAs', 'clean', 'title', 'toast']);
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

const resetOwner = new ProjectDocument();
const resetOrder = [];
const resetDocument = project();
resetDocument.schematic.settings = { gridSize: 0.127 };
resetOwner.registerView('pcb', {
    clearSection() { resetOrder.push('pcb'); },
});
resetOwner.registerView('schematic', {
    clearSection() {
        resetOrder.push('schematic');
        resetDocument.schematic.shapes = [];
        resetDocument.schematic.components = [];
    },
    serializeSection: () => structuredClone(resetDocument),
});
let initialRecovery;
resetOwner.fileManager.autoSaveToStorage = data => {
    resetOrder.push('recovery');
    initialRecovery = data;
};
await resetOwner.reset();
assert.deepEqual(resetOrder, ['schematic', 'pcb', 'recovery']);
assert.deepEqual(initialRecovery, resetOwner.serialize(), 'Recovery includes retained editor settings');
assert.equal(resetOwner.fileManager.fileName, 'untitled.cpcb');
assert.equal(resetOwner.fileManager.loading, false);
resetOwner.fileManager.saving = true;
await assert.rejects(resetOwner.reset(), /in progress/);
resetOwner.fileManager.saving = false;
let finishClear;
resetOwner.schematic.clearSection = () => new Promise(resolve => { finishClear = resolve; });
resetOwner.pcb.clearSection = () => { throw new Error('Clear failed'); };
resetOwner.fileManager.fileName = 'original.cpcb';
const pendingReset = resetOwner.reset();
assert.equal(resetOwner.fileManager.loading, true);
await assert.rejects(resetOwner.reset(), /in progress/);
finishClear();
await assert.rejects(pendingReset, /Clear failed/);
assert.equal(resetOwner.fileManager.loading, false, 'Failed clear releases the operation guard');
assert.equal(resetOwner.fileManager.fileName, 'original.cpcb', 'Do not adopt an untitled file after failed clear');
assert.deepEqual(resetOrder, ['schematic', 'pcb', 'recovery']);
console.log('PASS: project validation, save snapshots, dirty state, load rollback, and reset ownership');