import { cp, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const tag = process.argv[2];
if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag || '')) {
    throw new Error('Expected a stable release tag such as v1.0.0.');
}
const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
await mkdir(output);
for (const name of ['index.html', 'manifest.json', 'sw.js', 'CNAME', 'assets', 'src', 'workers']) {
    await cp(new URL(name, root), new URL(name, output), { recursive: true, errorOnExist: true, force: false });
}
await writeFile(new URL('assets/version.json', output), `${JSON.stringify({ version: tag.slice(1) }, null, 2)}\n`);
await writeFile(new URL('.nojekyll', output), '');
console.log(`Packaged ${tag} at ${fileURLToPath(output)}`);