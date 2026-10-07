import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';

const stored = new Map();
let pickerShown = 0;
globalThis.window = {
    addEventListener() {}, setTimeout(callback) { callback(); },
    showSaveFilePicker: async () => { pickerShown++; return { name: 'picked.cpcb' }; },
    showOpenFilePicker: async () => [],
};
globalThis.requestAnimationFrame = callback => callback();
globalThis.localStorage = {
    getItem: key => stored.get(key) ?? null,
    removeItem: key => stored.delete(key),
    setItem: (key, value) => stored.set(key, value),
};
installFakeDom();
const { FileManager, readProjectFile } = await import('../../src/core/FileManager.js');
const { ProjectDocument } = await import('../../src/core/ProjectDocument.js');
const { ProjectIntegrityError, assertSupportedPcb, defaultPcbStackup, storableProject, validateEditableProject } =
    await import('../../src/core/project-format.js');
const { compactProjectAliases } = await import('../../src/core/project-field-aliases.js');
const { default: SchematicApp } = await import('../../src/ui/SchematicApp.js');

const design = () => ({ trackWidth: 0.2, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3, units: 'mm', router: 'maze' });
const track = (id, x) => ({ type: 'track', id, nd: { a: [x, 0], b: [x + 1, 0] }, ed: { e: ['a', 'b'] } });
const valid = () => ({
    type: 'clearpcb-project', version: '1.0', schematic: { shapes: [], components: [] },
    pcb: { stackup: defaultPcbStackup(), design: design(), tracks: [track('t1', 0), track('t2', 2)] },
});
// A graph edge to a missing node: the loader rejects it and nothing repairs it.
const corrupt = () => {
    const project = valid();
    project.pcb.tracks[1].ed.e = ['a', 'missing'];
    return project;
};

{
    const input = valid();
    const before = JSON.stringify(input);
    assert.deepEqual(storableProject(input), compactProjectAliases(input), 'Storage form is the compact project form');
    assert.equal(JSON.stringify(input), before, 'Checking a project for storage leaves the live data alone');
    const blank = new ProjectDocument().serialize();
    assert.doesNotThrow(() => storableProject(blank), 'A real serialized project is storable');
    assert.throws(() => storableProject(corrupt()),
        error => error instanceof ProjectIntegrityError && /references a missing node/.test(error.message));
    const multiLayer = valid();
    multiLayer.pcb.stackup = { copperLayers: ['top-copper', 'inner-copper-1', 'bottom-copper'] };
    assert.throws(() => validateEditableProject(multiLayer), /only two-layer boards/);
    assert.throws(() => assertSupportedPcb(multiLayer.pcb), /only two-layer boards/);
    assert.throws(() => storableProject(multiLayer),
        error => error instanceof ProjectIntegrityError && /only two-layer boards/.test(error.message));
    console.log('PASS storage form, live-data isolation and integrity errors');
}

function managerWithHandle() {
    const manager = new FileManager();
    const events = [];
    const written = [];
    manager.fileHandle = {
        name: 'board.cpcb',
        async queryPermission() { events.push('permission'); return 'granted'; },
        async requestPermission() { events.push('permission'); return 'granted'; },
        async createWritable() {
            events.push('open');
            return { async write(blob) { written.push(blob); }, async close() { events.push('close'); } };
        },
    };
    manager.setFileName('board.cpcb');
    manager.setDirty(true);
    manager.hasFileSystemAccess = () => true;
    return { manager, events, written };
}

{
    const { manager, events, written } = managerWithHandle();
    let clearedRecovery = 0;
    manager.clearAutoSave = () => { clearedRecovery++; };
    const result = await manager.save(corrupt());
    assert.equal(result.success, false);
    assert.match(result.error, /failed its integrity check, so it was not saved and the file on disk is unchanged/);
    assert.match(result.error, /references a missing node/, 'The reason reaches the user');
    assert.deepEqual(events, [], 'Nothing is asked of the file before the check passes');
    assert.equal(written.length, 0);
    assert.equal(manager.isDirty, true, 'The unsaved changes stay unsaved');
    assert.equal(clearedRecovery, 0, 'Recovery data is kept');
    assert.equal(manager.saving, false, 'A later save can run');

    assert.equal((await manager.saveAs(corrupt())).success, false);
    assert.equal(pickerShown, 0, 'Save As does not ask for a name it would not use');

    const saved = await manager.save(valid());
    assert.equal(saved.success, true);
    assert.deepEqual(events, ['permission', 'open', 'close']);
    const reopened = await readProjectFile(written[0]);
    assert.deepEqual(validateEditableProject(reopened), validateEditableProject(valid()), 'What was written reopens as the same project');
    console.log('PASS saves refuse a project that would not reopen, before touching the file');
}

{
    const manager = new FileManager();
    manager.setFileName('recover.cpcb');
    const key = manager.autoSavePrefix + 'recover.cpcb';
    const errors = [];
    manager.onAutoSaveError = error => errors.push(error);
    manager.autoSaveToStorage(valid());
    const good = stored.get(key);
    assert.ok(good, 'A valid project is autosaved');
    const originalError = console.error;
    console.error = () => {};
    try {
        manager.autoSaveToStorage(corrupt());
        manager.autoSaveToStorage(corrupt());
    } finally {
        console.error = originalError;
    }
    await Promise.resolve();
    assert.equal(stored.get(key), good, 'The last good autosave is kept');
    assert.equal(errors.length, 1, 'The user is told once per failure streak');
    assert.ok(errors[0] instanceof ProjectIntegrityError);
    const recovered = manager.loadAutoSave('recover.cpcb');
    assert.doesNotThrow(() => validateEditableProject(recovered.data), 'Recovery still finds a project that loads');
    console.log('PASS autosave keeps the last good snapshot instead of an unloadable one');
}

{
    const messages = [];
    const host = { async alert(message, options) { messages.push([message, options.title]); } };
    await SchematicApp.prototype.onAutoSaveError.call(host, new ProjectIntegrityError('Dangling graph edge in tracks'));
    await SchematicApp.prototype.onAutoSaveError.call(host, new Error('QuotaExceededError'));
    assert.match(messages[0][0], /failed its integrity check, so the last good autosave is kept/);
    assert.match(messages[0][0], /Dangling graph edge in tracks/);
    assert.match(messages[1][0], /storage full or unavailable/);
    assert.deepEqual(messages.map(([, title]) => title), ['Auto-save Failed', 'Auto-save Failed']);
    console.log('PASS autosave warnings say why the snapshot was not written');
}
