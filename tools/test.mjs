import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const requested = process.argv.slice(2);
const files = readdirSync(root).filter((name) => /^test-.*\.mjs$/.test(name))
    .filter((name) => !requested.length || requested.some((pattern) => name.includes(pattern))).sort();
if (!files.length) throw new Error('No matching regression files.');
const failed = [];
for (const file of files) {
    console.log(`\n=== ${file} ===`);
    const result = spawnSync(process.execPath, [file], { cwd: root, stdio: 'inherit' });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) failed.push(file);
}
console.log(`\n${files.length - failed.length}/${files.length} regression files passed.`);
if (failed.length) console.error(`Failed: ${failed.join(', ')}`);
process.exitCode = failed.length ? 1 : 0;