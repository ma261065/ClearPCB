import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { getShapeDraw } from '../../src/pcb/modules/board-shapes.js';

let select = null;
globalThis.window = { addEventListener() {} };
globalThis.localStorage = { setItem() {} };
globalThis.requestAnimationFrame = callback => { callback(); return 1; };
globalThis.document = {
    getElementById: id => id === 'pcbToolShapeLayer' ? select : null,
    querySelectorAll: () => [],
    createElementNS() {
        const attributes = new Map();
        return {
            children: [],
            style: {}, setAttribute: (key, value) => attributes.set(key, String(value)),
            getAttribute: key => attributes.get(key) ?? null,
            removeAttribute: key => attributes.delete(key),
            appendChild(child) {
                this.children.push(child);
                child.parentNode = this;
                return child;
            },
        };
    },
};
const { PCB_LAYERS, notifyLayerLockChanged } = await import('../../src/pcb/modules/layers.js');
const { resolveShapeDrawLayer, shapeDrawClick, cancelShapeDraw } =
    await import('../../src/pcb/modules/board-shapes.js');
const { showBoardShapeToolProperties } = await import('../../src/pcb/modules/board-shape-properties.js');
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');
let html = '';
const syncPanel = panel => {
    const layer = panel.fields.find(field => field.id === 'pcbToolShapeLayer');
    select = { value: layer?.value || '', disabled: !!layer?.disabled, addEventListener() {} };
    html = layer?.disabled ? '<option value="" selected disabled>No unlocked layers</option>' : '';
};
const model = new PcbDocument();
const app = {
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
        assert.equal(select.value, 'bottom-copper', `${kind}: first unlocked valid layer is selected`);
        assert.equal(app.activeLayer, select.value, 'The dropdown and drawing default agree');
        assert.ok(app.status.modeStatus.textContent.endsWith(' | Bottom Copper'));
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
    app.activeLayer = 'top-copper';
    showBoardShapeToolProperties(app, 'rect');
    bottom.locked = true;
    notifyLayerLockChanged(app, 'bottom-copper', true);
    assert.equal(select.value, 'top-silk', 'Locking the current default selects the next valid layer');
    assert.equal(app.activeLayer, 'top-silk');

    const validLayers = ['top-copper', 'bottom-copper', 'top-silk', 'bottom-silk',
        'top-document', 'bottom-document', 'hole'];
    for (const layer of PCB_LAYERS) layer.locked = validLayers.includes(layer.id);
    notifyLayerLockChanged(app, 'top-silk', true);
    assert.equal(resolveShapeDrawLayer(app, app.activeLayer), null,
        'Unlocked mask, paste, outline and Via display layers are not drawing fallbacks');
    assert.equal(select.value, '');
    assert.equal(select.disabled, true);
    assert.match(html, /<option value="" selected disabled>No unlocked layers<\/option>/);
    assert.equal(app.status.modeStatus.textContent, 'Rect | No unlocked layers');
    const blockedLocks = PCB_LAYERS.map(layer => layer.locked);
    for (const kind of ['line', 'rect', 'circle', 'polygon', 'arc']) {
        app.currentTool = kind;
        shapeDrawClick(app, kind, { x: 1, y: -1 });
        assert.equal(getShapeDraw(app), null, `${kind}: no preview begins without an unlocked layer`);
        assert.equal(select.disabled, true);
    }
    assert.equal(app.history.undoStack.length, 0);
    assert.deepEqual(model.boardShapes, []);
    assert.deepEqual(PCB_LAYERS.map(layer => layer.locked), blockedLocks, 'Drawing never unlocks layers automatically');

    app.currentTool = 'rect';
    const hole = PCB_LAYERS.find(layer => layer.id === 'hole');
    hole.locked = false;
    notifyLayerLockChanged(app, 'hole', false);
    assert.equal(select.value, 'hole', 'Unlocking one valid layer recovers the existing dropdown immediately');
    assert.equal(select.disabled, false);
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
    const previousForm = html;
    hole.locked = true;
    notifyLayerLockChanged(app, 'hole', true);
    assert.equal(html, previousForm, 'Inactive drawing controls are not rebuilt as a new shape tool');
} finally {
    PCB_LAYERS.forEach((layer, index) => { layer.locked = locks[index]; });
}
console.log('PASS unlocked shape defaults, all-locked blocking, live recovery and completed shape/history layer parity');
