import assert from 'node:assert/strict';
import { installFakeDom, fakeElement } from './helpers/fake-dom.mjs';

function element(tagName) {
    const node = fakeElement(tagName);
    node.tagName = tagName.toUpperCase();
    node.value = '';
    return node;
}

const document = installFakeDom();
document.createElement = name => element(name);
document.createElementNS = (namespace, name) => element(name);

const properties = element('div');
properties.id = 'propertiesPanel';
document.body.appendChild(properties);

const listeners = new Map();
globalThis.window.addEventListener = (name, listener) => listeners.set(name, listener);
globalThis.window.removeEventListener = name => listeners.delete(name);

const { bindKeyboardShortcuts } = await import('../../src/schematic/modules/keyboard.js');
const { renderPropertyFields } = await import('../../src/shared/ui/property-fields.js');
const { getSchematicTextEdit, handleTextEditKey } = await import('../../src/schematic/modules/text-edit.js');
const { setSchematicInteraction } = await import('../../src/schematic/modules/schematic-interactions.js');

const shape = { text: 'VCC', supportsInlineEdit: true, x: 0, y: 0 };
const app = {
    currentTool: 'text',
    selection: { getSelection: () => [], isSelected: () => false, select() {} },
    fileManager: { setDirty() {} },
    renderShapes() {},
    updatePropertiesPanel() {},
    handleTextEditKey(e) { return handleTextEditKey(app, e); },
};

// A live inline edit with no overlay: the caret model is all this test needs.
const beginTextEdit = () => setSchematicInteraction(app, 'textEdit', {
    shape,
    originalText: shape.text,
    caretIndex: shape.text.length,
    selectionAnchor: null,
    symbolUndo: [],
    overlay: null,
    overlayGroup: null,
    overlayOffset: null,
});
beginTextEdit();

const destroy = bindKeyboardShortcuts(app);

const key = (target, value, modifiers = {}) => {
    const event = {
        type: 'keydown', key: value, target, bubbles: true, ...modifiers,
        prevented: false, stopped: false,
        preventDefault() { this.prevented = true; },
        stopPropagation() { this.stopped = true; },
        stopImmediatePropagation() { this.stopped = true; },
        get defaultPrevented() { return this.prevented; },
    };
    // The real listener is window-capture: it runs before the target control,
    // whose Escape handler may stop propagation.
    listeners.get('keydown')(event);
    if (!event.stopped) target.dispatchEvent(event);
    return event;
};

try {
    let propertyCancelCount = 0;
    const sizeField = renderPropertyFields(properties, [{
        key: 'fontSize',
        type: 'number',
        label: 'Text Size (mm)',
        id: 'prop_newShapeFontSize',
        value: 2,
        step: 0.5,
        cancel() {
            propertyCancelCount++;
            return true;
        },
    }]).get('fontSize');

    // The spinner keeps every key it can actually use.
    for (const [value, modifiers] of [
        ['4'], ['7'], ['-'], ['+'], ['.'], [','],
        ['Backspace'], ['Delete'], ['ArrowUp'], ['ArrowDown'],
        ['ArrowLeft'], ['ArrowRight'], ['Home'], ['End'], ['Tab'],
        ['a', { ctrlKey: true }], ['c', { ctrlKey: true }], ['v', { ctrlKey: true }],
    ]) {
        const event = key(sizeField, value, modifiers);
        assert.equal(event.prevented, false, `Text Size spinner must keep native handling for ${value}`);
        assert.equal(shape.text, 'VCC', `Text Size spinner key ${value} must not edit the text`);
    }

    assert.equal(key(sizeField, 'Enter').prevented, false,
        'Enter must stay with the focused Properties control');

    // Characters a number field cannot hold resume typing in the text.
    for (const value of ['H', 'i', ' ', '!']) {
        const event = key(sizeField, value);
        assert.equal(event.prevented, true, `Typing ${value} in the spinner must reach the text edit`);
    }
    assert.equal(shape.text, 'VCCHi !', 'Letters typed at the spinner append to the text being edited');

    // A real text field in the panel keeps everything, including letters.
    const nameField = element('input');
    nameField.id = 'prop_text';
    nameField.type = 'text';
    properties.appendChild(nameField);
    assert.equal(key(nameField, 'z').prevented, false, 'Text-entry property fields keep their own letters');
    assert.equal(shape.text, 'VCCHi !');

    // Controls that cannot hold text at all hand letters and digits back.
    const button = element('button');
    properties.appendChild(button);
    assert.equal(key(button, '7').prevented, true, 'Non-text property controls resume text typing');
    assert.equal(shape.text, 'VCCHi !7');

    sizeField.value = '3';
    sizeField.dispatchEvent({ type: 'input', bubbles: true });
    sizeField.focus();
    const escapeEvent = key(sizeField, 'Escape');
    assert.equal(escapeEvent.prevented, true, 'The real spinner handler consumes Escape');
    assert.equal(escapeEvent.stopped, true, 'The real spinner handler stops Escape propagation');
    assert.equal(propertyCancelCount, 1, 'The spinner cancels its pending preview');
    assert.equal(sizeField.value, '2.00', 'The spinner restores its described value');
    await new Promise(resolve => queueMicrotask(resolve));
    assert.equal(getSchematicTextEdit(app), null, 'The same Escape closes inline text editing');
    assert.equal(shape.text, 'VCC', 'One Escape from a Properties control cancels inline text editing');

    beginTextEdit();
    shape.text = 'changed';
    const canvas = element('div');
    document.body.appendChild(canvas);
    const canvasEscape = key(canvas, 'Escape');
    assert.equal(canvasEscape.prevented, true, 'One canvas Escape is consumed by inline text editing');
    assert.equal(getSchematicTextEdit(app), null, 'One canvas Escape closes inline text editing immediately');
    assert.equal(shape.text, 'VCC', 'Canvas Escape restores the original text');

    // Outside the Properties panel nothing changes: the canvas keeps its shortcuts.
    const outside = element('input');
    outside.type = 'number';
    document.body.appendChild(outside);
    assert.equal(key(outside, 'q').prevented, false, 'Inputs outside the Properties panel are untouched');
    assert.equal(shape.text, 'VCC');
} finally {
    destroy();
    setSchematicInteraction(app, 'textEdit', null);
    delete globalThis.document;
    delete globalThis.window;
}

console.log('PASS Properties controls hand typing back to an active schematic inline text edit');
