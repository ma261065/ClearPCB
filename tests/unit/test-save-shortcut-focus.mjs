import assert from 'node:assert/strict';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

const document = installFakeDom();
const listeners = new Map();
globalThis.window.addEventListener = (name, listener) => listeners.set(name, listener);
globalThis.window.removeEventListener = name => listeners.delete(name);

const { bindKeyboardShortcuts } = await import('../../src/schematic/modules/keyboard.js');
const { handlePcbKeyDown } = await import('../../src/pcb/modules/keyboard.js');

const control = tag => {
    const element = fakeElement(tag);
    element.tagName = tag.toUpperCase();
    element.type = tag === 'input' ? 'text' : '';
    return element;
};
const shortcut = (target, altKey = false) => ({
    key: 's',
    target,
    ctrlKey: true,
    metaKey: false,
    altKey,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    stopImmediatePropagation() {},
});

let schematicSaves = 0;
let schematicSaveAs = 0;
const schematic = {
    selection: { getSelection: () => [] },
    saveFile() { schematicSaves++; },
    saveFileAs() { schematicSaveAs++; },
};
const dispose = bindKeyboardShortcuts(schematic);
try {
    for (const target of [control('button'), control('input'), control('select')]) {
        const event = shortcut(target);
        listeners.get('keydown')(event);
        assert.equal(event.defaultPrevented, true, `schematic Ctrl+S is consumed from ${target.tagName}`);
    }
    const saveAsEvent = shortcut(control('input'), true);
    listeners.get('keydown')(saveAsEvent);
    assert.equal(saveAsEvent.defaultPrevented, true);
    assert.equal(schematicSaves, 3);
    assert.equal(schematicSaveAs, 1);
} finally {
    dispose();
}

let pcbSaves = 0;
let pcbSaveAs = 0;
const pcb = {
    status: { docTitle: null },
    project: {
        save() { pcbSaves++; return Promise.resolve({ success: true }); },
        saveAs() { pcbSaveAs++; return Promise.resolve({ success: true }); },
    },
};
for (const target of [control('button'), control('input'), control('select')]) {
    assert.equal(handlePcbKeyDown(pcb, shortcut(target)), true,
        `PCB Ctrl+S is consumed from ${target.tagName}`);
}
assert.equal(handlePcbKeyDown(pcb, shortcut(control('input'), true)), true);
assert.equal(pcbSaves, 3);
assert.equal(pcbSaveAs, 1);
await Promise.resolve();

delete globalThis.document;
delete globalThis.window;

console.log('PASS Ctrl+S saves from ribbon and property-control focus in both editors');
