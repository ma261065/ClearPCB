/**
 * Selection state seam: SelectionManager is the only writer of entity selected/hovered
 * flags and of its own private state. Editors use the public API (keepSelected,
 * dropSelected, dropHover, forget, clearSelection({ notify: false }), notifyChanged,
 * invalidateHitCache) so logical and visual selection cannot drift apart.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SelectionManager } from '../src/core/SelectionManager.js';

function item(id, extra = {}) {
    return { id, visible: true, selected: false, hovered: false, invalidations: 0,
        invalidate() { this.invalidations++; }, getBounds: () => ({ minX: 0, minY: 0, maxX: 1, maxY: 1 }),
        hitTest: () => true, ...extra };
}

function managerFor(items) {
    const notices = [];
    const selection = new SelectionManager({ onSelectionChanged: current => notices.push(current.map(s => s.id)) });
    selection.setShapes(items);
    return { selection, notices };
}

{
    const owner = item('owner');
    const label = item('label', { type: 'text', parentComponent: owner });
    const stranger = item('stranger');
    const { selection, notices } = managerFor([owner, label]);

    selection.keepSelected(label);
    assert.equal(selection.isSelected(label) && label.selected, true, 'keepSelected selects a tracked item');
    assert.deepEqual(selection.getSelection(), [label]);
    assert.equal(owner.invalidations, 1, 'keepSelected refreshes linked ownership visuals');
    assert.deepEqual(notices, [], 'keepSelected does not notify');

    const before = label.invalidations;
    selection.keepSelected(label);
    assert.equal(label.invalidations, before, 'keeping an already selected item is free');

    selection.keepSelected(stranger);
    selection.keepSelected(null);
    assert.equal(stranger.selected || selection.isSelected(stranger), false, 'untracked items are ignored');
    assert.equal(selection.count, 1);

    selection.select(owner, true);
    notices.length = 0;
    selection.dropSelected(label);
    assert.equal(label.selected || selection.isSelected(label), false);
    assert.deepEqual(selection.getSelection(), [owner], 'dropSelected refreshes the cached selection');
    assert.deepEqual(notices, [], 'dropSelected does not notify');

    selection.setHovered(owner);
    selection.dropHover(label);
    assert.equal(selection.hovered, 'owner', 'dropHover leaves another item hovered');
    selection.forget(owner);
    assert.equal(owner.selected || owner.hovered || selection.hovered !== null || selection.count !== 0, false,
        'forget clears selection and hover');

    selection.selectMultiple([owner, label]);
    notices.length = 0;
    selection.clearSelection({ notify: false });
    assert.equal(selection.count + Number(owner.selected) + Number(label.selected), 0);
    assert.deepEqual(notices, [], 'quiet clear does not notify');
    selection.notifyChanged();
    assert.deepEqual(notices, [[]], 'notifyChanged reports the current selection once');
}

{
    const shape = item('cached');
    const { selection } = managerFor([shape]);
    let hits = 0;
    shape.hitTest = () => { hits++; return true; };
    selection.hitTest({ x: 0.5, y: 0.5 });
    selection.hitTest({ x: 0.5, y: 0.5 });
    assert.equal(hits, 1, 'repeated hit tests reuse the cache');
    selection.invalidateHitCache();
    selection.hitTest({ x: 0.5, y: 0.5 });
    assert.equal(hits, 2, 'invalidateHitCache forces a fresh hit test');
}

// Static guard: no direct flag writes or private SelectionManager access outside the manager.
const root = fileURLToPath(new URL('../src/', import.meta.url));
const files = [];
(function walk(dir) {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.js')) files.push(path);
    }
})(root);

// Entities initialise their own flags; the PCB registry re-syncs adapter flags after replacing its list.
const allowed = new Set([
    'components/Component.js: this.selected = false;',
    'components/Component.js: this.hovered = false;',
    'shapes/shape.js: this.selected = false;',
    'shapes/shape.js: this.hovered = false;',
    'shapes/via.js: this.selected = false;',
    'shapes/copper-fill.js: this.selected = false;',
    'pcb/modules/selection-registry.js: selection._invalidateHitTestCache();',
    'pcb/modules/selection-registry.js: selection._selectionCache = null;',
    'pcb/modules/selection-registry.js: selection.selected = new Set([...selection.selected].filter((id) => selection._getShape(id)));',
    'pcb/modules/selection-registry.js: for (const item of selection.shapes) item.selected = selection.selected.has(item.id);',
]);
const offenders = [];
for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
    if (rel === 'core/SelectionManager.js') continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const text = line.trim();
        const flagWrite = /[\w\]]\.(selected|hovered)\s*=(?!=)/.test(text);
        const privateAccess = /\bselection\??\.(_\w+|selected\b|hovered\s*=(?!=))/.test(text);
        if ((flagWrite || privateAccess) && !allowed.has(`${rel}: ${text}`)) offenders.push(`${rel}: ${text}`);
    }
}
assert.deepEqual(offenders, [], 'selection flags and SelectionManager internals change only through its API');

console.log('PASS selection state seam: quiet keep/drop/forget/clear/notify API and no direct flag writes');
