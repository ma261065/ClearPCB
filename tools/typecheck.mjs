#!/usr/bin/env node
// Type-checks src/ in two passes and summarises the errors:
//   - jsconfig.json, the everyday settings; its baseline is empty, so any error fails;
//   - jsconfig.strict.json, which adds noImplicitAny and strictNullChecks. The code is
//     being moved onto it gradually: its baseline holds each file's current error count,
//     and folders already clean are listed in its cleanFolders.
// Each pass ratchets against its baseline: a file whose error count rises, a new file
// with errors, or any error in a clean folder fails. Without a baseline a pass only
// reports. Before both, it fails on a declaration whose JSDoc tags sit in a block other
// than the one nearest it: TypeScript reads only that block, so the others' types are
// silently ignored.
// TypeScript is not vendored. Install the pinned version into the repo's git-ignored
// node_modules, as CI does (see .github/workflows/regression.yml):
//   npm install --no-save --no-package-lock --ignore-scripts typescript@5.9.3
//
// Usage:
//   node tools/typecheck.mjs                    report, or check against the baseline
//   node tools/typecheck.mjs --write-baseline   record current per-file counts (cleanFolders is kept)
//   node tools/typecheck.mjs --strict-only      run only the strict pass
//
// Set TSC=/path/to/tsc.js to use a specific compiler.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const PASSES = [
    { name: 'Type check', config: 'jsconfig.json', baseline: 'tools/typecheck-baseline.json' },
    { name: 'Strict type check', config: 'jsconfig.strict.json', baseline: 'tools/typecheck-strict-baseline.json', strict: true },
];
const ERROR_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): /;
const GLOBAL_ERROR = /^error (TS\d+): /;

function locateTsc() {
    if (process.env.TSC) return process.env.TSC;
    try {
        return createRequire(join(root, 'package.json')).resolve('typescript/lib/tsc.js');
    } catch {
        return null;
    }
}

function tscVersion(tsc) {
    try {
        return JSON.parse(readFileSync(join(dirname(tsc), '..', 'package.json'), 'utf8')).version || 'unknown';
    } catch {
        return 'unknown';
    }
}

/** @returns {{files: Map<string, number>, codes: Map<string, number>, total: number, global: string[]}} */
export function parseDiagnostics(output) {
    const files = new Map();
    const codes = new Map();
    const global = [];
    let total = 0;
    for (const line of output.split(/\r?\n/)) {
        const match = ERROR_LINE.exec(line);
        if (match) {
            const file = relative(root, join(root, match[1])).split(sep).join('/');
            files.set(file, (files.get(file) || 0) + 1);
            codes.set(match[4], (codes.get(match[4]) || 0) + 1);
            total++;
        } else if (GLOBAL_ERROR.test(line)) {
            global.push(line);
        }
    }
    return { files, codes, total, global };
}

const top = (map, count) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, count);

function summary(name, { files, codes, total }, version) {
    const lines = [`### ${name} (TypeScript ${version})`, '',
        `${total} error(s) in ${files.size} file(s).`, ''];
    if (files.size) {
        lines.push('| Errors | File |', '| ---: | --- |', ...top(files, 20).map(([file, n]) => `| ${n} | ${file} |`), '');
        lines.push('| Errors | Code |', '| ---: | --- |', ...top(codes, 10).map(([code, n]) => `| ${n} | ${code} |`), '');
    }
    return lines.join('\n');
}

/** The files with errors in each clean folder; they must have none. */
export function cleanFolderErrors(files, cleanFolders = []) {
    return [...files].filter(([file]) => cleanFolders.some(folder => file.startsWith(folder.replace(/\/?$/, '/'))));
}

/**
 * Declarations in `text` with JSDoc tags in a block TypeScript ignores (any block but the
 * one nearest the declaration). Typedef and callback blocks declare types of their own.
 * @param {any} ts The TypeScript module.
 * @returns {number[]} 1-based line numbers of the ignored blocks.
 */
export function ignoredJsDocBlocks(ts, fileName, text) {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const lines = [];
    const visit = node => {
        const blocks = (node.jsDoc || []).filter(block => !(block.tags || [])
            .some(tag => ['typedef', 'callback'].includes(tag.tagName.text)));
        for (const block of blocks.slice(0, -1)) {
            if (block.tags?.length) lines.push(source.getLineAndCharacterOfPosition(block.getStart()).line + 1);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return lines;
}

/** Fail on ignored JSDoc blocks anywhere in src/; returns 0 or 1. */
function checkJsDocBlocks(tsc) {
    const ts = createRequire(tsc)('./typescript.js');
    const found = [];
    const walk = dir => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) walk(path);
            else if (name.endsWith('.js')) {
                for (const line of ignoredJsDocBlocks(ts, path, readFileSync(path, 'utf8'))) {
                    found.push(`${relative(root, path).split(sep).join('/')}:${line}`);
                }
            }
        }
    };
    walk(join(root, 'src'));
    for (const where of found) console.error(`IGNORED JSDOC ${where}: merge its tags into the block nearest the declaration`);
    return found.length ? 1 : 0;
}

/** Run one pass; returns 0 (ok), 1 (regressed) or 2 (could not run). */
function runPass(tsc, version, pass) {
    const run = spawnSync(process.execPath, [tsc, '-p', pass.config, '--noEmit', '--pretty', 'false'], {
        cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    });
    // tsc exits 0 (clean), 1 or 2 (diagnostics present); anything else is a crash.
    if (run.error || ![0, 1, 2].includes(run.status)) {
        console.error(run.error?.message || run.stderr || `tsc exited with ${run.status}`);
        return 2;
    }
    const result = parseDiagnostics(run.stdout);
    if (result.global.length) {
        console.error('Compiler configuration errors:\n' + result.global.join('\n'));
        return 2;
    }
    const report = summary(pass.name, result, version);
    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');

    const baselinePath = join(root, pass.baseline);
    const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
    if (process.argv.includes('--write-baseline')) {
        const files = Object.fromEntries([...result.files].sort((a, b) => a[0].localeCompare(b[0])));
        const cleanFolders = baseline?.cleanFolders ? { cleanFolders: baseline.cleanFolders } : {};
        writeFileSync(baselinePath, JSON.stringify({ typescript: version, total: result.total, ...cleanFolders, files }, null, 2) + '\n');
        console.log(`Wrote baseline for ${result.files.size} file(s) to ${pass.baseline}.`);
    } else if (!baseline) {
        console.log(`No ${pass.baseline}: report only.`);
        return 0;
    }
    const current = process.argv.includes('--write-baseline') ? JSON.parse(readFileSync(baselinePath, 'utf8')) : baseline;
    if (current.typescript !== version) {
        console.warn(`Baseline was recorded with TypeScript ${current.typescript}; running ${version}.`);
    }
    const regressions = [];
    const improvements = [];
    for (const [file, count] of result.files) {
        const allowed = current.files[file] || 0;
        if (count > allowed) regressions.push(`${file}: ${allowed} -> ${count}`);
    }
    for (const [file, allowed] of Object.entries(current.files)) {
        const count = result.files.get(file) || 0;
        if (count < allowed) improvements.push(`${file}: ${allowed} -> ${count}`);
    }
    const unclean = cleanFolderErrors(result.files, current.cleanFolders);
    for (const line of regressions) console.error(`MORE ERRORS  ${line}`);
    for (const [file, count] of unclean) console.error(`NOT CLEAN    ${file}: ${count} error(s) in a folder listed as clean`);
    for (const line of improvements) console.log(`FEWER ERRORS ${line}  (lower the baseline)`);
    console.log(`${pass.name}: ${result.total} error(s), baseline ${current.total}; `
        + `${regressions.length} file(s) regressed, ${improvements.length} improved`
        + (current.cleanFolders ? `; ${current.cleanFolders.length} clean folder(s)` : '') + '.');
    return regressions.length || unclean.length ? 1 : 0;
}

function main() {
    const tsc = locateTsc();
    if (!tsc || !existsSync(tsc)) {
        console.error('TypeScript not found. Install it (npm install --no-save typescript) or set TSC=/path/to/tsc.js.');
        process.exitCode = 2;
        return;
    }
    const version = tscVersion(tsc);
    const passes = process.argv.includes('--strict-only') ? PASSES.filter(pass => pass.strict) : PASSES;
    const results = [checkJsDocBlocks(tsc), ...passes.map(pass => runPass(tsc, version, pass))];
    process.exitCode = Math.max(0, ...results);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
