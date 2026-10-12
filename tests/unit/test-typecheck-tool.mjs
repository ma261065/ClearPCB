import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { ignoredJsDocBlocks, parseDiagnostics } = await import('../../tools/typecheck.mjs');

const output = [
    "src/easyeda/a.js(1,2): error TS7006: Parameter 'x' implicitly has an 'any' type.",
    "src/easyeda/a.js(3,4): error TS2339: Property 'y' does not exist on type '{}'.",
    "src/easyedax/b.js(1,1): error TS7006: Parameter 'z' implicitly has an 'any' type.",
    'src/shared/3d/c.js(9,9): error TS2532: Object is possibly undefined.',
    'error TS5058: The specified path does not exist: missing.json.',
    '  continuation line',
].join('\n');
const { files, codes, total, global } = parseDiagnostics(output);
assert.equal(total, 4);
assert.deepEqual([...files], [['src/easyeda/a.js', 2], ['src/easyedax/b.js', 1], ['src/shared/3d/c.js', 1]]);
assert.deepEqual(codes.get('TS7006'), 2);
assert.deepEqual(global, ['error TS5058: The specified path does not exist: missing.json.']);

const ignoredBlock = { tags: [{ tagName: { text: 'param' } }], getStart: () => 4 };
const nearestBlock = { tags: [{ tagName: { text: 'returns' } }], getStart: () => 8 };
const typedefBlock = { tags: [{ tagName: { text: 'typedef' } }], getStart: () => 12 };
const source = {
    jsDoc: [ignoredBlock, nearestBlock, typedefBlock],
    children: [],
    getLineAndCharacterOfPosition: position => ({ line: position }),
};
const fakeTs = {
    ScriptTarget: { Latest: 0 },
    ScriptKind: { JS: 0 },
    createSourceFile: () => source,
    forEachChild: (node, visit) => { for (const child of node.children || []) visit(child); },
};
assert.deepEqual(ignoredJsDocBlocks(fakeTs, 'sample.js', ''), [5]);

const config = JSON.parse(readFileSync(new URL('../../jsconfig.json', import.meta.url), 'utf8'));
assert.equal(config.compilerOptions.checkJs, true);
assert.equal(config.compilerOptions.strict, true);
assert.equal(Object.hasOwn(config.compilerOptions, 'noImplicitAny'), false);
assert.deepEqual(config.include, ['src/**/*.js']);

console.log('PASS typecheck tool: diagnostics, ignored JSDoc blocks and strict config');
