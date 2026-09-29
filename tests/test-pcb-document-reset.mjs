import assert from 'node:assert/strict';

function element(tag) {
    const attributes = new Map();
    return {
        tag, children: [], parentNode: null, style: {}, dataset: {},
        classList: { add() {}, remove() {} },
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
const autosaveDot = element('div');
globalThis.document = {
    documentElement: { getAttribute() { return 'dark'; } },
    createElementNS: (_namespace, tag) => element(tag),
    getElementById(id) { return id === 'clearpcb-autosave-dot' ? autosaveDot : null; },
    querySelector() { return null; },
};
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { ProjectDocument } = await import('../src/core/ProjectDocument.js');
const { newFile } = await import('../src/schematic/modules/files.js');
const { loadPcb } = await import('../src/pcb/modules/project-state.js');
const { renderBoardShape, shapeDrawClick, updateShapeDrawPreview } = await import('../src/pcb/modules/board-shapes.js');
const { setPcbSelection, getPcbSelectionEntries, clearPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const { renderPcbSelectionAnchors } = await import('../src/pcb/modules/selection-anchors.js');
const { CommandHistory } = await import('../src/core/CommandHistory.js');

function fixture(active) {
    const layers = new Map();
    const app = Object.assign(Object.create(PCBApp.prototype), {
        _active: active, currentTool: 'select', activeLayer: 'top-silk',
        tracks: [], vias: [], pads: [], boardShapes: [], texts: new Map(), placements: new Map(),
        _shapeElements: new Map(), _textElements: new Map(), _placementOverrides: new Map(),
        history: new CommandHistory(), netlist: [],
        viewport: { scale: 10, shiftHeld: true, hideCrosshair() {} },
        _ensureViewport() {},
        _getLayerGroup(id) {
            if (!layers.has(id)) layers.set(id, element('g'));
            return layers.get(id);
        },
        _updateCopperCuts() {}, _clearFillGroups() {}, _closeDRCPanel() {}, _clearDRCMarker() {},
        _refreshBoardShapeClearance() {}, _setPcbStatus() {}, _syncClipboardButtons() {}, _scheduleRemovalHatchRender() {},
        _updateCursorForTool() {}, _syncPcbHomeToolHighlight() {}, _hideToolOptions() {},
        _applyProjectDesignParams() {}, _refreshClearanceHalos() {}, _refreshFills() {},
    });
    const project = new ProjectDocument();
    const host = {
        project, fileManager: project.fileManager, selection: { clearSelection() {} },
        shapes: [], components: [],
        _clearAllShapes() { this.shapes = []; }, _clearAllComponents() { this.components = []; },
        viewport: { resetView() {}, setTitleBlockData() {} }, _updateTitle() {},
    };
    project.registerView('pcb', app);
    project.registerView('schematic', host, { isUiHost: true, lifecycle: { new: () => newFile(host) } });
    globalThis.bootstrap = { project };
    return { app, project, layers };
}

for (const active of [true, false]) {
    for (const selected of [true, false]) {
        const { app, project } = fixture(active);
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
    const { app, project } = fixture(true);
    const old = { id: 'reused-id', kind: 'circle', layer: 'top-silk', lineWidth: 0.2, x: 2, y: 3, radius: 1 };
    app.boardShapes.push(old);
    renderBoardShape(app, old);
    setPcbSelection(app, [{ kind: 'shape', object: old }]);
    renderPcbSelectionAnchors(app);
    project.fileManager.setDirty(true);
    project.schematic._confirm = async () => false;
    await project.newDocument();
    assert.equal(app.boardShapes[0], old, 'Cancelling New preserves the current document');
    assert.equal(getPcbSelectionEntries(app)[0].object, old);
    assert.equal(app._getLayerGroup('selection-overlay').querySelectorAll('.pcb-selection-anchors').length, 1);

    loadPcb(app, { stackup: { copperLayers: ['top-copper', 'bottom-copper'] },
        boardShapes: [{ ...old, x: 50, y: -20 }] });
    assert.notEqual(app.boardShapes[0], old);
    assert.equal(app.boardShapes[0].x, 50);
    assert.equal(getPcbSelectionEntries(app).length, 0, 'Open cannot transfer old selection to a reused object ID');
    assert.equal(app._getLayerGroup('selection-overlay').children.length, 0);
    clearPcbSelection(app);
    assert.equal(app._getLayerGroup('top-silk').children.length, 1, 'Open retains only the new document artwork');
}
delete globalThis.bootstrap;
clearTimeout(autosaveDot._t);
console.log('PASS PCB document reset clears selected shapes, hover adapters, handles and drawing previews without resurrection');
