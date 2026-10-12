#!/usr/bin/env node
// Type-checks src/ once with jsconfig.json. Any TypeScript diagnostic fails.
// Also fails on JSDoc tags in a block other than the one nearest a declaration.
// Set TSC=/path/to/tsc.js to use a specific compiler.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const CONFIG = 'jsconfig.json';
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
            const file = relative(root, resolve(root, match[1])).split(sep).join('/');
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

function summary(name, result, version) {
    const lines = ['### ' + name + ' (TypeScript ' + version + ')', '',
        result.total + ' error(s) in ' + result.files.size + ' file(s).', ''];
    if (result.files.size) {
        lines.push('| Errors | File |', '| ---: | --- |', ...top(result.files, 20).map(([file, n]) => '| ' + n + ' | ' + file + ' |'), '');
        lines.push('| Errors | Code |', '| ---: | --- |', ...top(result.codes, 10).map(([code, n]) => '| ' + n + ' | ' + code + ' |'), '');
    }
    return lines.join('\n');
}

/**
 * Declarations in text with JSDoc tags in a block TypeScript ignores (any block but the
 * one nearest the declaration). Typedef, callback and overload blocks stand on their own.
 * @param {any} ts The TypeScript module.
 * @returns {number[]} 1-based line numbers of the ignored blocks.
 */
export function ignoredJsDocBlocks(ts, fileName, text) {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const lines = [];
    const visit = node => {
        const blocks = (node.jsDoc || []).filter(block => !(block.tags || [])
            .some(tag => ['typedef', 'callback', 'overload'].includes(tag.tagName.text)));
        for (const block of blocks.slice(0, -1)) {
            if (block.tags?.length) lines.push(source.getLineAndCharacterOfPosition(block.getStart()).line + 1);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return lines;
}

function checkJsDocBlocks(tsc) {
    const ts = createRequire(tsc)('./typescript.js');
    const found = [];
    const walk = dir => {
        for (const name of readdirSync(dir)) {
            const file = join(dir, name);
            if (statSync(file).isDirectory()) walk(file);
            else if (name.endsWith('.js')) {
                for (const line of ignoredJsDocBlocks(ts, file, readFileSync(file, 'utf8'))) {
                    found.push(relative(root, file).split(sep).join('/') + ':' + line);
                }
            }
        }
    };
    walk(join(root, 'src'));
    for (const where of found) console.error('IGNORED JSDOC ' + where + ': merge its tags into the block nearest the declaration');
    return found.length ? 1 : 0;
}

function runTypecheck(tsc, version) {
    const run = spawnSync(process.execPath, [tsc, '-p', CONFIG, '--noEmit', '--pretty', 'false'], {
        cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
    });
    const output = [run.stdout, run.stderr].filter(Boolean).join('\n');
    if (run.error || ![0, 1, 2].includes(run.status)) {
        console.error(run.error?.message || output || 'tsc exited with ' + run.status);
        return 2;
    }
    const result = parseDiagnostics(output);
    if (result.global.length) {
        console.error('Compiler configuration errors:\n' + result.global.join('\n'));
        return 2;
    }
    if (result.total) process.stdout.write(output);
    const report = summary('Type check', result, version);
    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
    return result.total ? 1 : 0;
}

function main() {
    const tsc = locateTsc();
    if (!tsc || !existsSync(tsc)) {
        console.error('TypeScript not found. Install it (npm install --no-save typescript) or set TSC=/path/to/tsc.js.');
        process.exitCode = 2;
        return;
    }
    const version = tscVersion(tsc);
    process.exitCode = Math.max(checkJsDocBlocks(tsc), runTypecheck(tsc, version));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
