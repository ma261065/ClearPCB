import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { createPcbText, serializePcbText } from '../src/core/pcb-text.js';
import { AddTextCommand, EditTextCommand, RemoveTextCommand, beginTextContentPreview, getTextPosePreviewTexts } from '../src/pcb/modules/text-commands.js';
import { RemoveTextCommand as ModelRemoveTextCommand } from '../src/core/pcb-text-commands.js';
import { CompoundCommand } from '../src/pcb/modules/track-commands.js';
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
    const renders = [], removals = [], clearances = [], historyChanges = [];
    let destroyed = 0, inputRemoved = 0, cleared = 0, exited = 0;
    const app = {
        pcbDocument, history: new CommandHistory({ onChanged: change => historyChanges.push(change) }),
        _renderText: current => renders.push({ ...current }),
        refreshText(id) { const current = this.texts.get(id); if (current) this._renderText(current); },
        _removeTextElement: id => removals.push(id),
        _refreshBoardShapeClearance: current => clearances.push({ ...current }),
        clearProperties: () => cleared++, setActiveRibbonTab: tab => { if (tab === 'pcb-home') exited++; },
        selectText: PCBApp.prototype.selectText,
    };
    Object.defineProperty(app, 'texts', Object.getOwnPropertyDescriptor(PCBApp.prototype, 'texts'));
    if (isNew) app.history.execute(new AddTextCommand(app, text));
    else app.texts.set(text.id, text);
    setPcbSelection(app, [{ kind: 'text', object: text }]);
    const state = {
        text: beginTextContentPreview(app, text.id), originalContent: text.content, isNewPlacement: isNew, options: {},
        input: { value: text.content, parentNode: { removeChild: () => inputRemoved++ } },
        overlay: { destroy: () => destroyed++ },
    };
    app._textEdit = state;
    renders.length = 0;
    const preview = value => {
        state.text.content = value;
        state.input.value = value;
        assert.equal(text.content, original.content, 'Typing never authors content before commit');
    };
    const finish = commit => PCBApp.prototype._endTextInlineEdit.call(app, commit);
    const verifyTeardown = () => {
        assert.equal(app._textEdit, null);
        assert.equal(getTextPosePreviewTexts(app), undefined);
        assert.equal(state.committed, true);
        assert.equal(destroyed, 1);
        assert.equal(inputRemoved, 1);
        assert.equal(cleared, 1);
        assert.equal(exited, 1);
        assert.deepEqual(getPcbSelection(app), []);
    };
    return { app, text, original, renders, removals, clearances, historyChanges, preview, finish, verifyTeardown };
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
        f.preview('Failed content');
        f.app.history.execute = () => { throw new Error('Injected history failure'); };
        assert.throws(() => f.finish(true), /Injected history failure/);
        assert.deepEqual(f.text, f.original);
        assert.deepEqual(f.renders.at(-1), f.original);
        f.verifyTeardown();
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

for (const commit of [false, true]) for (const undoneStyle of [false, true]) {
    const f = fixture({ isNew: true });
    const execute = ModelRemoveTextCommand.prototype.execute;
    let modelRemovals = 0;
    ModelRemoveTextCommand.prototype.execute = function () { modelRemovals++; return execute.call(this); };
    try {
        if (undoneStyle) {
            f.app.history.execute(new EditTextCommand(f.app, f.text.id, { size: Math.PI }));
            f.app.history.undo();
            assert.equal(f.app.history.redoStack.length, 1);
        }
        f.preview(commit ? ' \t ' : 'Cancelled new label');
        f.finish(commit);
        assert.equal(modelRemovals, 1, 'New-placement disposal executes the model-owned Remove command');
        assert.equal(f.app.texts.size, 0);
        assert.equal(f.app.history.undoStack.length, 0, 'Untouched placement cancellation leaves no history entry');
        assert.equal(f.app.history.redoStack.length, 0, 'Discarded placement/style cannot be resurrected by redo');
        assert.equal(f.app.history.undo(), false);
        assert.equal(f.app.history.redo(), false);
        assert.equal(f.historyChanges.at(-1).canUndo, false, 'History controls are notified after removing the Add');
        assert.equal(f.historyChanges.at(-1).canRedo, false);
        assert.equal(f.renders.length, undoneStyle ? 2 : 0);
        assert.deepEqual(f.removals, [f.text.id]);
        f.verifyTeardown();
    } finally {
        ModelRemoveTextCommand.prototype.execute = execute;
        cancelPictureCopperRefresh(f.app);
    }
}

for (const commit of [false, true]) for (const edits of ['style', 'other-text', 'compound', 'trimmed-add']) {
    const f = fixture({ isNew: true });
    try {
        const other = createPcbText({ id: 'other', content: 'Independent', x: Math.E, y: Math.PI });
        f.app.pcbDocument.texts.set(other.id, other);
        const geometry = () => {
            const snapshot = f.app.pcbDocument.captureGeometry();
            // Existing Remove undo appends the restored text to the Map.
            snapshot.texts.sort((a, b) => a.id.localeCompare(b.id));
            return snapshot;
        };
        const initial = geometry();
        const add = f.app.history.undoStack[0];
        const style = () => new EditTextCommand(f.app, f.text.id,
            { size: 2.345678912, strokeWidth: 0.234567891, rotation: 73.123456789, border: true });
        const independent = () => new EditTextCommand(f.app, other.id, { content: 'Independent edit', x: -Math.PI });
        if (edits === 'other-text') f.app.history.execute(independent());
        else if (edits === 'compound') f.app.history.execute(new CompoundCommand([style(), independent()]));
        else {
            if (edits === 'trimmed-add') f.app.history.maxSize = 2;
            f.app.history.execute(style());
            if (edits === 'trimmed-add') f.app.history.execute(independent());
        }
        const prior = [...f.app.history.undoStack];
        const styled = serializePcbText(f.app.pcbDocument.texts.get(f.text.id));
        const otherState = serializePcbText(other);
        const beforeRemoval = geometry();
        // Keep the retained commands available while testing their full undo chain.
        f.app.history.maxSize = 100;
        f.preview(commit ? '   ' : 'Cancelled new label');
        f.renders.length = 0;
        f.finish(commit);
        assert.equal(f.renders.length, 0, 'Discarding new text requires removal, not a rollback redraw');
        assert.equal(f.app.texts.has(f.text.id), false);
        assert.deepEqual(serializePcbText(other), otherState, 'Independent authored edits survive cancellation');
        assert.deepEqual(f.app.history.undoStack.slice(0, -1), prior, 'Intervening commands retain their order and identity');
        assert.ok(f.app.history.undoStack.at(-1) instanceof RemoveTextCommand);
        assert.deepEqual(f.removals, [f.text.id]);
        f.verifyTeardown();
        f.app.history.undo();
        assert.deepEqual(serializePcbText(f.app.texts.get(f.text.id)), styled, 'Undo removal restores exact committed styles, not typed content');
        assert.deepEqual(geometry(), beforeRemoval);
        f.app.history.redo();
        assert.equal(f.app.texts.has(f.text.id), false);
        f.app.history.undo();
        for (const command of [...prior].reverse()) {
            f.app.history.undo();
            if (command === add) assert.equal(f.app.texts.has(f.text.id), false);
        }
        if (edits === 'trimmed-add') assert.deepEqual(geometry(), initial);
        else assert.deepEqual(serializePcbText(other), serializePcbText(createPcbText({
            id: 'other', content: 'Independent', x: Math.E, y: Math.PI,
        })));
        while (f.app.history.redo()) {}
        assert.equal(f.app.texts.has(f.text.id), false, 'Complete redo reaches the cancelled/blank final state');
        assert.deepEqual(serializePcbText(other), otherState);
    } finally { cancelPictureCopperRefresh(f.app); }
}

for (const withStyle of [false, true]) {
    const f = fixture({ isNew: true });
    const execute = ModelRemoveTextCommand.prototype.execute;
    try {
        if (withStyle) f.app.history.execute(new EditTextCommand(f.app, f.text.id, { size: Math.PI }));
        const before = f.app.pcbDocument.captureGeometry(), history = [...f.app.history.undoStack];
        ModelRemoveTextCommand.prototype.execute = () => { throw new Error('Injected model removal failure'); };
        f.preview('Cancelled content');
        assert.throws(() => f.finish(false), /Injected model removal failure/);
        assert.deepEqual(f.app.pcbDocument.captureGeometry(), before);
        assert.deepEqual(f.app.history.undoStack, history, 'Failed removal never prunes the Add or independent edits');
        f.verifyTeardown();
    } finally {
        ModelRemoveTextCommand.prototype.execute = execute;
        cancelPictureCopperRefresh(f.app);
    }
}

delete globalThis.document;
delete globalThis.window;
console.log('PASS standalone text inline handoff, cancellation, deletion, new-placement cleanup and precise history');
