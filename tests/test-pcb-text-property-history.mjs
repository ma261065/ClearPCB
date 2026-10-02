import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { createPcbText } from '../src/core/pcb-text.js';
import { measureText } from '../src/shared/pcb/stroke-font.js';
import { cancelPictureCopperRefresh } from '../src/pcb/modules/picture-refresh.js';
import { EditTextCommand, getTextPosePreviewTexts } from '../src/pcb/modules/text-commands.js';
import { createPcbTextSelectionAdapter } from '../src/pcb/modules/pcb-text-selection.js';
import { getPropertyEditor } from '../src/pcb/modules/property-editors.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById: () => null, querySelector: () => null };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

class Input {
    constructor(value) { this.value = String(value); this.listeners = new Map(); }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }
    fire(type, value = this.value) {
        this.value = String(value);
        for (const listener of this.listeners.get(type) || []) listener({ type });
    }
}

function fixture(options = {}) {
    const text = createPcbText({ id: 'label', content: 'R12', x: Math.PI, y: -Math.E,
        size: 1.234567, strokeWidth: 0.1234567, rotation: 37.1234567, ...options });
    const inputs = new Map(Object.entries({
        pcbPropTextLayer: text.layer, pcbPropTextSize: text.size, pcbPropTextRot: text.rotation,
        pcbPropTextLW: text.strokeWidth, pcbPropTextBorder: text.border,
    }).map(([id, value]) => [id, new Input(value)]));
    const items = { innerHTML: '', querySelector: selector => inputs.get(selector.slice(1)) || null };
    const pcbDocument = new PcbDocument();
    pcbDocument.texts.set(text.id, text);
    const renders = [];
    const clearances = [];
    const app = {
        pcbDocument, history: new CommandHistory(),
        _pcbPropsItems: () => items, _setPcbPropsTitle() {}, _layerLabel: layer => layer,
        _bindStrokeTextProps: PCBApp.prototype._bindStrokeTextProps,
        refreshText: () => renders.push({ ...app.texts.get(text.id) }),
        _refreshBoardShapeClearance: current => clearances.push({ ...current }),
    };
    Object.defineProperty(app, 'texts', Object.getOwnPropertyDescriptor(PCBApp.prototype, 'texts'));
    PCBApp.prototype._showTextProperties.call(app, text);
    return { app, text, inputs, renders, clearances };
}

for (const [id, field, intermediate, final] of [
    ['pcbPropTextSize', 'size', 2, 2.3456789],
    ['pcbPropTextLW', 'strokeWidth', 0.2, 0.2345678],
    ['pcbPropTextRot', 'rotation', 60, 90],
]) {
    const { app, text, inputs, renders, clearances } = fixture();
    try {
        const original = { ...text };
        const input = inputs.get(id);
        input.fire('input', intermediate);
        input.fire('input', final);
        assert.equal(app.texts.get(text.id)[field], final, 'Input previews immediately');
        assert.deepEqual(text, original, 'Property input leaves authored text unchanged');
        assert.equal(app.history.undoStack.length, 0, 'Keystrokes do not create commands');
        const beforeCommitRenders = renders.length;
        input.fire('change');
        assert.equal(app.history.undoStack.length, 1, 'One command per committed edit');
        assert.equal(text[field], final);
        assert.ok(renders.slice(beforeCommitRenders).every(state => state[field] === final),
            'Commit must not repaint the temporary rollback');
        cancelPictureCopperRefresh(app);
        assert.equal(clearances.at(-1)[field], final);
        app.history.undo();
        assert.deepEqual(text, original, 'Undo must restore the pre-preview state at full precision');
        assert.deepEqual(renders.at(-1), original, 'Undo refreshes presentation from the model');
        cancelPictureCopperRefresh(app);
        assert.deepEqual(clearances.at(-1), original, 'Undo refreshes derived clearance');
        app.history.redo();
        assert.equal(text[field], final);
        assert.equal(renders.at(-1)[field], final);
        assert.equal(app.pcbDocument.texts.get(text.id), text, 'History preserves model identity');
    } finally { cancelPictureCopperRefresh(app); }
}

for (const rotation of [0, 37, 90]) {
    for (const [layer, next] of [
        ['top-silk', 'bottom-copper'], ['bottom-silk', 'top-document'], ['top-silk', 'top-copper'],
    ]) {
        const { app, text, inputs } = fixture({ layer, rotation });
        try {
            const original = { ...text };
            const input = inputs.get('pcbPropTextLayer');
            input.fire('input', next);
            const oppositeSide = layer.startsWith('bottom-') !== next.startsWith('bottom-');
            const shift = oppositeSide ? measureText(original.content, original.size)
                * (next.startsWith('bottom-') ? 1 : -1) : 0;
            const expected = { ...original, layer: next,
                x: original.x + shift * Math.cos(rotation * Math.PI / 180),
                y: original.y - shift * Math.sin(rotation * Math.PI / 180) };
            assert.deepEqual(app.texts.get(text.id), expected, 'Layer preview retains the existing anchor compensation');
            assert.deepEqual(text, original);
            input.fire('change');
            assert.deepEqual(text, expected, 'Repeated change handler must not shift the anchor again');
            app.history.undo();
            assert.deepEqual(text, original, 'Undo restores layer and both anchor coordinates');
            app.history.redo();
            assert.deepEqual(text, expected);
        } finally { cancelPictureCopperRefresh(app); }
    }
}

{
    const { app, text, inputs } = fixture();
    try {
        const input = inputs.get('pcbPropTextSize');
        const original = text.size;
        input.fire('change', 2.25);
        assert.equal(text.size, 2.25, 'Change-only spinner events still apply');
        app.history.undo();
        assert.equal(text.size, original);
        app.history.redo();
        input.fire('input', '');
        input.fire('change', '');
        assert.equal(text.size, 2.25, 'Blank input preserves the last valid value');
        assert.equal(app.history.undoStack.length, 1);
        input.fire('input', 3);
        input.fire('change', 2.25);
        assert.equal(app.history.undoStack.length, 1, 'Returning to the initial value adds no command');
        input.fire('change', 4);
        app.history.undo();
        assert.equal(text.size, 2.25, 'Each later edit starts a fresh snapshot');
        app.history.undo();
        assert.equal(text.size, original);
    } finally { cancelPictureCopperRefresh(app); }
}

{
    const { app, text, inputs } = fixture();
    try {
        const originalSize = text.size;
        inputs.get('pcbPropTextSize').fire('input', 2);
        app.history.execute(new EditTextCommand(app, text.id, { content: 'Separate content edit', border: true }));
        assert.equal(text.size, originalSize);
        assert.equal(app.texts.get(text.id).size, 2, 'Independent commands retain the pending property field');
        assert.equal(app.texts.get(text.id).content, 'Separate content edit');
        assert.equal(app.texts.get(text.id).border, true);
        inputs.get('pcbPropTextSize').fire('change');
        app.history.undo();
        assert.equal(text.size, originalSize);
        assert.equal(text.content, 'Separate content edit', 'Style undo does not own content changes');
        assert.equal(text.border, true, 'Style undo does not own the independent border toggle');
        app.history.undo();
        assert.equal(text.content, 'R12');
        assert.equal(text.border, false);
    } finally { cancelPictureCopperRefresh(app); }
}

for (const finish of ['commit', 'cancel', 'panel-change', 'deactivate', 'failure']) {
    const { app, text, inputs, renders } = fixture();
    const original = { ...text }, serialized = app.pcbDocument.serialize(), geometry = app.pcbDocument.captureGeometry();
    let mapCopies = 0;
    let clearanceRequests = 0;
    app.pcbDocument.texts[Symbol.iterator] = function () { mapCopies++; return this.entries(); };
    app._pendingShapeClearances = new Map();
    app._pendingShapeClearances.set = function (id, value) {
        clearanceRequests++;
        return Map.prototype.set.call(this, id, value);
    };
    const input = inputs.get('pcbPropTextSize');
    try {
        for (let index = 0; index < 100; index++) input.fire('input', 2);
        const map = app.texts, copy = map.get(text.id);
        assert.notEqual(copy, text);
        assert.equal(PCBApp.prototype.isSectionEditing.call(app), true, 'Save/export must not mistake an uncommitted property preview for the displayed model');
        assert.equal(renders.length, 1, 'Repeated property values do not redraw or reschedule clearance');
        assert.equal(clearanceRequests, 1);
        for (let index = 1; index <= 100; index++) {
            input.fire('input', 2 + index / 1000);
            assert.equal(app.texts, map);
            assert.equal(app.texts.get(text.id), copy);
        }
        assert.equal(renders.length, 101, 'Each distinct property value redraws once');
        assert.equal(clearanceRequests, 101);
        assert.equal(mapCopies, 1, 'Property input reuses the initial map and text copy');
        assert.deepEqual(text, original);
        assert.deepEqual(app.pcbDocument.serialize(), serialized);
        assert.deepEqual(app.pcbDocument.captureGeometry(), geometry);
        const beforeFinish = renders.length;
        if (finish === 'commit') {
            input.fire('change');
            assert.equal(text.size, 2.1);
            assert.equal(renders.length - beforeFinish, 1, 'Commit has one canonical repaint, no duplicate input repaint');
            app.history.undo();
            assert.deepEqual(text, original);
            app.history.redo();
            assert.equal(text.size, 2.1);
        } else {
            if (finish === 'cancel') getPropertyEditor(app, 'text').cancel();
            else if (finish === 'panel-change') PCBApp.prototype._setPcbPropsTitle.call(app, 'Component');
            else if (finish === 'deactivate') {
                app._cancelPosePreviews = PCBApp.prototype._cancelPosePreviews;
                app._cancelDrawingMode = () => {};
                PCBApp.prototype.deactivate.call(app);
            } else {
                app.history.execute = () => { throw new Error('Injected property failure'); };
                assert.throws(() => input.fire('change'), /Injected property failure/);
            }
            assert.deepEqual(text, original);
            assert.deepEqual(renders.at(-1), original);
            assert.equal(input.value, String(original.size), 'Cancellation/failure restores displayed property values');
            assert.equal(app.history.canUndo(), false);
            if (finish !== 'failure') {
                input.fire('change');
                assert.equal(app.history.canUndo(), false, 'A late change event cannot recommit the cancelled value');
                if (finish === 'panel-change') {
                    input.fire('change', 99);
                    assert.deepEqual(text, original, 'Removed property controls cannot start a new edit through stale events');
                }
            }
        }
        assert.equal(getTextPosePreviewTexts(app), undefined);
        assert.equal(PCBApp.prototype.isSectionEditing.call(app), false);
    } finally { cancelPictureCopperRefresh(app); }
}

{
    const { app, text, inputs, renders } = fixture();
    try {
        inputs.get('pcbPropTextSize').fire('input', '');
        inputs.get('pcbPropTextSize').fire('change', '');
        assert.equal(getTextPosePreviewTexts(app), undefined, 'Invalid input does not allocate a preview');
        assert.equal(renders.length, 0);
        Object.freeze(text);
        inputs.get('pcbPropTextSize').fire('input', 3);
        getPropertyEditor(app, 'text').cancel();
        assert.equal(app.texts.get(text.id), text, 'Cancelling a property edit does not write even to a frozen model');
    } finally { cancelPictureCopperRefresh(app); }
}

for (const value of ['', '-', 'Infinity', '3']) {
    for (const handoff of ['change', 'commit', 'field', 'move', 'rotate']) {
        const { app, text, inputs } = fixture();
        const before = { ...text }, valid = value === '3';
        app.viewport = { scale: 100, svg: { style: {} }, setCrosshair() {}, hideCrosshair() {} };
        app._snapToGrid = point => point;
        inputs.get('pcbPropTextSize').fire('input', 3);
        inputs.get('pcbPropTextSize').value = value;
        try {
            if (handoff === 'change') inputs.get('pcbPropTextSize').fire('change');
            else if (handoff === 'commit') getPropertyEditor(app, 'text').commit();
            else if (handoff === 'field') inputs.get('pcbPropTextLW').fire('change', 0.4);
            else if (handoff === 'move') {
                PCBApp.prototype._beginTextDrag.call(app, app.texts.get(text.id), { x: text.x, y: text.y });
                PCBApp.prototype._updateTextDrag.call(app, { x: text.x + 2, y: text.y });
                PCBApp.prototype._endTextDrag.call(app, true);
            } else {
                const adapter = createPcbTextSelectionAdapter(app, text, `text:${text.id}`);
                adapter.beginAnchorDrag('rotate', { x: text.x + 10, y: text.y });
                adapter.updateAnchorDrag({ x: text.x, y: text.y - 10 });
                adapter.endAnchorDrag(true);
            }
            assert.equal(text.size, valid ? 3 : before.size, `${handoff}: completion validates the current source field`);
            assert.equal(app.history.undoStack.length, Number(valid) + Number(!['change', 'commit'].includes(handoff)));
            assert.equal(getTextPosePreviewTexts(app), undefined);
            while (app.history.canUndo()) app.history.undo();
            assert.deepEqual(text, before);
        } finally { cancelPictureCopperRefresh(app); }
    }
}

delete globalThis.window;
delete globalThis.document;
console.log('PASS PCB text property previews, undo/redo, layer anchors, precision and clearance refresh');
