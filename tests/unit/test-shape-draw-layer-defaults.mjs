import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { getShapeDraw } from '../../src/pcb/modules/board-shape-draw.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';

let select = null;
const document = installFakeDom();
globalThis.requestAnimationFrame = callback => { callback(); return 1; };
globalThis.window.requestAnimationFrame = globalThis.requestAnimationFrame;
document.getElementById = id => id === 'pcbToolShapeLayer' ? select : null;
document.querySelectorAll = () => [];
document.createElementNS = (_namespace, tag) => {
    const node = fakeElement(tag);
    node.attributes = new Map();
    const setAttribute = node.setAttribute.bind(node);
    const getAttribute = node.getAttribute.bind(node);
    const removeAttribute = node.removeAttribute.bind(node);
    node.setAttribute = (key, value) => { node.attributes.set(key, String(value)); setAttribute(key, value); };
    node.getAttribute = key => node.attributes.get(key) ?? getAttribute(key);
    node.removeAttribute = key => { node.attributes.delete(key); removeAttribute(key); };
    return node;
};
const { PCB_LAYERS, notifyLayerLockChanged } = await import('../../src/pcb/modules/layers.js');
const { resolveShapeDrawLayer, shapeDrawClick, cancelShapeDraw } = await import('../../src/pcb/modules/board-shape-draw.js');
const { showBoardShapeToolProperties } = await import('../../src/pcb/modules/board-shape-properties.js');
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');
let shown = null;
const syncPanel = panel => {
    const layer = panel.fields.find(field => field.id === 'pcbToolShapeLayer');
    select = { value: layer?.value || '', disabled: !!layer?.disabled, warning: layer?.warning || '', addEventListener() {} };
    shown = panel;
};
const unlockAction = () => shown?.actions?.[0]?.actions?.[0] || null;
const model = new PcbDocument();
const app = { ...pcbEditorStubs(),
    pcbDocument: model, boardShapes: model.boardShapes, tracks: model.tracks,
    vias: model.vias, pads: model.pads, texts: model.texts, placements: new Map(),
    history: new CommandHistory(), _shapeElements: new Map(), shapeIdCounter: 1,
    _layerGroups: new Map(), existingLayerGroups() { return this._layerGroups; }, _hoveredTrackOrVia: null,
    viewport: { scale: 100 }, snapToGrid: point => point, getLayerGroup: () => null,
    openPropertyPanel(panel) { syncPanel(panel); return true; },
    refreshPropertyPanel(panel) { syncPanel(panel); },
    setActiveRibbonTab() {},
    status: { modeStatus: { textContent: '' } },
    setPcbStatus: PCBApp.prototype.setPcbStatus,};
const locks = PCB_LAYERS.map(layer => layer.locked);
try {
    for (const layer of PCB_LAYERS) layer.locked = false;
    const top = PCB_LAYERS.find(layer => layer.id === 'top-copper');
    const bottom = PCB_LAYERS.find(layer => layer.id === 'bottom-copper');
    top.locked = true;
    for (const kind of ['line', 'rect', 'circle', 'polygon', 'arc']) {
        app.currentTool = kind;
        app.activeLayer = 'top-copper';
        showBoardShapeToolProperties(app, kind);
        assert.equal(select.value, 'top-copper', `${kind}: a locked default stays the tool's layer, not swapped for another`);
        assert.equal(app.activeLayer, select.value, 'The dropdown and drawing default agree');
        assert.match(select.warning, /“Top Copper” is locked/, 'The layer field says why nothing can be drawn');
        assert.equal(unlockAction()?.label, 'Unlock Top Copper', 'Properties offers the way out');
        assert.ok(app.status.modeStatus.textContent.endsWith(' | Top Copper'));
        shapeDrawClick(app, kind, { x: 1, y: -1 });
        assert.equal(getShapeDraw(app), null, `${kind}: nothing is drawn on the locked layer`);
        app.activeLayer = 'bottom-copper';
        showBoardShapeToolProperties(app, kind);
        assert.equal(select.warning, '', 'An unlocked layer carries no warning');
        assert.equal(unlockAction(), null);
        shapeDrawClick(app, kind, { x: 1, y: -1 });
        assert.equal(getShapeDraw(app).layer, 'bottom-copper', 'The preview uses the displayed default');
        const draw = getShapeDraw(app);
        notifyLayerLockChanged(app, 'top-copper', true);
        assert.equal(getShapeDraw(app), draw, 'Updating lock indicators does not replace an unfinished shape');
        cancelShapeDraw(app);
    }
    app.currentTool = 'rect';
    app.activeLayer = 'top-document';
    showBoardShapeToolProperties(app, 'rect');
    assert.equal(select.value, 'top-document', 'An explicitly chosen unlocked layer remains preferred');
    bottom.locked = true;
    app.activeLayer = 'bottom-copper';
    showBoardShapeToolProperties(app, 'rect');
    notifyLayerLockChanged(app, 'bottom-copper', true);
    assert.equal(select.value, 'bottom-copper', 'Locking the current default keeps it, flagged');
    assert.equal(app.activeLayer, 'bottom-copper');
    assert.match(select.warning, /“Bottom Copper” is locked/);

    assert.equal(resolveShapeDrawLayer(app, 'vias'), 'top-silk',
        'Display-only layers still map to a drawable layer');
    const validLayers = ['top-copper', 'bottom-copper', 'top-silk', 'bottom-silk',
        'top-document', 'bottom-document', 'hole'];
    for (const layer of PCB_LAYERS) layer.locked = validLayers.includes(layer.id);
    app.activeLayer = 'hole';
    notifyLayerLockChanged(app, 'top-silk', true);
    assert.equal(select.value, 'hole');
    const blockedLocks = PCB_LAYERS.map(layer => layer.locked);
    for (const kind of ['line', 'rect', 'circle', 'polygon', 'arc']) {
        app.currentTool = kind;
        shapeDrawClick(app, kind, { x: 1, y: -1 });
        assert.equal(getShapeDraw(app), null, `${kind}: no preview begins on a locked layer`);
    }
    assert.equal(app.history.undoStack.length, 0);
    assert.deepEqual(model.boardShapes, []);
    assert.deepEqual(PCB_LAYERS.map(layer => layer.locked), blockedLocks, 'Drawing never unlocks layers automatically');

    app.currentTool = 'rect';
    const hole = PCB_LAYERS.find(layer => layer.id === 'hole');
    hole.locked = false;
    notifyLayerLockChanged(app, 'hole', false);
    assert.equal(select.value, 'hole', 'Unlocking the layer recovers the tool immediately');
    assert.equal(select.warning, '');
    assert.equal(app.activeLayer, 'hole');
    assert.equal(app.status.modeStatus.textContent, 'Rect | Hole');
    shapeDrawClick(app, 'rect', { x: 1, y: -1 });
    shapeDrawClick(app, 'rect', { x: 5, y: -5 });
    assert.equal(model.boardShapes.length, 1);
    assert.equal(model.boardShapes[0].layer, 'hole', 'The completed shape uses the newly available layer');
    assert.equal(app.history.undoStack.length, 1);
    app.history.undo();
    assert.equal(model.boardShapes.length, 0);
    app.history.redo();
    assert.equal(model.boardShapes[0].layer, 'hole');
    app.currentTool = 'select';
    const previousPanel = shown;
    hole.locked = true;
    notifyLayerLockChanged(app, 'hole', true);
    assert.equal(shown, previousPanel, 'Inactive drawing controls are not rebuilt as a new shape tool');
} finally {
    PCB_LAYERS.forEach((layer, index) => { layer.locked = locks[index]; });
}
console.log('PASS shape tools keep a locked layer and refuse it with a warning, live recovery and completed shape/history layer parity');
