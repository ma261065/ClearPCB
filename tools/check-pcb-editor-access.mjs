#!/usr/bin/env node
// Ratchets PCB code's use of the PCB editor's private (`app._x`) members down.
//
// Modules should use the public services in src/pcb/modules/pcb-editor-api.js.
// tools/pcb-editor-access-baseline.json lists the private members each module still
// uses. A module using a private member not listed for it fails, and so does a listed
// member it no longer uses, so the baseline only shrinks. Scans src/pcb and the shared
// PCB code in src/shared/pcb. Modules always name the editor `app`; dynamic `app[key]`
// access is not tracked.
//
// Usage:
//   node tools/check-pcb-editor-access.mjs            check against the baseline
//   node tools/check-pcb-editor-access.mjs --update   rewrite the baseline (review the diff)

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const scanRoots = [join(root, 'src', 'pcb'), join(root, 'src', 'shared', 'pcb')];
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

/**
 * Ways to reach editor internals that the `app._x` scan cannot see. Modules must
 * not become editor methods (prototype mixins, `fn.call(app)`), so `this._x` in a
 * module cannot stand in for `app._x`, and must not install accessors on the
 * editor that disguise moved state as the old private field.
 */
const LOOPHOLES = [
    { pattern: /\b(?:assign|defineProperties|defineProperty)\(\s*\w+\.prototype\b/, why: 'mixes members into a class prototype' },
    { pattern: /\b__(?:lookup|define)[GS]etter__\b/, why: 'uses a legacy accessor lookup' },
    { pattern: /\bdefineProperty\(\s*(?:app|editor|this)\b/, why: 'installs an accessor on the editor' },
    { pattern: /\.(?:call|apply|bind)\(\s*(?:app|editor)\b/, why: 'runs module code with the editor as `this`' },
];

/** Loophole uses in one source file, as `line: reason` strings. */
export function editorAccessLoopholes(source) {
    const found = [];
    source.split('\n').forEach((line, index) => {
        if (/^\s*(?:\/\/|\*)/.test(line)) return;
        for (const { pattern, why } of LOOPHOLES) {
            if (pattern.test(line)) found.push(`${index + 1}: ${why}`);
        }
    });
    return found;
}

/**
 * @param {string[]} [roots] Directories to scan (default: the PCB scope).
 * @returns {Record<string, string[]>} Module path -> private members, for modules that use any.
 */
export function currentAccess(roots = scanRoots) {
    const access = {};
    for (const file of roots.flatMap(listJs).sort()) {
        const members = privateEditorMembers(readFileSync(file, 'utf8'));
        if (members.length) access[relative(root, file).split(sep).join('/')] = members;
    }
    return access;
}

/**
 * Check (or with --update rewrite) one editor's private-access baseline.
 * @param {{label: string, roots: string[], facade: string, baselinePath: string, hint: string}} scope
 */
export function runEditorAccessCheck({ label, roots, facade, baselinePath, hint }) {
    const baselineName = relative(root, baselinePath).split(sep).join('/');
    const loopholes = [...roots.flatMap(listJs), facade].sort().flatMap(file =>
        editorAccessLoopholes(readFileSync(file, 'utf8'))
            .map(entry => `${relative(root, file).split(sep).join('/')}:${entry}`));
    for (const line of loopholes) console.error(`LOOPHOLE ${line}`);
    if (loopholes.length) {
        console.error('Move the state or behaviour into its owning module instead; see State Ownership in docs/project_structure.md.');
        process.exitCode = 1;
        return;
    }
    const current = currentAccess(roots);
    if (process.argv.includes('--update')) {
        writeFileSync(baselinePath, JSON.stringify(current, null, 2) + '\n');
        const total = Object.values(current).reduce((sum, members) => sum + members.length, 0);
        console.log(`Wrote ${total} private access(es) in ${Object.keys(current).length} module(s) to ${baselineName}.`);
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
    for (const line of resolved) console.error(`RESOLVED ${line}  (remove it from ${baselineName})`);
    const total = Object.values(current).reduce((sum, members) => sum + members.length, 0);
    console.log(`${label} editor access: ${total} known private access(es), ${added.length} new, ${resolved.length} resolved.`);
    if (added.length) console.error(hint);
    process.exitCode = added.length || resolved.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runEditorAccessCheck({
        label: 'PCB', roots: scanRoots, facade: join(root, 'src', 'ui', 'PCBApp.js'), baselinePath,
        hint: 'Use or add a public service in src/pcb/modules/pcb-editor-api.js instead.',
    });
}
