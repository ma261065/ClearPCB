import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = fileURLToPath(new URL('../tests/unit/', import.meta.url));
const requested = process.argv.slice(2);
const files = readdirSync(tests).filter((name) => /^test-.*\.mjs$/.test(name))
    .filter((name) => !requested.length || requested.some((pattern) => name.includes(pattern))).sort();
if (!files.length) throw new Error('No matching regression files.');
// A test that passes while printing one of these was saved by a handler that caught and
// logged a programming error (usually a fixture missing what the real editor has).
// A test that means to exercise such a path replaces console.error for that step.
const SWALLOWED_ERROR = /\b(TypeError|ReferenceError|SyntaxError|RangeError)\b/;
const failed = [];
for (const file of files) {
    console.log(`\n=== ${file} ===`);
    const result = spawnSync(process.execPath, [join(tests, file)], {
        cwd: root, stdio: ['inherit', 'inherit', 'pipe'], encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
    });
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) {
        failed.push(file);
    } else if (SWALLOWED_ERROR.test(result.stderr || '')) {
        const line = (result.stderr || '').split('\n').find(text => SWALLOWED_ERROR.test(text));
        console.error(`${file} passed but printed a swallowed error: ${line?.trim()}`);
        failed.push(file);
    }
}
console.log(`\n${files.length - failed.length}/${files.length} regression files passed.`);
if (failed.length) console.error(`Failed: ${failed.join(', ')}`);
process.exitCode = failed.length ? 1 : 0;
