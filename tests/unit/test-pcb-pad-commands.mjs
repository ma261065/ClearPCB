import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { Pad } from '../../src/shapes/pad.js';
import { AddPadCommand, RemovePadCommand, ModifyPadCommand, MovePadCommand } from '../../src/core/pcb-pad-commands.js';

assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
const model = new PcbDocument();
const other = new PcbDocument();
const pads = model.pads;
const untouched = new Pad({ id: 'untouched', x: 50, y: 50 });
model.pads.push(untouched);
const otherPad = new Pad({ id: 'other-project', x: -50, y: -50 });
other.pads.push(otherPad);
const otherState = otherPad.captureState();
const pad = new Pad({ id: 'authored-pad', x: 1.234567, y: -2.345678, shape: 'rectangle',
    size: 1.234567, drill: 0.345678, ratio: 2.345678, rotation: 23.456789,
    layers: 'bottom-copper', net: 'GND', locked: true, visible: false });
const original = pad.captureState();
const state = () => model.pads.map(item => item.captureState());
const states = [state()];
const history = new CommandHistory();
const add = new AddPadCommand(model, pad);
history.execute(add);
add.execute();
assert.equal(model.pads.length, 2, 'Repeated add does not duplicate an entity');
states.push(state());
const from = { x: pad.x, y: pad.y }, to = { x: Math.PI, y: -Math.E };
const move = new MovePadCommand(pad, from, to);
from.x = 999;
to.y = 999;
history.execute(move);
assert.equal(pad.x, Math.PI);
assert.equal(pad.y, -Math.E, 'Movement retains captured full-precision coordinates');
states.push(state());
const before = pad.captureState();
const after = { ...before, id: 'must-not-replace-id', size: 2.3456789, drill: 0.456789,
    shape: 'oval', ratio: 3.456789, rotation: -90.123456, layers: 'both',
    net: 'SIGNAL', locked: false, visible: true };
const modify = new ModifyPadCommand(pad, before, after);
before.net = 'caller changed before';
after.net = 'caller changed after';
history.execute(modify);
assert.equal(pad.id, original.id, 'Applying state preserves entity ID');
assert.equal(pad.net, 'SIGNAL', 'Undo/redo inputs belong to the command, not its caller');
assert.equal(pad.rotation, ((-90.123456 % 360) + 360) % 360);
assert.equal(pad.size, 2.3456789);
assert.equal(model.serializeEntities().pads[1].s, 2.3457);
assert.equal(pad.size, 2.3456789, 'Saving does not round live command data');
states.push(state());
const remove = new RemovePadCommand(model, pad);
history.execute(remove);
states.push(state());
for (let cycle = 0; cycle < 2; cycle++) {
    for (let index = states.length - 2; index >= 0; index--) {
        assert.equal(history.undo(), true);
        assert.deepEqual(state(), states[index], `Undo restores step ${index}`);
        assert.equal(model.pads, pads, 'Undo preserves collection identity');
        if (index > 0) assert.equal(model.pads[1], pad, 'Undo preserves pad identity');
    }
    for (let index = 1; index < states.length; index++) {
        assert.equal(history.redo(), true);
        assert.deepEqual(state(), states[index], `Redo restores step ${index}`);
        assert.equal(model.pads, pads, 'Redo preserves collection identity');
        if (index < states.length - 1) assert.equal(model.pads[1], pad, 'Redo preserves pad identity');
    }
}
remove.execute();
assert.deepEqual(model.pads, [untouched], 'Removing an absent entity leaves other pads alone');
remove.undo();
remove.undo();
assert.deepEqual(model.pads, [untouched, pad], 'Repeated removal undo does not duplicate the pad');
assert.equal(model.pads, pads);
assert.deepEqual(otherPad.captureState(), otherState);
assert.deepEqual(other.pads, [otherPad], 'Commands do not affect another document');
assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
console.log('PASS DOM-free pad commands, captured undo inputs, stable collections/entities and full-precision history');
