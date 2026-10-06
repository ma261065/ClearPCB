import assert from 'node:assert/strict';
import { activeTextInlineEdit } from '../src/pcb/modules/text-inline-edit.js';
import { setPcbInteraction } from '../src/pcb/modules/pcb-interactions.js';

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
// Node has Event but not InputEvent, which rerouted typing dispatches like real typing.
globalThis.InputEvent = class InputEvent extends Event {
    constructor(type, init = {}) { super(type, init); this.inputType = init.inputType ?? ''; this.data = init.data ?? null; }
};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const container = new Element('g');
const completions = [];
const app = {
    _active: true,
    viewport: { svg: {}, addInteractionOverlay: group => container.appendChild(group) },
    getLayerGroup: () => container,
    selectText() {},
    clearProperties() {},
    setActiveRibbonTab() {},
};
const text = { content: 'R12', size: 1.2, strokeWidth: 0.15, layer: 'top-silk' };
const startEdit = () => PCBApp.prototype._startTextInlineEdit.call(app, text, null, {
    componentId: 'reference', finish(_value, commit) { completions.push(commit); },
    select() {}, render() {}, transform: () => 'translate(0,0)',
});
startEdit();
try {
    await new Promise(resolve => setTimeout(resolve, 0));
    const activeEdit = activeTextInlineEdit(app);
    const hiddenInput = activeEdit.input;
    const key = (value, modifiers = {}) => {
        if (!listeners.get('keydown')) startEdit();
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
    {
        const field = new Element('input');
        field.id = 'pcbPropTextSize';
        field.type = 'number';
        properties.appendChild(field);
        field.focus();
        const event = key('x');
        assert.equal(event.prevented, true, 'A letter a number field cannot hold resumes label typing');
        assert.equal(document.activeElement, activeTextInlineEdit(app).input, 'and moves typing back to the label');
        assert.equal(text.content, 'R12x');
        field.remove();
    }
    hiddenInput.focus();
    assert.equal(key('7').prevented, false, 'Hidden input still receives its own native keystrokes');
    const button = new Element('button');
    properties.appendChild(button);
    button.focus();
    assert.equal(key('7').prevented, true, 'Non-numeric property controls can still resume label typing');
    assert.equal(text.content, 'R12x7');
} finally {
    activeTextInlineEdit(app)?.overlay.destroy();
    activeTextInlineEdit(app)?.input.remove();
    setPcbInteraction(app, '_textEdit', null);
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.InputEvent;
}
console.log('PASS numeric property keyboard ownership during PCB reference and text inline editing');
