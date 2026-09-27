/** Headless regression tests for schematic polyline segment refinement. */

globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById() { return null; },
    createElementNS() {
        return {
            attributes: {},
            setAttribute(name, value) { this.attributes[name] = value; },
            remove() {},
            classList: { add() {} },
            style: {},
        };
    },
};

const { createLine, createPolygon, createRect } = await import('../src/shapes/polyline.js');
const {
    tryBeginPolylineSegmentDrag,
    updatePolylineSegmentDrag,
} = await import('../src/schematic/modules/polyline-segment-drag.js');
const { clearShapeSegmentSelection, renderShapeSegmentSelection } = await import('../src/schematic/modules/shape-management.js');
const { idleState } = await import('../src/schematic/modules/draw-states.js');
const { updatePropertiesPanel } = await import('../src/ui/modules/properties.js');
const { Circle } = await import('../src/shapes/circle.js');
const { Arc } = await import('../src/shapes/arc.js');
const { setSchematicShapeSegmentType, showSegmentContextMenu, dismissAnchorContextMenu, splitAnchorAndDrag } = await import('../src/ui/modules/context-menu.js');
const { deleteSelected } = await import('../src/ui/modules/selection.js');
const { resolveAnchorDragOnMouseUp, commitShapeJoin } = await import('../src/ui/modules/drag.js');
const { SelectionManager } = await import('../src/core/SelectionManager.js');
const { handleEscape } = await import('../src/ui/modules/keyboard.js');
const { setPathSegmentType } = await import('../src/shapes/path-operations.js');
const { snapShapeBulge } = await import('../src/schematic/modules/shape-snap.js');
const { bindMouseEvents } = await import('../src/ui/modules/mouse.js');

let failures = 0;
function expect(name, condition) {
    if (condition) console.log(`PASS: ${name}`);
    else {
        failures++;
        console.error(`FAIL: ${name}`);
    }
}

{
    const originalCreate = document.createElement;
    const originalFind = document.getElementById;
    const elements = [];
    document.createElement = tag => {
        const listeners = new Map();
        const element = { tag, children: [], style: {}, value: '', attributes: {},
            appendChild(child) { this.children.push(child); },
            append(...children) { this.children.push(...children); },
            setAttribute(name, value) { this.attributes[name] = value; },
            addEventListener(type, listener) {
                if (!listeners.has(type)) listeners.set(type, []);
                listeners.get(type).push(listener);
            },
            fire(type, details = {}) {
                for (const listener of listeners.get(type) || []) listener({ preventDefault() {}, stopPropagation() {}, ...details });
            },
        };
        elements.push(element);
        return element;
    };
    document.getElementById = id => elements.find(element => element.id === id) || null;
    try {
        const circle = new Circle({ radius: 5, lineWidth: 0.2 });
        const arc = new Arc({ startPoint: { x: 0, y: 0 }, endPoint: { x: 10, y: 0 }, bulgePoint: { x: 5, y: 2 }, lineWidth: 0.4 });
        const rectangle = createRect({ x: 0, y: 0, width: 10, height: 10, cornerRadius: 1 });
        for (const [selection, property] of [[[circle], 'lineWidth'], [[arc], 'lineWidth'],
            [[circle, arc], 'lineWidth'], [[rectangle], 'cornerRadius']]) {
            selection.forEach((item, index) => { item[property] = 0.2 + index * 0.2; });
            for (const item of selection) item.getPropertyDescriptors = () => [{ key: property, label: property, type: 'number', min: 0, max: 25 }];
            const commands = [];
            let currentSelection = selection;
            const app = { shapes: selection, components: [], selection: { getSelection: () => currentSelection },
                ui: { propertiesPanel: document.createElement('div') }, fileManager: { setDirty() {} },
                renderShapes() {}, _updatePropertiesPanel() {},
                history: { execute(command) { commands.push(command); command.execute(); } } };
            const build = () => {
                elements.length = 0;
                updatePropertiesPanel(app, selection);
                return document.getElementById(`prop_${property}`);
            };
            const original = selection.map(item => item[property]);
            let input = build();
            for (const value of ['2', '3']) { input.value = value; input.fire('input'); }
            expect('schematic numeric input previews without history', commands.length === 0 && selection.every(item => item[property] === 3));
            input.fire('change');
            input.fire('blur');
            await Promise.resolve();
            expect('schematic numeric preview commits exactly once', commands.length === 1);
            commands[0].undo();
            expect('schematic numeric undo restores every original value', selection.every((item, index) => item[property] === original[index]));
            commands[0].execute();
            expect('schematic numeric redo restores the preview', selection.every(item => item[property] === 3));
            input = build();
            input.value = '4'; input.fire('input'); input.fire('keydown', { key: 'Escape' });
            expect('schematic Escape cancels without history', commands.length === 1 && selection.every(item => item[property] === 3));
            input = build();
            input.value = '5'; input.fire('input');
            input.value = '3'; input.fire('input'); input.fire('change');
            expect('schematic unchanged preview creates no history', commands.length === 1);
            input = build();
            input.value = '6'; input.fire('input'); input.value = ''; input.fire('change');
            expect('schematic invalid commit cancels its preview', commands.length === 1 && selection.every(item => item[property] === 3));
            input = build();
            input.value = '4.5'; input.fire('input'); currentSelection = []; input.fire('blur');
            await Promise.resolve();
            expect('schematic detached input commits against its original targets', commands.length === 2 && selection.every(item => item[property] === 4.5));
            commands.at(-1).undo();
        }

        const buildInput = (app, property) => {
            elements.length = 0;
            app.ui = { propertiesPanel: document.createElement('div') };
            for (const shape of app.shapes) {
                const descriptors = shape.getPropertyDescriptors();
                shape.getPropertyDescriptors = () => descriptors.filter(desc => desc.key === property);
            }
            updatePropertiesPanel(app, [...app.selection.getSelection()]);
            return document.getElementById(`prop_${property}`);
        };
        for (const standalone of [false, true]) {
            for (const curved of [false, true]) {
                const shape = createLine({ points: standalone
                    ? [{ x: 0, y: 0 }, { x: 10, y: 0 }]
                    : [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] });
                shape.setEdgeAttr('e0', 'bulge', curved ? 0.5 : 0);
                const app = commandAppFor(shape);
                app._selectedShapeSegment = { shapeId: shape.id, edgeId: 'e0' };
                buildInput(app, 'lineWidth');
                const title = `${curved ? 'Arc' : 'Line'}${standalone ? '' : ' Segment'}`;
                expect('refined segment Properties names its geometry', elements.some(element => element.textContent === title));
            }
        }
        for (const selectedNode of [false, true]) {
            const shape = createRect({ x: 0, y: 0, width: 200, height: 200, cornerRadius: 1 });
            const app = commandAppFor(shape);
            if (selectedNode) app._selectedShapeNode = { shapeId: shape.id, nodeId: 'n0' };
            const before = shape.captureState();
            const input = buildInput(app, 'cornerRadius');
            expect('corner radius spinner is bounded from zero to 25', Number(input.max) === 25 && Number(input.min) === 0);
            input.value = '30';
            input.fire('input');
            input.fire('change');
            expect('corner radius clamps values above 25', (selectedNode ? shape.nodeCornerRadius('n0') : shape.cornerRadius) === 25
                && input.value === '25.00');
            expect('corner radius edit creates one undo command', app.commands.length === 1);
            app.commands[0].undo();
            expect('large corner radius edit is undoable', JSON.stringify(shape.captureState()) === JSON.stringify(before));
        }
        for (const property of ['lineWidth', 'cornerRadius']) {
            const first = createRect({ x: 0, y: 0, width: 10, height: 10, cornerRadius: 1 });
            const second = createRect({ x: 20, y: 0, width: 10, height: 10, cornerRadius: 2 });
            for (const shape of [first, second]) {
                shape.setEdgeAttr('e0', 'width', 0.8);
                shape.setNodeCornerRadius('n1', 3);
            }
            const app = commandAppFor(first);
            app.shapes.push(second);
            app.selection.select(second, true);
            const originals = app.shapes.map(shape => shape.captureState());
            const input = buildInput(app, property);
            expect(`multi-shape ${property} control is exposed`, !!input);
            input.value = '2.5'; input.fire('input');
            expect('whole-shape previews clear the corresponding overrides', app.shapes.every(shape => property === 'lineWidth'
                ? [...shape.edges.keys()].every(edgeId => shape.getEdgeAttr(edgeId, 'width') === 2.5)
                : Object.keys(shape.nodeCornerRadii).length === 0));
            input.fire('change');
            expect('multi-shape override reset is one command', app.commands.length === 1);
            app.commands[0].undo();
            expect('undo restores all overrides and original defaults', app.shapes.every((shape, index) =>
                JSON.stringify(shape.captureState()) === JSON.stringify(originals[index])));
        }
        {
            const first = new Circle({ radius: 5, lineWidth: 2 });
            const second = new Circle({ radius: 3, lineWidth: 1 });
            const app = commandAppFor(first);
            app.shapes.push(second); app.selection.select(second, true);
            const input = buildInput(app, 'diameter');
            expect('circles expose a shared numeric diameter control', !!input);
            input.value = '1'; input.fire('input');
            expect('diameter shrink constrains both circle widths', app.shapes.every(shape => shape.radius === 0.5 && shape.lineWidth === 0.5));
            input.value = '8'; input.fire('input');
            expect('diameter regrowth restores pre-preview widths', first.radius === 4 && first.lineWidth === 2 && second.lineWidth === 1);
            input.fire('change'); app.commands[0].undo();
            expect('diameter undo restores both original sizes and widths', first.radius === 5 && second.radius === 3 && first.lineWidth === 2 && second.lineWidth === 1);
        }
        for (const standalone of [false, true]) {
            const shape = standalone ? new Arc({ startPoint: { x: 0, y: 0 }, endPoint: { x: 10, y: 0 }, bulgePoint: { x: 5, y: 1.25 } })
                : createPolygon({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] });
            const app = commandAppFor(shape);
            if (!standalone) {
                shape.setEdgeAttr('e0', 'bulge', 0.25);
                app._selectedShapeSegment = { shapeId: shape.id, edgeId: 'e0' };
            }
            const original = shape.captureState();
            const input = buildInput(app, 'bulge');
            expect('arc properties display two-decimal bulges', input.value === '0.25'
                && input.attributes['data-number-format'] !== 'precise');
            input.value = '0.001'; input.fire('input'); input.fire('change');
            expect('small bulges round to zero and become straight lines', input.value === '0.00' && (standalone
                ? app.shapes.length === 1 && app.shapes[0].type === 'polyline' && !app.shapes[0].closed
                : !shape.getEdgeAttr('e0', 'bulge')));
            app.commands[0].undo();
            expect('bulge undo restores the original geometry', JSON.stringify(shape.captureState()) === JSON.stringify(original));
            input.value = '0'; input.fire('input'); input.fire('change');
            expect('zero bulge becomes a straight line', standalone
                ? app.shapes.length === 1 && app.shapes[0].type === 'polyline' && !app.shapes[0].closed
                : !shape.getEdgeAttr('e0', 'bulge'));
            app.commands.at(-1).undo();
            expect('straightening undo restores the original arc object and curvature', app.shapes.includes(shape)
                && JSON.stringify(shape.captureState()) === JSON.stringify(original));
        }
    } finally {
        document.createElement = originalCreate;
        document.getElementById = originalFind;
    }
}

function appFor(shape) {
    const selected = [];
    return {
        interactionState: 'idle',
        shapes: [shape],
        components: [],
        didDrag: false,
        pendingAnchorDrag: null,
        selection: {
            hitTest() { return shape; },
            getSelection() { return selected; },
            select(candidate) {
                selected.splice(0, selected.length, candidate);
                candidate.selected = true;
            },
        },
        viewport: {
            scale: 100,
            gridSize: 1,
            gridVisible: true,
            isPanning: false,
            svg: { style: {} },
            getSnappedPosition(point) {
                return { x: Math.round(point.x), y: Math.round(point.y) };
            },
        },
        _captureShapeState(candidate) { return candidate.captureState(); },
        _updateShapeSelectionTip() {},
    };
}

function commandAppFor(shape) {
    const app = appFor(shape);
    const selected = [shape];
    app.commands = [];
    app.selection = {
        getSelection: () => [...selected],
        select(item, additive = false) {
            if (!additive) selected.length = 0;
            if (!selected.includes(item)) selected.push(item);
            item.selected = true;
        },
        clear() { selected.length = 0; },
        clearSelection() { selected.length = 0; },
        _clearSelection() { selected.length = 0; },
        _notifySelectionChanged() {},
    };
    Object.assign(app, {
        renderShapes() {}, _showCrosshair() {}, _hideCrosshair() {}, _updateCrosshair() {}, _updatePropertiesPanel() {},
        fileManager: { setDirty() {} },
        _applyShapeState(target, state) { target.applyState(state); },
        _commandAddShape(target) { if (!this.shapes.includes(target)) this.shapes.push(target); },
        _commandRemoveShape(target) {
            const index = this.shapes.indexOf(target);
            if (index >= 0) this.shapes.splice(index, 1);
            const selectedIndex = selected.indexOf(target);
            if (selectedIndex >= 0) selected.splice(selectedIndex, 1);
        },
        _commandDeleteShapes(entries) { for (const entry of entries) this._commandRemoveShape(entry.shape); },
        _commandRestoreShapes(entries) { for (const entry of entries) this.shapes.splice(entry.index, 0, entry.shape); },
        history: { execute(command) { app.commands.push(command); command.execute(); } },
    });
    return app;
}

{
    const shape = createLine({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] });
    const app = commandAppFor(shape);
    app.propertySelection = [];
    app._updatePropertiesPanel = selection => { app.propertySelection = selection; };
    app.selection = new SelectionManager({ onSelectionChanged: selection => app._updatePropertiesPanel(selection) });
    app.selection.setShapes(app.shapes);
    app.selection.select(shape);
    const addShape = app._commandAddShape;
    const removeShape = app._commandRemoveShape;
    app._commandAddShape = function (target) {
        addShape.call(this, target);
        this.selection.setShapes(this.shapes);
    };
    app._commandRemoveShape = function (target) {
        this.selection.deselect(target);
        removeShape.call(this, target);
        this.selection.setShapes(this.shapes);
    };
    const before = shape.captureState();
    shape.moveAnchor('n3', 0, 0);
    expect('closing a line commits an endpoint join', commitShapeJoin(app, shape, 'n3', { shape, anchorId: 'n0' }, before));
    const polygon = app.shapes[0];
    expect('closing a line replaces it with one polygon', app.shapes.length === 1 && polygon !== shape && polygon.closed);
    expect('closed polygon is registered as selected', polygon.selected && app.selection.selected.has(polygon.id)
        && app.selection.getSelection().length === 1 && app.selection.getSelection()[0] === polygon);
    expect('closed polygon supplies the properties selection', app.propertySelection.length === 1 && app.propertySelection[0] === polygon);
    app.selection.clearSelection();
    expect('closed polygon deselects normally', !polygon.selected && app.selection.getSelection().length === 0);
    const hit = app.selection.hitTest({ x: 10, y: 5 });
    expect('closed polygon can be hit again', hit === polygon);
    if (hit) app.selection.select(hit);
    expect('clicking the polygon restores its properties selection', polygon.selected && app.propertySelection[0] === polygon);
}

for (const focus of ['node', 'segment']) {
    const shape = createPolygon({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] });
    const app = commandAppFor(shape);
    const original = shape.captureState();
    if (focus === 'node') app._selectedShapeNode = { shapeId: shape.id, nodeId: 'n1' };
    else app._selectedShapeSegment = { shapeId: shape.id, edgeId: 'e0' };
    deleteSelected(app);
    expect(`Delete acts on the focused ${focus}, not the entire shape`, app.shapes.length === 1 && app.shapes[0].type === 'polyline' && !app.shapes[0].closed);
    expect('focused deletion is one undo operation', app.commands.length === 1);
    app.commands[0].undo();
    expect('focused deletion undo restores the original polygon', app.shapes.includes(shape)
        && JSON.stringify(shape.captureState()) === JSON.stringify(original));
}
for (const focus of ['node', 'segment']) {
    const shape = createLine({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    const app = commandAppFor(shape);
    if (focus === 'node') app._selectedShapeNode = { shapeId: shape.id, nodeId: 'n0' };
    else app._selectedShapeSegment = { shapeId: shape.id, edgeId: 'e0' };
    deleteSelected(app);
    expect(`deleting the last ${focus} removes the line`, app.shapes.length === 0);
    app.commands[0].undo();
    expect('last-segment deletion is undoable', app.shapes[0] === shape);
}
for (const closed of [false, true]) {
    for (const cancel of [false, true]) {
        const options = { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] };
        const shape = closed ? createPolygon(options) : createLine(options);
        shape.setEdgeAttr('e0', 'bulge', 0.25);
        shape.setEdgeAttr('e1', 'width', 0.8);
        shape.setNodeCornerRadius('n1', 2);
        const app = commandAppFor(shape);
        const original = shape.captureState();
        splitAnchorAndDrag(app, shape, 'n1', 0, 0);
        expect('split preview contains only simple independent paths', app.shapes.length === (closed ? 1 : 2)
            && app.shapes.every(item => !!item.toEditablePath() && !item.closed));
        expect('split preserves all original segments', app.shapes.reduce((count, item) => count + item.edges.size, 0) === (closed ? 4 : 3));
        expect('split has no history before placement', app.commands.length === 0);
        shape.moveAnchor(app.drag.anchorId, 12, 2);
        if (cancel) {
            handleEscape(app);
            expect('Escape removes the split preview and restores the original', app.shapes.length === 1 && app.commands.length === 0
                && JSON.stringify(shape.captureState()) === JSON.stringify(original));
        } else {
            resolveAnchorDragOnMouseUp(app, shape, app.drag.beforeState, app.didDrag);
            expect('split placement is one undo step', app.commands.length === 1 && app.shapes.length === (closed ? 1 : 2));
            const placed = app.shapes.map(item => item.captureState());
            app.commands[0].undo();
            expect('split undo restores the complete original shape', app.shapes.length === 1
                && JSON.stringify(shape.captureState()) === JSON.stringify(original));
            app.commands[0].execute();
            expect('split redo restores both pieces and their metadata', JSON.stringify(app.shapes.map(item => item.captureState())) === JSON.stringify(placed));
        }
    }
}
{
    const shape = new Arc({ startPoint: { x: 0, y: 0 }, endPoint: { x: 10, y: 0 }, bulgePoint: { x: 5, y: 2 }, lineWidth: 0.8 });
    const app = commandAppFor(shape);
    expect('standalone arc converts to a line', setSchematicShapeSegmentType(app, shape, null, 'line'));
    expect('standalone replacement preserves width and endpoints', app.shapes.length === 1 && app.shapes[0].type === 'polyline'
        && app.shapes[0].lineWidth === 0.8 && app.shapes[0].getOrderedPoints()[1].x === 10);
    app.commands[0].undo();
    expect('standalone conversion undo restores the Arc object', app.shapes[0] === shape);
    app.commands[0].execute();
    expect('standalone conversion redo restores a line', app.shapes[0].type === 'polyline');
}

{
    const originalCreate = document.createElementNS;
    document.createElementNS = (namespace, tag) => ({
        tag, attributes: {}, children: [],
        setAttribute(name, value) { this.attributes[name] = value; },
        appendChild(child) { this.children.push(child); },
        remove() {},
    });
    try {
        const arc = new Arc({ startPoint: { x: 0, y: 0 }, endPoint: { x: 10, y: 0 }, bulgePoint: { x: 5, y: 2 } });
        arc.element = { parentNode: null };
        arc._updateAnchors(2, true);
        const handles = arc.anchorsGroup.children;
        const bulge = handles.find(handle => handle.attributes['data-anchor-id'] === 'mid');
        expect('standalone Arc bulge is a green circle', bulge.tag === 'circle'
            && bulge.attributes.fill === '#33dd77' && bulge.attributes.stroke === '#2e7d32');
        expect('standalone Arc endpoints remain square', handles.filter(handle => handle.tag === 'rect').length === 2);
        const radius = Number(bulge.attributes.r);
        arc.moveAnchor('mid', 5, 3);
        arc._updateAnchors(4, true);
        const midpoint = arc.getMidPoint();
        expect('bulge circle is reused and follows geometry and zoom', arc.anchorsGroup.children.includes(bulge)
            && Number(bulge.attributes.cx) === midpoint.x && Number(bulge.attributes.cy) === midpoint.y
            && Number(bulge.attributes.r) === radius / 2);
    } finally {
        document.createElementNS = originalCreate;
    }
}

for (const floating of [false, true]) {
    const original = floating
        ? createLine({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], lineWidth: 0.8 })
        : new Arc({ startPoint: { x: 0, y: 0 }, endPoint: { x: 10, y: 0 }, bulgePoint: { x: 5, y: 2 }, lineWidth: 0.8 });
    const before = original.captureState();
    const app = commandAppFor(original);
    if (floating) setSchematicShapeSegmentType(app, original, 'e0', 'arc', { floating: true });
    const arc = app.shapes[0];
    const dragBefore = arc.captureState();
    app.viewport.scale = 20;
    app.viewport.gridVisible = false;
    const snapped = snapShapeBulge(app, arc, 'mid', { x: 5, y: 0.01 });
    arc.moveAnchor('mid', snapped.x, snapped.y);
    resolveAnchorDragOnMouseUp(app, arc, dragBefore, true);
    const line = app.shapes[0];
    expect('zero-bulge drag commits a selected straight line in one undo step', app.commands.length === 1
        && app.shapes.length === 1 && line.type === 'polyline' && line.edges.size === 1
        && !line.closed && line.lineWidth === 0.8 && app.selection.getSelection()[0] === line);
    expect('zero-bulge drag preserves endpoints', JSON.stringify(line.getOrderedPoints())
        === JSON.stringify([{ x: 0, y: 0 }, { x: 10, y: 0 }]));
    app.commands[0].undo();
    expect('zero-bulge drag undo restores the original object and geometry', app.shapes.length === 1
        && app.shapes[0] === original && JSON.stringify(original.captureState()) === JSON.stringify(before));
    app.commands[0].execute();
    expect('zero-bulge drag redo restores the straight line', app.shapes.length === 1 && app.shapes[0] === line);
}

for (const mode of ['immediate', 'place', 'cancel']) {
    const line = createLine({ points: [{ x: 1, y: 2 }, { x: 11, y: 2 }], lineWidth: 0.2 });
    line.setEdgeAttr('e0', 'width', 0.8);
    const before = line.captureState();
    const app = commandAppFor(line);
    expect('single line converts to standalone Arc', setSchematicShapeSegmentType(app, line, 'e0', 'arc', { floating: mode !== 'immediate' }));
    const arc = app.shapes[0];
    expect('converted Arc preserves endpoints and effective segment width', arc.type === 'arc'
        && arc.startPoint.x === 1 && arc.endPoint.x === 11 && arc.lineWidth === 0.8 && !arc.fill);
    expect('converted Arc is the selected object', app.selection.getSelection()[0] === arc);
    if (mode !== 'immediate') {
        expect('conversion preview does not create history', app.commands.length === 0 && app.drag.anchorId === 'mid');
        arc.moveAnchor(app.drag.anchorId, 6, 5);
        expect('curvature placement leaves both endpoints fixed', arc.startPoint.x === 1 && arc.startPoint.y === 2
            && arc.endPoint.x === 11 && arc.endPoint.y === 2);
        if (mode === 'cancel') {
            handleEscape(app);
            expect('Escape restores the original selected line without history', app.commands.length === 0
                && app.shapes.length === 1 && app.shapes[0] === line && app.selection.getSelection()[0] === line
                && JSON.stringify(line.captureState()) === JSON.stringify(before));
            continue;
        }
        resolveAnchorDragOnMouseUp(app, arc, app.drag.beforeState, true);
    }
    const placed = arc.captureState();
    expect('single-line conversion commits once', app.commands.length === 1);
    app.commands[0].undo();
    expect('conversion undo restores original line metadata', app.shapes.length === 1 && app.shapes[0] === line
        && JSON.stringify(line.captureState()) === JSON.stringify(before));
    app.commands[0].execute();
    expect('conversion redo restores placed Arc', app.shapes.length === 1 && app.shapes[0] === arc
        && JSON.stringify(arc.captureState()) === JSON.stringify(placed));
    setSchematicShapeSegmentType(app, arc, null, 'line');
    expect('converted Arc returns to a straight single line', app.shapes.length === 1
        && app.shapes[0].type === 'polyline' && app.shapes[0].edges.size === 1 && app.shapes[0].lineWidth === 0.8
        && !app.shapes[0].edges.values().next().value.bulge);
}

for (const kind of ['line', 'polygon', 'rectangle']) {
    for (const floating of [false, true]) {
        const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
        const shape = kind === 'rectangle' ? createRect({ x: 0, y: 0, width: 10, height: 10 })
            : kind === 'line' ? createLine({ points }) : createPolygon({ points });
        const edgeId = [...shape.edges.keys()][0];
        shape.setEdgeAttr(edgeId, 'width', 0.7);
        shape.setNodeCornerRadius('n2', 1);
        const app = appFor(shape);
        const commands = [];
        Object.assign(app, {
            renderShapes() {}, _showCrosshair() {}, _hideCrosshair() {}, _updateCrosshair() {},
            _applyShapeState(target, state) { target.applyState(state); },
            fileManager: { setDirty() {} },
            history: { execute(command) { commands.push(command); command.execute(); } },
        });
        app.selection.select(shape);
        const before = shape.captureState();
        const pcbPath = structuredClone(shape.toEditablePath());
        setPathSegmentType(pcbPath, 0, 'arc');
        expect(`${kind} segment can convert to an arc`, setSchematicShapeSegmentType(app, shape, edgeId, 'arc', { floating }));
        expect(`${kind} conversion uses shared PCB curvature`, shape.edges.get(edgeId).bulge === pcbPath.segmentBulges[0]);
        expect(`${kind} conversion preserves widths, corner radii and closure`,
            shape.getEdgeAttr(edgeId, 'width') === 0.7 && shape.nodeCornerRadius('n2') === 1
            && shape.closed === (kind !== 'line') && !shape.isRect);
        expect(`${kind} conversion keeps the segment selected`, app._selectedShapeSegment.edgeId === edgeId);
        if (floating) {
            expect('arc conversion floats a bulge handle before committing', app.drag.anchorId === `bulge_${edgeId}` && commands.length === 0);
            shape.moveAnchor(app.drag.anchorId, 5, 2.5);
            handleEscape(app);
            expect('Escape restores the original straight shape without history',
                JSON.stringify(shape.captureState()) === JSON.stringify(before) && commands.length === 0 && app.drag === null);
            setSchematicShapeSegmentType(app, shape, edgeId, 'arc', { floating: true });
            shape.moveAnchor(app.drag.anchorId, 5, 2.5);
            resolveAnchorDragOnMouseUp(app, shape, app.drag.beforeState, app.didDrag);
        }
        expect('conversion and curvature placement create one undo step', commands.length === 1);
        const curved = shape.captureState();
        commands[0].undo();
        expect('conversion undo restores exact original shape', JSON.stringify(shape.captureState()) === JSON.stringify(before));
        commands[0].execute();
        expect('conversion redo restores the arc', JSON.stringify(shape.captureState()) === JSON.stringify(curved));
        expect('arc segment can convert back to a line', setSchematicShapeSegmentType(app, shape, edgeId, 'line'));
        expect('line conversion clears curvature', !shape.edges.get(edgeId).bulge);
        commands.at(-1).undo();
        expect('line conversion is undoable', JSON.stringify(shape.captureState()) === JSON.stringify(curved));
        shape.locked = true;
        expect('locked shapes cannot be converted', !setSchematicShapeSegmentType(app, shape, edgeId, 'line'));
    }
}

{
    const original = { createElement: document.createElement, querySelector: document.querySelector,
        body: document.body, removeEventListener: document.removeEventListener };
    let menu = null;
    document.createElement = () => {
        const listeners = new Map();
        return { style: {}, children: [], appendChild(child) { this.children.push(child); },
            addEventListener(type, listener) { listeners.set(type, listener); },
            click() { listeners.get('click')?.(); }, remove() { menu = null; },
        };
    };
    document.querySelector = () => menu;
    document.body = { appendChild(element) { menu = element; } };
    document.removeEventListener = () => {};
    try {
        const shape = createPolygon({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] });
        const app = appFor(shape);
        app.selection.select(shape);
        app.renderShapes = () => {};
        const edgeId = [...shape.edges.keys()][0];
        showSegmentContextMenu(app, shape, edgeId, 10, 10);
        const convert = menu.children.find(child => child.textContent === 'Convert to Arc Segment');
        expect('schematic polygon segment menu exposes arc conversion', !!convert);
        convert.click();
        expect('menu conversion starts floating curvature editing', app.interactionState === 'anchorDrag' && !!shape.edges.get(edgeId).bulge);
        showSegmentContextMenu(app, shape, edgeId, 10, 10);
        expect('curved segment menu exposes line conversion', menu.children.some(child => child.textContent === 'Convert to Line Segment'));
        dismissAnchorContextMenu();
        const line = createLine({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
        showSegmentContextMenu(app, line, 'e0', 10, 10);
        expect('single-line menu uses standalone conversion wording',
            menu.children.some(child => child.textContent === 'Convert to Arc')
            && !menu.children.some(child => child.textContent === 'Convert to Arc Segment'));
        expect('two-point lines expose only whole-line deletion',
            !menu.children.some(child => /^Delete segment$/i.test(child.textContent))
            && menu.children.some(child => child.textContent === 'Delete line'));
        dismissAnchorContextMenu();
        const arc = new Arc({ startPoint: { x: 0, y: 0 }, endPoint: { x: 10, y: 0 }, bulgePoint: { x: 5, y: 2 } });
        showSegmentContextMenu(app, arc, null, 10, 10);
        expect('standalone arc menu exposes conversion and deletion',
            menu.children.some(child => child.textContent === 'Convert to Line')
            && menu.children.some(child => child.textContent === 'Delete arc')
            && !menu.children.some(child => /^Delete segment$/i.test(child.textContent)));
        dismissAnchorContextMenu();
    } finally {
        dismissAnchorContextMenu();
        Object.assign(document, original);
    }
}

const cases = [
    ['line', createLine({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }] })],
    ['rectangle', createRect({ x: 0, y: 0, width: 10, height: 10, cornerRadius: 2 })],
    ['polygon', createPolygon({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 10 }] })],
];

for (const [name, shape] of cases) {
    const app = appFor(shape);
    const worldPos = { x: 3, y: 0 };
    expect(`${name} first click leaves segment refinement disabled`,
        !tryBeginPolylineSegmentDrag(app, shape, worldPos, false, 0.1));
    app.selection.select(shape);
    tryBeginPolylineSegmentDrag(app, shape, worldPos, true, 0.1);
    const edgeId = app.drag?.edgeId;
    const edge = shape.edges.get(edgeId);
    expect(`${name} second click refines the hit segment`, app.drag?.mode === 'segment');
    expect(`${name} stores a stable edge id`, app._selectedShapeSegment?.edgeId === edgeId);

    app.drag = null;
    expect(`${name} selected edge can begin a later segment drag`,
        tryBeginPolylineSegmentDrag(app, shape, worldPos, true, 0.1));
    const otherEdgeId = [...shape.edges.keys()].find((candidate) => candidate !== edgeId);
    if (otherEdgeId) {
        const otherEdge = shape.edges.get(otherEdgeId);
        const otherFrom = shape.nodes.get(otherEdge.from);
        const otherTo = shape.nodes.get(otherEdge.to);
        const otherPoint = { x: (otherFrom.x + otherTo.x) / 2, y: (otherFrom.y + otherTo.y) / 2 };
        app.drag = null;
        expect(`${name} another edge does not inherit segment drag mode`,
            !tryBeginPolylineSegmentDrag(app, shape, otherPoint, true, 0.1));
    }
    app.drag = null;
    tryBeginPolylineSegmentDrag(app, shape, worldPos, true, 0.1);

    const untouchedNodeId = [...shape.nodes.keys()].find((id) => id !== edge.from && id !== edge.to);
    const untouchedBefore = untouchedNodeId ? { ...shape.nodes.get(untouchedNodeId) } : null;
    updatePolylineSegmentDrag(app, { x: 3, y: 2 });
    expect(`${name} segment drag moves both selected edge endpoints`,
        shape.nodes.get(edge.from).y === 2 && shape.nodes.get(edge.to).y === 2);
    expect(`${name} segment drag leaves other vertices fixed`, !untouchedNodeId
        || (shape.nodes.get(untouchedNodeId).x === untouchedBefore.x
            && shape.nodes.get(untouchedNodeId).y === untouchedBefore.y));
    expect(`${name} segment remains refined after movement`, app._selectedShapeSegment?.edgeId === edgeId);
    if (name === 'rectangle') expect('rectangle segment movement preserves its corner radius',
        shape.isRect && shape.cornerRadius === 2);
}

{
    const shape = createRect({ x: 0, y: 0, width: 10, height: 10, cornerRadius: 2 });
    const app = appFor(shape);
    app.selection.select(shape);
    tryBeginPolylineSegmentDrag(app, shape, { x: 3, y: 0 }, true, 0.1);
    updatePolylineSegmentDrag(app, { x: 4, y: 2 });
    expect('skewing a rectangle segment converts it to a polygon', !shape.isRect);
    updatePolylineSegmentDrag(app, { x: 3, y: 2 });
    expect('returning the segment to axis alignment restores rectangle semantics', shape.isRect && shape.cornerRadius === 2);
    shape.applyState(app.drag.beforeState);
    expect('cancelling restores the original rectangle', shape.isRect && shape.nodes.get('n0').y === 0);
}

{
    const shape = createLine({
        lineWidth: 0.2,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
    });
    const [selectedEdgeId, otherEdgeId] = [...shape.edges.keys()];
    shape.setEdgeAttr(selectedEdgeId, 'width', 0.6);
    expect('schematic segment width changes only the selected edge',
        shape.getEdgeAttr(selectedEdgeId, 'width') === 0.6
        && shape.getEdgeAttr(otherEdgeId, 'width') === 0.2
        && shape.lineWidth === 0.2);
    expect('schematic segment width is serialized by stable edge id',
        shape.toJSON().ew?.[selectedEdgeId] === 0.6
        && shape.toJSON().ew?.[otherEdgeId] === undefined);
    expect('segment hit testing includes its width override',
        shape.hitTestEdge({ x: 5, y: 0.28 }, 0) === selectedEdgeId);
    const clone = shape.clone();
    expect('schematic clone preserves segment width overrides',
        clone.getEdgeAttr(selectedEdgeId, 'width') === 0.6
        && clone.getEdgeAttr(otherEdgeId, 'width') === 0.2);
}

{
    const shape = createRect({ x: 0, y: 0, width: 10, height: 10, cornerRadius: 0 });
    const [selectedNodeId, otherNodeId] = [...shape.nodes.keys()];
    shape.setNodeCornerRadius(selectedNodeId, 2);
    expect('schematic node radius changes only the selected node',
        shape.nodeCornerRadius(selectedNodeId) === 2
        && shape.nodeCornerRadius(otherNodeId) === 0);
    const state = shape.captureState();
    shape.setNodeCornerRadius(selectedNodeId, 3);
    shape.applyState(state);
    expect('schematic node radius survives undo snapshots', shape.nodeCornerRadius(selectedNodeId) === 2);
    expect('schematic clone preserves node radius', shape.clone().nodeCornerRadius(selectedNodeId) === 2);
    expect('schematic node radius is serialized by stable node id', shape.toJSON().ncr?.[selectedNodeId] === 2);
}

{
    const shape = createRect({ x: 0, y: 0, width: 10, height: 10 });
    const app = appFor(shape);
    app.selection.select(shape);
    const nodeId = shape.nodes.keys().next().value;
    const pending = { shape, anchorId: nodeId, screenPos: { x: 0, y: 0 }, snapped: { x: 0, y: 0 } };
    app.pendingAnchorDrag = pending;
    app.renderShapes = () => {};
    app._updatePropertiesPanel = () => {};
    let activeTab = null;
    app._setActiveRibbonTab = tab => { activeTab = tab; };
    idleState.click(app, { preventDefault() {} }, { worldPos: shape.nodes.get(nodeId) });
    expect('schematic Node properties preserve pending click-release movement',
        app.pendingAnchorDrag === pending
        && app._selectedShapeNode?.nodeId === nodeId);
    expect('node refinement activates Properties', activeTab === 'properties');
}

{
    const shape = createRect({ x: 0, y: 0, width: 10, height: 10 });
    const app = appFor(shape);
    app.selection.select(shape);
    app.renderShapes = () => {};
    const edgeId = shape.edges.keys().next().value;
    let activeTab = null;
    let propertiesSelection = null;
    app._setActiveRibbonTab = tab => { activeTab = tab; };
    app._updatePropertiesPanel = selection => { propertiesSelection = selection; };
    app._pendingShapeSegmentToggle = { shape, edgeId, hadSegment: false, segmentCandidateMatches: false };
    idleState.click(app, { preventDefault() {} }, { worldPos: { x: 3, y: 0 } });
    expect('second shape click refines a segment without an earlier matching edge click',
        app._selectedShapeSegment?.edgeId === edgeId);
    expect('segment refinement activates Properties without returning Home', activeTab === 'properties');
    expect('segment Properties keeps the selected shape', propertiesSelection?.[0] === shape);
    app._pendingShapeSegmentToggle = { shape, edgeId, hadSegment: true };
    idleState.click(app, { preventDefault() {} }, { worldPos: { x: 3, y: 0 } });
    expect('clicking the refined segment again retains PCB-style segment Properties',
        app._selectedShapeSegment?.edgeId === edgeId && app._selectedShapeNode === null && activeTab === 'properties');
}

for (const position of [3, 5]) {
    for (const nativeClick of [false, true]) {
        const originalWindowListener = window.addEventListener;
        const originalQuery = document.querySelector;
        const originalHTMLElement = globalThis.HTMLElement;
        const svgListeners = new Map();
        const windowListeners = new Map();
        window.addEventListener = (type, handler) => windowListeners.set(type, handler);
        document.querySelector = () => null;
        globalThis.HTMLElement = class {};
        try {
            const shape = createLine({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] });
            const app = appFor(shape);
            app.currentTool = 'select';
            app.selection.select(shape);
            app.renderShapes = () => {};
            app._hideCrosshair = () => {};
            app._removeBoxSelectElement = () => {};
            app.viewport.svg.addEventListener = (type, handler) => svgListeners.set(type, handler);
            app.viewport._getCachedRect = () => ({ left: 0, top: 0 });
            app.viewport.screenToWorld = point => ({ x: point.x / 100, y: point.y / 100 });
            let updates = 0;
            let activeTab = null;
            app._updatePropertiesPanel = () => { updates++; };
            app._setActiveRibbonTab = tab => { activeTab = tab; };
            const before = shape.captureState();
            bindMouseEvents(app);
            const event = { button: 0, clientX: position * 100, clientY: 0, preventDefault() {} };
            for (let press = 0; press < 2; press++) {
                svgListeners.get('mousedown')(event);
                windowListeners.get('mouseup')(event);
                expect('segment selection completes on release without a native click',
                    app._selectedShapeSegment?.edgeId === 'e0' && activeTab === 'properties' && updates === press + 1);
                expect('release clears pending segment selection and preserves geometry',
                    app._pendingShapeSegmentToggle == null && app.pendingAnchorDrag == null
                    && JSON.stringify(shape.captureState()) === JSON.stringify(before));
                if (nativeClick) {
                    svgListeners.get('click')(event);
                    expect('native click does not duplicate release selection', updates === press + 1);
                }
            }
        } finally {
            window.addEventListener = originalWindowListener;
            document.querySelector = originalQuery;
            globalThis.HTMLElement = originalHTMLElement;
        }
    }
}

{
    let removed = 0;
    const app = {
        _selectedShapeSegment: { shapeId: 'shape', edgeId: 'edge' },
        _shapeSegmentSelectionElement: { remove() { removed++; } },
    };
    clearShapeSegmentSelection(app);
    expect('schematic shape deselection clears refined segment state', app._selectedShapeSegment === null);
    expect('schematic shape deselection removes refined segment highlight',
        app._shapeSegmentSelectionElement === null && removed === 1);
}

{
    const shape = createRect({ x: 0, y: 0, width: 10, height: 10, cornerRadius: 2 });
    const app = appFor(shape);
    app.selection.select(shape);
    app.viewport.contentLayer = { appendChild() {} };
    const edgeId = shape.edges.keys().next().value;
    const edge = shape.edges.get(edgeId);
    const first = shape.nodes.get(edge.from);
    const second = shape.nodes.get(edge.to);
    app._selectedShapeSegment = { shapeId: shape.id, edgeId };
    const verifyTrim = (start, end) => {
        renderShapeSegmentSelection(app);
        const attrs = app._shapeSegmentSelectionElement?.attributes;
        const length = Math.hypot(second.x - first.x, second.y - first.y);
        const dx = (second.x - first.x) / length;
        const dy = (second.y - first.y) / length;
        return attrs && Number(attrs.x1) === first.x + dx * start
            && Number(attrs.y1) === first.y + dy * start
            && Number(attrs.x2) === second.x - dx * end
            && Number(attrs.y2) === second.y - dy * end;
    };
    expect('rounded rectangle highlights only the straight edge', verifyTrim(2, 2));
    shape.setNodeCornerRadius(edge.from, 3);
    shape.setNodeCornerRadius(edge.to, 0);
    expect('segment highlight respects independent corner radii', verifyTrim(3, 0));
    shape.setNodeCornerRadius(edge.from, 100);
    shape.setNodeCornerRadius(edge.to, 100);
    renderShapeSegmentSelection(app);
    expect('fully rounded edge leaves no selection dot', app._shapeSegmentSelectionElement === null);
    shape.setEdgeAttr(edgeId, 'width', shape.lineWidth + 1);
    shape.setNodeCornerRadius(edge.from, 3);
    shape.setNodeCornerRadius(edge.to, 0);
    expect('per-edge width preserves rounded selection trimming', verifyTrim(3, 0));
}

{
    const shape = createLine({
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], cornerRadius: 2,
    });
    const [firstId, secondId] = [...shape.edges.keys()];
    const first = shape.getStraightEdgePortion(firstId);
    const second = shape.getStraightEdgePortion(secondId);
    expect('open-line start is not trimmed', first.first.x === 0 && first.second.x === 8);
    expect('open-line end is not trimmed', second.first.y === 2 && second.second.y === 10);
    shape.setEdgeAttr(firstId, 'bulge', 0.4);
    const app = appFor(shape);
    app.selection.select(shape);
    app.viewport.contentLayer = { appendChild() {} };
    app._selectedShapeSegment = { shapeId: shape.id, edgeId: firstId };
    renderShapeSegmentSelection(app);
    expect('explicit arc selection stays curved', app._shapeSegmentSelectionElement?.attributes.d?.includes('A'));
}

{
    const shape = createLine({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], lineWidth: 0.2 });
    const app = appFor(shape);
    app.selection.select(shape);
    const edgeId = shape.edges.keys().next().value;
    shape.setEdgeAttr(edgeId, 'width', 0.6);
    app._selectedShapeSegment = { shapeId: shape.id, edgeId };
    const children = [];
    const overlay = {
        appendChild(element) { children.push(element); },
        insertBefore(element, before) { children.splice(children.indexOf(before), 0, element); },
    };
    const handles = { parentNode: overlay };
    shape.anchorsGroup = handles;
    app.viewport.contentLayer = overlay;
    for (const scale of [0.5, 10, 100]) {
        children.splice(0, children.length, handles);
        app.viewport.scale = scale;
        renderShapeSegmentSelection(app);
        const highlight = app._shapeSegmentSelectionElement;
        expect(`segment highlight follows rendered edge width at zoom ${scale}`,
            Number(highlight.attributes['stroke-width']) === Math.max(0.6, 1 / scale)
            && highlight.attributes['vector-effect'] === undefined);
        expect(`segment highlight stays below midpoint handles at zoom ${scale}`,
            children[0] === highlight && children[1] === handles);
        expect('segment highlight cannot intercept handle clicks', highlight.attributes['pointer-events'] === 'none');
    }
}

if (failures) process.exitCode = 1;