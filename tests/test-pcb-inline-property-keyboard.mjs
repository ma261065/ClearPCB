import assert from 'node:assert/strict';

class Element {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.style = {};
        this.listeners = new Map();
        this.value = '';
    }
    setAttribute() {}
    removeAttribute() {}
    appendChild(child) {
        child.remove();
        this.children.push(child);
        child.parentNode = this;
    }
    removeChild(child) {
        this.children.splice(this.children.indexOf(child), 1);
        child.parentNode = null;
    }
    remove() { this.parentNode?.removeChild(this); }
    get isConnected() { return !!this.parentNode; }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }
    dispatchEvent(event) {
        for (const listener of this.listeners.get(event.type) || []) listener(event);
    }
    focus() { document.activeElement = this; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
}
const properties = new Element('div');
properties.contains = element => element.parentNode === properties;
const listeners = new Map();
globalThis.document = {
    body: new Element('body'), activeElement: null,
    createElement: name => new Element(name),
    createElementNS: (namespace, name) => new Element(name),
    getElementById: id => id === 'pcbPropertiesPanel' ? properties : null,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name),
};
globalThis.window = { addEventListener() {} };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const container = new Element('g');
const completions = [];
const app = {
    _active: true,
    viewport: { svg: {}, addInteractionOverlay: group => container.appendChild(group) },
    _getLayerGroup: () => container,
    _endTextInlineEdit: commit => completions.push(commit),
};
const text = { content: 'R12', size: 1.2, strokeWidth: 0.15, layer: 'top-silk' };
PCBApp.prototype._startTextInlineEdit.call(app, text, null, {
    select() {}, render() {}, transform: () => 'translate(0,0)',
});
try {
    await new Promise(resolve => setTimeout(resolve, 0));
    const hiddenInput = app._textEdit.input;
    const key = (value, modifiers = {}) => {
        const event = { key: value, ...modifiers, prevented: false, stopped: false,
            preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
        listeners.get('keydown')(event);
        return event;
    };
    for (const id of ['pcbPropRefRot', 'pcbPropTextRot', 'pcbPropRefSize', 'pcbPropRefLW']) {
        const field = new Element('input');
        field.id = id;
        field.type = 'number';
        properties.appendChild(field);
        for (const [value, modifiers] of [
            ['4'], ['5'], ['-'], ['.'], ['Backspace'], ['Delete'], ['ArrowLeft'], ['ArrowRight'],
            ['Home'], ['End'], ['ArrowUp'], ['ArrowDown'], ['Tab'],
            ['a', { ctrlKey: true }], ['c', { ctrlKey: true }], ['v', { ctrlKey: true }],
            ['z', { ctrlKey: true }], ['a', { metaKey: true }],
        ]) {
            field.focus();
            const event = key(value, modifiers);
            assert.equal(event.prevented, false, `${id} must retain native handling for ${value}`);
            assert.equal(event.stopped, false);
            assert.equal(document.activeElement, field, 'Typing in a number field must not focus the hidden label input');
            assert.equal(text.content, 'R12', 'Numeric property edits must not change label content');
            assert.equal(hiddenInput.value, 'R12');
        }
        for (const value of ['Enter', 'Escape']) {
            field.focus();
            assert.equal(key(value).prevented, true);
        }
        field.remove();
    }
    assert.deepEqual(completions, [true, false, true, false, true, false, true, false],
        'Enter/Escape retain inline commit/cancel behavior from properties');
    hiddenInput.focus();
    assert.equal(key('7').prevented, false, 'Hidden input still receives its own native keystrokes');
    const button = new Element('button');
    properties.appendChild(button);
    button.focus();
    assert.equal(key('7').prevented, true, 'Non-numeric property controls can still resume label typing');
    assert.equal(text.content, 'R127');
} finally {
    app._textEdit.overlay.destroy();
    app._textEdit.input.remove();
    app._textEdit = null;
    delete globalThis.document;
    delete globalThis.window;
}
console.log('PASS numeric property keyboard ownership during PCB reference and text inline editing');
