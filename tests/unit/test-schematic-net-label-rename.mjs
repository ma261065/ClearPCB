import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = { addEventListener() {}, removeEventListener() {}, getElementById: () => null };
const { endTextEdit } = await import('../../src/schematic/modules/text-edit.js');
const { CommandHistory } = await import('../../src/core/CommandHistory.js');

const wireShape = (id, net, pinConnections = new Map()) => ({ id, type: 'wire', net, wireLabel: `W_${id}`,
    nodes: new Map(), edges: new Map(), pinConnections, nodeAt: () => null, invalidate() {} });
const fieldText = (id, text, fieldKey, parentComponent) => ({ id, type: 'text', text, fieldKey, parentComponent,
    invalidate() {}, applyState(state) { Object.assign(this, state); } });
function editor(shapes) {
    let panelRefreshes = 0;
    const app = {
        shapes, components: [],
        selection: { getSelection: () => [], isSelected: () => true, select() {} },
        history: new CommandHistory(),
        renderShapes() {}, alert(message) { throw new Error(`Unexpected alert: ${message}`); },
        updatePropertiesPanel() { panelRefreshes++; },
        get panelRefreshes() { return panelRefreshes; },
    };
    return app;
}
/** Simulate typing a new value into an inline text edit and committing it. */
function renameInline(app, text, value) {
    app.textEdit = { shape: text, originalText: text.text, caretIndex: text.text.length };
    text.text = value;
    endTextEdit(app, true);
}

{
    // Inline-renaming a Net label's text renames the label and the wires attached to it, undoably.
    const netLabel = { id: 'net-1', type: 'net', net: 'OLD', x: 0, y: 0, invalidate() {} };
    const wire = wireShape('wire-1', 'OLD', new Map([['n0', { componentId: 'net-1' }]]));
    const unrelated = wireShape('wire-2', 'OTHER');
    const text = fieldText('text-1', 'OLD', 'net', netLabel);
    const app = editor([netLabel, wire, unrelated, text]);
    renameInline(app, text, 'NEW');
    assert.equal(netLabel.net, 'NEW', 'The Net label adopts its edited text');
    assert.equal(wire.net, 'NEW', 'Attached wires follow the renamed Net label');
    assert.equal(unrelated.net, 'OTHER', 'Unattached wires keep their net');
    assert.equal(app.textEdit, null);
    assert.ok(app.panelRefreshes > 0);
    app.history.undo();
    assert.deepEqual([text.text, netLabel.net, wire.net], ['OLD', 'OLD', 'OLD'], 'Undo restores the label and its wires');
    app.history.redo();
    assert.deepEqual([text.text, netLabel.net, wire.net], ['NEW', 'NEW', 'NEW']);
}

for (const fieldKey of ['label', 'wireLabel']) {
    // Inline-renaming a wire's label text renames the wire, and undo restores its name.
    const wire = wireShape('wire-3', 'SIG');
    const text = fieldText('text-3', 'W_wire-3', fieldKey, wire);
    const app = editor([wire, text]);
    renameInline(app, text, 'DATA');
    assert.equal(wire.wireLabel, 'DATA', `A ${fieldKey} edit renames the wire`);
    assert.equal(Object.hasOwn(wire, 'label'), false, `A ${fieldKey} edit does not invent a wire.label property`);
    app.history.undo();
    assert.equal(text.text, 'W_wire-3');
    assert.equal(wire.wireLabel, 'W_wire-3', `Undoing a ${fieldKey} edit restores the wire's name`);
    app.history.redo();
    assert.equal(wire.wireLabel, 'DATA');
}
console.log('PASS inline Net-label and wire-label renames update their parents and undo cleanly');
