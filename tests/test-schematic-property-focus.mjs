import assert from 'node:assert/strict';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { SelectionManager } from '../src/core/SelectionManager.js';
import { createRect } from '../src/shapes/polyline.js';
import { Circle } from '../src/shapes/circle.js';
import { Text } from '../src/shapes/text.js';

class Element {
    constructor(tag) {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.style = {};
        this.dataset = {};
        this.value = '';
        this.listeners = new Map();
        const classes = new Set();
        this.classList = {
            add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name),
            toggle(name, force) { if (force) classes.add(name); else classes.delete(name); },
        };
    }
    setAttribute(name, value) { this[name] = String(value); }
    appendChild(child) { this.children.push(child); child.parentNode = this; }
    append(...children) { children.filter(child => typeof child === 'object').forEach(child => this.appendChild(child)); }
    contains(target) { return this === target || this.children.some(child => child.contains(target)); }
    set innerHTML(_html) {
        if (this.contains(document.activeElement)) document.activeElement = document.body;
        this.children.forEach(child => { child.parentNode = null; });
        this.children = [];
    }
    querySelector(selector) {
        const matches = selector.startsWith('#') && this.id === selector.slice(1);
        return matches ? this : this.children.map(child => child.querySelector(selector)).find(Boolean) || null;
    }
    addEventListener(name, callback) {
        if (!this.listeners.has(name)) this.listeners.set(name, []);
        this.listeners.get(name).push(callback);
    }
    focus() { document.activeElement = this; }
    fire(name, details = {}) {
        const event = { type: name, target: this, preventDefault() {}, stopPropagation() {}, ...details };
        for (const callback of this.listeners.get(name) || []) callback(event);
    }
}
const hostListeners = new Map();
globalThis.window = {
    addEventListener: (name, callback) => hostListeners.set(name, callback),
    removeEventListener: name => hostListeners.delete(name),
};
globalThis.document = {
    body: new Element('body'), activeElement: null,
    createElement: tag => new Element(tag),
    getElementById: id => document.body.querySelector(`#${id}`),
};
const { updatePropertiesPanel } = await import('../src/ui/modules/properties.js');
const { bindKeyboardShortcuts } = await import('../src/ui/modules/keyboard.js');

function fixture(shapes, refinement = {}) {
    document.body.innerHTML = '';
    const panel = new Element('div');
    document.body.appendChild(panel);
    const selection = new SelectionManager();
    selection.setShapes(shapes);
    shapes.forEach(shape => selection.select(shape, true));
    let rebuilds = 0;
    const app = {
        shapes, components: [], selection, currentTool: 'select',
        ui: { propertiesPanel: panel }, viewport: { snapToGrid: false },
        history: new CommandHistory(), renderShapes() {}, fileManager: { setDirty() {} }, ...refinement,
        _updatePropertiesPanel(selected) { rebuilds++; updatePropertiesPanel(this, selected); },
    };
    app._updatePropertiesPanel(shapes);
    const dispose = bindKeyboardShortcuts(app);
    const keydown = key => {
        const event = { key, target: document.activeElement, defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
        hostListeners.get('keydown')(event);
        return event;
    };
    return { app, dispose, keydown, rebuilds: () => rebuilds };
}

for (const property of ['lineWidth', 'cornerRadius', 'diameter', 'fontSize', 'rotation']) {
    for (const count of [1, 3]) {
        const shapes = Array.from({ length: count }, (_, i) => property === 'diameter'
            ? new Circle({ x: 10 + i * 20, y: 10, radius: 5, lineWidth: 0.2 })
            : ['fontSize', 'rotation'].includes(property)
                ? new Text({ x: 10 + i * 20, y: 10, text: 'Label' })
                : createRect({ x: 10 + i * 20, y: 10, width: 12, height: 8, lineWidth: 0.2, cornerRadius: 0.5 }));
        if (property === 'rotation') shapes.forEach(shape => { shape.fieldKey = 'reference'; });
        const { app, dispose, keydown, rebuilds } = fixture(shapes);
        try {
            const input = document.getElementById(`prop_${property}`);
            assert.ok(input);
            input.focus();
            const before = shapes.map(shape => shape.captureState());
            const readPositions = () => shapes.map(shape => shape.type === 'polyline'
                ? shape.getOrderedPoints() : { x: shape.x, y: shape.y });
            const positions = structuredClone(readPositions());
            const initialRebuilds = rebuilds();
            const values = property === 'diameter' ? [11, 12, 13]
                : ['fontSize', 'rotation'].includes(property) ? [3, 4, 5] : [0.6, 0.7, 0.8];
            for (const value of values) {
                assert.equal(keydown('ArrowUp').defaultPrevented, false, 'The native number field owns every arrow key');
                assert.equal(keydown('ArrowDown').defaultPrevented, false, 'Down arrows also stay in the number field');
                input.value = String(value); input.fire('input'); input.fire('change');
                assert.ok(document.activeElement === input, `${property} (${count} shapes): committing a step keeps focus`);
                assert.equal(document.getElementById(input.id), input, `${property}: preserve the field DOM node`);
                assert.equal(rebuilds(), initialRebuilds, 'Numeric-only changes do not rebuild Properties');
                assert.ok(shapes.every(shape => Math.abs(shape[property] - value) < 1e-9));
                assert.deepEqual(readPositions(), positions, 'Property stepping never translates the shape');
            }
            const after = shapes.map(shape => shape.captureState());
            assert.equal(app.history.undoStack.length, 3);
            input.fire('change');
            assert.equal(app.history.undoStack.length, 3);
            document.activeElement = document.body;
            for (let i = 0; i < 3; i++) app.history.undo();
            assert.deepEqual(shapes.map(shape => shape.captureState()), before);
            for (let i = 0; i < 3; i++) app.history.redo();
            assert.deepEqual(shapes.map(shape => shape.captureState()), after);
            assert.equal(keydown('ArrowRight').defaultPrevented, true, 'Canvas nudging resumes after leaving the field');
            app.history.undo();
            assert.deepEqual(shapes.map(shape => shape.captureState()), after);
        } finally { dispose(); }
    }
}

{
    const text = new Text({ text: 'Label' });
    text.fieldKey = 'reference';
    const { dispose } = fixture([text]);
    try {
        const input = document.getElementById('prop_rotation');
        input.focus();
        for (const value of ['270', '12', '360']) {
            input.value = value; input.fire('input'); input.fire('change');
            assert.ok(document.activeElement === input);
            assert.equal(Number(input.value), Number(value) % 360);
        }
    } finally { dispose(); }
}

{
    const shapes = [0.2, 0.5].map(lineWidth => createRect({ width: 10, height: 10, lineWidth }));
    const { app, dispose } = fixture(shapes);
    try {
        const input = document.getElementById('prop_lineWidth');
        assert.equal(input.value, '');
        assert.ok(input.placeholder);
        input.focus();
        input.value = '0.7'; input.fire('input');
        input.value = ''; input.fire('change');
        assert.deepEqual(shapes.map(shape => shape.lineWidth), [0.2, 0.5]);
        assert.equal(input.value, '');
        assert.ok(input.placeholder, 'Invalid edits restore the mixed value');
        assert.ok(document.activeElement === input);
        assert.equal(app.history.undoStack.length, 0);
        input.value = '0.8'; input.fire('input'); input.fire('change');
        assert.equal(input.placeholder, '', 'Committing a common value clears the mixed placeholder');
        assert.equal(Number(input.value), 0.8);
        input.value = '0.9'; input.fire('input');
        document.activeElement = document.body; input.fire('blur');
        await Promise.resolve();
        assert.equal(app.history.undoStack.length, 2);
        assert.ok(document.getElementById(input.id) !== input, 'Unfocused commits still rebuild Properties');
    } finally { dispose(); }
}

{
    const circle = new Circle({ radius: 5, lineWidth: 0.5 });
    const { app, dispose } = fixture([circle]);
    try {
        const diameter = document.getElementById('prop_diameter');
        const width = document.getElementById('prop_lineWidth');
        diameter.focus();
        diameter.value = '0.4'; diameter.fire('input'); diameter.fire('change');
        assert.equal(circle.radius, 0.2);
        assert.equal(Number(width.value), 0.2, 'Shrinking a circle synchronizes the constrained width');
        assert.ok(document.activeElement === diameter);
        width.focus();
        diameter.fire('blur');
        width.value = '0.1'; width.fire('input');
        await Promise.resolve();
        assert.ok(document.activeElement === width, 'Deferred blur of a committed field leaves the new field alone');
        width.fire('change');
        assert.equal(circle.lineWidth, 0.1);
        assert.equal(app.history.undoStack.length, 2);
        width.value = '4'; width.fire('input'); width.fire('change');
        assert.equal(Number(width.value), 0.2, 'Clamping updates the focused field in place');
        assert.ok(document.activeElement === width);
        diameter.focus();
        diameter.value = '0.15'; diameter.fire('input');
        diameter.value = ''; diameter.fire('change');
        assert.equal(Number(diameter.value), 0.4);
        assert.equal(Number(width.value), 0.2, 'Cancelling restores paired controls as well as geometry');
    } finally { dispose(); }
}

for (const refinement of ['whole', 'node', 'segment']) {
    const rectangle = createRect({ width: 10, height: 10 });
    const selected = refinement === 'node' ? { _selectedShapeNode: { shapeId: rectangle.id, nodeId: 'n0' } }
        : refinement === 'segment' ? { _selectedShapeSegment: { shapeId: rectangle.id, edgeId: 'e0' } } : {};
    if (refinement === 'segment') rectangle.setEdgeAttr('e0', 'bulge', 0.25);
    const { app, dispose } = fixture([rectangle], selected);
    try {
        const property = refinement === 'segment' ? 'bulge' : 'cornerRadius';
        const input = document.getElementById(`prop_${property}`);
        const before = rectangle.captureState();
        if (refinement === 'segment') {
            const width = document.getElementById('prop_lineWidth');
            width.focus();
            for (const value of ['0.3', '0.4']) {
                width.value = value; width.fire('input'); width.fire('change');
                assert.ok(document.activeElement === width, 'Refined segment width keeps focus');
                assert.equal(rectangle.getEdgeAttr('e0', 'width'), Number(value));
                assert.equal(rectangle.lineWidth, before.lineWidth, 'A segment edit does not change the whole shape width');
            }
        }
        input.focus();
        for (const value of refinement === 'segment' ? ['0.5', '0.6'] : ['1', '2', '0']) {
            input.value = value; input.fire('input'); input.fire('change');
            assert.ok(document.activeElement === input, `${refinement}: repeated edits retain focus`);
            if (refinement !== 'segment') {
                assert.equal(document.getElementById('propDecomposeCorners').style.display, value === '0' ? 'none' : '',
                    'Decompose action availability follows corner changes without rebuilding');
            }
        }
        if (refinement === 'segment') {
            input.value = '0'; input.fire('input'); input.fire('change');
            assert.equal(document.getElementById('prop_bulge'), null, 'Straightening removes the obsolete Bulge field');
            assert.ok(document.activeElement !== input, 'Schema changes still rebuild Properties');
        }
        while (app.history.undo()) {}
        assert.deepEqual(rectangle.captureState(), before);
    } finally { dispose(); }
}
console.log('PASS schematic numeric focus, keyboard ownership, exact history, mixed values, constraints, refinement and structural refresh');
