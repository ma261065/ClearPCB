import assert from 'node:assert/strict';
import { FileManager } from '../src/core/FileManager.js';
import { ProjectDocument } from '../src/core/ProjectDocument.js';

const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const originalStorage = globalThis.localStorage;
const timers = new Map();
const stored = new Map();
let nextTimer = 0;
let writes = 0;
let failKey = null;

globalThis.setInterval = (callback, interval) => {
    assert.equal(interval, 10000);
    const id = ++nextTimer;
    timers.set(id, callback);
    return id;
};
globalThis.clearInterval = (id) => timers.delete(id);
globalThis.localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    removeItem: (key) => stored.delete(key),
    setItem(key, value) {
        if (key === failKey) throw new Error('Simulated storage failure');
        writes++;
        stored.set(key, value);
    },
};

const data = () => ({ type: 'clearpcb-project', version: '2.0', schematic: { shapes: [], components: [] } });
const tick = (manager) => timers.get(manager.autoSaveTimer)();

try {
    const manager = new FileManager();
    let serializations = 0;
    const serialize = () => { serializations++; return data(); };
    manager.startAutoSave(serialize);
    tick(manager);
    assert.equal(serializations, 0);
    manager.setDirty(true);
    tick(manager);
    assert.equal(serializations, 1);
    const firstWrites = writes;
    const key = manager.autoSavePrefix + encodeURIComponent(manager.fileName);
    const firstSnapshot = stored.get(key);
    for (let index = 0; index < 20; index++) tick(manager);
    assert.equal(serializations, 1);
    assert.equal(writes, firstWrites);
    assert.equal(stored.get(key), firstSnapshot);
    assert.equal(manager.isDirty, true);

    manager.setDirty(true);
    tick(manager);
    assert.equal(serializations, 2);
    manager.stopAutoSave();
    manager.startAutoSave(serialize);
    tick(manager);
    assert.equal(serializations, 2);

    manager.loading = true;
    manager.touch();
    tick(manager);
    assert.equal(serializations, 2);
    manager.loading = false;
    tick(manager);
    assert.equal(serializations, 3);

    manager.setFileName('renamed.cpcb');
    tick(manager);
    assert.equal(serializations, 4);
    assert.ok(stored.has(manager.autoSavePrefix + 'renamed.cpcb'));
    manager.clearAutoSave('unrelated.cpcb');
    tick(manager);
    assert.equal(serializations, 4);
    manager.clearAutoSave(manager.fileName);
    tick(manager);
    assert.equal(serializations, 5);
    manager.clearAutoSave();
    tick(manager);
    assert.equal(serializations, 6);

    manager.setDirty(false);
    manager.clearAutoSave(manager.fileName);
    tick(manager);
    assert.equal(serializations, 6);
    manager.stopAutoSave();

    const owner = new ProjectDocument();
    let pcbSerializations = 0;
    const pcb = { isSectionDirty: () => true, onDocumentChanged: () => {} };
    owner.registerView('pcb', pcb);
    owner.fileManager.startAutoSave(() => { pcbSerializations++; return data(); }, () => owner.isViewDirty());
    tick(owner.fileManager);
    tick(owner.fileManager);
    assert.equal(pcbSerializations, 1);
    pcb.onDocumentChanged();
    tick(owner.fileManager);
    assert.equal(pcbSerializations, 2);
    assert.equal(owner.fileManager.isDirty, false);
    owner.fileManager.stopAutoSave();

    for (const failure of ['document', 'index', 'serialization']) {
        const retry = new FileManager();
        retry.setFileName(`retry-${failure}.cpcb`);
        retry.setDirty(true);
        let attempts = 0;
        let serializationFails = failure === 'serialization';
        failKey = failure === 'document' ? retry.autoSavePrefix + retry.fileName
            : failure === 'index' ? retry.autoSavePrefix + 'index' : null;
        retry.startAutoSave(() => {
            attempts++;
            if (serializationFails) throw new Error('Simulated serialization failure');
            return data();
        });
        assert.doesNotThrow(() => tick(retry));
        assert.equal(retry._lastAutoSave, null);
        failKey = null;
        serializationFails = false;
        tick(retry);
        assert.equal(attempts, 2);
        tick(retry);
        assert.equal(attempts, 2);
        retry.stopAutoSave();
    }

    const changedDuringSnapshot = new FileManager();
    changedDuringSnapshot.setDirty(true);
    let attempts = 0;
    changedDuringSnapshot.startAutoSave(() => {
        attempts++;
        if (attempts === 1) changedDuringSnapshot.touch();
        return data();
    });
    tick(changedDuringSnapshot);
    tick(changedDuringSnapshot);
    tick(changedDuringSnapshot);
    assert.equal(attempts, 2);
    changedDuringSnapshot.stopAutoSave();
    assert.equal(timers.size, 0);
    console.log('Autosave revision regressions passed (simulated failures above are expected).');
} finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    if (originalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalStorage;
}