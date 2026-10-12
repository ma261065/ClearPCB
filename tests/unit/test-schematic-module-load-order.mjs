import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Schematic modules import each other directly, so an import cycle that reads a binding
// while modules are still evaluating would throw only for some load orders. Load every
// module first, on its own, in a fresh process.
const dir = new URL('../../src/schematic/', import.meta.url);
const modules = ['modules', 'render'].flatMap(sub => readdirSync(new URL(`${sub}/`, dir))
    .filter(name => name.endsWith('.js')).map(name => new URL(`${sub}/${name}`, dir).href));
const loader = `
const noop = () => {};
const stub = () => new Proxy(function () {}, { get: (_, key) => key === Symbol.toPrimitive ? () => '' : stub(),
    apply: () => stub(), construct: () => stub() });
globalThis.window = { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }) };
globalThis.document = stub();
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
await import(process.argv[1]);`;
const failures = [];
for (const url of modules) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', loader, url], { encoding: 'utf8' });
    if (result.status !== 0) failures.push(`${url.split('/src/')[1]}: ${([...result.stderr.matchAll(/\w*Error: .*/g)].pop() || [result.stderr])[0]}`);
}
assert.deepEqual(failures, [], 'Every schematic module loads first without import-order errors');
assert.ok(modules.length > 20);
console.log(`PASS: ${modules.length} schematic modules each load first in a fresh process`);
