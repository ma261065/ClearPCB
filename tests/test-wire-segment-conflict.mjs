import assert from 'node:assert/strict';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { Wire } from '../src/shapes/wire.js';
import { Net } from '../src/shapes/net.js';

globalThis.window = { addEventListener() {} };
const { commitSegmentDrag } = await import('../src/ui/modules/drag.js');
const wire = new Wire({ points: [{ x: 0, y: -5 }, { x: 10, y: -5 }] });
const firstNet = new Net({ x: 0, y: 0, net: 'VCC' });
const secondNet = new Net({ x: 10, y: 0, net: 'GND' });
const before = wire.captureState();
const alerts = [];
let renders = 0;
const app = {
    shapes: [wire, firstNet, secondNet], components: [], history: new CommandHistory(),
    renderShapes() { renders++; },
    _alert(message) { alerts.push(message); },
};
const earlierCommand = { description: 'Earlier edit', execute() {}, undo() { assert.fail('Earlier edit must not be undone'); } };
app.history.record(earlierCommand);
wire.move(0, 5);
assert.equal(commitSegmentDrag(app, wire, new Map([[wire, before]])), false);
assert.equal(alerts.length, 1);
assert.match(alerts[0], /GND.*VCC/);
assert.deepEqual([...wire.nodes.values()].map(({ x, y }) => ({ x, y })), [{ x: 0, y: -5 }, { x: 10, y: -5 }]);
assert.equal(wire.pinConnections.size, 0);
assert.deepEqual(app.history.undoStack, [earlierCommand]);
assert.equal(app.history.redoStack.length, 0);
assert.ok(renders > 0);
wire.move(0, -1);
assert.equal(commitSegmentDrag(app, wire, new Map([[wire, before]])), true);
assert.equal(app.history.undoStack.length, 2);
app.history.undo();
assert.deepEqual([...wire.nodes.values()].map(({ x, y }) => ({ x, y })), [{ x: 0, y: -5 }, { x: 10, y: -5 }]);
console.log('PASS conflicting segment move rolls back geometry/connections and preserves earlier history; valid moves remain undoable');