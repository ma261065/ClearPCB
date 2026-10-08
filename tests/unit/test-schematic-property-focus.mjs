import assert from 'node:assert/strict';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { SelectionManager } from '../../src/core/SelectionManager.js';
import { createRect, createLine, createPolygon } from '../../src/shapes/polyline.js';
import { Circle } from '../../src/shapes/circle.js';
import { Text } from '../../src/shapes/text.js';
import { Net } from '../../src/shapes/net.js';
import { getShapeSegmentFocus, setShapeNodeFocus, setShapeSegmentFocus } from '../../src/schematic/modules/shape-focus.js';
import { flushSettledChanges } from '../../src/shared/ui/settled-input.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

const hostListeners = new Map();
const document = installFakeDom();
function element(tag = 'div') {
    const node = fakeElement(tag);
    node.tagName = String(tag).toUpperCase();
    const removeChild = node.removeChild.bind(node);
    const replaceChildren = node.replaceChildren.bind(node);
    node.removeChild = child => {
        if (child.contains?.(document.activeElement)) document.activeElement = document.body;
        return removeChild(child);
    };
    node.replaceChildren = (...nodes) => {
        if (node.contains(document.activeElement)) document.activeElement = document.body;
        return replaceChildren(...nodes);
    };
    return node;
}
globalThis.window.addEventListener = (name, callback) => hostListeners.set(name, callback);
globalThis.window.removeEventListener = name => hostListeners.delete(name);
document.createElement = tag => element(tag);
const { updatePropertiesPanel, hasSchematicPropertyPreview } = await import('../../src/schematic/modules/properties.js');
const { bindKeyboardShortcuts } = await import('../../src/schematic/modules/keyboard.js');
const { runSchematicHistoryAction } = await import('../../src/schematic/modules/editor-actions.js');
const { ProjectDocument } = await import('../../src/core/ProjectDocument.js');
const { default: SchematicApp } = await import('../../src/ui/SchematicApp.js');

function fixture(shapes, refinement = {}) {
    const { nodeFocus, segmentFocus, ...overrides } = refinement;
    document.body.innerHTML = '';
    const panel = element('div');
    document.body.appendChild(panel);
    const selection = new SelectionManager();
    selection.setShapes(shapes);
    shapes.forEach(shape => selection.select(shape, true));
    let rebuilds = 0;
    const app = {
        shapes, components: [], selection, currentTool: 'select',
        ui: { propertiesPanel: panel }, viewport: { snapToGrid: false },
        history: new CommandHistory(), renderShapes() {}, fileManager: { setDirty() {} }, ...overrides,
        updatePropertiesPanel(selected) { rebuilds++; updatePropertiesPanel(this, selected); },
    };
    setShapeNodeFocus(app, nodeFocus);
    setShapeSegmentFocus(app, segmentFocus);
    app.updatePropertiesPanel(shapes);
    const dispose = bindKeyboardShortcuts(app);
    const keydown = key => {
        const event = { key, target: document.activeElement, defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
        hostListeners.get('keydown')(event);
        return event;
    };
    return { app, dispose, keydown, rebuilds: () => rebuilds };
}

// A reference reads horizontally or vertically like every schematic text (no Rotation field).
for (const property of ['lineWidth', 'cornerRadius', 'diameter', 'fontSize']) {
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
                flushSettledChanges();
                assert.ok(document.activeElement === input, `${property} (${count} shapes): committing a step keeps focus`);
                assert.equal(document.getElementById(input.id), input, `${property}: preserve the field DOM node`);
                assert.ok(rebuilds() > initialRebuilds, 'Numeric changes re-describe Properties through the shared renderer');
                assert.ok(shapes.every(shape => Math.abs(shape[property] - value) < 1e-9),
                    `${property} (${count} shapes) preview/commit updates every target to ${value}: ${shapes.map(shape => shape[property]).join(',')}`);
                assert.deepEqual(readPositions(), positions, 'Property stepping never translates the shape');
            }
            const after = shapes.map(shape => shape.captureState());
            assert.equal(app.history.undoStack.length, 3);
            input.fire('change');
            flushSettledChanges();
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

// A reference is oriented like any schematic text: H/V buttons, no free Rotation field.
{
    const text = new Text({ text: 'Label', rotation: 37 });
    text.fieldKey = 'reference';
    assert.equal(text.rotation, 0, 'a stored free angle snaps to horizontal or vertical');
    const { dispose } = fixture([text]);
    try {
        assert.equal(document.getElementById('prop_rotation'), null, 'no free-angle Rotation field');
        document.getElementById('propTextVertical').fire('click');
        assert.equal(text.rotation, 270);
        document.getElementById('propTextHorizontal').fire('click');
        assert.equal(text.rotation, 0);
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
        flushSettledChanges();
        assert.deepEqual(shapes.map(shape => shape.lineWidth), [0.2, 0.5]);
        assert.equal(input.value, '');
        assert.ok(input.placeholder, 'Invalid edits restore the mixed value');
        assert.ok(document.activeElement === input);
        assert.equal(app.history.undoStack.length, 0);
        input.value = '0.8'; input.fire('input'); input.fire('change');
        flushSettledChanges();
        assert.equal(input.placeholder, '', 'Committing a common value clears the mixed placeholder');
        assert.equal(Number(input.value), 0.8);
        input.value = '0.9'; input.fire('input');
        document.activeElement = document.body; input.fire('blur');
        await Promise.resolve();
        assert.equal(app.history.undoStack.length, 2);
        assert.equal(document.getElementById(input.id), input, 'Shared renderer reuses property rows across unfocused commits');
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
        flushSettledChanges();
        assert.equal(circle.radius, 0.2);
        assert.equal(Number(width.value), 0.2, 'Shrinking a circle synchronizes the constrained width');
        assert.ok(document.activeElement === diameter);
        width.focus();
        diameter.fire('blur');
        width.value = '0.1'; width.fire('input');
        await Promise.resolve();
        assert.ok(document.activeElement === width, 'Deferred blur of a committed field leaves the new field alone');
        width.fire('change');
        flushSettledChanges();
        assert.equal(circle.lineWidth, 0.1);
        assert.equal(app.history.undoStack.length, 2);
        width.value = '4'; width.fire('input'); width.fire('change');
        flushSettledChanges();
        assert.equal(Number(width.value), 0.2, 'Clamping updates the focused field in place');
        assert.ok(document.activeElement === width);
        diameter.focus();
        diameter.value = '0.15'; diameter.fire('input');
        diameter.value = ''; diameter.fire('change');
        flushSettledChanges();
        assert.equal(Number(diameter.value), 0.4);
        assert.equal(Number(width.value), 0.2, 'Cancelling restores paired controls as well as geometry');
    } finally { dispose(); }
}

for (const refinement of ['whole', 'node', 'segment']) {
    const rectangle = createRect({ width: 10, height: 10 });
    const selected = refinement === 'node' ? { nodeFocus: { shapeId: rectangle.id, nodeId: 'n0' } }
        : refinement === 'segment' ? { segmentFocus: { shapeId: rectangle.id, edgeId: 'e0' } } : {};
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
                flushSettledChanges();
                assert.ok(document.activeElement === width, 'Refined segment width keeps focus');
                assert.equal(rectangle.getEdgeAttr('e0', 'width'), Number(value));
                assert.equal(rectangle.lineWidth, before.lineWidth, 'A segment edit does not change the whole shape width');
            }
        }
        input.focus();
        for (const value of refinement === 'segment' ? ['0.5', '0.6'] : ['1', '2', '0']) {
            input.value = value; input.fire('input'); input.fire('change');
            flushSettledChanges();
            assert.ok(document.activeElement === input, `${refinement}: repeated edits retain focus`);
            if (refinement !== 'segment') {
                assert.equal(!!document.getElementById('propDecomposeCorners'), value !== '0',
                    'Decompose action availability follows corner changes through re-description');
            }
        }
        if (refinement === 'segment') {
            input.value = '0'; input.fire('input'); input.fire('change');
            flushSettledChanges();
            assert.equal(document.getElementById('prop_bulge'), null, 'Straightening removes the obsolete Bulge field');
            assert.ok(document.activeElement !== input, 'Schema changes still rebuild Properties');
        }
        while (app.history.undo()) {}
        assert.deepEqual(rectangle.captureState(), before);
    } finally { dispose(); }
}
for (const completion of ['change', 'blur']) for (const withinPanel of [false, true]) {
    const shape = createRect({ width: 10, height: 10, lineWidth: 0.2, cornerRadius: 0.5 });
    const { app, dispose, keydown } = fixture([shape]);
    try {
        const previous = document.getElementById('prop_lineWidth');
        const next = document.getElementById('prop_cornerRadius');
        const before = shape.captureState();
        previous.focus();
        previous.value = '0.8'; previous.fire('input');
        if (withinPanel) next.focus();
        else document.activeElement = document.body;
        previous.fire(completion);
        if (completion === 'change') flushSettledChanges();
        await Promise.resolve();
        assert.equal(app.history.undoStack.length, 1);
        assert.equal(shape.lineWidth, 0.8);
        if (withinPanel) {
            assert.ok(document.activeElement === next, 'Finishing the previous field must retain focus in Properties');
            assert.equal(document.getElementById(next.id), next);
            assert.equal(keydown('ArrowUp').defaultPrevented, false, 'The next field, not canvas nudging, owns the arrow');
            next.value = '1.5'; next.fire('input'); next.fire('change');
            flushSettledChanges();
            assert.equal(app.history.undoStack.length, 2);
            app.history.undo();
            assert.equal(shape.lineWidth, 0.8);
        } else assert.equal(document.getElementById(next.id), next, 'Leaving Properties re-describes without replacing stable rows');
        app.history.undo();
        assert.deepEqual(shape.captureState(), before);
    } finally { dispose(); }
}

for (const nextProperty of ['cornerRadius', 'lineWidth']) {
    const shape = createRect({ width: 10, height: 10, lineWidth: 0.2, cornerRadius: 0.5 });
    const { app, dispose } = fixture([shape]);
    try {
        const previousProperty = nextProperty === 'cornerRadius' ? 'lineWidth' : 'cornerRadius';
        const previous = document.getElementById(`prop_${previousProperty}`);
        const next = document.getElementById(`prop_${nextProperty}`);
        const before = shape.captureState();
        previous.focus();
        previous.value = '0.8'; previous.fire('input'); previous.fire('blur');
        next.focus();
        next.value = '1.5'; next.fire('input');
        assert.equal(app.history.undoStack.length, 1, 'A new field first commits the previous field independently');
        assert.equal(Number(next.value), 1.5, 'Handoff preserves the newly typed value');
        await Promise.resolve();
        assert.equal(shape[previousProperty], 0.8);
        assert.equal(shape[nextProperty], 1.5, 'Deferred blur cannot capture the next field into the previous command');
        assert.equal(document.getElementById(next.id), next);
        assert.equal(document.activeElement, next);
        next.fire('change');
        flushSettledChanges();
        assert.equal(app.history.undoStack.length, 2);
        const after = shape.captureState();
        app.history.undo();
        assert.equal(shape[previousProperty], 0.8);
        assert.equal(shape[nextProperty], before[nextProperty], 'First undo changes only the second field');
        app.history.undo();
        assert.deepEqual(shape.captureState(), before);
        app.history.redo(); app.history.redo();
        assert.deepEqual(shape.captureState(), after);
    } finally { dispose(); }
}

for (const invalid of ['', '-']) {
    const shape = createRect({ width: 10, height: 10, lineWidth: 0.2, cornerRadius: 0.5 });
    const { app, dispose } = fixture([shape]);
    try {
        const width = document.getElementById('prop_lineWidth');
        const radius = document.getElementById('prop_cornerRadius');
        const before = shape.captureState();
        width.focus(); width.value = '0.8'; width.fire('input');
        width.value = invalid; width.fire('input'); width.fire('blur');
        radius.focus(); radius.value = '1.5'; radius.fire('input');
        assert.equal(shape.lineWidth, before.lineWidth, 'Invalid previous input cancels rather than committing its last valid preview');
        assert.equal(app.history.undoStack.length, 0);
        await Promise.resolve();
        assert.equal(shape.cornerRadius, 1.5);
        assert.equal(Number(radius.value), 1.5);
        assert.ok(document.activeElement === radius);
        radius.fire('change');
        flushSettledChanges();
        assert.equal(app.history.undoStack.length, 1);
        const after = shape.captureState();
        app.history.undo();
        assert.deepEqual(shape.captureState(), before);
        app.history.redo();
        assert.deepEqual(shape.captureState(), after);
    } finally { dispose(); }
}

for (const property of ['fill', 'text', 'style']) for (const valid of [false, true]) {
    const shape = property === 'fill' ? new Circle({ radius: 5, lineWidth: 0.2 })
        : property === 'text' ? new Text({ text: 'Before' }) : new Net({ net: 'VCC' });
    const { app, dispose } = fixture([shape]);
    try {
        const numericProperty = property === 'fill' ? 'lineWidth' : 'fontSize';
        const input = document.getElementById(`prop_${numericProperty}`);
        const before = shape.captureState(), originalProperty = shape[property], originalNumber = shape[numericProperty];
        const allElements = element => [element, ...element.children.flatMap(allElements)];
        const discrete = property === 'fill'
            ? allElements(app.ui.propertiesPanel).filter(element => element.type === 'checkbox').at(-1)
            : document.getElementById(`prop_${property}`);
        const number = property === 'fill' ? 0.8 : 3;
        const value = property === 'fill' ? true : property === 'text' ? 'After' : 'gnd';
        input.focus(); input.value = String(number); input.fire('input');
        if (!valid) { input.value = ''; input.fire('input'); }
        input.fire('blur');
        discrete.focus();
        if (property === 'fill') discrete.checked = value;
        else discrete.value = value;
        discrete.fire('change');
        assert.equal(app.history.undoStack.length, valid ? 2 : 1,
            'A discrete action settles the preceding numeric edit before executing');
        assert.equal(shape[numericProperty], valid ? number : originalNumber);
        assert.equal(shape[property], value);
        const after = shape.captureState();
        await Promise.resolve();
        assert.deepEqual(shape.captureState(), after, 'Deferred numeric blur cannot absorb the discrete property edit');
        assert.equal(app.history.undoStack.length, valid ? 2 : 1);
        app.history.undo();
        assert.equal(shape[property], originalProperty, 'First Undo reverses only the discrete property');
        assert.equal(shape[numericProperty], valid ? number : originalNumber);
        if (valid) app.history.undo();
        assert.deepEqual(shape.captureState(), before);
        if (valid) app.history.redo();
        app.history.redo();
        assert.deepEqual(shape.captureState(), after);
    } finally { dispose(); }
}

for (const property of ['fill', 'text', 'style']) for (const replacement of ['refresh', 'selection', 'panel']) {
    const create = () => property === 'fill' ? new Circle({ radius: 5 })
        : property === 'text' ? new Text({ text: 'Before' }) : new Net({ net: 'VCC' });
    const shape = create();
    const { app, dispose } = fixture([shape]);
    try {
        const allElements = element => [element, ...element.children.flatMap(allElements)];
        const control = () => property === 'fill'
            ? allElements(app.ui.propertiesPanel).filter(element => element.type === 'checkbox').at(-1)
            : document.getElementById(`prop_${property}`);
        const retired = control();
        const retiredDelete = document.getElementById('ribbonDelete');
        const retiredCopy = document.getElementById('propCopy');
        let deletes = 0, copies = 0;
        app._deleteSelected = () => { deletes++; };
        app.copySelection = () => { copies++; };
        if (replacement === 'selection') {
            const next = create();
            app.shapes.push(next);
            app.selection.setShapes(app.shapes);
            app.selection.select(next, false);
        } else if (replacement === 'panel') {
            document.body.innerHTML = '';
            app.ui.propertiesPanel = element('div');
            document.body.appendChild(app.ui.propertiesPanel);
        }
        app.updatePropertiesPanel(app.selection.getSelection());
        const current = control(), before = app.shapes.map(item => item.captureState()), initialChildren = app.ui.propertiesPanel.children;
        if (property === 'fill') retired.checked = true;
        else retired.value = property === 'text' ? 'Stale' : 'gnd';
        if (retired === current) {
            assert.notEqual(replacement, 'panel', 'Only an in-place panel can reconcile and keep the current control');
        } else {
            retired.fire('change'); retiredDelete.fire('click'); retiredCopy.fire('click');
            assert.deepEqual(app.shapes.map(item => item.captureState()), before, 'Replaced controls cannot edit the current selection');
            assert.equal(app.history.undoStack.length, 0);
            assert.equal(deletes, 0, 'Replaced Delete cannot operate on a newer selection');
            assert.equal(copies, 0);
        }
        assert.equal(control(), current);
        assert.equal(app.ui.propertiesPanel.children, initialChildren, 'Stale callbacks cannot rebuild Properties');
        document.getElementById('propCopy').fire('click');
        assert.equal(copies, 1, 'Current action buttons still operate');
        if (property === 'fill') current.checked = true;
        else current.value = property === 'text' ? 'After' : 'gnd';
        current.fire('change');
        assert.equal(app.history.undoStack.length, 1);
    } finally { dispose(); }
}

for (const [tool, nextTool, id, key, value] of [
    ['circle', 'rect', 'prop_newShapeLineWidth', 'lineWidth', '0.5'],
    ['text', 'net', 'prop_newShapeFontSize', 'netFontSize', '3'],
    ['wire', 'wire', 'prop_newWireNet', 'wireNet', 'GND'],
]) {
    const options = { lineWidth: 0.2, fill: false, fontSize: 2, netFontSize: 1.4, wireNet: 'VCC' };
    const { app, dispose } = fixture([], { currentTool: tool, toolOptions: { ...options } });
    try {
        const retired = document.getElementById(id);
        const retiredFill = document.getElementById('prop_newShapeFill');
        app.currentTool = nextTool;
        app.updatePropertiesPanel([]);
        const current = document.getElementById(id);
        if (retired !== current) {
            retired.value = value; retired.fire('change');
            if (retiredFill) { retiredFill.checked = true; retiredFill.fire('change'); }
            assert.deepEqual(app.toolOptions, options, 'Old drawing defaults cannot change the current tool');
        }
        current.value = value; current.fire('change');
        assert.equal(app.toolOptions[key], key === 'wireNet' ? value : Number(value));
    } finally { dispose(); }
}

{
    // Wire Net fields use the same existing-net menu as the PCB editor, not a browser datalist.
    const wire = { type: 'wire', net: 'SIG' };
    const { app, dispose } = fixture([], { currentTool: 'wire', shapes: [wire], toolOptions: { wireNet: '' } });
    try {
        const input = document.getElementById('prop_newWireNet');
        const control = input.parentNode;
        assert.equal(control.className, 'prop-net-control');
        const menu = control.children.find(child => child.tagName === 'DETAILS');
        assert.equal(menu?.className, 'prop-net-menu', 'The Net field offers the shared net menu');
        assert.equal(control.children.some(child => child.tagName === 'DATALIST'), false);
        const options = menu.children.find(child => child.tagName === 'DIV').children;
        assert.deepEqual(options.map(option => [option.dataset.net, option.textContent]), [['', 'Auto'], ['SIG', 'SIG']]);
        menu.open = true;
        options[1].fire('click');
        assert.equal(input.value, 'SIG');
        assert.equal(app.toolOptions.wireNet, 'SIG', 'Picking a net applies it');
        assert.equal(menu.open, false, 'Picking closes the menu');
    } finally { dispose(); }
}

for (const replacement of ['escape', 'commit', 'refresh', 'selection']) {
    const shape = new Circle({ radius: 5, lineWidth: 0.5 });
    const { app, dispose } = fixture([shape]);
    try {
        const retired = document.getElementById('prop_diameter');
        retired.focus();
        if (replacement === 'escape') {
            retired.value = '4'; retired.fire('input');
            retired.fire('keydown', { key: 'Escape' });
        } else if (replacement === 'commit') {
            retired.value = '4'; retired.fire('input');
            document.activeElement = document.body;
            retired.fire('blur');
            await Promise.resolve();
        } else if (replacement === 'refresh') app.updatePropertiesPanel([shape]);
        else {
            const next = new Circle({ radius: 3, lineWidth: 0.3 });
            app.shapes.push(next);
            app.selection.setShapes(app.shapes);
            app.selection.select(next, false);
            app.updatePropertiesPanel([next]);
        }
        if (document.getElementById('prop_diameter') === retired) {
            assert.ok(['escape', 'commit', 'refresh', 'selection'].includes(replacement),
                'Reconciled rows remain live when the same field still exists');
            continue;
        }
        const baseline = app.shapes.map(item => item.captureState()), depth = app.history.undoStack.length;
        const current = document.getElementById('prop_lineWidth');
        current.focus();
        current.value = '0.2'; current.fire('input');
        const pending = app.shapes.map(item => item.captureState());
        for (const event of ['input', 'change', 'blur']) {
            retired.value = '1'; retired.fire(event);
            await Promise.resolve();
            assert.deepEqual(app.shapes.map(item => item.captureState()), pending,
                `${replacement}: a retired field's ${event} must not alter the newer preview`);
            assert.equal(app.history.undoStack.length, depth);
            assert.equal(document.getElementById('prop_lineWidth'), current);
            assert.equal(document.activeElement, current);
        }
        retired.value = ''; retired.fire('change');
        retired.fire('keydown', { key: 'Escape' });
        assert.deepEqual(app.shapes.map(item => item.captureState()), pending);
        assert.equal(document.getElementById('prop_lineWidth'), current);
        current.fire('change');
        flushSettledChanges();
        assert.equal(app.history.undoStack.length, depth + 1);
        app.history.undo();
        assert.deepEqual(app.shapes.map(item => item.captureState()), baseline);
        app.history.redo();
        assert.deepEqual(app.shapes.map(item => item.captureState()), pending);
    } finally { dispose(); }
}

{
    const shape = createRect({ width: 10, height: 10 });
    shape.setEdgeAttr('e0', 'bulge', 0.25);
    const { app, dispose } = fixture([shape], { segmentFocus: { shapeId: shape.id, edgeId: 'e0' } });
    try {
        const retired = document.getElementById('prop_bulge');
        retired.focus();
        retired.value = '0'; retired.fire('input'); retired.fire('change');
        flushSettledChanges();
        const after = shape.captureState();
        assert.equal(document.getElementById('prop_bulge'), null);
        retired.value = '0.5'; retired.fire('input'); retired.fire('change'); retired.fire('blur');
        await Promise.resolve();
        assert.deepEqual(shape.captureState(), after, 'A removed Bulge control cannot curve the straightened segment again');
        assert.equal(app.history.undoStack.length, 1);
    } finally { dispose(); }
}

{
    const shape = createLine({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }] });
    shape.setEdgeAttr('e1', 'bulge', 0.25);
    const { app, dispose } = fixture([shape], { segmentFocus: { shapeId: shape.id, edgeId: 'e1' } });
    try {
        const before = shape.captureState();
        const bulge = document.getElementById('prop_bulge');
        const next = document.getElementById('prop_lineWidth');
        bulge.focus(); bulge.value = '0'; bulge.fire('input');
        next.focus(); next.value = '0.8'; next.fire('input');
        assert.equal(shape.nodes.size, 2, 'Field handoff finalizes the previous segment before starting another edit');
        assert.equal(shape.lineWidth, before.lineWidth);
        assert.equal(document.getElementById('prop_bulge'), null);
        assert.notEqual(document.getElementById('prop_lineWidth'), next);
        assert.equal(getShapeSegmentFocus(app), null);
        assert.equal(app.history.undoStack.length, 1);
        const after = shape.captureState();
        bulge.fire('blur'); next.fire('change');
        await Promise.resolve();
        assert.deepEqual(shape.captureState(), after);
        app.history.undo();
        assert.deepEqual(shape.captureState(), before);
        app.history.redo();
        assert.deepEqual(shape.captureState(), after);
    } finally { dispose(); }
}

for (const closed of [false, true]) for (const boundary of ['uniform', 'width', 'curve', 'selected-width']) {
    for (const completion of ['change', 'blur']) {
        const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
        if (closed) points.push({ x: 30, y: 10 }, { x: 0, y: 10 });
        const shape = (closed ? createPolygon : createLine)({ points, lineWidth: 0.2 });
        shape.setEdgeAttr('e1', 'bulge', 0.25);
        if (boundary === 'width') shape.setEdgeAttr('e0', 'width', 0.7);
        if (boundary === 'curve') shape.setEdgeAttr('e0', 'bulge', 0.3);
        if (boundary === 'selected-width') shape.setEdgeAttr('e1', 'width', 0.7);
        shape.setNodeCornerRadius('n3', 0.8);
        const { app, dispose } = fixture([shape], { segmentFocus: { shapeId: shape.id, edgeId: 'e1' } });
        try {
            const before = shape.captureState();
            let input = document.getElementById('prop_bulge');
            input.focus();
            input.value = '0'; input.fire('input');
            assert.equal(shape.nodes.size, points.length, 'Previewing zero keeps editable segment identities');
            input.fire('keydown', { key: 'Escape' });
            assert.deepEqual(shape.captureState(), before, 'Cancelling zero bulge restores exact curved geometry');
            assert.equal(app.history.undoStack.length, 0);
            input = document.getElementById('prop_bulge');
            input.focus();
            input.value = '0'; input.fire('input');
            input.value = '0.4'; input.fire('input');
            assert.equal(shape.nodes.size, points.length, 'Passing through zero during a preview does not merge nodes');
            assert.equal(shape.getEdgeAttr('e1', 'bulge'), 0.4);
            input.value = '0'; input.fire('input');
            input.fire(completion);
            if (completion === 'change') flushSettledChanges();
            await Promise.resolve();
            const expected = points.filter((_, index) => boundary === 'selected-width'
                || index !== 2 && (index !== 1 || boundary !== 'uniform'));
            assert.deepEqual(shape.getOrderedPoints(), expected, 'Committed straightening merges only redundant equal-width nodes');
            assert.equal(shape.nodeCornerRadius('n3'), 0.8, 'Surviving node metadata stays attached');
            if (boundary === 'curve') assert.equal(shape.getEdgeAttr('e0', 'bulge'), 0.3);
            if (boundary === 'width') assert.equal(shape.getEdgeAttr('e0', 'width'), 0.7);
            if (boundary === 'selected-width') assert.equal(shape.getEdgeAttr('e1', 'width'), 0.7);
            assert.equal(document.getElementById('prop_bulge'), null, 'Straightening removes the obsolete Bulge control');
            assert.equal(getShapeSegmentFocus(app)?.edgeId ?? null, shape.edges.has('e1') ? 'e1' : null,
                'Refinement cannot refer to a removed edge');
            assert.equal(app.history.undoStack.length, 1, 'Straightening and cleanup share one undo step');
            const after = shape.captureState();
            app.history.undo();
            assert.deepEqual(shape.captureState(), before);
            app.history.redo();
            assert.deepEqual(shape.captureState(), after);
        } finally { dispose(); }
    }
}
for (const action of ['undo', 'redo']) {
    const shape = new Circle({ radius: 5 });
    const { app, dispose } = fixture([shape]);
    try {
        let input = document.getElementById('prop_diameter');
        input.focus();
        input.value = '12'; input.fire('input'); input.fire('change');
        flushSettledChanges();
        if (action === 'redo') {
            app.history.undo();
            app.updatePropertiesPanel(app.selection.getSelection());
            input = document.getElementById('prop_diameter');
        }
        input.value = '20'; input.fire('input');
        assert.equal(hasSchematicPropertyPreview(app), true);
        runSchematicHistoryAction(app, action);
        const expected = action === 'undo' ? 10 : 12;
        assert.equal(shape.diameter, expected);
        assert.equal(hasSchematicPropertyPreview(app), false);
        assert.equal(Number(document.getElementById('prop_diameter').value), expected);
        input.fire('blur');
        await Promise.resolve();
        assert.equal(shape.diameter, expected, 'Old blur cannot commit over history');
        assert.equal(app.history.undoStack.length, action === 'undo' ? 0 : 1);
    } finally { dispose(); }
}

{
    const originals = Object.fromEntries(['setInterval', 'clearInterval', 'requestIdleCallback',
        'cancelIdleCallback', 'localStorage'].map(key => [key, globalThis[key]]));
    const timers = new Map(), idle = new Map(), stored = new Map();
    let nextId = 0;
    globalThis.setInterval = callback => { timers.set(++nextId, callback); return nextId; };
    globalThis.clearInterval = id => timers.delete(id);
    globalThis.requestIdleCallback = callback => { idle.set(++nextId, callback); return nextId; };
    globalThis.cancelIdleCallback = id => idle.delete(id);
    globalThis.localStorage = {
        getItem: key => stored.get(key) ?? null,
        setItem: (key, value) => stored.set(key, value),
        removeItem: key => stored.delete(key),
    };
    const flushIdle = () => {
        for (const [id, callback] of [...idle]) { idle.delete(id); callback(); }
    };
    try {
        for (const queuedBefore of [false, true]) for (const commit of [false, true]) {
            for (const replaceRoot of [false, true]) {
                stored.clear();
                const shape = new Circle({ radius: 5 });
                const { app, dispose } = fixture([shape]);
                const project = new ProjectDocument();
                app.project = project;
                app.fileManager = project.fileManager;
                app.isSectionEditing = SchematicApp.prototype.isSectionEditing;
                project.schematicDocument.shapes = app.shapes;
                project.registerView('schematic', app);
                project.fileManager.setDirty(true);
                project.startAutoSave();
                const tick = () => timers.get(project.fileManager.autoSaveTimer)();
                const key = project.fileManager.autoSavePrefix + encodeURIComponent(project.fileManager.fileName);
                try {
                    if (queuedBefore) tick();
                    const input = document.getElementById('prop_diameter');
                    input.focus();
                    input.value = '20'; input.fire('input');
                    if (replaceRoot) {
                        document.body.innerHTML = '';
                        app.ui.propertiesPanel = element('div');
                        document.body.appendChild(app.ui.propertiesPanel);
                        app.updatePropertiesPanel(app.selection.getSelection());
                    }
                    assert.equal(project.canSerialize(), false, 'Pending edit remains visible across panel replacement');
                    assert.throws(() => project.serialize(), /Finish the current edit before saving/);
                    if (!queuedBefore) tick();
                    flushIdle();
                    assert.equal(stored.has(key), false, 'Autosave cannot persist reversible schematic geometry');
                    assert.equal(project.fileManager._lastAutoSave, null, 'Blocked autosave retains the pending revision');
                    if (commit) {
                        input.fire('blur');
                        await Promise.resolve();
                    } else runSchematicHistoryAction(app, 'undo');
                    assert.equal(shape.radius, commit ? 10 : 5);
                    assert.equal(app.history.undoStack.length, commit ? 1 : 0);
                    assert.equal(project.canSerialize(), true);
                    tick();
                    flushIdle();
                    const saved = JSON.parse(stored.get(key)).data.schematic;
                    assert.equal(saved.shapes[0].r, commit ? 10 : 5);
                    assert.deepEqual(saved, JSON.parse(JSON.stringify(project.serialize().schematic)));
                } finally { project.fileManager.stopAutoSave(); dispose(); }
            }
        }
    } finally {
        for (const [key, value] of Object.entries(originals)) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
    }
}
console.log('PASS schematic numeric focus, history boundaries, pending-preview autosave, constraints, refinement and structural refresh');
