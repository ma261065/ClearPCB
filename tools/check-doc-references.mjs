#!/usr/bin/env node
// Checks that the docs' references to the repository still resolve, so a renamed or
// deleted test, module or page cannot leave a doc pointing at nothing:
//   - a test named in code (`test-foo`) is tests/unit/test-foo.mjs;
//   - a script or stylesheet named in code (`board-shapes.js`) exists somewhere in the repo;
//   - a path in code under a project folder (`src/...`, `tests/...`) exists;
//   - a relative Markdown link resolves to a file.
// Usage: node tools/check-doc-references.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const PROJECT_FOLDERS = ['src', 'tests', 'tools', 'docs', 'assets', '.github'];
// Names the docs mention that are not repository files, and why.
const NOT_REPOSITORY_FILES = new Map([
    ['assets/kicad-index.json', 'built locally and by releases, not committed'],
    ['dist/assets/kicad-index.json', 'inside the release build'],
    ['tsc.js', "TypeScript's compiler, from node_modules"],
    ['imagetracer_v1.2.6.js', "the upstream library's file name"],
]);

function walk(dir, out = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', '.venv', 'dist'].includes(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path, out);
        else out.push(relative(root, path).replaceAll('\\', '/'));
    }
    return out;
}

const files = walk(root);
const fileSet = new Set(files);
const fileNames = new Set(files.map(path => path.split('/').pop()));
const docs = ['README.md', ...files.filter(path => path.startsWith('docs/') && path.endsWith('.md'))];

/** The problem with one name found in a code span, or null when it resolves. */
function codeReferenceProblem(name) {
    if (/[*<>]/.test(name) || NOT_REPOSITORY_FILES.has(name)) return null;
    if (/^test-[a-z0-9-]+$/.test(name)) {
        return fileSet.has(`tests/unit/${name}.mjs`) ? null : `test ${name} is not tests/unit/${name}.mjs`;
    }
    if (name.includes('/')) {
        if (!PROJECT_FOLDERS.includes(name.split('/')[0])) return null;
        const path = name.replace(/\/$/, '');
        return fileSet.has(path) || files.some(file => file.startsWith(`${path}/`)) ? null : `path ${name} does not exist`;
    }
    if (/^[\w.-]+\.(m?js|css|html)$/.test(name)) return fileNames.has(name) ? null : `file ${name} does not exist`;
    return null;
}

const problems = [];
for (const doc of docs) {
    readFileSync(join(root, doc), 'utf8').split('\n').forEach((line, index) => {
        const at = `${doc}:${index + 1}`;
        for (const [, span] of line.matchAll(/`([^`]+)`/g)) {
            for (const [name] of span.matchAll(/[\w./<>*-]+/g)) {
                const problem = codeReferenceProblem(name);
                if (problem) problems.push(`${at}: ${problem}`);
            }
        }
        for (const [, target] of line.matchAll(/\]\(<?([^)\s>]+)>?\)/g)) {
            if (/^(https?:|mailto:|#)/.test(target)) continue;
            const path = decodeURI(target.split('#')[0]);
            if (path && !existsSync(resolve(root, dirname(doc), path))) problems.push(`${at}: link ${target} does not resolve`);
        }
    });
}

if (problems.length) {
    console.error(`${problems.length} doc reference(s) do not resolve:\n${problems.join('\n')}`);
    process.exitCode = 1;
} else {
    console.log(`Doc references resolve (${docs.length} pages).`);
}
