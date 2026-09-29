import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { Via } from '../src/shapes/via.js';
import { Track } from '../src/shapes/track.js';
import { AddViaCommand, RemoveViaCommand, MoveViaCommand, ModifyViaCommand,
    ModifyViasCommand } from '../src/core/pcb-via-commands.js';

assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
const model = new PcbDocument();
const other = new PcbDocument();
const vias = model.vias;
const untouched = new Via({ id: 'untouched', x: 50, y: 50 });
const peer = new Via({ id: 'peer', x: 10, y: -10, net: 'GND' });
vias.push(untouched, peer);
const otherVia = new Via({ id: 'other-project', x: -50, y: -50 });
other.vias.push(otherVia);
const otherState = otherVia.captureState();
const via = new Via({ id: 'authored-via', x: 1.234567, y: -2.345678,
    diameter: 0.678912, drill: 0.345678, net: 'GND', locked: true, visible: false });
const original = via.captureState();
const track = new Track({ points: [{ x: via.x, y: via.y }, { x: 10, y: -10 }], net: 'GND' });
model.tracks.push(track);
const trackState = track.captureState();
const state = () => vias.map(item => item.captureState());
const states = [state()];
const history = new CommandHistory();
const add = new AddViaCommand(model, via);
history.execute(add);
add.execute();
assert.equal(vias.length, 3, 'Repeated add never duplicates a via');
states.push(state());
history.execute(new MoveViaCommand(via, via.x, via.y, Math.PI, -Math.E));
assert.equal(via.x, Math.PI);
assert.equal(via.y, -Math.E);
states.push(state());
const before = via.captureState();
const after = { ...before, id: 'must-not-replace-id', diameter: 1.234567, drill: 0.456789,
    net: 'SIGNAL', locked: false, visible: true };
const modify = new ModifyViaCommand(via, before, after);
before.net = 'caller changed before';
after.diameter = 999;
after.net = 'caller changed after';
history.execute(modify);
assert.equal(via.id, original.id);
assert.equal(via.net, 'SIGNAL');
assert.equal(via.diameter, 1.234567);
assert.equal(via.locked, false);
assert.equal(via.visible, true);
assert.equal(model.serializeEntities().vias[2].d, 1.2346);
assert.equal(model.serializeEntities().vias[2].x, 3.1416);
assert.equal(via.diameter, 1.234567, 'Save rounding does not modify authored command state');
assert.equal(via.x, Math.PI);
states.push(state());
const changes = [peer, via].map(target => ({
    via: target, before: target.captureState(),
    after: { ...target.captureState(), diameter: 0.456789, drill: 0.9, net: 'BATCH', locked: true },
}));
const batch = new ModifyViasCommand(changes);
for (const change of changes) {
    change.before.net = 'caller changed before';
    change.after.net = 'caller changed after';
    change.via = untouched;
}
changes.length = 0;
history.execute(batch);
assert.equal(peer.net, 'BATCH');
assert.equal(via.net, 'BATCH');
assert.equal(peer.drill, 0.456789, 'Batch edits preserve Via drill normalization');
assert.equal(via.drill, via.diameter);
assert.equal(untouched.net, '', 'Command membership does not alias the caller array or records');
states.push(state());
via.net = 'live edit';
via.diameter = 99;
peer.drill = 99;
batch.execute();
assert.deepEqual(state(), states.at(-1), 'Live entity mutations never alter stored snapshots');
const remove = new RemoveViaCommand(model, via);
history.execute(remove);
states.push(state());
for (let cycle = 0; cycle < 2; cycle++) {
    for (let index = states.length - 2; index >= 0; index--) {
        assert.equal(history.undo(), true);
        assert.deepEqual(state(), states[index], `Undo restores step ${index}`);
        assert.equal(model.vias, vias);
        assert.equal(vias[0], untouched);
        assert.equal(vias[1], peer);
        if (index > 0) assert.equal(vias[2], via);
    }
    for (let index = 1; index < states.length; index++) {
        assert.equal(history.redo(), true);
        assert.deepEqual(state(), states[index], `Redo restores step ${index}`);
        assert.equal(model.vias, vias);
        if (index < states.length - 1) assert.equal(vias[2], via);
    }
}
remove.execute();
assert.deepEqual(vias, [untouched, peer], 'Absent removal leaves other vias untouched');
remove.undo();
remove.undo();
assert.deepEqual(vias, [untouched, peer, via], 'Repeated removal undo never duplicates a via');
const partial = new ModifyViaCommand(via, { net: via.net }, { net: 'PARTIAL' });
const beforePartial = via.captureState();
partial.execute();
assert.deepEqual(via.captureState(), { ...beforePartial, net: 'PARTIAL' }, 'Sparse property edits retain other fields');
partial.undo();
assert.deepEqual(via.captureState(), beforePartial);
assert.deepEqual(track.captureState(), trackState, 'Standalone via commands do not mutate connected track geometry');
assert.deepEqual(other.vias, [otherVia]);
assert.deepEqual(otherVia.captureState(), otherState);
for (const target of vias) assert.equal('_svgElements' in target, false, 'Model commands never create render state');
assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
console.log('PASS DOM-free via history, owned batch snapshots, normalization, identity, precision and model isolation');
