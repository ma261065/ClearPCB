import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { AddFillCommand, RemoveFillCommand, ModifyFillCommand } from '../src/core/pcb-fill-commands.js';

assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
const model = new PcbDocument();
const other = new PcbDocument();
const shapes = model.boardShapes;
const graphic = { id: 'graphic', kind: 'circle', layer: 'top-silk', x: 100, y: 100, radius: 1, lineWidth: 0.2 };
shapes.push(graphic);
const fill = new CopperFill({ id: 'authored-fill', kind: 'polygon', net: 'GND', layer: 'top-copper',
    outline: [{ x: 1.234567, y: -2.345678 }, { x: 15, y: -2.345678 }, { x: 10, y: -15 }],
    cornerRadius: 0.234567, nodeCornerRadii: { 0: 0.345678 }, segmentBulges: { 1: 0.123456 } });
const state = () => shapes.map(shape => shape.type === 'fill' ? shape.captureState() : structuredClone(shape));
const states = [state()];
const history = new CommandHistory();
const add = new AddFillCommand(model, fill);
history.execute(add);
add.execute();
assert.equal(shapes.length, 2, 'Repeated add never duplicates the fill');
states.push(state());
const before = fill.captureState();
const after = { ...fill.captureState(), kind: 'circle', net: 'POWER', layer: 'bottom-copper',
    x: Math.PI, y: -Math.E, radius: 3.123456, cornerRadius: 0.456789,
    nodeCornerRadii: { 2: 0.567891 }, segmentBulges: { 0: -0.234567 },
    locked: true, visible: false };
const expectedAfter = structuredClone(after);
const modify = new ModifyFillCommand(fill, before, after);
for (const snapshot of [before, after]) {
    snapshot.outline[0].x = 999;
    snapshot.nodeCornerRadii[0] = 999;
    snapshot.segmentBulges[0] = 999;
    snapshot.net = 'Caller changed snapshot';
}
history.execute(modify);
assert.deepEqual(fill.captureState(), expectedAfter, 'Nested authored snapshots belong to the command');
assert.equal(model.serializeEntities().boardShapes[1].radius, 3.1235);
assert.equal(fill.radius, 3.123456, 'Save rounding leaves live command state unchanged');
fill.outline[0].x = 888;
fill.nodeCornerRadii[2] = 888;
fill.segmentBulges[0] = 888;
modify.execute();
assert.deepEqual(fill.captureState(), expectedAfter, 'Applying a snapshot never exposes it to later entity edits');
states.push(state());
const remove = new RemoveFillCommand(model, fill);
history.execute(remove);
states.push(state());
for (let cycle = 0; cycle < 2; cycle++) {
    for (let index = states.length - 2; index >= 0; index--) {
        assert.equal(history.undo(), true);
        assert.deepEqual(state(), states[index], `Undo restores authored step ${index}`);
        assert.equal(model.boardShapes, shapes);
        assert.equal(shapes[0], graphic);
        if (index > 0) assert.equal(shapes[1], fill, 'Undo preserves fill identity');
    }
    for (let index = 1; index < states.length; index++) {
        assert.equal(history.redo(), true);
        assert.deepEqual(state(), states[index], `Redo restores authored step ${index}`);
        assert.equal(model.boardShapes, shapes);
        assert.equal(shapes[0], graphic);
        if (index < states.length - 1) assert.equal(shapes[1], fill, 'Redo preserves fill identity');
    }
}
remove.execute();
assert.deepEqual(shapes, [graphic], 'Removing an absent fill cannot remove another board shape');
remove.undo();
remove.undo();
assert.deepEqual(shapes, [graphic, fill], 'Repeated undo does not duplicate a fill');
assert.equal(fill._computed, null, 'Authored commands do not compute derived pours');
assert.deepEqual(other.boardShapes, [], 'Collection operations remain scoped to their model');
assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
console.log('PASS DOM-free fill commands, detached nested snapshots, identity, precision and complete undo/redo');
