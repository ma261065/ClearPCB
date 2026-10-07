import assert from 'node:assert/strict';
import { createPropertyBinding, createPropertyPreview } from '../../src/shapes/property-preview.js';

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
// Field-level completion (current input, Escape, blur, focus) is the renderer's: test-property-fields.
console.log('PASS shared property ownership, field handoff, disposal and structural refresh');
