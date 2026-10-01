import assert from 'node:assert/strict';

function element(tag) {
    const attributes = new Map();
    const listeners = new Map();
    return {
        tag, children: [], parentNode: null, style: {}, dataset: {},
        classList: { add() {}, remove() {} },
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(listener);
        },
        dispatchEvent(event) { for (const listener of listeners.get(event.type) || []) listener(event); },
        focus() {},
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        removeAttribute(name) { attributes.delete(name); },
        appendChild(child) {
            child.remove();
            child.parentNode = this;
            this.children.push(child);
            return child;
        },
        removeChild(child) {
            this.children = this.children.filter(item => item !== child);
            child.parentNode = null;
        },
        remove() { this.parentNode?.removeChild(this); },
        querySelectorAll(selector) {
            const matches = item => selector.startsWith('.')
                ? (item.getAttribute('class') || '').split(/\s+/).includes(selector.slice(1))
                : item.tag === selector;
            return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
        },
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    };
}
globalThis.window = { addEventListener() {} };
globalThis.document = {
    body: element('body'),
    documentElement: { getAttribute() { return 'dark'; } },
    createElementNS: (_namespace, tag) => element(tag),
    createElement: tag => element(tag),
    getElementById() { return null; },
    querySelector() { return null; },
};
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { default: SchematicApp } = await import('../src/ui/SchematicApp.js');
const { ProjectDocument } = await import('../src/core/ProjectDocument.js');
const { newFile } = await import('../src/schematic/modules/files.js');
const { loadPcb } = await import('../src/pcb/modules/project-state.js');
const { renderBoardShape, shapeDrawClick, updateShapeDrawPreview } = await import('../src/pcb/modules/board-shapes.js');
const { setPcbSelection, getPcbSelectionEntries, clearPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const { renderPcbSelectionAnchors } = await import('../src/pcb/modules/selection-anchors.js');
const { CommandHistory } = await import('../src/core/CommandHistory.js');

function fixture(active) {
    const layers = new Map();
    const lifecycle = [];
    const project = new ProjectDocument();
    const app = Object.assign(Object.create(PCBApp.prototype), {
        pcbDocument: project.pcbDocument,
        _active: active, currentTool: 'select', activeLayer: 'top-silk',
        tracks: [], vias: [], pads: [], boardShapes: [], texts: new Map(), placements: new Map(),
        _shapeElements: new Map(), _textElements: new Map(),
        placementState: project.pcbDocument.placementState, _placementOverrides: project.pcbDocument.placementState.overrides,
        designSettings: project.pcbDocument.designSettings,
        history: new CommandHistory(), netlist: [],
        viewport: { scale: 10, shiftHeld: true, hideCrosshair() {},
            gridSize: 1, getGridOptions: () => [{ value: 1, label: '1 mm' }], fitToBounds() {} },
        ui: { gridSize: element('select') },
        initialize() {}, _retainRibbonHeight() {},
        _updateViewportStatus() {}, syncPcbViewToggles() {},
        _syncFromSchematic() { this._stale = false; },
        _setActiveRibbonTab(tab) { lifecycle.push(tab); },
        _showBoardDimensionsDialog() {
            assert.equal(this.boardShapes.length, 0, 'Prompt follows removal of the old shapes');
            assert.equal(getPcbSelectionEntries(this).length, 0, 'Prompt follows selection disposal');
            assert.equal(this._boardOutlineDrawn, false);
            assert.deepEqual([this._boardWidth, this._boardHeight, this._boardRadius], [100, 80, 0]);
            lifecycle.push('dimensions');
        },
        _ensureViewport() {},
        _getLayerGroup(id) {
            if (!layers.has(id)) layers.set(id, element('g'));
            return layers.get(id);
        },
        _updateCopperCuts() {}, _clearFillGroups() {}, _closeDRCPanel() {}, _clearDRCMarker() {},
        _refreshBoardShapeClearance() {}, _setPcbStatus() {}, _syncClipboardButtons() {}, _scheduleRemovalHatchRender() {},
        _updateCursorForTool() {}, _syncPcbHomeToolHighlight() {}, _hideToolOptions() {},
        _refreshClearanceHalos() {}, _refreshFills() {},
    });
    const host = {
        document: project.schematicDocument,
        project, fileManager: project.fileManager, selection: { clearSelection() {} },
        shapes: [], components: [],
        clearSection: SchematicApp.prototype.clearSection,
        serializeSection: SchematicApp.prototype.serializeSection,
        getViewSettings: SchematicApp.prototype.getViewSettings,
        _clearAllShapes() { this.shapes = []; }, _clearAllComponents() { this.components = []; },
        viewport: { resetView() {}, setTitleBlockData() {} }, _updateTitle() {},
        _notifyDocumentReplaced: SchematicApp.prototype._notifyDocumentReplaced,
        // UI-host prompts surface the underlying failure instead of a missing-method TypeError.
        _alert(message) { assert.fail(`Unexpected UI-host alert: ${message}`); },
        async _confirm(message) { assert.fail(`Unexpected UI-host confirm: ${message}`); },
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
    assert.deepEqual([app._boardWidth, app._boardHeight], [43, 27]);
    assert.equal(app._getLayerGroup('board-outline').querySelectorAll('.pcb-board-outline').length, 1,
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
        const layer = app._getLayerGroup('top-silk'), overlay = app._getLayerGroup('selection-overlay');
        assert.equal(layer.children.length, shapes.length);
        if (selected) {
            setPcbSelection(app, shapes.map(object => ({ kind: 'shape', object })));
            renderPcbSelectionAnchors(app);
            assert.equal(overlay.querySelectorAll('.pcb-selection-anchors').length, shapes.length);
            app._pcbSelection.setHovered(getPcbSelectionEntries(app)[0]);
        }
        await project.newDocument();
        assert.deepEqual(lifecycle, active ? ['pcb-home', 'dimensions'] : ['pcb-home'],
            'Successful New returns Home and prompts only when PCB is active');
        assert.equal(app.boardShapes.length, 0);
        assert.equal(layer.children.length, 0);
        assert.equal(overlay.querySelectorAll('.pcb-selection-anchors').length, 0,
            'File -> New must remove every selected shape outline and its handles');
        assert.equal(getPcbSelectionEntries(app).length, 0);
        assert.equal(app._pcbSelection.hovered, null);
        assert.equal(app._pcbSelection.shapes.length, 0);
        clearPcbSelection(app);
        app._pcbSelection.setHovered(null);
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
    const preview = app._shapeDraw.preview;
    assert.ok(preview.parentNode);
    loadPcb(app, replacement);
    assert.equal(preview.parentNode, null, 'New/Open removes drawing previews before dropping their state');
    assert.equal(app._shapeDraw, null);
    assert.equal(app.currentTool, 'select');
    assert.equal(app._getLayerGroup('selection-overlay').children.length, 0);
}

{
    const { app, project, lifecycle } = fixture(true);
    const old = { id: 'reused-id', kind: 'circle', layer: 'top-silk', lineWidth: 0.2, x: 2, y: 3, radius: 1 };
    app.boardShapes.push(old);
    renderBoardShape(app, old);
    setPcbSelection(app, [{ kind: 'shape', object: old }]);
    renderPcbSelectionAnchors(app);
    project.fileManager.setDirty(true);
    project.schematic._confirm = async () => false;
    await project.newDocument();
    assert.deepEqual(lifecycle, [], 'Cancelling New must not prompt or change tabs');
    assert.equal(app.boardShapes[0], old, 'Cancelling New preserves the current document');
    assert.equal(getPcbSelectionEntries(app)[0].object, old);
    assert.equal(app._getLayerGroup('selection-overlay').querySelectorAll('.pcb-selection-anchors').length, 1);

    loadPcb(app, { stackup: { copperLayers: ['top-copper', 'bottom-copper'] },
        boardShapes: [{ ...old, x: 50, y: -20 }] });
    assert.notEqual(app.boardShapes[0], old);
    assert.equal(app.boardShapes[0].x, 50);
    assert.equal(getPcbSelectionEntries(app).length, 0, 'Open cannot transfer old selection to a reused object ID');
    project.notifyDocumentReplaced('open');
    assert.deepEqual(lifecycle, ['pcb-home'], 'Open does not trigger the New-board setup prompt');
    assert.equal(app._getLayerGroup('selection-overlay').children.length, 0);
    clearPcbSelection(app);
    assert.equal(app._getLayerGroup('top-silk').children.length, 1, 'Open retains only the new document artwork');
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
    const first = app._boardDimensionsOverlay;
    assert.equal(first.parentNode, document.body, 'New displays the existing dimensions dialog');
    app._showBoardDimensionsDialog();
    assert.equal(app._boardDimensionsOverlay, first, 'Repeated setup requests do not stack dialogs');
    await project.newDocument();
    const second = app._boardDimensionsOverlay;
    assert.notEqual(second, first);
    assert.equal(first.parentNode, null, 'Replacing the document disposes its old dialog');
    assert.equal(document.body.children.length, 1);
    first.querySelector('#boardDlgOk').dispatchEvent({ type: 'click' });
    assert.equal(app._boardOutlineDrawn, false, 'A stale dialog cannot change the replacement document');
    second.querySelector('#boardDlgOk').dispatchEvent({ type: 'click' });
    assert.equal(app._boardOutlineDrawn, true, 'Accepting defaults creates the new board outline');
    assert.equal(app.pcbDocument.boardShapes.filter(shape => shape.layer === 'board-outline').length, 1,
        'Default setup explicitly authors one model outline');
    assert.equal(project.isDirty, true, 'The newly created outline is eligible for saving');
    assert.equal(app._boardDimensionsOverlay, null);
    assert.equal(document.body.children.length, 0);

    project.schematic._confirm = async () => true;
    await project.newDocument();
    const pending = app._boardDimensionsOverlay;
    loadPcb(app, { stackup: { copperLayers: ['top-copper', 'bottom-copper'] },
        board: { width: 45, height: 22, radius: 0 } });
    project.notifyDocumentReplaced('open');
    assert.equal(pending.parentNode, null, 'Open disposes an unfinished New-board dialog');
    assert.equal(app._boardDimensionsOverlay, null);
    assert.deepEqual([app._boardWidth, app._boardHeight], [45, 22]);
    pending.querySelector('#boardDlgOk').dispatchEvent({ type: 'click' });
    assert.deepEqual([app._boardWidth, app._boardHeight], [45, 22], 'Stale setup cannot overwrite loaded dimensions');
    document.createElement = createElement;
}

console.log('PASS PCB document reset disposes selection/previews/dialogs and prompts for New-board dimensions at the correct time');
