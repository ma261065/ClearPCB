import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { createPcbText, serializePcbText } from '../src/core/pcb-text.js';
import { AddTextCommand, EditTextCommand } from '../src/pcb/modules/text-commands.js';
import { cancelPictureCopperRefresh } from '../src/pcb/modules/picture-refresh.js';
import { setPcbSelection, getPcbSelection } from '../src/pcb/modules/selection-registry.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById: () => null };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

function fixture({ isNew = false, content = 'Original' } = {}) {
    const text = createPcbText({ id: 'label', content: isNew ? '' : content,
        x: Math.PI, y: -Math.E, size: 1.234567, strokeWidth: 0.123456, rotation: 37.123456 });
    const original = { ...text };
    const pcbDocument = new PcbDocument();
    const renders = [], removals = [], clearances = [];
    let destroyed = 0, inputRemoved = 0, cleared = 0, exited = 0;
    const app = {
        pcbDocument, texts: pcbDocument.texts, history: new CommandHistory(),
        _renderText: current => renders.push({ ...current }),
        _refreshText(id) { const current = this.texts.get(id); if (current) this._renderText(current); },
        _removeTextElement: id => removals.push(id),
        _refreshBoardShapeClearance: current => clearances.push({ ...current }),
        _clearProperties: () => cleared++, _exitTextTool: () => exited++,
        _selectText: PCBApp.prototype._selectText,
    };
    if (isNew) app.history.execute(new AddTextCommand(app, text));
    else app.texts.set(text.id, text);
    setPcbSelection(app, [{ kind: 'text', object: text }]);
    const state = {
        text, originalContent: text.content, isNewPlacement: isNew, options: {},
        input: { value: text.content, parentNode: { removeChild: () => inputRemoved++ } },
        overlay: { destroy: () => destroyed++ },
    };
    app._textEdit = state;
    renders.length = 0;
    const preview = value => { text.content = value; state.input.value = value; };
    const finish = commit => PCBApp.prototype._endTextInlineEdit.call(app, commit);
    const verifyTeardown = () => {
        assert.equal(app._textEdit, null);
        assert.equal(state.committed, true);
        assert.equal(destroyed, 1);
        assert.equal(inputRemoved, 1);
        assert.equal(cleared, 1);
        assert.equal(exited, 1);
        assert.deepEqual(getPcbSelection(app), []);
    };
    return { app, text, original, renders, removals, clearances, preview, finish, verifyTeardown };
}

for (const isNew of [false, true]) {
    const f = fixture({ isNew });
    try {
        f.preview('  Edited label  ');
        f.finish(true);
        assert.ok(f.renders.length > 0 && f.renders.every(text => text.content === '  Edited label  '),
            'Text commit must render only final content, never the temporary undo-capture rollback');
        assert.equal(f.app.history.undoStack.length, isNew ? 2 : 1);
        f.verifyTeardown();
        cancelPictureCopperRefresh(f.app);
        assert.equal(f.clearances.at(-1).content, '  Edited label  ');
        f.app.history.undo();
        assert.deepEqual(f.text, f.original, 'Undo restores exact content and leaves precise geometry untouched');
        cancelPictureCopperRefresh(f.app);
        assert.deepEqual(f.clearances.at(-1), f.original);
        f.app.history.redo();
        assert.equal(f.text.content, '  Edited label  ', 'Standalone text retains intentional whitespace');
    } finally { cancelPictureCopperRefresh(f.app); }
}

for (const commit of [false, true]) {
    const f = fixture();
    try {
        f.preview(commit ? 'Original' : 'Cancelled preview');
        f.app.history.execute(new EditTextCommand(f.app, f.text.id, { size: 2.345678 }));
        f.renders.length = 0;
        f.finish(commit);
        assert.equal(f.text.content, 'Original');
        assert.equal(f.text.size, 2.345678, 'Content completion preserves a separately committed style edit');
        assert.ok(f.renders.length > 0 && f.renders.every(text => text.content === 'Original'));
        assert.equal(f.app.history.undoStack.length, 1, 'Cancel and unchanged content add no history');
        f.verifyTeardown();
        f.app.history.undo();
        assert.deepEqual(f.text, f.original);
    } finally { cancelPictureCopperRefresh(f.app); }
}

{
    const f = fixture();
    try {
        f.preview('   ');
        f.finish(true);
        assert.equal(f.renders.length, 0, 'Deleting text must not repaint the old content first');
        assert.deepEqual(f.removals, [f.text.id]);
        assert.equal(f.app.texts.size, 0);
        assert.equal(f.app.history.undoStack.length, 1);
        f.verifyTeardown();
        f.app.history.undo();
        assert.deepEqual(f.app.texts.get(f.text.id), serializePcbText(f.original),
            'Deleting blank content captures the pre-preview text with the existing snapshot defaults');
        f.app.history.redo();
        assert.equal(f.app.texts.size, 0);
    } finally { cancelPictureCopperRefresh(f.app); }
}

for (const commit of [false, true]) {
    const f = fixture({ isNew: true });
    try {
        const unrelated = { execute() {}, undo() {} };
        f.app.history.execute(unrelated);
        f.preview(commit ? '   ' : 'Cancelled new label');
        f.finish(commit);
        assert.equal(f.renders.length, 0, 'Discarding new text requires removal, not a rollback redraw');
        assert.equal(f.app.texts.size, 0);
        assert.deepEqual(f.app.history.undoStack, [unrelated], 'Only this cancelled placement is removed from history');
        assert.deepEqual(f.removals, [f.text.id]);
        f.verifyTeardown();
    } finally { cancelPictureCopperRefresh(f.app); }
}

delete globalThis.document;
delete globalThis.window;
console.log('PASS standalone text inline handoff, cancellation, deletion, new-placement cleanup and precise history');
