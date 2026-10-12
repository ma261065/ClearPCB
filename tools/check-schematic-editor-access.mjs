#!/usr/bin/env node
// Keeps schematic code off the schematic editor's private (`app._x`) members, with the
// same rules as tools/check-pcb-editor-access.mjs. Scans the schematic layer
// (src/schematic); tools/schematic-editor-access-baseline.json lists any private
// SchematicApp members a module may use; it is empty.
//
// Usage:
//   node tools/check-schematic-editor-access.mjs            check against the baseline
//   node tools/check-schematic-editor-access.mjs --update   rewrite the baseline (review the diff)

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEditorAccessCheck } from './check-pcb-editor-access.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

runEditorAccessCheck({
    label: 'Schematic',
    roots: [join(root, 'src', 'schematic')],
    facade: join(root, 'src', 'ui', 'SchematicApp.js'),
    baselinePath: join(root, 'tools', 'schematic-editor-access-baseline.json'),
    hint: 'Use a public SchematicApp method or a schematic module export instead.',
});
