/**
 * Ratchet: tests should build their DOM with tests/helpers/fake-dom.mjs and their
 * PCB editor with tests/pcb-editor-fixture.mjs, not hand-roll `globalThis.document`
 * stubs, which drift from the code and let tests pass or fail for the wrong reason.
 * The count of hand-rolled stubs may only go down; lower BASELINE when it does.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const BASELINE = 168;

const testsDir = new URL('./', import.meta.url);
const handRolled = readdirSync(testsDir)
    .filter(name => /^test-.*\.mjs$/.test(name))
    .filter(name => /globalThis\.document\s*(\?\?)?=/.test(readFileSync(new URL(name, testsDir), 'utf8')));

assert.ok(handRolled.length <= BASELINE,
    `${handRolled.length} tests hand-roll globalThis.document (baseline ${BASELINE}): use installFakeDom() from tests/helpers/fake-dom.mjs`);
assert.equal(handRolled.length, BASELINE,
    `Hand-rolled DOM stubs fell to ${handRolled.length}: lower BASELINE in test-fixture-ratchet.mjs`);

console.log(`PASS fixture ratchet: ${handRolled.length} tests still hand-roll a DOM (only goes down)`);
