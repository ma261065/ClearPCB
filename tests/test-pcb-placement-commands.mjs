import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { capturePlacementOverride } from '../src/core/PcbPlacementState.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { normalizePcbSection } from '../src/core/project-field-aliases.js';
import { SetPlacementLockedCommand, SetPlacementRefVisibleCommand, MoveRefTextCommand,
    RotateRefTextCommand, SetRefStyleCommand } from '../src/core/pcb-placement-commands.js';

assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
const model = new PcbDocument();
const other = new PcbDocument();
const state = model.placementState;
const overrides = state.overrides;
const initial = { x: Math.PI, y: -Math.E, rotation: 37.123456, mirror: true, side: 'bottom',
    refDx: 2.345678, refDy: -3.456789, refRot: -90, refSize: 1.234567, refStrokeWidth: 0.234567 };
state.record('part', initial);
state.record('untouched', { x: 50, y: 50 });
const untouched = structuredClone(overrides.get('untouched'));
const current = () => structuredClone(overrides.get('part'));
const states = [current()];
const history = new CommandHistory();
for (const command of [
    new SetPlacementLockedCommand(state, 'part', true),
    new SetPlacementRefVisibleCommand(state, 'part', false),
    new MoveRefTextCommand(state, 'part', initial.refDx, initial.refDy, Math.PI, -Math.E),
    new RotateRefTextCommand(state, 'part', 270, 450.123456),
]) {
    history.execute(command);
    states.push(current());
}
const before = { refSize: current().refSize, refStrokeWidth: current().refStrokeWidth, refRot: current().refRot };
const after = { refSize: 2.345678, refStrokeWidth: 0.345678, refRot: -90.123456, x: 999 };
const style = new SetRefStyleCommand(state, 'part', before, after);
before.refSize = 999;
after.refSize = 999;
history.execute(style);
assert.equal(current().refSize, 2.345678);
assert.equal(current().refRot, ((-90.123456 % 360) + 360) % 360);
assert.equal(current().x, Math.PI, 'Style commands ignore unrelated input fields');
states.push(current());
const saved = normalizePcbSection(model.serialize()).placements.part;
assert.equal(saved.refSize, 2.3457);
assert.equal(saved.refDx, 3.1416);
assert.equal(current().refSize, 2.345678);
assert.equal(current().refDx, Math.PI, 'Serialization does not round the model');
overrides.get('part').refSize = 888;
style.execute();
assert.deepEqual(current(), states.at(-1), 'Live metadata edits cannot change command snapshots');
for (let cycle = 0; cycle < 2; cycle++) {
    for (let index = states.length - 2; index >= 0; index--) {
        assert.equal(history.undo(), true);
        assert.deepEqual(current(), states[index], `Undo restores step ${index}`);
        assert.equal(state.overrides, overrides);
    }
    for (let index = 1; index < states.length; index++) {
        assert.equal(history.redo(), true);
        assert.deepEqual(current(), states[index], `Redo restores step ${index}`);
        assert.equal(state.overrides, overrides);
    }
}
const pending = new SetPlacementLockedCommand(state, 'part', false);
state.record('part', { ...current(), x: 77.123456, rotation: 123, side: 'top' });
pending.execute();
pending.undo();
assert.equal(current().x, 77.123456, 'Metadata edits preserve newer canonical placement coordinates');
assert.equal(current().rotation, 123);
assert.equal(current().side, 'top');
const sparseBefore = current();
const sparse = new SetRefStyleCommand(state, 'part', { refSize: sparseBefore.refSize }, { refSize: 4.123456 });
sparse.execute();
assert.deepEqual(current(), { ...sparseBefore, refSize: 4.123456 });
sparse.undo();
assert.deepEqual(current(), sparseBefore);
const staleProjection = { ...current(), locked: !current().locked, refVisible: !current().refVisible };
for (const command of [
    new SetPlacementLockedCommand(state, 'part', false, staleProjection),
    new SetPlacementRefVisibleCommand(state, 'part', true, staleProjection),
]) {
    const canonical = current();
    command.execute();
    command.undo();
    assert.deepEqual(current(), canonical, 'A supplied projection never overrides existing canonical undo metadata');
}
assert.deepEqual(overrides.get('untouched'), untouched);
assert.equal(other.placementState.overrides.size, 0);

for (const create of [
    (state, seed) => new SetPlacementLockedCommand(state, 'new', true, seed),
    (state, seed) => new SetPlacementRefVisibleCommand(state, 'new', false, seed),
    (state, seed) => new MoveRefTextCommand(state, 'new', 0, 0, 2, 3, seed),
    (state, seed) => new RotateRefTextCommand(state, 'new', 0, 90, seed),
    (state, seed) => new SetRefStyleCommand(state, 'new', { refSize: 0.9 }, { refSize: 2 }, seed),
]) {
    const fresh = new PcbDocument();
    const artwork = {};
    artwork.self = artwork;
    const seed = { x: Math.PI, y: -Math.E, elements: [artwork], pads: new Map(), reference: 'R1' };
    const baseline = capturePlacementOverride(seed);
    const command = create(fresh.placementState, seed);
    assert.equal(fresh.serializeSection(), null, 'Constructing a command must not seed or dirty the model');
    seed.x = 999;
    command.execute();
    const recorded = fresh.placementState.overrides.get('new');
    assert.equal(recorded.x, Math.PI);
    assert.deepEqual(Object.keys(recorded), Object.keys(baseline), 'Only authored fields are retained from generated artwork');
    assert.doesNotThrow(() => JSON.stringify(fresh.serialize()));
    command.undo();
    assert.deepEqual(fresh.placementState.overrides.get('new'), baseline,
        'First-edit undo retains the baseline override, matching existing persistence behavior');
    const roundTrip = new PcbDocument();
    roundTrip.load(fresh.serialize());
    assert.deepEqual(roundTrip.placementState.serialize(), fresh.placementState.serialize());
}
assert.throws(() => new SetPlacementLockedCommand(other.placementState, 'missing', true),
    /PCB placement is no longer available: missing/);
assert.equal(other.placementState.overrides.size, 0);
assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
console.log('PASS headless placement metadata commands, lazy authored baselines, precision, isolation and complete history');
