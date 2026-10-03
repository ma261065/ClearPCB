import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { SelectionManager } from '../src/core/SelectionManager.js';
import { Circle } from '../src/shapes/circle.js';
import { Track } from '../src/shapes/track.js';

function element() {
    return {
        children: [], style: {}, classList: { add() {} }, setAttribute() {},
        appendChild(child) { this.children.push(child); child.parentNode = this; },
        removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentNode = null; },
        remove() { this.parentNode?.removeChild(this); },
        cloneNode() { return element(); },
    };
}
globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: () => element(), getElementById: () => null, querySelector: () => null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { default: SchematicApp } = await import('../src/ui/SchematicApp.js');
const { copySelection, beginPastePreview } = await import('../src/schematic/modules/clipboard.js');
const { newFile } = await import('../src/schematic/modules/files.js');

function fixture() {
    const project = new ProjectDocument();
    const alerts = [];
    const app = Object.assign(Object.create(SchematicApp.prototype), {
        project, document: project.schematicDocument, fileManager: project.fileManager,
        selection: new SelectionManager(), history: new CommandHistory(),
        currentTool: 'select', interactionState: 'idle',
        viewport: {
            contentLayer: element(), svg: element(), removeContent() {}, resetView() {},
            setTitleBlockData() {}, getSnappedPosition: point => point,
        },
        _showCrosshair() {}, _hideCrosshair() {}, _updateCrosshair() {},
        _updateSelectableItems() {}, _updateUndoRedoButtons() {}, _updateTitle() {},
        renderShapes() {}, _removeBoxSelectElement() {}, _setToolCursor() {}, _updateShapePanelOptions() {},
        invalidate() {}, _setActiveRibbonTab() {}, _confirm: async () => true,
        _alert: message => alerts.push(message),
    });
    project.registerView('schematic', app);
    const shape = new Circle({ radius: 5 });
    app.shapes.push(shape);
    app.selection.setShapes(app.shapes);
    app.selection.select(shape);
    project.pcbDocument.tracks.push(new Track({ points: [{ x: 0, y: 0 }, { x: 5, y: 0 }] }));
    app.history.record({ execute() {}, undo() {}, description: 'Earlier edit' });
    project.fileManager.setFileName('existing.cpcb');
    project.fileManager.fileHandle = { name: 'existing.cpcb' };
    project.fileManager.setDirty(true);
    return { app, project, shape, alerts };
}

for (const mode of ['paste', 'drawing', 'wire', 'component', 'anchor', 'pending']) {
    const { app, project, shape, alerts } = fixture();
    if (mode === 'paste') {
        copySelection(app);
        beginPastePreview(app);
    } else if (mode === 'drawing' || mode === 'wire') {
        app.currentTool = mode === 'wire' ? 'wire' : 'circle';
        app.isDrawing = true;
        app.interactionState = 'drawing';
        app.previewElement = element();
        app.viewport.contentLayer.appendChild(app.previewElement);
    } else if (mode === 'component') {
        app.currentTool = 'component';
        app.placingComponent = {};
        app.componentPreview = element();
        app.viewport.contentLayer.appendChild(app.componentPreview);
    } else {
        const beforeState = shape.captureState();
        if (mode === 'anchor') {
            app.drag = { shape, beforeState };
            app.interactionState = 'anchorDrag';
        } else app.pendingAnchorDrag = { shape, preInsertState: beforeState };
        shape.move(4, 5);
    }
    assert.equal(project.canSerialize(), false, `${mode}: pending edit blocks save before New`);
    await newFile(app);
    assert.deepEqual(alerts, [], `${mode}: New must not fail after clearing either document`);
    assert.equal(app.shapes.length, 0);
    assert.equal(project.pcbDocument.tracks.length, 0);
    assert.equal(app.history.undoStack.length, 0);
    assert.equal(project.fileManager.fileHandle, null);
    assert.notEqual(project.fileManager.fileName, 'existing.cpcb');
    assert.equal(project.canSerialize(), true);
    assert.equal(app.viewport.contentLayer.children.length, 0, `${mode}: old preview SVG is removed`);
}

for (const cleanup of ['throw', 'unfinished', 'declined']) {
    const { app, project, alerts } = fixture();
    copySelection(app);
    beginPastePreview(app);
    const before = project.schematicDocument.serialize().schematic;
    const undo = [...app.history.undoStack];
    if (cleanup === 'throw') app._cancelPaste = () => { throw new Error('Preview cleanup failed'); };
    else if (cleanup === 'unfinished') app._cancelPaste = () => {};
    else app._confirm = async () => false;
    await newFile(app);
    assert.deepEqual(alerts, cleanup === 'declined' ? [] : [
        'Failed to create new document: ' + (cleanup === 'throw'
            ? 'Preview cleanup failed' : 'Finish the current edit before creating a new document.'),
    ]);
    assert.deepEqual(project.schematicDocument.serialize().schematic, before);
    assert.equal(project.pcbDocument.tracks.length, 1);
    assert.deepEqual(app.history.undoStack, undo);
    assert.equal(project.fileManager.fileName, 'existing.cpcb');
    assert.equal(project.fileManager.loading, false);
}
console.log('PASS New cancels schematic pending edits before clearing and preserves both documents on cleanup failure');
