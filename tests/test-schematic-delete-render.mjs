import assert from 'node:assert/strict';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { SelectionManager } from '../src/core/SelectionManager.js';
import { createRect, createLine } from '../src/shapes/polyline.js';
import { Wire } from '../src/shapes/wire.js';

class Element {
    attributes = new Map();
    children = [];
    parentNode = null;
    style = {};
    dataset = {};
    classList = { add() {} };
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(child) { this.insertBefore(child, null); }
    insertBefore(child, next) {
        child.remove();
        const index = next ? this.children.indexOf(next) : this.children.length;
        assert.ok(index >= 0);
        this.children.splice(index, 0, child);
        child.parentNode = this;
    }
    removeChild(child) {
        assert.ok(this.children.includes(child));
        this.children.splice(this.children.indexOf(child), 1);
        child.parentNode = null;
    }
    remove() { this.parentNode?.removeChild(this); }
    set textContent(_text) { for (const child of [...this.children]) child.remove(); }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
    get previousSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) - 1] || null; }
}
const listeners = new Map();
globalThis.window = {
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
};
globalThis.document = { createElementNS: () => new Element(), getElementById: () => null };
const {
    commandAddShapeInternal, commandRemoveShapeInternal, commandDeleteShapesInternal,
    commandRestoreShapesInternal, renderShapes,
} = await import('../src/schematic/modules/shape-management.js');
const { deleteSelected } = await import('../src/ui/modules/selection.js');
const { deleteWire, deleteWireSegment } = await import('../src/ui/modules/context-menu.js');
const { bindKeyboardShortcuts } = await import('../src/ui/modules/keyboard.js');

function fixture(shape) {
    const layer = new Element();
    const root = new Element();
    root.appendChild(layer);
    const app = {
        shapes: [], components: [], currentTool: 'select', interactionState: 'idle',
        viewport: { scale: 10, contentLayer: layer, addContent: element => layer.appendChild(element) },
        selection: new SelectionManager(), history: new CommandHistory(), fileManager: { setDirty() {} },
        _updateSelectableItems() { this.selection.setShapes(this.shapes); },
        _updatePropertiesPanel() {},
        renderShapes(force) { renderShapes(this, force); },
        _commandAddShape(item, label) { return commandAddShapeInternal(this, item, label); },
        _commandRemoveShape(item, options) { return commandRemoveShapeInternal(this, item, options); },
        _commandDeleteShapes(items, labels) { commandDeleteShapesInternal(this, items, labels); },
        _commandRestoreShapes(items, labels) { commandRestoreShapesInternal(this, items, labels); },
        _deleteSelected() { deleteSelected(this); },
    };
    commandAddShapeInternal(app, shape);
    app.selection.select(shape);
    return app;
}

for (const key of ['Delete', 'Backspace']) {
    for (const curved of [false, true]) {
        const rectangle = createRect({ x: 0, y: 0, width: 10, height: 10, lineWidth: 0.234567 });
        if (curved) rectangle.setEdgeAttr('e0', 'bulge', 0.25);
        const before = rectangle.captureState();
        const app = fixture(rectangle);
        app._selectedShapeSegment = { shapeId: rectangle.id, edgeId: 'e0' };
        app.renderShapes(true);
        const overlay = app._shapeSegmentSelectionElement;
        assert.equal(overlay.parentNode, app.viewport.contentLayer);
        const dispose = bindKeyboardShortcuts(app);
        try {
            listeners.get('keydown')({ key, target: { tagName: 'DIV' }, preventDefault() {}, stopPropagation() {} });
            assert.equal(overlay.parentNode, null, 'Delete removes the refined-edge SVG before another pointer event');
            assert.equal(app._shapeSegmentSelectionElement, null);
            assert.equal(app._selectedShapeSegment, null);
            assert.equal(rectangle.element.parentNode, null, 'The old rectangle artwork is removed immediately');
            assert.equal(app.shapes.length, 1);
            const remaining = app.shapes[0];
            assert.equal(remaining.closed, false);
            assert.equal(remaining.edges.size, 3);
            assert.equal(remaining.element.parentNode, app.viewport.contentLayer);
            assert.equal(app.history.undoStack.length, 1);
            app.history.undo();
            assert.deepEqual(app.shapes, [rectangle]);
            assert.deepEqual(rectangle.captureState(), before);
            assert.equal(rectangle.element.parentNode, app.viewport.contentLayer);
            assert.equal(remaining.element.parentNode, null);
            app.history.redo();
            assert.deepEqual(app.shapes, [remaining]);
            assert.equal(rectangle.element.parentNode, null);
            assert.equal(remaining.element.parentNode, app.viewport.contentLayer);
        } finally { dispose(); }
    }
}

for (const action of [
    (app, shape) => { app._selectedShapeNode = { shapeId: shape.id, nodeId: 'n0' }; deleteSelected(app); },
    (app, shape) => deleteWireSegment(app, shape, 'e0'),
    (app, shape) => deleteWire(app, shape),
]) {
    const line = createLine({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    const app = fixture(line);
    app._selectedShapeSegment = { shapeId: line.id, edgeId: 'e0' };
    app.renderShapes(true);
    const overlay = app._shapeSegmentSelectionElement;
    action(app, line);
    assert.equal(app.shapes.length, 0);
    assert.equal(overlay.parentNode, null);
    assert.equal(line.element.parentNode, null);
    app.history.undo();
    assert.deepEqual(app.shapes, [line]);
    assert.equal(line.element.parentNode, app.viewport.contentLayer);
}
for (const action of [deleteWire, (app, wire) => deleteWireSegment(app, wire, 'e0')]) {
    const wire = new Wire({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    const app = fixture(wire);
    action(app, wire);
    assert.equal(app.shapes.length, 0);
    assert.equal(wire.element.parentNode, null);
    assert.equal(app.selection.getSelection().length, 0);
    app.history.undo();
    assert.deepEqual(app.shapes, [wire]);
    assert.equal(wire.element.parentNode, app.viewport.contentLayer);
}
console.log('PASS schematic Delete/Backspace removes segment artwork immediately, with real selection, rendering and undo/redo');
