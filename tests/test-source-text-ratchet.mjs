/**
 * Ratchet for tests that evaluate sliced source text with `new Function`. Such tests
 * break on refactors and check text rather than behaviour; call the real function
 * instead (see pcb-editor-fixture.mjs). New ones fail here, and a listed test that
 * no longer slices source must be removed from the list, so it only shrinks.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const ALLOWED = new Set([
    'test-board3d-artwork-cache.mjs',
    'test-board3d-mask-cache.mjs',
    'test-board3d-surface-reuse.mjs',
    'test-board3d-surface-worker.mjs',
    'test-board-view-sync.mjs',
    'test-bootstrap-tab-readiness.mjs',
    'test-builtin-package-lifecycle.mjs',
    'test-component-index-lifecycle.mjs',
    'test-document-layers.mjs',
    'test-node-connection-locality.mjs',
    'test-pcb-deferred-load.mjs',
    'test-pcb-paste-preview-isolation.mjs',
    'test-pcb-selection-layer-locks.mjs',
    'test-reference-selection-overlay.mjs',
    'test-track-terminology.mjs',
]);

const testsDir = new URL('./', import.meta.url);
const slicing = readdirSync(testsDir)
    .filter(name => /^test-.*\.mjs$/.test(name) && name !== 'test-source-text-ratchet.mjs')
    .filter(name => {
        const text = readFileSync(new URL(name, testsDir), 'utf8');
        return /new Function\(/.test(text) && /readFileSync\(/.test(text);
    });
const added = slicing.filter(name => !ALLOWED.has(name));
const converted = [...ALLOWED].filter(name => !slicing.includes(name));
assert.deepEqual(added, [], 'new tests must call real functions instead of evaluating sliced source');
assert.deepEqual(converted, [], 'remove converted tests from ALLOWED so the ratchet only shrinks');

console.log(`PASS source-text ratchet: ${slicing.length} legacy tests still evaluate sliced source; no new ones`);
