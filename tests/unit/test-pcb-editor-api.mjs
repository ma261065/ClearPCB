import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';

const noop = () => {};
installFakeDom();
globalThis.window.devicePixelRatio = 1;
globalThis.localStorage.setItem = noop;

const { default: PCBApp } = await import('../../src/ui/PCBApp.js');
const { PCB_EDITOR_SERVICES } = await import('../../src/pcb/modules/pcb-editor-api.js');
const { importSpecifiers } = await import('../../tools/check-imports.mjs');
const { privateEditorMembers } = await import('../../tools/check-pcb-editor-access.mjs');
const { readFileSync } = await import('node:fs');

assert.equal(new Set(PCB_EDITOR_SERVICES).size, PCB_EDITOR_SERVICES.length);
for (const name of PCB_EDITOR_SERVICES) {
    assert.equal(typeof PCBApp.prototype[name], 'function', `PCBApp implements editor service ${name}`);
    assert.equal(PCBApp.prototype[`_${name}`], undefined, `No private alias _${name} remains`);
}
assert.deepEqual(importSpecifiers(readFileSync(new URL('../../src/pcb/modules/pcb-editor-api.js', import.meta.url), 'utf8')), [],
    'The service list stays import-free');

assert.deepEqual(privateEditorMembers(`
    app._one(); app?._two; app.three; this._own; notapp._x;
    // app._commented
    /* app._blockCommented */
`), ['_one', '_two']);
assert.deepEqual(privateEditorMembers(`
    app._one; editor?._two(); host._three; this._own;
`, ['app', 'editor', 'host']), ['_one', '_three', '_two']);

const { editorAccessLoopholes } = await import('../../tools/check-pcb-editor-access.mjs');
assert.deepEqual(editorAccessLoopholes([
    'Object.defineProperties(PCBApp.prototype, Object.getOwnPropertyDescriptors(MIXIN));',
    'Object.assign(PCBApp.prototype, helpers);',
    'get _x() { return MIXIN.__lookupGetter__("_x").call(this); }',
    'Object.defineProperty(app, key, { get() { return state[key]; } });',
    'return helper.call(app, value);',
    '// Object.assign(PCBApp.prototype, commentedOut);',
    'Object.defineProperty(window, "x", {}); fn.call(this); app._kept();',
].join('\n')), [
    '1: mixes members into a class prototype',
    '2: mixes members into a class prototype',
    '3: uses a legacy accessor lookup',
    '4: installs an accessor on the editor',
    '5: runs module code with the editor as `this`',
], 'Disguised editor access is reported; ordinary code and comments are not');

// The editor always implements its methods, so `app.method?.()` only hides a broken
// fake or a typo. Optional calls remain for members that may be absent (nullable fields).
const { readdirSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const { join, relative } = await import('node:path');
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const listJs = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? listJs(join(dir, entry.name)) : entry.name.endsWith('.js') ? [join(dir, entry.name)] : []);
const editorMethods = new Set(Object.getOwnPropertyNames(PCBApp.prototype)
    .filter(name => typeof Object.getOwnPropertyDescriptor(PCBApp.prototype, name)?.value === 'function'));
const optionalMethodCalls = [join(repoRoot, 'src', 'pcb'), join(repoRoot, 'src', 'shared', 'pcb')].flatMap(listJs).flatMap(file =>
    [...readFileSync(file, 'utf8').matchAll(/\bapp\.(\w+)\?\.\(/g)]
        .filter(match => editorMethods.has(match[1]))
        .map(match => `${relative(repoRoot, file)}: app.${match[1]}?.()`));
assert.deepEqual(optionalMethodCalls, [], 'PCB modules call editor methods directly');

console.log('PASS PCB editor services: implemented publicly, no private aliases, access scanner semantics, loopholes, direct method calls');
