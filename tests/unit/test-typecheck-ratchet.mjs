import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { cleanFolderErrors, parseDiagnostics } = await import('../../tools/typecheck.mjs');

// tools/typecheck.mjs counts tsc errors per file, and fails any error in a folder its
// strict baseline lists as clean.
const output = [
    "src/easyeda/a.js(1,2): error TS7006: Parameter 'x' implicitly has an 'any' type.",
    "src/easyeda/a.js(3,4): error TS2339: Property 'y' does not exist on type '{}'.",
    "src/easyedax/b.js(1,1): error TS7006: Parameter 'z' implicitly has an 'any' type.",
    'src/shared/3d/c.js(9,9): error TS2532: Object is possibly undefined.',
    '  continuation line',
].join('\n');
const { files, codes, total, global } = parseDiagnostics(output);
assert.equal(total, 4);
assert.deepEqual([...files], [['src/easyeda/a.js', 2], ['src/easyedax/b.js', 1], ['src/shared/3d/c.js', 1]]);
assert.deepEqual(codes.get('TS7006'), 2);
assert.deepEqual(global, []);

assert.deepEqual(cleanFolderErrors(files, ['src/easyeda']).map(([file]) => file), ['src/easyeda/a.js'],
    'a clean folder covers its own files, not a folder whose name merely starts the same');
assert.deepEqual(cleanFolderErrors(files, ['src/shared/3d/']).map(([file]) => file), ['src/shared/3d/c.js']);
assert.deepEqual(cleanFolderErrors(files), []);

// The strict pass extends the everyday settings with the two checks being adopted.
const strict = JSON.parse(readFileSync(new URL('../../jsconfig.strict.json', import.meta.url), 'utf8'));
assert.equal(strict.extends, './jsconfig.json');
assert.deepEqual(strict.compilerOptions, { noImplicitAny: true, strictNullChecks: true });
const baseline = JSON.parse(readFileSync(new URL('../../tools/typecheck-strict-baseline.json', import.meta.url), 'utf8'));
for (const folder of baseline.cleanFolders) {
    assert.deepEqual(Object.keys(baseline.files).filter(file => file.startsWith(`${folder}/`)), [],
        `the strict baseline allows no errors in the clean folder ${folder}`);
}

console.log('PASS type check ratchet: per-file counts and clean folders');
