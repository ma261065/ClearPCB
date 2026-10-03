import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { SelectionManager } from '../src/core/SelectionManager.js';
import { Circle } from '../src/shapes/circle.js';
import { Polyline } from '../src/shapes/polyline.js';
import { ModifyShapeCommand } from '../src/schematic/modules/commands.js';

const listeners = new Map();
const elements = new Map();
globalThis.window = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name),
};
globalThis.document = {
    getElementById: id => elements.get(id) || null,
    querySelector: () => null,
};
const { default: SchematicApp } = await import('../src/ui/SchematicApp.js');
const { bindKeyboardShortcuts, handleEscape, runSchematicHistoryAction } = await import('../src/schematic/modules/keyboard.js');
const { onToolSelected } = await import('../src/schematic/modules/tool.js');

function button() {
    const events = new Map();
    return { checked: true, addEventListener: (name, callback) => events.set(name, callback),
        click: () => events.get('click')() };
}

function fixture(shape = new Circle({ radius: 5 })) {
    elements.clear();
    for (const id of ['zoomFit', 'zoomIn', 'zoomOut', 'resetView']) elements.set(id, button());
    const project = new ProjectDocument();
    const app = Object.create(SchematicApp.prototype);
    Object.assign(app, {
        project, document: project.schematicDocument, fileManager: project.fileManager,
        eventBus: { emit() {} },
        currentTool: 'select', interactionState: 'idle',
        viewport: { svg: { style: {} } }, selection: new SelectionManager(),
        renderShapes() {}, _hideCrosshair() {}, _removeBoxSelectElement() {},
        _updateUndoRedoButtons() {}, _updateGridDropdown() {}, _bindPropertiesPanel() {}, _bindRibbon() {},
        getViewSettings: () => undefined,
        ui: Object.fromEntries(['undoBtn', 'redoBtn', 'gridSize', 'gridStyle', 'units', 'showGrid', 'snapToGrid']
            .map(id => [id, button()])),
    });
    app.history = new CommandHistory({ onChanged: () => app._onHistoryChanged() });
    app.shapes.push(shape);
    app.selection.setShapes(app.shapes);
    app.selection.select(shape);
    project.registerView('schematic', app);
    app._bindUIControls();
    bindKeyboardShortcuts(app);
    const invoke = (source, action) => source === 'ribbon' ? app.ui[`${action}Btn`].click()
        : listeners.get('keydown')({ key: action === 'undo' ? 'z' : 'y', ctrlKey: true,
            target: { tagName: 'svg' }, preventDefault() {} });
    return { app, project, shape, invoke };
}

for (const source of ['keyboard', 'ribbon']) for (const action of ['undo', 'redo']) {
    for (const mode of ['anchorDrag', 'segmentDrag', 'pending']) {
        const shape = mode === 'anchorDrag' ? new Circle({ radius: 5 })
            : new Polyline({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
        const { app, project, invoke } = fixture(shape);
        const before = shape.captureState();
        shape.lineWidth = 0.7;
        const after = shape.captureState();
        shape.applyState(before);
        app.history.execute(new ModifyShapeCommand(app, shape, before, after));
        if (action === 'redo') app.history.undo();
        const dragBefore = shape.captureState();
        if (mode === 'pending') app.pendingAnchorDrag = { shape, preInsertState: dragBefore };
        else {
            app.drag = { shape, beforeState: dragBefore };
            app.interactionState = mode;
        }
        shape.move(4, 5);
        assert.equal(project.canSerialize(), false, `${mode}: snapshot blocked before history`);
        invoke(source, action);
        assert.deepEqual(shape.captureState(), action === 'undo' ? before : after, `${source}/${action}/${mode}`);
        assert.equal(app.drag ?? null, null);
        assert.equal(app.pendingAnchorDrag ?? null, null);
        assert.equal(app.interactionState, 'idle');
        assert.equal(project.canSerialize(), true);
        assert.equal(app.history.undoStack.length, action === 'undo' ? 0 : 1);
        assert.equal(app.history.redoStack.length, action === 'undo' ? 1 : 0);
        handleEscape(app);
        assert.deepEqual(shape.captureState(), action === 'undo' ? before : after,
            'Escape cannot resurrect the snapshot from the already-cancelled drag');
    }
}

for (const action of ['undo', 'redo']) for (const state of ['moveDrag', 'boxSelect', 'overlapCycle']) {
    const { app, invoke } = fixture();
    app.interactionState = state;
    app._overlapCyclePress = {};
    if (state !== 'overlapCycle') app.drag = { mode: 'move', shapes: [] };
    invoke('keyboard', action);
    assert.equal(app.interactionState, 'idle');
    assert.equal(app.drag ?? null, null);
    if (state === 'overlapCycle') assert.equal(app._overlapCyclePress, null);
}

for (const tool of ['select', 'circle']) for (const mode of ['anchorDrag', 'segmentDrag', 'pending']) {
    const shape = new Polyline({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    const { app, project } = fixture(shape);
    app.componentPicker = { isOpen: false };
    app._setToolCursor = () => {};
    app._updateShapePanelOptions = () => {};
    const before = shape.captureState();
    if (mode === 'pending') app.pendingAnchorDrag = { shape, preInsertState: before };
    else {
        app.drag = { shape, beforeState: before };
        app.interactionState = mode;
    }
    shape.move(4, 5);
    onToolSelected(app, tool);
    assert.deepEqual(shape.captureState(), before, 'Changing tools restores the live pointer edit first');
    assert.equal(app.drag ?? null, null);
    assert.equal(app.pendingAnchorDrag ?? null, null);
    assert.equal(app.currentTool, tool);
    assert.equal(project.canSerialize(), true, 'Tool transitions cannot strand the new save guard');
    assert.equal(app.history.undoStack.length, 0);
}

for (const source of ['keyboard', 'ribbon']) for (const action of ['undo', 'redo']) {
    const { app, shape, invoke } = fixture();
    const before = shape.captureState();
    shape.radius = 6;
    const after = shape.captureState();
    app.history.execute(new ModifyShapeCommand(app, shape, before, after));
    if (action === 'redo') app.history.undo();
    app.drag = { shape, beforeState: shape.captureState() };
    app.interactionState = 'anchorDrag';
    const undo = [...app.history.undoStack], redo = [...app.history.redoStack];
    const error = new Error('Fixture rollback failure');
    shape.applyState = () => { throw error; };
    assert.throws(() => invoke(source, action), failure => failure === error);
    assert.deepEqual(app.history.undoStack, undo, 'Failed cleanup cannot advance undo');
    assert.deepEqual(app.history.redoStack, redo, 'Failed cleanup cannot advance redo');
}

for (const flag of ['drag', 'pendingAnchorDrag', 'isDrawing', 'textEdit', 'pastingClipboard', 'placingComponent']) {
    const { app, project } = fixture();
    app[flag] = {};
    assert.equal(project.canSerialize(), false, `${flag}: pending schematic edits block snapshots`);
    assert.throws(() => project.serialize(), /Finish the current edit before saving/);
    app[flag] = null;
    assert.doesNotThrow(() => project.serialize(), `${flag}: clearing the edit permits snapshots`);
}

for (const action of ['undo', 'redo']) {
    for (const [flag, cancel] of [['textEdit', '_endTextEdit'], ['pastingClipboard', '_cancelPaste'],
        ['placingComponent', '_cancelComponentPlacement']]) {
        const { app } = fixture();
        app[flag] = {};
        let calls = 0;
        app[cancel] = () => { calls++; app[flag] = null; };
        app.history[action] = () => { throw new Error('Cannot advance history underneath a placement or inline edit'); };
        assert.equal(runSchematicHistoryAction(app, action), true);
        assert.equal(calls, 1);
    }
    const { app } = fixture();
    app.isDrawing = true;
    app.interactionState = 'drawing';
    app.history[action] = () => { throw new Error('Drawing retains history ownership'); };
    assert.equal(runSchematicHistoryAction(app, action), false);
}
for (const tool of ['wire', 'line', 'rect', 'circle', 'arc', 'polygon', 'text', 'net', 'noconnect']) {
    for (const started of [false, true]) {
        if (started && ['text', 'net', 'noconnect'].includes(tool)) continue;
        const { app } = fixture();
        const svgNode = () => ({ style: {}, setAttribute() {}, appendChild() {}, remove() {} });
        document.createElementNS = svgNode;
        app.viewport.contentLayer = svgNode();
        app.componentPicker = { isOpen: false };
        app._updateShapePanelOptions = () => {};
        app._onOptionsChanged = () => {};
        app._setActiveRibbonTab = tab => { app.activeTab = tab; };
        app._setActiveToolButton = toolId => { app.activeButton = toolId; };
        app._onToolSelected(tool);
        assert.equal(app.activeTab, 'properties');
        assert.equal(app.currentTool, tool);
        if (started) {
            app.interactionState = 'drawing';
            app.isDrawing = true;
            app.previewElement = svgNode();
            app.drawStart = { x: 0, y: 0 };
        }
        listeners.get('keydown')({ key: 'Escape', target: { tagName: 'svg' },
            preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
        assert.equal(app.currentTool, 'select', `${tool}/${started}: one Escape returns to Select`);
        assert.equal(app.interactionState, 'idle');
        assert.equal(app.activeButton, 'select');
        assert.equal(app.activeTab, 'home', `${tool}/${started}: no empty Properties tab after cancellation`);
        assert.equal(app.viewport.svg.style.cursor, 'default');
        assert.equal(app.isDrawing, false);
        assert.equal(app.previewElement ?? null, null);
        assert.equal(app._toolGhost ?? null, null);
    }
}
{
    const { app } = fixture();
    app.componentPicker = { isOpen: false };
    app._updateShapePanelOptions = () => {};
    app.activeTab = 'properties';
    app._setActiveRibbonTab = tab => { app.activeTab = tab; };
    app._onToolSelected('select');
    assert.equal(app.activeTab, 'properties', 'Select preserves Properties when an existing shape is selected');
}
console.log('PASS schematic keyboard/ribbon history cleanup, undo/redo rollback, snapshot readiness and transient-mode ownership');
