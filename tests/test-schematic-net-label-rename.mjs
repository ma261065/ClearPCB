import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = { addEventListener() {}, removeEventListener() {}, getElementById: () => null };
const { endTextEdit } = await import('../src/ui/modules/text-edit.js');

// Inline-renaming a Net label's text propagates the new name to the wires attached to it.
const netLabel = { id: 'net-1', type: 'net', net: 'OLD', x: 0, y: 0, invalidate() {} };
const wire = { id: 'wire-1', type: 'wire', net: 'OLD', nodes: new Map(), edges: new Map(), pinConnections: new Map([['n0', { componentId: 'net-1' }]]),
    nodeAt: () => null, invalidate() {} };
const unrelated = { id: 'wire-2', type: 'wire', net: 'OTHER', nodes: new Map(), edges: new Map(), pinConnections: new Map(), nodeAt: () => null, invalidate() {} };
const text = { id: 'text-1', type: 'text', text: 'NEW', fieldKey: 'net', parentComponent: netLabel, invalidate() {},
    applyState(state) { Object.assign(this, state); } };
let panelRefreshes = 0;
const app = {
    shapes: [netLabel, wire, unrelated, text], components: [],
    textEdit: { shape: text, originalText: 'OLD', caretIndex: 3 },
    selection: { getSelection: () => [], isSelected: () => true, select() {} },
    history: { execute(command) { command.execute(); } },
    renderShapes() {}, _alert(message) { throw new Error(`Unexpected alert: ${message}`); },
    _updatePropertiesPanel() { panelRefreshes++; },
};

endTextEdit(app, true);
assert.equal(text.text, 'NEW');
assert.equal(netLabel.net, 'NEW', 'The Net label adopts its edited text');
assert.equal(wire.net, 'NEW', 'Attached wires follow the renamed Net label');
assert.equal(unrelated.net, 'OTHER', 'Unattached wires keep their net');
assert.equal(app.textEdit, null);
assert.ok(panelRefreshes > 0);
console.log('PASS inline Net-label rename propagates to attached wires');
