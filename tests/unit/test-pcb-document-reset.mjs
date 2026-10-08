import assert from 'node:assert/strict';
import { setEditorActive, setEditorStale } from '../../src/pcb/modules/pcb-editor-api.js';
import { getShapeDraw } from '../../src/pcb/modules/board-shape-draw.js';
import { installFakeDom, fakeElement } from './helpers/fake-dom.mjs';
import { schematicEditorStubs } from './helpers/schematic-editor-stubs.mjs';

function element(tag) {
    return Object.assign(fakeElement(tag), { tag });
}
const document = installFakeDom();
document.createElementNS = (_namespace, tag) => element(tag);
document.createElement = tag => element(tag);
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');
const { boardDimensionsDialog, initializeBoardOutlineState, isBoardOutlineDrawn } = await import('../../src/pcb/modules/board-outline-resize.js');
const { default: SchematicApp } = await import('../../src/ui/SchematicApp.js');
const { ProjectDocument } = await import('../../src/core/ProjectDocument.js');
const { newFile } = await import('../../src/schematic/modules/files.js');
const { loadPcb } = await import('../../src/pcb/modules/project-state.js');
const { renderBoardShape } = await import('../../src/pcb/modules/board-shape-render.js');
const { shapeDrawClick, updateShapeDrawPreview } = await import('../../src/pcb/modules/board-shape-draw.js');
const { boardDimensions } = await import('../../src/shared/pcb/board-outline.js');
const { getPcbSelectionManager, setPcbSelection, getPcbSelectionEntries, clearPcbSelection } = await import('../../src/pcb/modules/selection-registry.js');
const { renderPcbSelectionAnchors } = await import('../../src/pcb/modules/selection-anchors.js');
const { CommandHistory } = await import('../../src/core/CommandHistory.js');

function fixture(active) {
    const layers = new Map();
    const lifecycle = [];
    const project = new ProjectDocument();
    const app = Object.assign(Object.create(PCBApp.prototype), {
        pcbDocument: project.pcbDocument,
        currentTool: 'select', activeLayer: 'top-silk',
        tracks: [], vias: [], pads: [], boardShapes: [], texts: new Map(), placements: new Map(),
        _shapeElements: new Map(),
        placementState: project.pcbDocument.placementState, _placementOverrides: project.pcbDocument.placementState.overrides,
        designSettings: project.pcbDocument.designSettings,
        history: new CommandHistory(), netlist: [],
        viewport: { scale: 10, shiftHeld: true, hideCrosshair() {},
            gridSize: 1, getGridOptions: () => [{ value: 1, label: '1 mm' }], fitToBounds() {} },
        ui: { gridSize: element('select') },
        initialize() {}, _retainRibbonHeight() {},
        _updateViewportStatus() {}, syncPcbViewToggles() {},
        setActiveRibbonTab(tab) { lifecycle.push(tab); },
        _showBoardDimensionsDialog() {
            assert.equal(this.boardShapes.length, 0, 'Prompt follows removal of the old shapes');
            assert.equal(getPcbSelectionEntries(this).length, 0, 'Prompt follows selection disposal');
            assert.equal(isBoardOutlineDrawn(this), false);
            assert.deepEqual(Object.values(boardDimensions(this)), [100, 80, 0]);
            lifecycle.push('dimensions');
        },
        ensureViewport() {},
        getLayerGroup(id) {
            if (!layers.has(id)) layers.set(id, element('g'));
            return layers.get(id);
        },
        existingLayerGroups() { return layers; },
        updateCopperCuts() {},
        _refreshBoardShapeClearance() {}, setPcbStatus() {}, syncClipboardButtons() {},
        refreshPcbRibbon() {},
        refreshClearanceHalos() {}, refreshFills() {},
    });
    setEditorActive(app, active);
    initializeBoardOutlineState(app, false);
    const host = {
        ...schematicEditorStubs(),
        document: project.schematicDocument,
        project, fileManager: project.fileManager, selection: { clearSelection() {} },
        shapes: [], components: [],
        history: { clear() {} },
        updateSelectableItems() {},
        ui: {},
        clearSection: SchematicApp.prototype.clearSection,
        serializeSection: SchematicApp.prototype.serializeSection,
        getViewSettings: SchematicApp.prototype.getViewSettings,
        viewport: { resetView() {}, setTitleBlockData() {} },
        // UI-host prompts surface the underlying failure instead of a missing-method TypeError.
        alert(message) { assert.fail(`Unexpected UI-host alert: ${message}`); },
        async confirm(message) { assert.fail(`Unexpected UI-host confirm: ${message}`); },
    };
    project.registerView('pcb', app);
    project.registerView('schematic', host, { isUiHost: true, lifecycle: { new: () => newFile(host) } });
    globalThis.bootstrap = { project: { pcb: {
        clearSection() { assert.fail('New must not clear a different bootstrap project'); },
    } } };
    return { app, project, layers, lifecycle };
}

{
    const { app, project } = fixture(true);
    loadPcb(app, { stackup: { copperLayers: ['top-copper', 'bottom-copper'] },
        board: { width: 43, height: 27, radius: 2 } });
    const outline = project.pcbDocument.boardShapes.find(shape => shape.layer === 'board-outline');
    assert.ok(outline, 'Legacy dimensions generate a model-owned outline that survives entity adoption');
    assert.equal(app.boardShapes.length, 1);
    assert.equal(outline.cornerRadius, 2);
    assert.deepEqual([boardDimensions(app).width, boardDimensions(app).height], [43, 27]);
    assert.equal(app.getLayerGroup('board-outline').querySelectorAll('.pcb-board-outline').length, 1,
        'Legacy outline rendering is not duplicated');
}

for (const active of [true, false]) {
    for (const selected of [true, false]) {
        const { app, project, lifecycle } = fixture(active);
        const shape = { id: 'old-rect', kind: 'rect', layer: 'top-silk', lineWidth: 0.2,
            points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 4 }, { x: 0, y: 4 }] };
        const shapes = [shape,
            { id: 'old-circle', kind: 'circle', layer: 'top-silk', lineWidth: 0.2, x: 12, y: 3, radius: 2 },
            { id: 'old-line', kind: 'line', layer: 'top-silk', lineWidth: 0.2,
                points: [{ x: 16, y: 0 }, { x: 19, y: 5 }] },
        ];
        app.boardShapes.push(...shapes);
        for (const item of shapes) renderBoardShape(app, item);
        const layer = app.getLayerGroup('top-silk'), overlay = app.getLayerGroup('selection-overlay');
        assert.equal(layer.children.length, shapes.length);
        if (selected) {
            setPcbSelection(app, shapes.map(object => ({ kind: 'shape', object })));
            renderPcbSelectionAnchors(app);
            assert.equal(overlay.querySelectorAll('.pcb-selection-anchors').length, shapes.length);
            getPcbSelectionManager(app).setHovered(getPcbSelectionEntries(app)[0]);
        }
        await project.newDocument();
        assert.deepEqual(lifecycle, active ? ['pcb-home', 'dimensions'] : ['pcb-home'],
            'Successful New returns Home and prompts only when PCB is active');
        assert.equal(app.boardShapes.length, 0);
        assert.equal(layer.children.length, 0);
        assert.equal(overlay.querySelectorAll('.pcb-selection-anchors').length, 0,
            'File -> New must remove every selected shape outline and its handles');
        assert.equal(getPcbSelectionEntries(app).length, 0);
        assert.equal(getPcbSelectionManager(app).hovered, null);
        assert.equal(getPcbSelectionManager(app).shapes.length, 0);
        clearPcbSelection(app);
        getPcbSelectionManager(app).setHovered(null);
        renderPcbSelectionAnchors(app);
        assert.equal(layer.children.length, 0, 'Later deselection/hover cannot resurrect an old rectangle');
        assert.equal(overlay.children.length, 0);
        assert.equal(project.isDirty, false);
        await project.newDocument();
        assert.equal(layer.children.length, 0, 'Repeated New remains empty');
        assert.equal(lifecycle.filter(event => event === 'dimensions').length, active ? 2 : 0);
        if (!active) {
            app.activate();
            assert.equal(lifecycle.filter(event => event === 'dimensions').length, 1,
                'Schematic New defers the dimensions prompt until PCB activation');
        }
    }
}

for (const replacement of [null, { stackup: { copperLayers: ['top-copper', 'bottom-copper'] } }]) {
    const { app } = fixture(true);
    app.currentTool = 'rect';
    shapeDrawClick(app, 'rect', { x: 0, y: 0 });
    updateShapeDrawPreview(app, { x: 8, y: 4 });
    const preview = getShapeDraw(app).preview;
    assert.ok(preview.parentNode);
    loadPcb(app, replacement);
    assert.equal(preview.parentNode, null, 'New/Open removes drawing previews before dropping their state');
    assert.equal(getShapeDraw(app), null);
    assert.equal(app.currentTool, 'select');
    assert.equal(app.getLayerGroup('selection-overlay').children.length, 0);
}

{
    const { app, project, lifecycle } = fixture(true);
    const old = { id: 'reused-id', kind: 'circle', layer: 'top-silk', lineWidth: 0.2, x: 2, y: 3, radius: 1 };
    app.boardShapes.push(old);
    renderBoardShape(app, old);
    setPcbSelection(app, [{ kind: 'shape', object: old }]);
    renderPcbSelectionAnchors(app);
    project.fileManager.setDirty(true);
    project.schematic.confirm = async () => false;
    await project.newDocument();
    assert.deepEqual(lifecycle, [], 'Cancelling New must not prompt or change tabs');
    assert.equal(app.boardShapes[0], old, 'Cancelling New preserves the current document');
    assert.equal(getPcbSelectionEntries(app)[0].object, old);
    assert.equal(app.getLayerGroup('selection-overlay').querySelectorAll('.pcb-selection-anchors').length, 1);

    loadPcb(app, { stackup: { copperLayers: ['top-copper', 'bottom-copper'] },
        boardShapes: [{ ...old, x: 50, y: -20 }] });
    assert.notEqual(app.boardShapes[0], old);
    assert.equal(app.boardShapes[0].x, 50);
    assert.equal(getPcbSelectionEntries(app).length, 0, 'Open cannot transfer old selection to a reused object ID');
    project.notifyDocumentReplaced('open');
    assert.deepEqual(lifecycle, ['pcb-home'], 'Open does not trigger the New-board setup prompt');
    assert.equal(app.getLayerGroup('selection-overlay').children.length, 0);
    clearPcbSelection(app);
    assert.equal(app.getLayerGroup('top-silk').children.length, 1, 'Open retains only the new document artwork');
}
delete globalThis.bootstrap;
{
    const { app, project } = fixture(true);
    app._showBoardDimensionsDialog = PCBApp.prototype._showBoardDimensionsDialog;
    const createElement = document.createElement;
    document.createElement = tag => {
        const node = createElement(tag);
        if (tag === 'div') {
            const controls = new Map([
                ['#boardDlgShape', Object.assign(element('select'), { value: 'rect' })],
                ['#boardDlgRectangleSizes', element('div')],
                ['#boardDlgCircleSizes', element('div')],
                ['#boardDlgDiameter', Object.assign(element('input'), {
                    value: '80', setCustomValidity() {}, reportValidity() {},
                })],
                ['#boardDlgWidth', Object.assign(element('input'), { value: '100' })],
                ['#boardDlgHeight', Object.assign(element('input'), { value: '80' })],
                ['#boardDlgRadius', Object.assign(element('input'), { value: '0' })],
                ['#boardDlgOk', element('button')],
            ]);
            node.querySelector = selector => controls.get(selector) || null;
        }
        return node;
    };
    await project.newDocument();
    const first = boardDimensionsDialog(app);
    assert.equal(first.parentNode, document.body, 'New displays the existing dimensions dialog');
    app._showBoardDimensionsDialog();
    assert.equal(boardDimensionsDialog(app), first, 'Repeated setup requests do not stack dialogs');
    await project.newDocument();
    const second = boardDimensionsDialog(app);
    assert.notEqual(second, first);
    assert.equal(first.parentNode, null, 'Replacing the document disposes its old dialog');
    assert.equal(document.body.children.length, 1);
    first.querySelector('#boardDlgOk').dispatchEvent({ type: 'click' });
    assert.equal(isBoardOutlineDrawn(app), false, 'A stale dialog cannot change the replacement document');
    second.querySelector('#boardDlgOk').dispatchEvent({ type: 'click' });
    assert.equal(isBoardOutlineDrawn(app), true, 'Accepting defaults creates the new board outline');
    assert.equal(app.pcbDocument.boardShapes.filter(shape => shape.layer === 'board-outline').length, 1,
        'Default setup explicitly authors one model outline');
    assert.equal(project.isDirty, true, 'The newly created outline is eligible for saving');
    assert.equal(boardDimensionsDialog(app), null);
    assert.equal(document.body.children.length, 0);

    project.schematic.confirm = async () => true;
    await project.newDocument();
    const pending = boardDimensionsDialog(app);
    loadPcb(app, { stackup: { copperLayers: ['top-copper', 'bottom-copper'] },
        board: { width: 45, height: 22, radius: 0 } });
    project.notifyDocumentReplaced('open');
    assert.equal(pending.parentNode, null, 'Open disposes an unfinished New-board dialog');
    assert.equal(boardDimensionsDialog(app), null);
    assert.deepEqual([boardDimensions(app).width, boardDimensions(app).height], [45, 22]);
    pending.querySelector('#boardDlgOk').dispatchEvent({ type: 'click' });
    assert.deepEqual([boardDimensions(app).width, boardDimensions(app).height], [45, 22], 'Stale setup cannot overwrite loaded dimensions');
    document.createElement = createElement;
}

console.log('PASS PCB document reset disposes selection/previews/dialogs and prompts for New-board dimensions at the correct time');
