#!/usr/bin/env node
// Enforces the import-direction rules in docs/project_structure.md.
//
//   shared    (core, shapes, components, shared, easyeda) must not import either editor.
//   schematic (schematic/, ui/SchematicApp.js, ui/modules/) must not import PCB code.
//   pcb       (pcb/, ui/PCBApp.js) must not import schematic code.
//   bootstrap (ui/AppBootstrap.js) may import anything.
//
// Existing violations are listed in tools/import-baseline.json. New violations fail,
// and so do baseline entries that no longer occur, so the baseline only shrinks.
//
// Usage:
//   node tools/check-imports.mjs            check against the baseline
//   node tools/check-imports.mjs --update   rewrite the baseline (review the diff)

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const srcRoot = join(root, 'src');
const baselinePath = join(root, 'tools', 'import-baseline.json');

const FORBIDDEN = {
    shared: new Set(['pcb', 'schematic', 'bootstrap']),
    schematic: new Set(['pcb', 'bootstrap']),
    pcb: new Set(['schematic', 'bootstrap']),
    bootstrap: new Set(),
};

/** @param {string} path repo-relative, forward slashes */
export function layerOf(path) {
    if (!path.startsWith('src/')) return null;
    const rest = path.slice(4);
    if (rest === 'ui/AppBootstrap.js') return 'bootstrap';
    if (rest === 'ui/PCBApp.js' || rest.startsWith('pcb/')) return 'pcb';
    if (rest === 'ui/SchematicApp.js' || rest.startsWith('ui/') || rest.startsWith('schematic/')) return 'schematic';
    return 'shared';
}

/** Module specifiers from static, re-export, side-effect and literal dynamic imports. */
export function importSpecifiers(source) {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const specs = [];
    const patterns = [
        /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
        /\bimport\s*['"]([^'"]+)['"]/g,
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    for (const pattern of patterns) {
        for (const match of code.matchAll(pattern)) specs.push(match[1]);
    }
    return specs;
}

function listJs(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return listJs(full);
        return entry.name.endsWith('.js') ? [full] : [];
    });
}

const repoPath = absolute => relative(root, absolute).split(sep).join('/');

export function findViolations() {
    const violations = [];
    for (const file of listJs(srcRoot)) {
        const from = repoPath(file);
        const fromLayer = layerOf(from);
        for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
            if (!spec.startsWith('.')) continue;
            const to = repoPath(resolve(dirname(file), spec));
            const toLayer = layerOf(to);
            if (toLayer && FORBIDDEN[fromLayer].has(toLayer)) {
                violations.push(`${from} -> ${to}`);
            }
        }
    }
    return [...new Set(violations)].sort();
}

function main() {
    const current = findViolations();
    if (process.argv.includes('--update')) {
        writeFileSync(baselinePath, JSON.stringify(current, null, 2) + '\n');
        console.log(`Wrote ${current.length} baseline violation(s) to ${repoPath(baselinePath)}.`);
        return;
    }
    const baseline = new Set(existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : []);
    const added = current.filter(edge => !baseline.has(edge));
    const resolved = [...baseline].filter(edge => !current.includes(edge));
    for (const edge of added) console.error(`NEW      ${edge}`);
    for (const edge of resolved) console.error(`RESOLVED ${edge}  (remove it from tools/import-baseline.json)`);
    console.log(`Import boundaries: ${current.length} known violation(s), ${added.length} new, ${resolved.length} resolved.`);
    if (added.length) console.error('New imports cross a documented boundary; see docs/project_structure.md.');
    process.exitCode = added.length || resolved.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
