import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const version = '1.0.0-alpha.4';
const root = new URL('../', import.meta.url);
const destination = new URL('assets/vendor/vtracer-NOTICES.txt', root);
const manifestPath = new URL('assets/vendor/vtracer-notice-sources.json', root);
const temporary = await mkdtemp(join(tmpdir(), 'clearpcb-vtracer-notices-'));
async function download(url) {
    const response = await fetch(url, { headers: { 'User-Agent': 'ClearPCB licence collector (https://github.com/ma261065/ClearPCB)' } });
    if (!response.ok) throw new Error(`${response.status}: ${url}`);
    return new Uint8Array(await response.arrayBuffer());
}
async function json(url) {
    return JSON.parse(new TextDecoder().decode(await download(url)));
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
let sources;
try {
    sources = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const lockPath = join(temporary, 'Cargo.lock');
    await writeFile(lockPath, await download(`https://raw.githubusercontent.com/visioncortex/vtracer/${version}/Cargo.lock`));
    const parser = 'import json,sys\ntry:\n import tomllib\nexcept ImportError:\n import pip._vendor.tomli as tomllib\nprint(json.dumps(tomllib.load(open(sys.argv[1], "rb"))["package"]))';
    const packages = JSON.parse(execFileSync('python', ['-c', parser, lockPath], { encoding: 'utf8' }));
    const selected = new Map();
    function include(reference) {
        const [name, requestedVersion] = reference.split(' ');
        const matches = packages.filter(item => item.name === name && (!requestedVersion || item.version === requestedVersion));
        if (matches.length !== 1) throw new Error(`Ambiguous lock dependency: ${reference}`);
        const entry = matches[0];
        const key = `${entry.name}@${entry.version}`;
        if (selected.has(key)) return;
        selected.set(key, { name: entry.name, version: entry.version, checksum: entry.checksum });
        for (const dependency of entry.dependencies ?? []) include(dependency);
    }
    for (const reference of ['visioncortex', 'flo_curves 0.8.0', 'image']) include(reference);
    const bindingSeeds = [
        ['wasm-bindgen', '0.2.126'], ['js-sys', '0.3.103'], ['serde-wasm-bindgen', '0.6.5'],
        ['serde', null], ['serde_derive', null],
    ];
    async function includeBinding(name, pinnedVersion) {
        const known = [...selected.values()].find(entry => entry.name === name && (!pinnedVersion || entry.version === pinnedVersion));
        if (known) return;
        const resolved = pinnedVersion ?? (await json(`https://crates.io/api/v1/crates/${name}`)).crate.max_stable_version;
        selected.set(`${name}@${resolved}`, { name, version: resolved });
        const { dependencies } = await json(`https://crates.io/api/v1/crates/${name}/${resolved}/dependencies`);
        for (const dependency of dependencies) {
            if (dependency.kind === 'dev' || dependency.optional) continue;
            await includeBinding(dependency.crate_id, dependency.req.startsWith('=') ? dependency.req.slice(1) : null);
        }
    }
    for (const [name, pinnedVersion] of bindingSeeds) await includeBinding(name, pinnedVersion);
    sources = { engine: version, provenance: 'Notice superset: tagged core lockfile, binary-identified binding versions, reconstructed binding transitives. Not an upstream WASM build lockfile.',
        crates: [...selected.values()].sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`)) };
}

const sections = [
    `VTracer ${version}: third-party licence notices`,
    sources.provenance,
    'The upstream npm archive omits its build lockfile. This collection conservatively includes core image dependencies and build-time crates, some of which may not be linked into the WASM. See vtracer-notice-sources.json for pinned sources and checksums.',
];
for (const [label, url] of [
    ['VTracer', `https://raw.githubusercontent.com/visioncortex/vtracer/${version}/LICENSE`],
    ['VTracer MIT licence', `https://raw.githubusercontent.com/visioncortex/vtracer/${version}/webapp/LICENSE-MIT`],
    ['VTracer Apache licence', `https://raw.githubusercontent.com/visioncortex/vtracer/${version}/webapp/LICENSE-APACHE`],
    ['Rust standard library copyright', 'https://raw.githubusercontent.com/rust-lang/rust/1.95.0/COPYRIGHT'],
    ['Rust MIT licence', 'https://raw.githubusercontent.com/rust-lang/rust/1.95.0/LICENSE-MIT'],
    ['Rust Apache licence', 'https://raw.githubusercontent.com/rust-lang/rust/1.95.0/LICENSE-APACHE'],
]) {
    sections.push(`${label}\nSource: ${url}\n\n${new TextDecoder().decode(await download(url))}`);
}
for (const entry of sources.crates) {
    const source = `https://static.crates.io/crates/${entry.name}/${entry.name}-${entry.version}.crate`;
    const bytes = await download(source);
    const checksum = sha256(bytes);
    if (entry.checksum && checksum !== entry.checksum) throw new Error(`Checksum mismatch: ${entry.name}`);
    entry.checksum = checksum;
    const archive = join(temporary, `${entry.name}-${entry.version}.crate`);
    await writeFile(archive, bytes);
    const metadata = await json(`https://crates.io/api/v1/crates/${entry.name}/${entry.version}`);
    entry.license = metadata.version.license;
    const files = execFileSync('tar', ['-tf', archive], { encoding: 'utf8' }).trim().split(/\r?\n/);
    const notices = files.filter(file => /\/(?:[^/]*license[^/]*|copying[^/]*|copyright[^/]*|notice[^/]*)$/i.test(file) && !file.endsWith('/'));
    if (!notices.length && entry.license === 'Apache-2.0') {
        notices.push(...files.filter(file => /\/(?:Cargo.toml.orig|README.md)$/.test(file)));
    }
    if (!notices.length) throw new Error(`No licence text in ${entry.name}-${entry.version}`);
    const texts = notices.map(file => `${file}\n\n${execFileSync('tar', ['-xOf', archive, file], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })}`);
    sections.push(`${entry.name} ${entry.version}\nDeclared licence: ${entry.license}\nSource: ${source}\nSHA-256: ${checksum}\n\n${texts.join('\n\n')}`);
    console.log(`${entry.name} ${entry.version}: ${entry.license}`);
}
await writeFile(manifestPath, `${JSON.stringify(sources, null, 2)}\n`);
await writeFile(destination, `${sections.join('\n\n============================================================\n\n')}\n`);
console.log(`Collected ${sources.crates.length} crate notice sets.`);