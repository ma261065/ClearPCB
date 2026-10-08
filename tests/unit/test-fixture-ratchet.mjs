/**
 * Tests build their DOM with tests/unit/helpers/fake-dom.mjs and their PCB editor with
 * tests/unit/pcb-editor-fixture.mjs, not a hand-rolled `globalThis.document` stub, which
 * drifts from the code and lets tests pass or fail for the wrong reason. Test-specific
 * behaviour goes on top of the installed fake. The only exceptions are listed, with why.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const EXCEPTIONS = new Map([
    ['test-schematic-module-load-order.mjs',
        'loads each module first in a bare child process, under a catch-all proxy that tolerates any DOM access'],
]);

const testsDir = new URL('./', import.meta.url);
const handRolled = readdirSync(testsDir)
    .filter(name => /^test-.*\.mjs$/.test(name))
    .filter(name => /globalThis\.document\s*(\?\?)?=/.test(readFileSync(new URL(name, testsDir), 'utf8')));

assert.deepEqual(handRolled.filter(name => !EXCEPTIONS.has(name)), [],
    'These tests hand-roll globalThis.document: use installFakeDom() from tests/unit/helpers/fake-dom.mjs');
for (const name of EXCEPTIONS.keys()) {
    assert.ok(handRolled.includes(name), `${name} no longer hand-rolls a DOM: remove its exception`);
}

console.log(`PASS fixture rule: no test hand-rolls a DOM (${EXCEPTIONS.size} listed exception)`);
