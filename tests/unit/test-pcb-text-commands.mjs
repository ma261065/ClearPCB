import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { createPcbText, serializePcbText } from '../../src/core/pcb-text.js';
import { AddTextCommand, RemoveTextCommand, MoveTextCommand, EditTextCommand } from '../../src/core/pcb-text-commands.js';

assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
const model = new PcbDocument();
const other = new PcbDocument();
const texts = model.texts;
const history = new CommandHistory();
const state = () => [...model.texts.values()].map(serializePcbText);
const states = [state()];
const text = createPcbText({ id: 'headless-text', content: 'Original', x: 1.234567, y: -2.345678,
    size: 1.234567, strokeWidth: 0.123456, rotation: 12.345678, layer: 'bottom-copper', border: true });
const original = serializePcbText(text);
history.execute(new AddTextCommand(model, text));
assert.equal(model.texts.get(text.id), text);
assert.equal(history.getUndoDescription(), 'Add text "Original"');
states.push(state());
history.execute(new MoveTextCommand(model, text.id, text.x, text.y, Math.PI, -Math.E));
assert.equal(model.texts.get(text.id), text, 'Movement preserves entity identity');
assert.equal(text.x, Math.PI);
states.push(state());
const patch = { content: 'Edited', rotation: 98.7654321, size: 2.3456789, border: false };
const edit = new EditTextCommand(model, text.id, patch);
patch.content = 'Changed caller data';
history.execute(edit);
assert.equal(text.content, 'Edited', 'The command owns its captured patch');
assert.equal(model.texts.get(text.id), text, 'Property edits preserve entity identity');
states.push(state());
history.execute(new RemoveTextCommand(model, text.id));
assert.equal(model.texts.size, 0);
assert.equal(history.getUndoDescription(), 'Delete text "Edited"');
states.push(state());
for (let index = states.length - 2; index >= 0; index--) {
    assert.equal(history.undo(), true);
    assert.deepEqual(state(), states[index], `Undo restores step ${index} at full precision`);
}
for (let index = 1; index < states.length; index++) {
    assert.equal(history.redo(), true);
    assert.deepEqual(state(), states[index], `Redo restores step ${index} after deletion recreated the text`);
}
assert.equal(model.texts, texts, 'Commands retain the model collection');
assert.equal(other.texts.size, 0, 'Operations remain scoped to the owning model');
history.undo();
history.undo();
history.undo();
assert.deepEqual(state(), [original]);
const restored = model.texts.get(text.id);
assert.notEqual(restored, text, 'Deletion undo retains snapshot-based restoration');
const saved = model.serializeEntities().texts[0];
assert.equal(saved.x, 1.2346);
assert.equal(restored.x, original.x, 'File rounding never alters command state');

assert.throws(() => new RemoveTextCommand(model, 'missing'), /no longer available/);
assert.throws(() => new EditTextCommand(model, 'missing', { content: 'Fail' }), /no longer available/);
assert.throws(() => new MoveTextCommand(model, 'missing', 0, 0, 1, 1).execute(), /no longer available/);
const stale = new EditTextCommand(model, text.id, { content: 'Stale' });
model.clear();
assert.throws(() => stale.execute(), /no longer available/);
assert.equal(model.texts, texts);
assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
console.log('PASS DOM-free PCB text commands, full undo/redo chains, identity, precision and model isolation');
