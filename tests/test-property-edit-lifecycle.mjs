import assert from 'node:assert/strict';
import { createPropertyBinding, createPropertyPreview, commitPropertyPreviewInput,
    bindPropertyPreviewInput } from '../src/shapes/property-preview.js';

const binding = createPropertyBinding();
let state = { width: 1, radius: 2 };
const edits = [];
const makePreview = () => createPropertyPreview({
    binding,
    capture: () => ({ ...state }),
    restore: before => { state = { ...before }; },
    redraw() {},
    commit(before, after, options) { state = { ...after }; edits.push({ before, after, options }); },
});
const width = makePreview(), radius = makePreview();
width.update(() => { state.width = 3; });
radius.update(() => { state.radius = 4; });
assert.equal(edits.length, 1);
assert.deepEqual(edits[0], {
    before: { width: 1, radius: 2 }, after: { width: 3, radius: 2 }, options: { rebuild: false },
});
assert.equal(width.active, false);
assert.equal(radius.active, true);
radius.commit();
assert.deepEqual(edits[1].before, edits[0].after);
assert.deepEqual(edits[1].after, { width: 3, radius: 4 });
assert.equal(binding.active, false);

width.update(() => { state.width = 5; });
binding.dispose();
assert.deepEqual(state, { width: 3, radius: 4 });
assert.equal(binding.disposed, true);
assert.equal(binding.active, false);
width.update(() => { assert.fail('Disposed binding cannot restart a preview'); });
assert.equal(binding.prepare(), false);
assert.equal(edits.length, 2);

{
    const owner = createPropertyBinding();
    const failure = new Error('Cannot finish the previous edit');
    owner.activate({ active: true, commit() { throw failure; }, cancel() {} });
    assert.throws(() => owner.activate({ active: false }), error => error === failure);
    assert.equal(owner.active, true, 'Failed handoff must not transfer ownership');
}

function inputFixture() {
    const listeners = new Map();
    const input = {
        value: '1',
        addEventListener(name, callback) { listeners.set(name, callback); },
        fire(name, details = {}) {
            const event = { defaultPrevented: false, propagationStopped: false,
                preventDefault() { this.defaultPrevented = true; },
                stopPropagation() { this.propagationStopped = true; }, ...details };
            listeners.get(name)?.(event);
            return event;
        },
    };
    return input;
}
for (const completion of ['commit', 'prepare', 'handoff', 'cancel', 'dispose']) {
    const owner = createPropertyBinding();
    let value = 1, finalized = 0;
    const commands = [];
    const preview = createPropertyPreview({
        binding: owner, capture: () => value, restore: before => { value = before; }, redraw() {},
        beforeCommit() { value = Math.round(value); finalized++; },
        commit(before, after) { commands.push({ before, after }); value = after; },
    });
    preview.update(() => { value = 2.6; });
    assert.equal(finalized, 0, 'Previewing must not finalize geometry');
    if (completion === 'handoff') owner.activate({ active: false });
    else owner[completion]();
    if (completion === 'cancel' || completion === 'dispose') {
        assert.equal(finalized, 0);
        assert.equal(value, 1);
        assert.deepEqual(commands, []);
    } else {
        assert.equal(finalized, 1);
        assert.equal(value, 3);
        assert.deepEqual(commands, [{ before: 1, after: 3 }], 'Every commit path captures finalized geometry once');
    }
}
globalThis.document = { activeElement: null };
for (const valid of [false, true]) for (const completion of ['commit', 'prepare', 'handoff']) {
    const owner = createPropertyBinding(), input = inputFixture();
    let value = 1, finalized = 0, refreshes = 0;
    const commands = [];
    const preview = createPropertyPreview({
        binding: owner, capture: () => value, restore: before => { value = before; }, redraw() {},
        beforeCommit() { finalized++; },
        commit(before, after, options) { value = after; commands.push({ before, after, options }); },
    });
    bindPropertyPreviewInput(input, preview, { binding: owner, refresh() { refreshes++; } });
    input.value = '2';
    preview.update(() => { value = 2; });
    if (!valid) input.value = '';
    if (completion === 'handoff') owner.activate({ active: false });
    else owner[completion]();
    assert.equal(value, valid ? 2 : 1, 'Owner completion uses the current numeric input, not just the last valid preview');
    assert.equal(commands.length, valid ? 1 : 0);
    assert.equal(finalized, valid ? 1 : 0, 'Invalid input does not run geometry finalization');
    assert.equal(refreshes, 1);
    if (valid) assert.deepEqual(commands[0].options, { rebuild: completion === 'commit' },
        'Handoff and action preparation retain their no-rebuild request');
    input.fire('blur');
    await Promise.resolve();
    assert.equal(commands.length, valid ? 1 : 0);
    assert.equal(refreshes, 1, 'Delayed blur does not repeat completion');
}
for (const focus of ['same', 'sibling', 'outside']) {
    const input = inputFixture();
    const sibling = inputFixture();
    const focusRoot = { contains: target => target === input || target === sibling };
    document.activeElement = focus === 'same' ? input : focus === 'sibling' ? sibling : null;
    const calls = [];
    let active = true, current = true;
    const preview = {
        get active() { return active; },
        commit(options) { calls.push(options); active = false; return true; },
        cancel() { const changed = active; active = false; return changed; },
    };
    let refreshes = 0, cancellations = 0;
    const options = { isCurrent: () => current, focusRoot,
        refresh() { refreshes++; }, onCancel() { cancellations++; } };
    bindPropertyPreviewInput(input, preview, options);
    assert.equal(commitPropertyPreviewInput(input, preview, options), true);
    assert.deepEqual(calls, [{ rebuild: focus === 'outside' }]);
    assert.equal(refreshes, 1);
    input.fire('blur');
    await Promise.resolve();
    assert.equal(calls.length, 1, 'Deferred blur must not recommit a finished edit');
    active = true;
    commitPropertyPreviewInput(input, preview, { ...options, forceRebuild: true });
    assert.deepEqual(calls.at(-1), { rebuild: true });
    active = true;
    input.value = '';
    commitPropertyPreviewInput(input, preview, options);
    assert.equal(active, false, 'Invalid numeric completion cancels');
    assert.equal(calls.length, 2);
    active = true;
    const event = input.fire('keydown', { key: 'Escape' });
    assert.equal(active, false);
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.propagationStopped, true);
    assert.equal(cancellations, 1);
    assert.equal(input.fire('keydown', { key: 'Escape' }).defaultPrevented, false,
        'An idle field does not consume the next Escape');
    current = false;
    active = true;
    input.value = '2';
    const beforeRefresh = refreshes;
    input.fire('blur');
    await Promise.resolve();
    assert.deepEqual(calls.at(-1), { rebuild: false }, 'Pending blur may settle without rebuilding a newer panel');
    assert.equal(refreshes, beforeRefresh);
    assert.equal(active, false);
    assert.equal(commitPropertyPreviewInput(input, preview, options), false);
    assert.equal(calls.length, 3, 'A retired idle field cannot restart completion');
}
console.log('PASS shared property ownership, field handoff, disposal, focus, structural refresh, Escape and deferred blur');
