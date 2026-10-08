import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const noop = () => {};
globalThis.window = { addEventListener: noop, removeEventListener: noop };
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };

const { default: SchematicApp } = await import('../../src/ui/SchematicApp.js');
const { SCHEMATIC_EDITOR_SERVICES } = await import('../../src/schematic/modules/schematic-editor-api.js');
const { PCB_EDITOR_SERVICES } = await import('../../src/pcb/modules/pcb-editor-api.js');
const { importSpecifiers } = await import('../../tools/check-imports.mjs');

assert.equal(new Set(SCHEMATIC_EDITOR_SERVICES).size, SCHEMATIC_EDITOR_SERVICES.length);
for (const name of SCHEMATIC_EDITOR_SERVICES) {
    assert.equal(typeof SchematicApp.prototype[name], 'function', `SchematicApp implements editor service ${name}`);
    assert.equal(SchematicApp.prototype[`_${name}`], undefined, `No private alias _${name} remains`);
}
assert.deepEqual(importSpecifiers(readFileSync(new URL('../../src/schematic/modules/schematic-editor-api.js', import.meta.url), 'utf8')), [],
    'The service list stays import-free');

// A service both editors offer has one name in both.
const shared = SCHEMATIC_EDITOR_SERVICES.filter(name => PCB_EDITOR_SERVICES.includes(name));
for (const name of ['fitToContent', 'setActiveRibbonTab']) {
    assert.ok(shared.includes(name), `${name} is a service of both editors`);
}

// The editor always implements its methods, so `app.method?.()` only hides a broken
// fake or a typo. Optional calls remain for members that may be absent.
const { readdirSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const { join, relative } = await import('node:path');
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const listJs = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? listJs(join(dir, entry.name)) : entry.name.endsWith('.js') ? [join(dir, entry.name)] : []);
const editorMethods = new Set(Object.getOwnPropertyNames(SchematicApp.prototype)
    .filter(name => typeof Object.getOwnPropertyDescriptor(SchematicApp.prototype, name)?.value === 'function'));
const optionalMethodCalls = listJs(join(repoRoot, 'src', 'schematic')).flatMap(file =>
    [...readFileSync(file, 'utf8').matchAll(/\bapp\.(\w+)\?\.\(/g)]
        .filter(match => editorMethods.has(match[1]))
        .map(match => `${relative(repoRoot, file)}: app.${match[1]}?.()`));
assert.deepEqual(optionalMethodCalls, [], 'Schematic modules call editor methods directly');

console.log(`PASS schematic editor services: ${SCHEMATIC_EDITOR_SERVICES.length} implemented publicly, no private aliases, direct method calls`);
