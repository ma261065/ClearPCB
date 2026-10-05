import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Properties panels are logic only: they describe fields and actions, and
// shared/ui/property-fields.js (through each editor's host) is the one place that
// builds controls. Then a new look for the panels changes the renderer and hosts alone.

const root = fileURLToPath(new URL('../src/', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');

/** Panel modules: no DOM at all. */
const PANELS = [
    'pcb/modules/pad-properties.js',
    'pcb/modules/multi-selection-properties.js',
    'pcb/modules/text-properties.js',
    'pcb/modules/component-properties.js',
    'pcb/modules/board-shape-properties.js',
    'pcb/modules/copper-fill-edit.js',
    'schematic/modules/properties.js',
];
const DOM = /\b(innerHTML|outerHTML|insertAdjacentHTML|querySelector(All)?|getElementById|createElement(NS)?|addEventListener|activeElement)\b|\bdocument\./;
for (const path of PANELS) {
    const match = DOM.exec(read(path));
    assert.equal(match, null, `${path} describes its panel; the renderer owns the DOM (found ${match?.[0]})`);
}

/** Property-row markup belongs to the renderer and the editors' hosts. */
const RENDERERS = new Set(['shared/ui/property-fields.js', 'schematic/modules/property-host.js']);
const MARKUP = /\bprop-(row|toggle|net-control|net-menu|value|action)\b|props-placeholder/;
const files = [];
const walk = dir => {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.js')) files.push(relative(root, path).replace(/\\/g, '/'));
    }
};
walk(root);
const offenders = files.filter(path => !RENDERERS.has(path) && MARKUP.test(read(path)));
assert.deepEqual(offenders, [], 'Only the Properties renderer and hosts build property rows');

console.log(`PASS Properties panels are logic only (${PANELS.length} panel modules; rows built by the renderer)`);
