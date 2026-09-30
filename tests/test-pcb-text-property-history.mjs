import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { createPcbText } from '../src/core/pcb-text.js';
import { measureText } from '../src/pcb/modules/stroke-font.js';
import { cancelPictureCopperRefresh } from '../src/pcb/modules/picture-refresh.js';
import { EditTextCommand } from '../src/pcb/modules/text-commands.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById: () => null };
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
        pcbDocument, texts: pcbDocument.texts, history: new CommandHistory(),
        _pcbPropsItems: () => items, _setPcbPropsTitle() {}, _layerLabel: layer => layer,
        _bindStrokeTextProps: PCBApp.prototype._bindStrokeTextProps,
        _refreshText: () => renders.push({ ...text }),
        _refreshBoardShapeClearance: () => clearances.push({ ...text }),
    };
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
        assert.equal(text[field], final, 'Input previews immediately');
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
            assert.deepEqual(text, expected, 'Layer preview retains the existing anchor compensation');
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

delete globalThis.window;
delete globalThis.document;
console.log('PASS PCB text property previews, undo/redo, layer anchors, precision and clearance refresh');
