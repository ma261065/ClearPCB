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
globalThis.document = { activeElement: null };
for (const focused of [false, true]) {
    const input = inputFixture();
    document.activeElement = focused ? input : null;
    const calls = [];
    let active = true, current = true;
    const preview = {
        get active() { return active; },
        commit(options) { calls.push(options); active = false; return true; },
        cancel() { const changed = active; active = false; return changed; },
    };
    let refreshes = 0, cancellations = 0;
    const options = { isCurrent: () => current, refresh() { refreshes++; }, onCancel() { cancellations++; } };
    bindPropertyPreviewInput(input, preview, options);
    assert.equal(commitPropertyPreviewInput(input, preview, options), true);
    assert.deepEqual(calls, [{ rebuild: !focused }]);
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
