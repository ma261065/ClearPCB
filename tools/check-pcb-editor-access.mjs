#!/usr/bin/env node
// Ratchets pcb/modules' use of the PCB editor's private (`app._x`) members down.
//
// Modules should use the public services in src/pcb/modules/pcb-editor-api.js.
// tools/pcb-editor-access-baseline.json lists the private members each module still
// uses. A module using a private member not listed for it fails, and so does a listed
// member it no longer uses, so the baseline only shrinks. Modules always name the
// editor `app`; dynamic `app[key]` access is not tracked.
//
// Usage:
//   node tools/check-pcb-editor-access.mjs            check against the baseline
//   node tools/check-pcb-editor-access.mjs --update   rewrite the baseline (review the diff)

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pcbRoot = join(root, 'src', 'pcb');
const baselinePath = join(root, 'tools', 'pcb-editor-access-baseline.json');

const listJs = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listJs(full);
    return entry.name.endsWith('.js') ? [full] : [];
});

/** Private editor members referenced by one module's source. */
export function privateEditorMembers(source) {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    return [...new Set([...code.matchAll(/\bapp\??\.(_[A-Za-z]\w*)/g)].map(match => match[1]))].sort();
}

/** @returns {Record<string, string[]>} Module path -> private members, for modules that use any. */
export function currentAccess() {
    const access = {};
    for (const file of listJs(pcbRoot).sort()) {
        const members = privateEditorMembers(readFileSync(file, 'utf8'));
        if (members.length) access[relative(root, file).split(sep).join('/')] = members;
    }
    return access;
}

function main() {
    const current = currentAccess();
    if (process.argv.includes('--update')) {
        writeFileSync(baselinePath, JSON.stringify(current, null, 2) + '\n');
        const total = Object.values(current).reduce((sum, members) => sum + members.length, 0);
        console.log(`Wrote ${total} private access(es) in ${Object.keys(current).length} module(s) to tools/pcb-editor-access-baseline.json.`);
        return;
    }
    const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {};
    const added = [];
    const resolved = [];
    for (const file of new Set([...Object.keys(current), ...Object.keys(baseline)])) {
        const now = new Set(current[file] || []);
        const allowed = new Set(baseline[file] || []);
        for (const member of now) if (!allowed.has(member)) added.push(`${file}: app.${member}`);
        for (const member of allowed) if (!now.has(member)) resolved.push(`${file}: app.${member}`);
    }
    for (const line of added) console.error(`NEW      ${line}`);
    for (const line of resolved) console.error(`RESOLVED ${line}  (remove it from tools/pcb-editor-access-baseline.json)`);
    const total = Object.values(current).reduce((sum, members) => sum + members.length, 0);
    console.log(`PCB editor access: ${total} known private access(es), ${added.length} new, ${resolved.length} resolved.`);
    if (added.length) console.error('Use or add a public service in src/pcb/modules/pcb-editor-api.js instead.');
    process.exitCode = added.length || resolved.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
