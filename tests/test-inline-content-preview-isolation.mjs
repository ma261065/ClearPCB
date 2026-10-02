import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { createPcbText, TEXT_LAYERS } from '../src/core/pcb-text.js';
import { AddTextCommand, getTextPosePreviewTexts } from '../src/pcb/modules/text-commands.js';
import { cancelPictureCopperRefresh } from '../src/pcb/modules/picture-refresh.js';
import { measureText } from '../src/shared/pcb/stroke-font.js';
import { loadPcb } from '../src/pcb/modules/project-state.js';

class Element {
    constructor(tag = 'g') {
        this.tagName = tag.toUpperCase(); this.children = []; this.attributes = new Map();
        this.dataset = {}; this.style = {}; this.listeners = new Map(); this.value = '';
    }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
    remove() { this.parentNode?.removeChild(this); }
    get isConnected() { return !!this.parentNode; }
    addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
    }
    dispatchEvent(event) { for (const fn of [...(this.listeners.get(event.type) || [])]) fn(event); }
    fire(type, value) { this.value = String(value); this.dispatchEvent({ type }); }
    focus() { document.activeElement = this; }
    blur() { document.activeElement = null; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
}
let fields = new Map();
const documentListeners = new Map();
globalThis.document = {
    body: new Element('body'), documentElement: new Element('html'), activeElement: null,
    createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    getElementById: id => fields.get(id) || null,
    addEventListener: (type, fn) => documentListeners.set(type, fn),
    removeEventListener: type => documentListeners.delete(type),
};
globalThis.window = { addEventListener() {} };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

function fixture(layer, extraTexts = 0, isNew = false) {
    const pcbDocument = new PcbDocument();
    const text = createPcbText({ id: 'text', content: isNew ? '' : 'Original', layer, x: Math.PI, y: -Math.E,
        rotation: 37.123456789, size: 1.23456789, strokeWidth: 0.123456789 });
    let content = text.content, contentReads = 0, mapCopies = 0;
    Object.defineProperty(text, 'content', { enumerable: true,
        get() { contentReads++; return content; }, set(value) { content = value; } });
    if (!isNew) pcbDocument.texts.set(text.id, text);
    const other = createPcbText({ id: 'other', content: 'Untouched', layer });
    pcbDocument.texts.set(other.id, other);
    for (let index = 0; index < extraTexts; index++) {
        const extra = createPcbText({ id: `extra${index}`, layer });
        pcbDocument.texts.set(extra.id, extra);
    }
    pcbDocument.texts[Symbol.iterator] = function () { mapCopies++; return this.entries(); };
    fields = new Map(['pcbPropTextLayer', 'pcbPropTextSize', 'pcbPropTextRot', 'pcbPropTextLW', 'pcbPropTextBorder']
        .map(id => [id, new Element(id === 'pcbPropTextLayer' ? 'select' : 'input')]));
    const properties = { innerHTML: '', querySelector: selector => fields.get(selector.slice(1)) || null };
    const groups = new Map(TEXT_LAYERS.map(id => [id, new Element()]));
    const overlay = new Element();
    let renders = 0;
    const app = {
        _active: true, pcbDocument, history: new CommandHistory(), currentTool: 'select',
        placements: new Map(), tracks: [], vias: [], pads: [], boardShapes: [],
        _textElements: new Map(), _shapeElements: new Map(),
        viewport: { svg: new Element('svg'), addInteractionOverlay: group => overlay.appendChild(group) },
        getLayerGroup: id => groups.get(id) || null,
        _pcbPropsItems: () => properties, _setPcbPropsTitle() {}, _layerLabel: id => id,
        clearProperties() {}, _exitTextTool() {}, _refreshBoardShapeClearance() {},
        _cancelTrackDraw() {}, _cancelFillDraw() {}, _cancelShapeDraw() {}, _ensureViewport() {}, markSectionClean() {},
        _renderText(value) { renders++; PCBApp.prototype._renderText.call(this, value); },
    };
    Object.defineProperty(app, 'texts', Object.getOwnPropertyDescriptor(PCBApp.prototype, 'texts'));
    for (const name of ['_startTextInlineEdit', '_endTextInlineEdit', 'refreshText', '_removeTextElement', '_selectText',
        '_showTextProperties', '_bindStrokeTextProps', '_cancelPosePreviews', '_cancelDrawingMode']) app[name] = PCBApp.prototype[name];
    if (isNew) app.history.execute(new AddTextCommand(app, text));
    else app._renderText(text);
    app._renderText(other);
    return { app, text, other, overlay, renders: () => renders, mapCopies: () => mapCopies,
        contentReads: () => contentReads, resetReads: () => { contentReads = 0; } };
}

for (const layer of TEXT_LAYERS) for (const finish of ['commit', 'cancel', 'deactivate', 'load', 'failure']) {
    const f = fixture(layer), { app, text, other, overlay } = f;
    const original = { ...text };
    const geometry = app.pcbDocument.captureGeometry(), serialized = app.pcbDocument.serialize();
    const otherSvg = app._textElements.get(other.id);
    try {
        app._startTextInlineEdit(text);
        const state = app._textEdit, draft = state.text, map = app.texts;
        assert.notEqual(draft, text);
        assert.equal(map.get(text.id), draft);
        assert.equal(map.get(other.id), other);
        assert.equal(f.mapCopies(), 1);
        f.resetReads();
        const initialRenders = f.renders();
        for (let index = 0; index < 100; index++) {
            state.input.fire('input', `  New content ${index}  `);
            assert.equal(app.texts, map);
            assert.equal(app._textEdit.text, draft);
        }
        assert.equal(f.renders() - initialRenders, 100, 'One glyph redraw per changed input');
        assert.equal(f.contentReads(), 0, 'Typing never rereads canonical content');
        assert.equal(f.mapCopies(), 1, 'Typing never copies the document text map again');
        const changedRenders = f.renders();
        for (let index = 0; index < 100; index++) {
            state.input.setSelectionRange(index % state.input.value.length, index % state.input.value.length);
            state.input.fire('input', state.input.value);
        }
        assert.equal(f.renders(), changedRenders, 'Unchanged input/caret events do not rebuild glyph SVG');
        assert.equal(f.contentReads(), 0);
        assert.deepEqual(text, original);
        assert.deepEqual(app.pcbDocument.captureGeometry(), geometry);
        assert.deepEqual(app.pcbDocument.serialize(), serialized);
        assert.equal(app._textElements.get(other.id), otherSvg);
        assert.equal(app.history.canUndo(), false);

        fields.get('pcbPropTextSize').fire('input', 2.5);
        assert.equal(draft.size, 2.5, 'Separate live style edits reach the reusable content projection');
        assert.equal(text.size, original.size, 'Inline property input also remains outside the document');
        assert.equal(draft.content, state.input.value);
        fields.get('pcbPropTextSize').fire('change', 2.5);
        app.history.undo();
        assert.equal(draft.size, original.size);
        assert.equal(draft.content, state.input.value, 'Style undo cannot overwrite pending typed content');
        app.history.redo();
        assert.equal(draft.size, 2.5);
        const nextLayer = layer.startsWith('bottom-') ? 'top-silk' : 'bottom-silk';
        const shift = measureText(draft.content, draft.size) * (nextLayer.startsWith('bottom-') ? 1 : -1);
        fields.get('pcbPropTextLayer').fire('change', nextLayer);
        assert.equal(text.x, original.x + shift * Math.cos(original.rotation * Math.PI / 180),
            'Side changes use the displayed content width, not the original model content');
        assert.equal(draft.x, text.x);
        assert.equal(draft.layer, nextLayer);
        assert.equal(text.content, original.content);
        assert.equal(f.mapCopies(), 1, 'Property edits reuse the same map and content object too');
        const styled = { ...text };
        const historySize = app.history.undoStack.length;
        if (finish === 'load') {
            app._active = false;
            loadPcb(app, null);
            assert.equal(app.pcbDocument.texts.size, 0);
            assert.equal(app._textElements.size, 0);
        } else {
            if (finish === 'failure') {
                app.history.execute = () => { throw new Error('Injected content failure'); };
                assert.throws(() => app._endTextInlineEdit(true), /Injected content failure/);
            } else if (finish === 'deactivate') PCBApp.prototype.deactivate.call(app);
            else app._endTextInlineEdit(finish === 'commit');
            if (finish === 'commit') {
                assert.equal(text.content, '  New content 99  ');
                assert.equal(app.history.undoStack.length, historySize + 1);
                app.history.undo();
                assert.deepEqual(text, styled);
                app.history.redo();
                assert.equal(text.content, '  New content 99  ');
            } else {
                assert.deepEqual(text, styled, 'Content cancellation/failure preserves independently committed styles');
                assert.equal(app.history.undoStack.length, historySize);
            }
        }
        assert.equal(app._textEdit, null);
        assert.equal(getTextPosePreviewTexts(app), undefined);
        assert.equal(app.texts, app.pcbDocument.texts);
        assert.equal(overlay.children.length, 0);
        assert.equal(documentListeners.has('keydown'), false);
        assert.equal(state.input.isConnected, false);
        assert.equal(state.overlay.blinkTimer, null);
    } finally {
        if (app._textEdit) app._endTextInlineEdit(false);
        cancelPictureCopperRefresh(app);
    }
}

for (const commit of [false, true]) {
    const { app, text } = fixture('top-silk');
    const original = { ...text };
    try {
        app._startTextInlineEdit(text);
        app._textEdit.input.fire('input', 'Pending content');
        fields.get('pcbPropTextSize').fire('input', 3);
        assert.deepEqual(text, original);
        app._endTextInlineEdit(commit);
        assert.equal(getTextPosePreviewTexts(app), undefined);
        if (commit) {
            assert.equal(text.content, 'Pending content');
            assert.equal(text.size, 3);
            assert.equal(app.history.undoStack.length, 2, 'Enter commits the pending style and content as independent edits');
            app.history.undo();
            assert.equal(text.content, original.content);
            assert.equal(text.size, 3);
            app.history.undo();
        } else assert.equal(app.history.canUndo(), false);
        assert.deepEqual(text, original, 'Cancellation restores uncommitted content and style without authored rollback');
    } finally { cancelPictureCopperRefresh(app); }
}

{
    const f = fixture('top-silk', 5000), { app, text } = f;
    try {
        app._startTextInlineEdit(text);
        const state = app._textEdit, map = app.texts;
        for (const [id, canonical] of app.pcbDocument.texts) {
            assert.equal(map.get(id) === canonical, id !== text.id, 'Only the edited text is copied on a dense board');
        }
        const copies = f.mapCopies(), renders = f.renders();
        f.resetReads();
        for (let index = 0; index < 100; index++) state.input.fire('input', `Dense ${index}`);
        assert.equal(f.mapCopies(), copies);
        assert.equal(f.contentReads(), 0);
        assert.equal(f.renders() - renders, 100);
        assert.equal(app.texts, map);
        app._endTextInlineEdit(false);
    } finally { cancelPictureCopperRefresh(app); }
}

for (const finish of ['cancel', 'blank', 'accept']) for (const committedStyle of [false, true]) {
    const { app, text, other } = fixture('top-silk', 0, true);
    const originalSize = text.size, size = 3.123456789;
    try {
        app._startTextInlineEdit(text, null, { isNewPlacement: true });
        app._textEdit.input.fire('input', finish === 'blank' ? '  ' : 'New label');
        fields.get('pcbPropTextSize').fire('input', size);
        assert.equal(text.size, originalSize);
        assert.equal(text.content, '');
        if (committedStyle) fields.get('pcbPropTextSize').fire('change', size);
        app._endTextInlineEdit(finish !== 'cancel');
        assert.equal(app.texts.get(other.id), other);
        assert.equal(getTextPosePreviewTexts(app), undefined);
        if (finish === 'accept') {
            assert.equal(text.content, 'New label');
            assert.equal(text.size, size);
            assert.equal(app.history.undoStack.length, 3, 'Add, style and accepted content remain independent');
            app.history.undo();
            assert.equal(text.content, '');
            assert.equal(text.size, size);
            app.history.undo();
            assert.equal(text.size, originalSize);
            app.history.undo();
            assert.equal(app.texts.has(text.id), false);
            while (app.history.redo()) {}
            assert.equal(app.texts.get(text.id).content, 'New label');
            assert.equal(app.texts.get(text.id).size, size);
        } else {
            assert.equal(app.texts.has(text.id), false);
            const styled = committedStyle || finish === 'blank';
            assert.equal(app.history.undoStack.length, styled ? 3 : 0);
            if (styled) {
                app.history.undo();
                assert.equal(app.texts.get(text.id).content, '');
                assert.equal(app.texts.get(text.id).size, size);
                app.history.undo();
                assert.equal(app.texts.get(text.id).size, originalSize);
                app.history.undo();
                assert.equal(app.texts.has(text.id), false);
                while (app.history.redo()) {}
                assert.equal(app.texts.has(text.id), false);
            }
        }
    } finally {
        if (app._textEdit) app._endTextInlineEdit(false);
        cancelPictureCopperRefresh(app);
    }
}
console.log('PASS inline content model isolation, stable dense-board projections, redraw counts, styles/history and lifecycle cleanup');
