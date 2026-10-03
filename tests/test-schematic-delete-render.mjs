import assert from 'node:assert/strict';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { SelectionManager } from '../src/core/SelectionManager.js';
import { createRect, createLine, createPolygon } from '../src/shapes/polyline.js';
import { Wire } from '../src/shapes/wire.js';
import { Arc } from '../src/shapes/arc.js';

class Element {
    attributes = new Map();
    children = [];
    parentNode = null;
    style = {};
    dataset = {};
    classList = {
        contains: name => (this.getAttribute('class') || this.className || '').split(/\s+/).includes(name),
        add: name => this.classList.toggle(name, true),
        toggle: (name, force) => {
            const names = new Set((this.getAttribute('class') || this.className || '').split(/\s+/).filter(Boolean));
            if (force ?? !names.has(name)) names.add(name); else names.delete(name);
            this.setAttribute('class', [...names].join(' '));
        },
    };
    _text = '';
    rebuilds = 0;
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    appendChild(child) { this.insertBefore(child, null); }
    append(...children) {
        for (const child of children) {
            if (typeof child === 'string') this._text += child;
            else this.appendChild(child);
        }
    }
    addEventListener() {}
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
    set textContent(text) {
        for (const child of [...this.children]) child.remove();
        this._text = String(text);
    }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(text) { this.rebuilds++; this.textContent = text; }
    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }
    querySelectorAll(selector) {
        const matches = selector.startsWith('#') ? this.id === selector.slice(1)
            : selector.startsWith('.') && selector.slice(1).split('.').every(name => this.classList.contains(name));
        return [...(matches ? [this] : []), ...this.children.flatMap(child => child.querySelectorAll(selector))];
    }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
    get previousSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) - 1] || null; }
}
const listeners = new Map();
globalThis.window = {
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
};
globalThis.document = {
    body: new Element(), createElementNS: () => new Element(), createElement: () => new Element(),
    getElementById: id => document.body.querySelector(`#${id}`),
    querySelector: selector => document.body.querySelector(selector),
    querySelectorAll: selector => document.body.querySelectorAll(selector),
    addEventListener() {}, removeEventListener() {},
};
const {
    commandAddShapeInternal, commandRemoveShapeInternal, commandDeleteShapesInternal,
    commandRestoreShapesInternal,
} = await import('../src/schematic/modules/shape-management.js');
const { renderShapes } = await import('../src/schematic/modules/schematic-view.js');
const { deleteSelected } = await import('../src/ui/modules/selection.js');
const { deleteWire, deleteWireSegment, deleteSchematicShapeNode, splitAnchorAndDrag, setSchematicShapeSegmentType,
    decomposeShapeCorners } = await import('../src/ui/modules/context-menu.js');
const { bindKeyboardShortcuts } = await import('../src/ui/modules/keyboard.js');
const { bindPropertiesPanel, updatePropertiesPanel } = await import('../src/ui/modules/properties.js');
const { bindRibbon } = await import('../src/ui/modules/ribbon.js');
const { default: SchematicApp } = await import('../src/ui/SchematicApp.js');

function fixture(shape) {
    document.body.textContent = '';
    const layer = new Element();
    const root = new Element();
    root.appendChild(layer);
    document.body.appendChild(root);
    const panel = new Element();
    document.body.appendChild(panel);
    const tip = new Element();
    tip.id = 'schematicStatusTip';
    document.body.appendChild(tip);
    const ribbon = new Element();
    ribbon.className = 'ribbon';
    document.body.appendChild(ribbon);
    for (const name of ['home', 'properties']) {
        const tab = new Element(), panel = new Element();
        tab.className = 'ribbon-tab';
        tab.dataset.tab = name;
        panel.className = 'ribbon-panel';
        panel.dataset.panel = name;
        ribbon.append(tab, panel);
    }
    const subscribers = new Map();
    const app = {
        shapes: [], components: [], currentTool: 'select', interactionState: 'idle',
        ui: { propertiesPanel: panel }, selectionNotifications: [],
        eventBus: {
            on(name, listener) {
                if (!subscribers.has(name)) subscribers.set(name, []);
                subscribers.get(name).push(listener);
            },
            emit(name, selection) {
                assert.equal(name, 'selectionChanged');
                app.selectionNotifications.push({ selection: [...selection], shapes: [...app.shapes],
                    segment: app._selectedShapeSegment, node: app._selectedShapeNode,
                    interactionState: app.interactionState });
                for (const subscriber of subscribers.get(name) || []) subscriber(selection);
            },
        },
        viewport: { scale: 10, svg: root, contentLayer: layer, addContent: element => layer.appendChild(element) },
        selection: new SelectionManager({ onSelectionChanged: selected => app._onSelectionChanged(selected) }),
        history: new CommandHistory(), fileManager: { setDirty() {} },
        _onSelectionChanged: SchematicApp.prototype._onSelectionChanged,
        _updateShapeSelectionTip: SchematicApp.prototype._updateShapeSelectionTip,
        _updateSelectableItems() { this.selection.setShapes(this.shapes); },
        _updatePropertiesPanel(selection) { updatePropertiesPanel(this, selection); },
        renderShapes(force) { renderShapes(this, force); },
        _commandAddShape(item, label) { return commandAddShapeInternal(this, item, label); },
        _commandRemoveShape(item, options) { return commandRemoveShapeInternal(this, item, options); },
        _commandDeleteShapes(items, labels) { commandDeleteShapesInternal(this, items, labels); },
        _commandRestoreShapes(items, labels) { commandRestoreShapesInternal(this, items, labels); },
        _deleteSelected() { deleteSelected(this); },
        _captureShapeState(item) { return item.captureState(); },
        _showCrosshair() { this.crosshairVisible = true; },
        _hideCrosshair() { this.crosshairVisible = false; },
        _updateCrosshair() {},
    };
    bindPropertiesPanel(app);
    bindRibbon(app);
    commandAddShapeInternal(app, shape);
    app.selection.select(shape);
    assert.ok(panel.textContent.includes('1 selected'), 'Properties starts with the selected shape');
    assert.equal(document.querySelector('.ribbon-tab.active').dataset.tab, 'properties');
    app.selectionNotifications.length = 0;
    return app;
}

function expectDeletionNotification(app) {
    assert.equal(app.selectionNotifications.length, 1, 'Publish the final selection once after deletion');
    assert.deepEqual(app.selectionNotifications[0].selection, []);
    assert.deepEqual(app.selectionNotifications[0].shapes, app.shapes, 'Subscribers see the completed command');
    assert.equal(app.selectionNotifications[0].segment, null);
    assert.equal(app.selectionNotifications[0].node, null);
    assert.ok(app.ui.propertiesPanel.textContent.includes('None selected'), 'Selection subscribers clear stale Properties');
    assert.equal(document.getElementById('prop_lineWidth'), null);
    assert.equal(document.getElementById('prop_net'), null);
    assert.equal(document.querySelector('.ribbon-tab.active').dataset.tab, 'home', 'Empty selection leaves Properties');
}

for (const nodeId of ['n0', 'n1']) for (const action of ['Delete', 'Backspace', 'context']) {
    const line = createLine({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    const app = fixture(line);
    const before = line.captureState();
    app._selectedShapeNode = { shapeId: line.id, nodeId };
    app._onSelectionChanged(app.selection.getSelection());
    assert.equal(document.getElementById('prop_cornerRadius'), null, 'Endpoints have no corner-radius control');
    app.selectionNotifications.length = 0;
    const dispose = bindKeyboardShortcuts(app);
    try {
        if (action === 'context') assert.equal(deleteSchematicShapeNode(app, line, nodeId), true);
        else listeners.get('keydown')({ key: action, target: { tagName: 'DIV' }, preventDefault() {}, stopPropagation() {} });
        assert.deepEqual(app.shapes, []);
        expectDeletionNotification(app);
        assert.equal(app.history.undoStack.length, 1);
        app.history.undo();
        assert.deepEqual(app.shapes, [line]);
        assert.deepEqual(line.captureState(), before);
        app.history.redo();
        assert.deepEqual(app.shapes, []);
    } finally { dispose(); }
}

for (const nodeId of ['n0', 'n2']) {
    const line = createLine({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] });
    const app = fixture(line);
    app._selectedShapeNode = { shapeId: line.id, nodeId };
    app._onSelectionChanged(app.selection.getSelection());
    deleteSelected(app);
    assert.deepEqual(app.shapes, [line]);
    assert.equal(line.nodes.size, 2);
    assert.equal(document.querySelector('.ribbon-tab.active').dataset.tab, 'properties');
    assert.ok(document.getElementById('prop_lineWidth'), 'Surviving longer lines keep whole-object Properties');
}

for (const [closed, points, bulges, expected] of [
    [false, [{ x: 0, y: 0 }, { x: 10, y: 0 }], {}, [false, false]],
    [false, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], {}, [false, true, false]],
    [false, [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }], {}, [false, false, false]],
    [true, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], {}, [true, true, true]],
    [false, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], { e0: 0.25 }, [false, false, false]],
]) {
    const shape = (closed ? createPolygon : createLine)({ points, cornerRadius: 1 });
    for (const [edgeId, bulge] of Object.entries(bulges)) shape.setEdgeAttr(edgeId, 'bulge', bulge);
    const app = fixture(shape), before = shape.captureState();
    for (const [index, showRadius] of expected.entries()) {
        app._selectedShapeNode = { shapeId: shape.id, nodeId: `n${index}` };
        app._onSelectionChanged(app.selection.getSelection());
        assert.equal(!!document.getElementById('prop_cornerRadius'), showRadius, `Node ${index}: radius is only for a corner`);
        assert.equal(document.querySelector('.ribbon-tab.active').dataset.tab, 'properties');
    }
    assert.deepEqual(shape.captureState(), before, 'Control visibility leaves stored radii and geometry untouched');
}

for (const closed of [false, true]) for (const boundary of ['uniform', 'width-change', 'curve']) {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 20, y: 0 },
        ...(closed ? [{ x: 20, y: 10 }, { x: 0, y: 10 }] : [{ x: 30, y: 0 }])];
    const shape = (closed ? createPolygon : createLine)({ points });
    if (boundary === 'width-change') shape.setEdgeAttr('e0', 'width', 0.7);
    if (boundary === 'curve') shape.setEdgeAttr('e0', 'bulge', 0.25);
    shape.setNodeCornerRadius('n1', 0.75);
    shape.setNodeCornerRadius('n4', 1.25);
    const before = shape.captureState();
    const app = fixture(shape);
    app._selectedShapeNode = { shapeId: shape.id, nodeId: 'n2' };
    app._onSelectionChanged(app.selection.getSelection());
    deleteSelected(app);
    const expected = closed
        ? [points[0], ...(boundary === 'uniform' ? [] : [points[1]]), ...points.slice(3)]
        : [points[0], ...(boundary === 'uniform' ? [] : [points[1]]), points[4]];
    assert.deepEqual(shape.getOrderedPoints(), expected, 'Node deletion also completes collinear cleanup');
    assert.equal(shape.nodes.has('n1'), boundary !== 'uniform', 'Width/curvature boundaries retain their node IDs');
    assert.equal(shape.nodeCornerRadius('n4'), 1.25);
    if (boundary === 'width-change') assert.equal(shape.getEdgeAttr('e0', 'width'), 0.7);
    if (boundary === 'curve') assert.equal(shape.getEdgeAttr('e0', 'bulge'), 0.25);
    assert.deepEqual(app.selection.getSelection(), [shape]);
    assert.equal(app.history.undoStack.length, 1);
    const after = shape.captureState();
    app.history.undo();
    assert.deepEqual(shape.captureState(), before);
    app.history.redo();
    assert.deepEqual(shape.captureState(), after);
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
            expectDeletionNotification(app);
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

for (const split of [false, true]) {
    const shape = split
        ? createLine({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 10 }] })
        : createRect({ x: 0, y: 0, width: 10, height: 10 });
    const app = fixture(shape);
    const before = shape.captureState();
    if (split) splitAnchorAndDrag(app, shape, 'n1', 0, 0);
    app._selectedShapeNode = { shapeId: shape.id, nodeId: split ? app.drag.anchorId : 'n1' };
    app._onSelectionChanged(app.selection.getSelection());
    app.renderShapes(true);
    const tip = document.getElementById('schematicStatusTip');
    assert.equal(tip.hidden, true);
    app.selectionNotifications.length = 0;
    const rebuilds = app.ui.propertiesPanel.rebuilds;
    deleteSelected(app);
    assert.equal(tip.hidden, false, 'Finishing a refined edit restores the whole-shape selection tip');
    assert.equal(app.selectionNotifications.length, 1, 'Retained selection publishes its final refinement once');
    assert.deepEqual(app.selectionNotifications[0].selection, [shape]);
    assert.equal(app.selectionNotifications[0].node, null);
    assert.equal(app.selectionNotifications[0].segment, null);
    assert.equal(app.ui.propertiesPanel.rebuilds, rebuilds + 1);
    assert.ok(document.getElementById('prop_lineWidth'), 'Properties returns from Node to the surviving whole shape');
    assert.deepEqual(app.shapes, [shape]);
    assert.equal(app.history.undoStack.length, split ? 0 : 1);
    if (split) {
        assert.equal(app.drag, null);
        assert.equal(app.interactionState, 'idle');
        assert.equal(app.crosshairVisible, false);
    } else {
        assert.equal(shape.nodes.size, 3);
        app.history.undo();
    }
    assert.deepEqual(shape.captureState(), before);
}

for (const kind of ['arc-to-line', 'line-to-arc', 'floating-line-to-arc',
    'segment-to-arc', 'floating-segment-to-arc', 'segment-to-line', 'collapsed-segment-to-line', 'decompose']) {
    const shape = kind === 'arc-to-line'
        ? new Arc({ startPoint: { x: 0, y: 0 }, endPoint: { x: 10, y: 0 }, bulgePoint: { x: 5, y: 2 } })
        : kind === 'collapsed-segment-to-line'
            ? createLine({ points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }] })
        : kind.includes('line-to-arc') ? createLine({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] })
            : createRect({ x: 0, y: 0, width: 10, height: 10, cornerRadius: kind === 'decompose' ? 1 : 0 });
    const edgeId = shape.type === 'arc' ? null : kind === 'collapsed-segment-to-line' ? 'e1' : 'e0';
    if (shape.type === 'polyline' && kind.endsWith('to-line')) shape.setEdgeAttr(edgeId, 'bulge', 0.25);
    const app = fixture(shape);
    const rebuilds = app.ui.propertiesPanel.rebuilds;
    const floating = kind.startsWith('floating');
    const changed = kind === 'decompose' ? decomposeShapeCorners(app, shape)
        : setSchematicShapeSegmentType(app, shape, edgeId, kind.endsWith('to-line') ? 'line' : 'arc', { floating });
    assert.equal(changed, true);
    assert.equal(app.selectionNotifications.length, 1, `${kind}: one completed selection notification`);
    assert.equal(app.ui.propertiesPanel.rebuilds, rebuilds + 1, `${kind}: one Properties rebuild`);
    assert.deepEqual(app.selectionNotifications[0].selection, app.selection.getSelection());
    assert.deepEqual(app.selectionNotifications[0].segment, app._selectedShapeSegment,
        `${kind}: subscribers receive final refinement, not an intermediate whole-object selection`);
    assert.equal(app.selectionNotifications[0].interactionState, floating ? 'anchorDrag' : 'idle');
    assert.equal(document.getElementById('schematicStatusTip').hidden,
        !!app._selectedShapeSegment || app.shapes[0].type !== 'polyline');
    assert.equal(app.history.undoStack.length, floating ? 0 : 1, 'UI completion does not add history');
    if (kind.endsWith('to-line')) assert.equal(document.getElementById('prop_bulge'), null);
    if (kind === 'collapsed-segment-to-line') assert.equal(shape.nodes.size, 2);
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
    expectDeletionNotification(app);
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
    expectDeletionNotification(app);
    app.history.undo();
    assert.deepEqual(app.shapes, [wire]);
    assert.equal(wire.element.parentNode, app.viewport.contentLayer);
}
for (const edgeId of ['e0', 'e1']) {
    const wire = new Wire({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 10 }] });
    const app = fixture(wire);
    const before = wire.captureState();
    deleteWireSegment(app, wire, edgeId);
    assert.equal(app.selectionNotifications.length, 1, 'Wire graph changes publish only the completed selection');
    if (edgeId === 'e1') {
        assert.equal(app.shapes.length, 2);
        expectDeletionNotification(app);
    } else {
        assert.deepEqual(app.selectionNotifications[0].selection, [wire], 'An in-place wire edit keeps its selection');
        assert.equal(wire.edges.size, 2);
        assert.ok(document.getElementById('prop_net'), 'Surviving wire Properties remain available');
    }
    app.history.undo();
    assert.deepEqual(app.shapes, [wire]);
    assert.deepEqual(wire.captureState(), before);
}
{
    const shape = createRect({ x: 0, y: 0, width: 10, height: 10 });
    const app = fixture(shape);
    const other = createLine({ points: [{ x: 20, y: 0 }, { x: 30, y: 0 }] });
    commandAddShapeInternal(app, other);
    app.selection.select(other, true);
    app.selectionNotifications.length = 0;
    deleteWireSegment(app, shape, 'e0');
    expectDeletionNotification(app);
    assert.ok(app.shapes.includes(other), 'Context deletion does not remove unrelated selected objects');
    assert.equal(app.selection.isSelected(other), false, 'Existing context-deletion selection clearing is preserved');
}
{
    const shape = createRect({ x: 0, y: 0, width: 10, height: 10 });
    const app = fixture(shape);
    const width = document.getElementById('prop_lineWidth');
    shape.locked = true;
    deleteWireSegment(app, shape, 'e0');
    assert.deepEqual(app.selectionNotifications, [], 'Rejected edits do not publish selection changes');
    shape.locked = false;
    app.history.execute = () => { throw new Error('Rejected delete command'); };
    assert.throws(() => deleteWireSegment(app, shape, 'e0'), /Rejected delete command/);
    assert.deepEqual(app.selectionNotifications, [], 'Failed commands do not report completed UI cleanup');
    assert.deepEqual(app.selection.getSelection(), [shape]);
    assert.equal(document.getElementById('prop_lineWidth'), width);
}
console.log('PASS schematic deletion redraw, one final selection notification, Properties cleanup and exact undo/redo');
