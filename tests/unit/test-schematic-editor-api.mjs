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

console.log(`PASS schematic editor services: ${SCHEMATIC_EDITOR_SERVICES.length} implemented publicly, no private aliases`);
