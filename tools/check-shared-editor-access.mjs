#!/usr/bin/env node
// Keeps shared code off editor private members and editor-attached state.
// Scans editor-like identifiers (`app`, `editor`, `host`) in shared layers that
// both editors may call. `src/shared/pcb` stays in the PCB-specific scope because
// it is PCB geometry shared with the model rather than both editor facades.
//
// Usage:
//   node tools/check-shared-editor-access.mjs            check against the baseline
//   node tools/check-shared-editor-access.mjs --update   rewrite the baseline (review the diff)

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEditorAccessCheck } from './check-pcb-editor-access.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

runEditorAccessCheck({
    label: 'Shared',
    roots: [
        join(root, 'src', 'core'),
        join(root, 'src', 'shapes'),
        join(root, 'src', 'components'),
        join(root, 'src', 'shared', 'ui'),
        join(root, 'src', 'shared', '3d'),
        join(root, 'src', 'easyeda'),
    ],
    baselinePath: join(root, 'tools', 'shared-editor-access-baseline.json'),
    hint: 'Move state into its owning shared module, or call a public editor method instead.',
    editorNames: ['app', 'editor', 'host'],
});
