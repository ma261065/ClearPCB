#!/usr/bin/env node
// Type-checks src/ with the jsconfig.json settings and summarises the errors.
//
// Without tools/typecheck-baseline.json this only reports (exit 0). With a baseline
// it ratchets: a file whose error count rises, or a new file with errors, fails.
// TypeScript is not vendored; CI installs a pinned version (see regression.yml).
//
// Usage:
//   node tools/typecheck.mjs                    report, or check against the baseline
//   node tools/typecheck.mjs --write-baseline   record current per-file counts
//
// Set TSC=/path/to/tsc.js to use a specific compiler.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const baselinePath = join(root, 'tools', 'typecheck-baseline.json');
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

function summary({ files, codes, total }, version) {
    const lines = [`### Type check (TypeScript ${version})`, '',
        `${total} error(s) in ${files.size} file(s).`, ''];
    if (files.size) {
        lines.push('| Errors | File |', '| ---: | --- |', ...top(files, 20).map(([file, n]) => `| ${n} | ${file} |`), '');
        lines.push('| Errors | Code |', '| ---: | --- |', ...top(codes, 10).map(([code, n]) => `| ${n} | ${code} |`), '');
    }
    return lines.join('\n');
}

function main() {
    const tsc = locateTsc();
    if (!tsc || !existsSync(tsc)) {
        console.error('TypeScript not found. Install it (npm install --no-save typescript) or set TSC=/path/to/tsc.js.');
        process.exitCode = 2;
        return;
    }
    const version = tscVersion(tsc);
    const run = spawnSync(process.execPath, [tsc, '-p', 'jsconfig.json', '--noEmit', '--pretty', 'false'], {
        cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    });
    // tsc exits 0 (clean), 1 or 2 (diagnostics present); anything else is a crash.
    if (run.error || ![0, 1, 2].includes(run.status)) {
        console.error(run.error?.message || run.stderr || `tsc exited with ${run.status}`);
        process.exitCode = 2;
        return;
    }
    const result = parseDiagnostics(run.stdout);
    if (result.global.length) {
        console.error('Compiler configuration errors:\n' + result.global.join('\n'));
        process.exitCode = 2;
        return;
    }
    const report = summary(result, version);
    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');

    if (process.argv.includes('--write-baseline')) {
        const files = Object.fromEntries([...result.files].sort((a, b) => a[0].localeCompare(b[0])));
        writeFileSync(baselinePath, JSON.stringify({ typescript: version, total: result.total, files }, null, 2) + '\n');
        console.log(`Wrote baseline for ${result.files.size} file(s) to tools/typecheck-baseline.json.`);
        return;
    }
    if (!existsSync(baselinePath)) {
        console.log('No tools/typecheck-baseline.json: report only.');
        return;
    }
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
    if (baseline.typescript !== version) {
        console.warn(`Baseline was recorded with TypeScript ${baseline.typescript}; running ${version}.`);
    }
    const regressions = [];
    const improvements = [];
    for (const [file, count] of result.files) {
        const allowed = baseline.files[file] || 0;
        if (count > allowed) regressions.push(`${file}: ${allowed} -> ${count}`);
    }
    for (const [file, allowed] of Object.entries(baseline.files)) {
        const count = result.files.get(file) || 0;
        if (count < allowed) improvements.push(`${file}: ${allowed} -> ${count}`);
    }
    for (const line of regressions) console.error(`MORE ERRORS  ${line}`);
    for (const line of improvements) console.log(`FEWER ERRORS ${line}  (lower the baseline)`);
    console.log(`Type check: ${result.total} error(s), baseline ${baseline.total}; `
        + `${regressions.length} file(s) regressed, ${improvements.length} improved.`);
    process.exitCode = regressions.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
