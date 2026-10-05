import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    PANEL_EDITOR_KINDS, PROPERTY_EDITOR_KINDS, getPropertyEditor, setPropertyEditor, releasePropertyEditor,
    hasActivePropertyEditor, commitPropertyEditors, eachPropertyEditorOnLayer,
} from '../src/pcb/modules/property-editors.js';
import { importSpecifiers } from '../tools/check-imports.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

// Slots are per editor, start empty, and reject unknown kinds.
const app = {}, other = {};
for (const kind of PROPERTY_EDITOR_KINDS) assert.equal(getPropertyEditor(app, kind), null);
assert.throws(() => setPropertyEditor(app, 'shape', {}), /Unknown PCB property editor kind: shape/);
assert.throws(() => releasePropertyEditor(app, 'Track', {}), /Unknown/);
const first = { active: false }, second = { active: true };
assert.equal(setPropertyEditor(app, 'track', first), first, 'Claiming returns the binding');
assert.equal(getPropertyEditor(other, 'track'), null, 'Editors do not share slots');

// A disposed binding can only release its own slot, never a newer owner's.
setPropertyEditor(app, 'track', second);
releasePropertyEditor(app, 'track', first);
assert.equal(getPropertyEditor(app, 'track'), second);
releasePropertyEditor(app, 'track', second);
assert.equal(getPropertyEditor(app, 'track'), null);
releasePropertyEditor(other, 'track', second);

// Activity queries respect the requested kinds.
setPropertyEditor(app, 'boardDimension', { active: true });
setPropertyEditor(app, 'pad', { active: false });
assert.equal(hasActivePropertyEditor(app), true);
assert.equal(hasActivePropertyEditor(app, PANEL_EDITOR_KINDS), false, 'Board-size fields are not a panel editor');
assert.equal(hasActivePropertyEditor(other), false);
assert.deepEqual(PROPERTY_EDITOR_KINDS, [...PANEL_EDITOR_KINDS, 'boardDimension']);

// Commits run in the given order and stop at the first failure.
{
    const editor = {}, events = [];
    const failure = new Error('commit failed');
    for (const kind of ['text', 'pad', 'via']) {
        setPropertyEditor(editor, kind, { commit() { events.push(kind); if (kind === 'pad') throw failure; } });
    }
    assert.throws(() => commitPropertyEditors(editor, ['via', 'track', 'pad', 'text']), error => error === failure);
    assert.deepEqual(events, ['via', 'pad'], 'Missing slots are skipped; a failure stops later commits');
}

// Layer release visits editors in their historical order and tests each just before acting.
{
    const editor = {}, events = [];
    const binding = (kind, affected) => ({
        affectsLayer(layerId) { events.push(`test:${kind}`); return affected.has(layerId); },
        dispose() { events.push(`dispose:${kind}`); },
    });
    for (const kind of PANEL_EDITOR_KINDS) setPropertyEditor(editor, kind, binding(kind, new Set(['top-copper'])));
    setPropertyEditor(editor, 'text', binding('text', new Set(['top-silk'])));
    setPropertyEditor(editor, 'boardDimension', { affectsLayer() { assert.fail('Board-size fields are released separately'); } });
    getPropertyEditor(editor, 'track').dispose = () => {
        events.push('dispose:track');
        setPropertyEditor(editor, 'via', null);
    };
    eachPropertyEditorOnLayer(editor, 'top-copper', target => target.dispose());
    assert.deepEqual(events, [
        'test:track', 'dispose:track', 'test:boardShape', 'dispose:boardShape',
        'test:text', 'test:component', 'dispose:component', 'test:pad', 'dispose:pad', 'test:fill', 'dispose:fill',
    ], 'A slot released by an earlier editor is not visited');
}

// The module stays import-free (fabrication export loads it in the Gerber worker).
assert.deepEqual(importSpecifiers(readFileSync(join(root, 'src/pcb/modules/property-editors.js'), 'utf8')), []);

// The former editor fields cannot reappear.
const listJs = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? listJs(join(dir, entry.name)) : entry.name.endsWith('.js') ? [join(dir, entry.name)] : []);
const legacy = /\b_(?:boardShape|track|via|pad|text|boardDimension)PropertyBinding\b|\b_componentProperties\b/;
for (const file of listJs(join(root, 'src'))) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), legacy, `${file} uses property-editors.js instead of editor fields`);
}

console.log('PASS PCB property editors: per-editor ownership, safe release, ordered commits and layer release, import-free');
