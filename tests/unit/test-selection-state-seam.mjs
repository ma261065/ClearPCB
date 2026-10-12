/**
 * Selection state seam: selection and hover live only in SelectionManager (its
 * id sets), never as flags on entities. Renderers ask it through
 * isSelected()/isHovered(), editors change it through the public API
 * (keepSelected, dropSelected, dropHover, forget, clearSelection({ notify: false }),
 * notifyChanged, invalidateHitCache), and entity refreshes go through the
 * configurable invalidateEntity hook.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SelectionManager } from '../../src/core/SelectionManager.js';

function item(id, extra = {}) {
    return { id, visible: true, invalidations: 0,
        invalidate() { this.invalidations++; }, getBounds: () => ({ minX: 0, minY: 0, maxX: 1, maxY: 1 }),
        hitTest: () => true, ...extra };
}

function managerFor(items, options = {}) {
    const notices = [];
    const selection = new SelectionManager({ onSelectionChanged: current => notices.push(current.map(s => s.id)), ...options });
    selection.setShapes(items);
    return { selection, notices };
}

{
    const owner = item('owner');
    const label = item('label', { type: 'text', parentComponent: owner });
    const stranger = item('stranger');
    const { selection, notices } = managerFor([owner, label]);

    selection.keepSelected(label);
    assert.equal(selection.isSelected(label), true, 'keepSelected selects a tracked item');
    assert.deepEqual(selection.getSelection(), [label]);
    assert.equal(label.invalidations, 1, 'the newly selected item is refreshed');
    assert.equal(owner.invalidations, 1, 'keepSelected refreshes linked ownership visuals');
    assert.deepEqual(notices, [], 'keepSelected does not notify');

    selection.keepSelected(label);
    assert.equal(label.invalidations, 1, 'keeping an already selected item is free');

    selection.keepSelected(stranger);
    selection.keepSelected(null);
    assert.equal(selection.isSelected(stranger), false, 'untracked items are ignored');
    assert.equal(selection.count, 1);

    selection.select(owner, true);
    notices.length = 0;
    selection.dropSelected(label);
    assert.equal(selection.isSelected(label), false);
    assert.deepEqual(selection.getSelection(), [owner], 'dropSelected refreshes the cached selection');
    assert.deepEqual(notices, [], 'dropSelected does not notify');

    selection.setHovered(owner);
    assert.equal(selection.isHovered(owner) && !selection.isHovered(label) && !selection.isHovered(null), true);
    selection.dropHover(label);
    assert.equal(selection.hovered, 'owner', 'dropHover leaves another item hovered');
    selection.forget(owner);
    assert.equal(selection.isHovered(owner) || selection.count !== 0, false, 'forget clears selection and hover');

    selection.selectMultiple([owner, label]);
    notices.length = 0;
    selection.clearSelection({ notify: false });
    assert.equal(selection.count, 0);
    assert.deepEqual(notices, [], 'quiet clear does not notify');
    selection.notifyChanged();
    assert.deepEqual(notices, [[]], 'notifyChanged reports the current selection once');
    for (const entity of [owner, label, stranger]) {
        assert.equal('selected' in entity || 'hovered' in entity, false, 'no selection flags are written to entities');
    }
}

{
    const refreshed = [];
    const owner = item('owner');
    const label = item('label', { type: 'text', parentComponent: owner });
    const { selection } = managerFor([owner, label], { invalidateEntity: entity => refreshed.push(entity.id) });
    selection.select(label);
    selection.setHovered(owner);
    selection.setHovered(null);
    selection.clearSelection();
    assert.deepEqual(refreshed, ['label', 'owner', 'owner', 'owner', 'label', 'owner'],
        'selection, hover and linked ownership refreshes all go through invalidateEntity');
    assert.equal(owner.invalidations + label.invalidations, 0, 'the hook replaces the default invalidate()');
}

{
    // Hooks that redraw immediately must see the final state, not the one being left.
    const seen = [];
    const first = item('first');
    const second = item('second');
    let selection;
    ({ selection } = managerFor([first, second], {
        invalidateEntity: entity => seen.push(`${entity.id}:${selection.isSelected(entity)}/${selection.isHovered(entity)}`),
    }));
    selection.setHovered(first);
    selection.setHovered(second);
    selection.captureBoxSelectBase();
    selection.syncBoxSelection({ minX: -1, minY: -1, maxX: 2, maxY: 2 });
    selection.syncBoxSelection({ minX: 5, minY: 5, maxX: 6, maxY: 6 });
    assert.deepEqual(seen, ['first:false/true', 'first:false/false', 'second:false/true',
        'first:true/false', 'second:true/true', 'first:false/false', 'second:false/true'],
        'hover and box-selection refreshes run after the state change');
}

{
    const below = item('below');
    const top = item('top');
    const { selection } = managerFor([below, top]);
    assert.equal(selection.hitTest({ x: 0.5, y: 0.5 }), top, 'the topmost item wins when nothing is selected');
    selection.select(below);
    assert.equal(selection.hitTest({ x: 0.5, y: 0.5 }), below, 'a selected item wins over one drawn above it');
    assert.equal(selection.hitTest({ x: 0.5, y: 0.6 }, true).find(hit => selection.isSelected(hit)), below);
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

// Static guard: no entity selection flags and no private SelectionManager access outside it.
const root = fileURLToPath(new URL('../../src/', import.meta.url));
const files = [];
(function walk(dir) {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.js')) files.push(path);
    }
})(root);

// Unrelated "selected"/"hovered" fields: render options, anchor descriptors, PCB board-shape hover store.
const unrelated = /\b(opts|anchor|state\(app\))\.(selected|hovered)\b/;
const allowed = new Set([
    'pcb/modules/selection-registry.js: selection.selected = new Set([...selection.selected].filter((id) => selection._getShape(id)));',
]);
const offenders = [];
for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
    if (rel === 'core/SelectionManager.js') continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const text = line.trim();
        const code = text.replace(/'[^']*'|"[^"]*"/g, "''");
        const flagUse = /[\w\])?]\.(selected|hovered)\b/.test(code.replace(/\bselection\??\.(selected|hovered)\b/g, '')) && !unrelated.test(code);
        const privateAccess = /\bselection\??\.(_\w+|selected\b|hovered\s*=(?!=))/.test(text);
        if ((flagUse || privateAccess) && !allowed.has(`${rel}: ${text}`)) offenders.push(`${rel}: ${text}`);
    }
}
assert.deepEqual(offenders, [], 'selection state lives in SelectionManager and changes only through its API');

console.log('PASS selection state seam: flag-free entities, invalidateEntity hook, selected-first hits, quiet API and guard');
