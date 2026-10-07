/**
 * Guard against tests that evaluate sliced source text with `new Function`. Such
 * tests break on refactors and check text rather than behaviour; call the real
 * function instead (see pcb-editor-fixture.mjs), adding a small seam only when a
 * collaborator must be observed. The legacy list this ratchet tracked is now empty.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const testsDir = new URL('./', import.meta.url);
const slicing = readdirSync(testsDir)
    .filter(name => /^test-.*\.mjs$/.test(name) && name !== 'test-source-text-ratchet.mjs')
    .filter(name => {
        const text = readFileSync(new URL(name, testsDir), 'utf8');
        return /new Function\(/.test(text) && /readFileSync\(/.test(text);
    });
assert.deepEqual(slicing, [], 'tests must call real functions instead of evaluating sliced source');

console.log('PASS source-text guard: no test evaluates sliced source');
