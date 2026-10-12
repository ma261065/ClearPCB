import assert from 'node:assert/strict';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { SelectionManager } from '../../src/core/SelectionManager.js';
import { createRect, createLine, createPolygon } from '../../src/shapes/polyline.js';
import { Wire } from '../../src/shapes/wire.js';
import { Arc } from '../../src/shapes/arc.js';
import { viewOf } from '../../src/schematic/render/shape-view-state.js';
import { getShapeNodeFocus, getShapeSegmentFocus, setShapeNodeFocus, setShapeSegmentFocus } from '../../src/schematic/modules/shape-focus.js';
import { getSchematicDrag } from '../../src/schematic/modules/drag.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

function element(tag = 'div') {
    const node = fakeElement(tag);
    node.rebuilds = 0;
    const innerHTML = Object.getOwnPropertyDescriptor(node, 'innerHTML');
    Object.defineProperty(node, 'innerHTML', {
        get: innerHTML.get,
        set(value) {
            node.rebuilds++;
            innerHTML.set.call(node, value);
        },
    });
    return node;
}

const listeners = new Map();
const document = installFakeDom();
globalThis.window.addEventListener = (name, callback) => listeners.set(name, callback);
globalThis.window.removeEventListener = name => listeners.delete(name);
document.createElementNS = (_namespace, tag) => element(tag);
document.createElement = tag => element(tag);
const {
    commandAddShapeInternal, commandRemoveShapeInternal, commandDeleteShapesInternal,
    commandRestoreShapesInternal,
} = await import('../../src/schematic/modules/shape-management.js');
const { getShapeSegmentSelectionElement, renderShapes } = await import('../../src/schematic/modules/schematic-view.js');
const { runSchematicDeleteAction } = await import('../../src/schematic/modules/editor-actions.js');
const { deleteWire, deleteWireSegment, deleteSchematicShapeNode, splitAnchorAndDrag, setSchematicShapeSegmentType } =
    await import('../../src/schematic/modules/context-menu.js');
const { bindKeyboardShortcuts } = await import('../../src/schematic/modules/keyboard.js');
const { bindPropertiesPanel, updatePropertiesPanel } = await import('../../src/schematic/modules/properties.js');
const { bindRibbon } = await import('../../src/schematic/modules/ribbon.js');
const { default: SchematicApp } = await import('../../src/ui/SchematicApp.js');

function fixture(shape) {
    document.body.textContent = '';
    const layer = element();
    const root = element();
    root.appendChild(layer);
    document.body.appendChild(root);
    const panel = element();
    document.body.appendChild(panel);
    const tip = element();
    tip.id = 'schematicStatusTip';
    document.body.appendChild(tip);
    const ribbon = element();
    ribbon.id = 'ribbonSchematic';
    ribbon.className = 'ribbon';
    document.body.appendChild(ribbon);
    for (const name of ['home', 'properties']) {
        const tab = element(), panel = element();
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
                    segment: getShapeSegmentFocus(app), node: getShapeNodeFocus(app),
                    interactionState: app.interactionState });
                for (const subscriber of subscribers.get(name) || []) subscriber(selection);
            },
        },
        viewport: { scale: 10, svg: root, contentLayer: layer, addContent: element => layer.appendChild(element) },
        selection: new SelectionManager({ onSelectionChanged: selected => app._onSelectionChanged(selected) }),
        history: new CommandHistory(), fileManager: { setDirty() {} },
        _onSelectionChanged: SchematicApp.prototype._onSelectionChanged,
        updateShapeSelectionTip: SchematicApp.prototype.updateShapeSelectionTip,
        setActiveRibbonTab: SchematicApp.prototype.setActiveRibbonTab,
        updateSelectableItems() { this.selection.setShapes(this.shapes); },
        updatePropertiesPanel(selection) { updatePropertiesPanel(this, selection); },
        renderShapes(force) { renderShapes(this, force); },
        commandAddShape(item, label) { return commandAddShapeInternal(this, item, label); },
        commandRemoveShape(item, options) { return commandRemoveShapeInternal(this, item, options); },
        commandDeleteShapes(items, labels) { commandDeleteShapesInternal(this, items, labels); },
        commandRestoreShapes(items, labels) { commandRestoreShapesInternal(this, items, labels); },
        _deleteSelected() { runSchematicDeleteAction(this); },
        _captureShapeState(item) { return item.captureState(); },
        showCrosshair() { this.crosshairVisible = true; },
        hideCrosshair() { this.crosshairVisible = false; },
        updateCrosshair() {},
    };
    bindPropertiesPanel(app);
    bindRibbon(app);
    commandAddShapeInternal(app, shape);
    app.selection.select(shape);
    assert.ok(app.ui.propertiesPanel.textContent.includes('1 selected'), 'Properties starts with the selected shape');
    assert.equal(app.activeRibbonTab, 'properties');
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
    setShapeNodeFocus(app, { shapeId: line.id, nodeId });
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
    setShapeNodeFocus(app, { shapeId: line.id, nodeId });
    app._onSelectionChanged(app.selection.getSelection());
    runSchematicDeleteAction(app);
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
        setShapeNodeFocus(app, { shapeId: shape.id, nodeId: `n${index}` });
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
    setShapeNodeFocus(app, { shapeId: shape.id, nodeId: 'n2' });
    app._onSelectionChanged(app.selection.getSelection());
    runSchematicDeleteAction(app);
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
        setShapeSegmentFocus(app, { shapeId: rectangle.id, edgeId: 'e0' });
        app.renderShapes(true);
        const overlay = getShapeSegmentSelectionElement(app);
        assert.equal(overlay.parentNode, app.viewport.contentLayer);
        const dispose = bindKeyboardShortcuts(app);
        try {
            listeners.get('keydown')({ key, target: { tagName: 'DIV' }, preventDefault() {}, stopPropagation() {} });
            assert.equal(overlay.parentNode, null, 'Delete removes the refined-edge SVG before another pointer event');
            assert.equal(getShapeSegmentSelectionElement(app), null);
            assert.equal(getShapeSegmentFocus(app), null);
            assert.equal(viewOf(rectangle).element.parentNode, null, 'The old rectangle artwork is removed immediately');
            assert.equal(app.shapes.length, 1);
            const remaining = app.shapes[0];
            assert.equal(remaining.closed, false);
            assert.equal(remaining.edges.size, 3);
            assert.equal(viewOf(remaining).element.parentNode, app.viewport.contentLayer);
            assert.equal(app.history.undoStack.length, 1);
            expectDeletionNotification(app);
            app.history.undo();
            assert.deepEqual(app.shapes, [rectangle]);
            assert.deepEqual(rectangle.captureState(), before);
            assert.equal(viewOf(rectangle).element.parentNode, app.viewport.contentLayer);
            assert.equal(viewOf(remaining).element.parentNode, null);
            app.history.redo();
            assert.deepEqual(app.shapes, [remaining]);
            assert.equal(viewOf(rectangle).element.parentNode, null);
            assert.equal(viewOf(remaining).element.parentNode, app.viewport.contentLayer);
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
    setShapeNodeFocus(app, { shapeId: shape.id, nodeId: split ? getSchematicDrag(app).anchorId : 'n1' });
    app._onSelectionChanged(app.selection.getSelection());
    app.renderShapes(true);
    const tip = document.getElementById('schematicStatusTip');
    assert.equal(tip.hidden, true);
    app.selectionNotifications.length = 0;
    runSchematicDeleteAction(app);
    assert.equal(tip.hidden, false, 'Finishing a refined edit restores the whole-shape selection tip');
    assert.equal(app.selectionNotifications.length, 1, 'Retained selection publishes its final refinement once');
    assert.deepEqual(app.selectionNotifications[0].selection, [shape]);
    assert.equal(app.selectionNotifications[0].node, null);
    assert.equal(app.selectionNotifications[0].segment, null);
    assert.ok(document.getElementById('prop_lineWidth'), 'Properties returns from Node to the surviving whole shape');
    assert.deepEqual(app.shapes, [shape]);
    assert.equal(app.history.undoStack.length, split ? 0 : 1);
    if (split) {
        assert.equal(getSchematicDrag(app), null);
        assert.equal(app.interactionState, 'idle');
        assert.equal(app.crosshairVisible, false);
    } else {
        assert.equal(shape.nodes.size, 3);
        app.history.undo();
    }
    assert.deepEqual(shape.captureState(), before);
}

for (const kind of ['arc-to-line', 'line-to-arc', 'floating-line-to-arc',
    'segment-to-arc', 'floating-segment-to-arc', 'segment-to-line', 'collapsed-segment-to-line']) {
    const shape = kind === 'arc-to-line'
        ? new Arc({ startPoint: { x: 0, y: 0 }, endPoint: { x: 10, y: 0 }, bulgePoint: { x: 5, y: 2 } })
        : kind === 'collapsed-segment-to-line'
            ? createLine({ points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }] })
        : kind.includes('line-to-arc') ? createLine({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] })
            : createRect({ x: 0, y: 0, width: 10, height: 10, cornerRadius: 0 });
    const edgeId = shape.type === 'arc' ? null : kind === 'collapsed-segment-to-line' ? 'e1' : 'e0';
    if (shape.type === 'polyline' && kind.endsWith('to-line')) shape.setEdgeAttr(edgeId, 'bulge', 0.25);
    const app = fixture(shape);
    const floating = kind.startsWith('floating');
    const changed = setSchematicShapeSegmentType(app, shape, edgeId, kind.endsWith('to-line') ? 'line' : 'arc', { floating });
    assert.equal(changed, true);
    assert.equal(app.selectionNotifications.length, 1, `${kind}: one completed selection notification`);
    assert.ok(document.getElementById('ribbonDelete'), `${kind}: Properties reflects the completed refinement`);
    assert.deepEqual(app.selectionNotifications[0].selection, app.selection.getSelection());
    assert.deepEqual(app.selectionNotifications[0].segment, getShapeSegmentFocus(app),
        `${kind}: subscribers receive final refinement, not an intermediate whole-object selection`);
    assert.equal(app.selectionNotifications[0].interactionState, floating ? 'anchorDrag' : 'idle');
    assert.equal(document.getElementById('schematicStatusTip').hidden,
        !!getShapeSegmentFocus(app) || app.shapes[0].type !== 'polyline');
    assert.equal(app.history.undoStack.length, floating ? 0 : 1, 'UI completion does not add history');
    if (kind.endsWith('to-line')) assert.equal(document.getElementById('prop_bulge'), null);
    if (kind === 'collapsed-segment-to-line') assert.equal(shape.nodes.size, 2);
}

for (const action of [
    (app, shape) => { setShapeNodeFocus(app, { shapeId: shape.id, nodeId: 'n0' }); runSchematicDeleteAction(app); },
    (app, shape) => deleteWireSegment(app, shape, 'e0'),
    (app, shape) => deleteWire(app, shape),
]) {
    const line = createLine({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    const app = fixture(line);
    setShapeSegmentFocus(app, { shapeId: line.id, edgeId: 'e0' });
    app.renderShapes(true);
    const overlay = getShapeSegmentSelectionElement(app);
    action(app, line);
    assert.equal(app.shapes.length, 0);
    assert.equal(overlay.parentNode, null);
    assert.equal(viewOf(line).element.parentNode, null);
    expectDeletionNotification(app);
    app.history.undo();
    assert.deepEqual(app.shapes, [line]);
    assert.equal(viewOf(line).element.parentNode, app.viewport.contentLayer);
}
for (const action of [deleteWire, (app, wire) => deleteWireSegment(app, wire, 'e0')]) {
    const wire = new Wire({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    const app = fixture(wire);
    action(app, wire);
    assert.equal(app.shapes.length, 0);
    assert.equal(viewOf(wire).element.parentNode, null);
    assert.equal(app.selection.getSelection().length, 0);
    expectDeletionNotification(app);
    app.history.undo();
    assert.deepEqual(app.shapes, [wire]);
    assert.equal(viewOf(wire).element.parentNode, app.viewport.contentLayer);
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
