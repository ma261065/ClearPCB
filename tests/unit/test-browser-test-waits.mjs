/**
 * Browser-test hygiene: page.waitForFunction does not await a promise its predicate
 * returns, so an async predicate (or one that imports an app module) passes at once
 * and the scenario races ahead. Such waits must use waitForPage() from
 * tests/browser/helpers/editor-helpers.mjs, which polls page.evaluate.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASYNC_PREDICATE = /waitForFunction\(\s*(?:async\b|\([^)]*\)\s*=>\s*(?:import\(|[^\n;]*\.then\())/g;

/** @param {string} source */
export function asyncWaitForFunctionCalls(source) {
    return [...source.matchAll(ASYNC_PREDICATE)].map(match => source.slice(0, match.index).split('\n').length);
}

assert.deepEqual(asyncWaitForFunctionCalls('await page.waitForFunction(async () => !!(await import("/a.js")).x);'), [1]);
assert.deepEqual(asyncWaitForFunctionCalls('await page.waitForFunction(() => import("/a.js")\n    .then(m => m.ok));'), [1]);
assert.deepEqual(asyncWaitForFunctionCalls('x;\nawait page.waitForFunction(() => window.ready.then(Boolean));'), [2]);
assert.deepEqual(asyncWaitForFunctionCalls('await page.waitForFunction(() => window.bootstrap?.ready);'), []);
assert.deepEqual(asyncWaitForFunctionCalls('await page.waitForFunction(text => JSON.stringify(x) === text, expected);'), []);

const root = fileURLToPath(new URL('../browser/', import.meta.url));
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.mjs') ? [join(dir, entry.name)] : []);
const offenders = files(root).flatMap(file =>
    asyncWaitForFunctionCalls(readFileSync(file, 'utf8')).map(line => `${file.slice(root.length)}:${line}`));
assert.deepEqual(offenders, [], 'Async predicates passed to page.waitForFunction pass at once: use waitForPage()');

console.log('PASS browser-test waits: no async predicate is passed to page.waitForFunction');
