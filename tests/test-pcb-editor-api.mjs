import assert from 'node:assert/strict';

const noop = () => {};
const element = () => ({
    style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, getAttribute: () => null, appendChild: child => child, removeChild: noop,
    addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [],
});
globalThis.window = { addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1 };
globalThis.document = {
    body: element(), documentElement: { getAttribute: () => 'dark' },
    createElement: element, createElementNS: element,
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, removeEventListener: noop,
};
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };

const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { PCB_EDITOR_SERVICES } = await import('../src/pcb/modules/pcb-editor-api.js');
const { importSpecifiers } = await import('../tools/check-imports.mjs');
const { privateEditorMembers } = await import('../tools/check-pcb-editor-access.mjs');
const { readFileSync } = await import('node:fs');

assert.equal(new Set(PCB_EDITOR_SERVICES).size, PCB_EDITOR_SERVICES.length);
for (const name of PCB_EDITOR_SERVICES) {
    assert.equal(typeof PCBApp.prototype[name], 'function', `PCBApp implements editor service ${name}`);
    assert.equal(PCBApp.prototype[`_${name}`], undefined, `No private alias _${name} remains`);
}
assert.deepEqual(importSpecifiers(readFileSync(new URL('../src/pcb/modules/pcb-editor-api.js', import.meta.url), 'utf8')), [],
    'The service list stays import-free');

assert.deepEqual(privateEditorMembers(`
    app._one(); app?._two; app.three; this._own; notapp._x;
    // app._commented
    /* app._blockCommented */
`), ['_one', '_two']);

console.log('PASS PCB editor services: implemented publicly, no private aliases, access scanner semantics');
