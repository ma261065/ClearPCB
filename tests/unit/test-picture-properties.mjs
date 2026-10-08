import assert from 'node:assert/strict';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { pictureShape } from '../../src/shared/pcb/picture-raster.js';
import { isPictureCopperRefreshPending } from '../../src/pcb/modules/refresh-state.js';
import { flushSettledChanges } from '../../src/shared/ui/settled-input.js';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { clearanceOverlayState } from '../../src/pcb/modules/clearance-overlay.js';

installFakeDom();
const { renderPropertyFields, propertyField } = await import('../../src/shared/ui/property-fields.js');
const fields = new Map();
const items = document.body.appendChild(document.createElement('div'));
let currentPanel = null;
const syncPanel = panel => {
    currentPanel = panel;
    renderPropertyFields(items, panel.fields);
    fields.clear();
    for (const field of panel.fields) {
        const id = field.id || field.key;
        const control = document.getElementById(id);
        if (!control) continue;
        control.input = value => { control.value = String(value); control.dispatchEvent({ type: 'input' }); };
        control.keydown = key => control.dispatchEvent({ type: 'keydown', key, preventDefault() {}, stopPropagation() {} });
        control.toggle = checked => { control.checked = checked; control.dispatchEvent({ type: 'change' }); };
        control.change = value => { control.value = String(value); control.dispatchEvent({ type: 'change' }); };
        fields.set(id, control);
    }
};
const settleChange = (field, value) => {
    field.change(value);
    flushSettledChanges();
};
const { cloneShapeGeometry } = await import('../../src/core/pcb-board-shapes.js');
const { createBoardShapeSelectionAdapter } = await import('../../src/pcb/modules/board-shapes.js');
const { showBoardShapeProperties } = await import('../../src/pcb/modules/board-shape-properties.js');
const { setPcbSelection } = await import('../../src/pcb/modules/selection-registry.js');
const { copperCutState } = await import('../../src/pcb/modules/copper-cuts.js');
const image = { ...pictureShape({ width: 4, height: 2, rectangles: [{ x: 0, y: 0, width: 1, height: 2 }] },
    { widthMm: 4, layer: 'top-silk' }), id: 'pshape_1' };
const app = { boardShapes: [image], placements: new Map(), tracks: [], vias: [], texts: new Map(),
    _shapeElements: new Map(), getLayerGroup() { return null; }, viewport: { scale: 10, setCrosshair() {}, hideCrosshair() {} },
    history: new CommandHistory(), openPropertyPanel(panel) { syncPanel(panel); return true; },
    refreshPropertyPanel(panel) { syncPanel(panel); }, snapToGrid(point) { return point; } };
setPcbSelection(app, [{ kind: 'shape', object: image }]);
showBoardShapeProperties(app, image);
assert.ok(fields.has('pcbPropImageWidth'));
assert.equal(propertyField(currentPanel, 'cornerRadius'), null);
assert.equal(propertyField(currentPanel, 'lineWidth'), null);
const before = cloneShapeGeometry(image);
app.netlist = [{ net: 'GND' }, { net: 'VCC' }, { net: 'GND' }, { net: 'A<&"' }];
settleChange(fields.get('pcbPropImageWidth'), '8');
assert.equal(image.points[1].x - image.points[0].x, 8);
assert.equal(image.points[3].y - image.points[0].y, 4);
assert.equal(app.history.undoStack.length, 1);
app.history.undo();
assert.deepEqual(cloneShapeGeometry(image), before);
app.history.redo();
settleChange(fields.get('pcbPropImageHeight'), '2');
assert.deepEqual(cloneShapeGeometry(image), before);
fields.get('pcbPropImageLayer').change('bottom-copper');
assert.equal(image.layer, 'bottom-copper');
const imageNet = propertyField(currentPanel, 'net');
assert.equal(imageNet?.id, 'pcbPropImageNet');
assert.deepEqual(imageNet.options.map(option => option.value), ['', 'A<&"', 'GND', 'VCC']);
fields.get('pcbPropImageNet').change('GND');
assert.equal(image.net, 'GND');
assert.equal(fields.get('pcbPropImageNet').value, 'GND');
app.history.undo();
assert.equal(image.net, '');
app.history.undo();
assert.equal(image.layer, 'top-silk');
const adapter = createBoardShapeSelectionAdapter(app, image, 'shape:pshape_1');
adapter.beginMove({ x: 0, y: 0 });
adapter.updateMove({ x: 3, y: 5 });
adapter.endMove(true, { moved: true });
assert.deepEqual(image.points[0], { x: 1, y: 4 });
app.history.undo();
assert.deepEqual(cloneShapeGeometry(image), before);
adapter.beginAnchorDrag(2, image.points[2]);
adapter.updateAnchorDrag({ x: 6, y: 3 });
adapter.endAnchorDrag(true, { moved: true });
assert.deepEqual(image.points[2], { x: 6, y: 3 });
app.history.undo();
assert.deepEqual(cloneShapeGeometry(image), before);
console.log('PASS image Properties controls, proportional dimensions, layer/net changes, drag and resize undo');

// Locking from the panel sticks and makes the other controls read-only; unlocking reverses it.
{
    setPcbSelection(app, [{ kind: 'shape', object: image }]);
    showBoardShapeProperties(app, image);
    propertyField(currentPanel, 'locked').commit(true);
    assert.equal(image.locked, true);
    assert.equal(propertyField(currentPanel, 'locked').value, true, 'the Locked box stays ticked after the panel refreshes');
    assert.equal(propertyField(currentPanel, 'width').disabled, true, 'a locked picture is read-only');
    propertyField(currentPanel, 'locked').commit(false);
    assert.equal(image.locked, false);
    assert.equal(propertyField(currentPanel, 'width').disabled, false);
    app.history.undo();
    app.history.undo();
    showBoardShapeProperties(app, image);
}
const artwork = image.artwork;
assert.equal(propertyField(currentPanel, 'rotation')?.step, 1);
settleChange(fields.get('pcbPropImageRot'), '90');
assert.ok(Math.abs(image.points[0].x + 1) < 1e-9);
assert.ok(Math.abs(image.points[0].y - 2) < 1e-9, 'Positive rotation matches text counterclockwise convention');
assert.ok(Math.abs(Math.hypot(image.points[1].x - image.points[0].x, image.points[1].y - image.points[0].y) - 4) < 1e-9);
assert.ok(Math.abs(image.points[0].x + image.points[2].x) < 1e-9, 'Centre stays fixed');
assert.equal(image.artwork, artwork);
app.history.undo();
assert.deepEqual(cloneShapeGeometry(image), before);
app.history.redo();
assert.equal(fields.get('pcbPropImageRot').value, '90');
settleChange(fields.get('pcbPropImageRot'), '-15');
assert.equal(fields.get('pcbPropImageRot').value, '345');
settleChange(fields.get('pcbPropImageRot'), '375');
assert.equal(fields.get('pcbPropImageRot').value, '15');
const rotated = cloneShapeGeometry(image);
settleChange(fields.get('pcbPropImageRot'), '');
assert.deepEqual(cloneShapeGeometry(image), rotated);
console.log('PASS image rotation spinner, text-compatible direction, angle wrapping and undo/redo');
const spinner = fields.get('pcbPropImageRot');
const historyDepth = app.history.undoStack.length;
for (const angle of [30, 45, 60, 90, 345, 360, 15, 0, -15, 360, 375]) {
    spinner.input(String(angle));
    const displayed = adapter.object;
    const actual = -Math.atan2(displayed.points[1].y - displayed.points[0].y,
        displayed.points[1].x - displayed.points[0].x) * 180 / Math.PI;
    assert.deepEqual(cloneShapeGeometry(image), rotated, 'Rotation input preserves authored geometry');
    const wrapped = ((angle % 360) + 360) % 360;
    const difference = ((actual - wrapped + 180) % 360 + 360) % 360 - 180;
    assert.ok(Math.abs(difference) < 1e-9, 'Input previews the absolute angle immediately');
    assert.equal(spinner.value, String(wrapped), 'Displayed angle wraps immediately like text');
    assert.equal(fields.get('pcbPropImageRot'), spinner, 'Live preview preserves the held spinner');
    assert.equal(app.history.undoStack.length, historyDepth, 'Preview does not create undo entries');
}
assert.equal(spinner.value, '15');
spinner.input('60');
settleChange(spinner, '60');
const finalRotation = cloneShapeGeometry(image);
assert.equal(app.history.undoStack.length, historyDepth + 1);
app.history.undo();
assert.deepEqual(cloneShapeGeometry(image), rotated, 'Undo restores geometry before the entire spinner edit');
app.history.redo();
assert.deepEqual(cloneShapeGeometry(image), finalRotation);
console.log('PASS live image rotation preserves spinner and commits a single undo entry');
for (const [layer, label] of [['top-document', 'Top Document'], ['bottom-document', 'Bottom Document']]) {
    assert.ok(propertyField(currentPanel, 'layer').options.some(option => option.value === layer && option.label === label));
    const previousLayer = image.layer;
    fields.get('pcbPropImageLayer').change(layer);
    assert.equal(image.layer, layer);
    assert.ok(!fields.has('pcbPropImageNet'), 'Document-layer properties do not show a copper net control');
    app.history.undo();
    assert.equal(image.layer, previousLayer);
}
console.log('PASS document-layer image Properties choices and undo');
let fillRefreshes = 0;
let ratsnestRefreshes = 0;
let copperCutRefreshes = 0;
copperCutState(app).active = true;
app.updateCopperCuts = () => { copperCutRefreshes++; };
app.refreshFills = () => { fillRefreshes++; };
app.updateRatsnest = () => { ratsnestRefreshes++; };
for (let step = 1; step <= 20; step++) fields.get('pcbPropImageWidth').change(String(4 + step / 10));
flushSettledChanges();
fields.get('pcbPropImageRot').input('90');
settleChange(fields.get('pcbPropImageRot'), '90');
app.history.undo();
app.history.redo();
for (const [id, value] of [['pcbPropImageWidth', '12'], ['pcbPropImageHeight', '6'], ['pcbPropImageRot', '135']]) {
    const original = cloneShapeGeometry(image);
    const depth = app.history.undoStack.length;
    fields.get(id).input(value);
    assert.notDeepEqual(cloneShapeGeometry(adapter.object), original, 'Silk previews update the visible geometry');
    assert.deepEqual(cloneShapeGeometry(image), original, 'Silk previews preserve authored geometry');
    fields.get(id).keydown('Escape');
    assert.deepEqual(cloneShapeGeometry(image), original, 'Escape restores the silk preview');
    fields.get(id).input(value);
    settleChange(fields.get(id), '');
    assert.deepEqual(cloneShapeGeometry(image), original, 'An invalid edit restores the silk preview');
    assert.equal(app.history.undoStack.length, depth, 'Cancelled previews do not create history');
}
assert.equal(fillRefreshes, 0, 'Silk spinner edits do not recompute copper pours');
assert.equal(ratsnestRefreshes, 0, 'Silk spinner edits do not rebuild copper connectivity');
assert.equal(copperCutRefreshes, 0, 'Silk spinner edits do not rebuild board-wide copper clipping');
fields.get('pcbPropImageLayer').change('top-copper');
assert.equal(fillRefreshes, 1, 'Moving onto copper refreshes pours');
assert.equal(ratsnestRefreshes, 1);
fields.get('pcbPropImageLayer').change('top-document');
assert.equal(fillRefreshes, 2, 'Moving off copper refreshes pours');
assert.equal(ratsnestRefreshes, 2);
app.history.undo();
assert.equal(fillRefreshes, 3, 'Undoing a copper layer change refreshes pours');
assert.equal(ratsnestRefreshes, 3);
console.log('PASS non-copper image spinner edits skip copper work and layer transitions still refresh');
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const pendingCopper = new Map();
let copperTimerId = 0;
let imageClearanceRefreshes = 0;
const clearanceOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'g');
const clearanceLayer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
app.getLayerGroup = id => id === 'clearance-overlay' ? clearanceOverlay
    : id === image.layer ? clearanceLayer : null;
app.existingLayerGroups = () => new Map([['clearance-overlay', clearanceOverlay], [image.layer, clearanceLayer]]);
app.getRoutingParams = () => { imageClearanceRefreshes++; return { clearance: 0.25 }; };
clearanceOverlayState(app).clearancesVisible = true;
app.updateRatsnest = options => {
    ratsnestRefreshes++;
};
const cutsBeforeBurst = copperCutRefreshes;
try {
    const pendingSettle = new Map();
    globalThis.setTimeout = (callback, delay) => {
        if (delay === 100) {
            pendingCopper.set(++copperTimerId, callback);
            return copperTimerId;
        }
        assert.equal(delay, 400);
        const id = `settle-${++copperTimerId}`;
        pendingSettle.set(id, callback);
        return id;
    };
    globalThis.clearTimeout = id => { pendingCopper.delete(id); pendingSettle.delete(id); };
    for (const [id, pairedId, edge] of [
        ['pcbPropImageWidth', 'pcbPropImageHeight', 1],
        ['pcbPropImageHeight', 'pcbPropImageWidth', 3],
    ]) {
        const spinner = fields.get(id);
        const original = cloneShapeGeometry(image);
        const dimension = Math.hypot(image.points[edge].x - image.points[0].x, image.points[edge].y - image.points[0].y);
        const historySize = app.history.undoStack.length;
        const halo = { parentNode: { removeChild(child) { child.parentNode = null; } } };
        clearanceOverlayState(app).boardShapeClearanceCache = new Map([[image.id, { elements: [halo] }]]);
        for (const factor of [1.1, 1.2, 1.3]) {
            spinner.input(String(dimension * factor));
            const displayed = adapter.object;
            const actual = Math.hypot(displayed.points[edge].x - displayed.points[0].x, displayed.points[edge].y - displayed.points[0].y);
            assert.deepEqual(cloneShapeGeometry(image), original);
            assert.ok(Math.abs(actual - dimension * factor) < 1e-9, 'Held spinner previews absolute size without compounding');
            assert.equal(fields.get(id), spinner, 'Live resizing preserves the held input');
            assert.match(fields.get(pairedId).value, /^\d+\.\d{2}$/, 'Paired dimension updates with two decimals');
            assert.equal(app.history.undoStack.length, historySize);
            assert.equal(halo.parentNode, null, 'Live resizing hides clearance immediately');
            assert.equal(pendingCopper.size, 0, 'Typing retains settled pours until acceptance');
        }
        settleChange(spinner, String(dimension * 1.3));
        assert.equal(app.history.undoStack.length, historySize + 1);
        const resized = cloneShapeGeometry(image);
        app.history.undo();
        assert.deepEqual(cloneShapeGeometry(image), original);
        app.history.redo();
        assert.deepEqual(cloneShapeGeometry(image), resized);
        app.history.undo();
    }
    for (let step = 1; step <= 20; step++) fields.get('pcbPropImageWidth').change(String(6 + step / 10));
    flushSettledChanges();
    fields.get('pcbPropImageRot').input('105');
    settleChange(fields.get('pcbPropImageRot'), '105');
    app.history.undo();
    const beforeCancel = cloneShapeGeometry(image);
    const depthBeforeCancel = app.history.undoStack.length;
    fields.get('pcbPropImageWidth').input('12');
    fields.get('pcbPropImageWidth').keydown('Escape');
    assert.deepEqual(cloneShapeGeometry(image), beforeCancel, 'Copper preview cancellation restores geometry');
    assert.equal(app.history.undoStack.length, depthBeforeCancel);
    assert.equal(fillRefreshes, 3, 'Copper spinner clicks and undo do not pour synchronously');
    assert.equal(ratsnestRefreshes, 3, 'Copper spinner clicks and undo do not reconcile synchronously');
    assert.equal(imageClearanceRefreshes, 1, 'Cancellation immediately restores canonical clearance');
    assert.equal(copperCutRefreshes, cutsBeforeBurst, 'Additive copper image edits do not rebuild unrelated copper cuts');
    assert.equal(pendingCopper.size, 1, 'Copper spinner burst and undo share one pending refresh');
    const callbacks = [...pendingCopper.values()];
    pendingCopper.clear();
    callbacks.forEach(callback => callback());
    assert.equal(fillRefreshes, 4);
    assert.equal(ratsnestRefreshes, 4);
    assert.equal(imageClearanceRefreshes, 1, 'The deferred reconciliation refreshes clearance after the burst');
} finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
}
console.log('PASS copper image spinner burst and undo defer one derived refresh');
for (const [id, property] of [
    ['pcbPropImageInvert', 'invert'],
    ['pcbPropImageFlipHorizontal', 'flipHorizontal'],
    ['pcbPropImageFlipVertical', 'flipVertical'],
]) {
    const originalArtwork = image.artwork;
    const originalGeometry = cloneShapeGeometry(image);
    const depth = app.history.undoStack.length;
    assert.equal(fields.get(id).checked, false);
    fields.get(id).toggle(true);
    assert.equal(image.artwork[property], true);
    assert.notEqual(image.artwork, originalArtwork);
    assert.equal(image.artwork.rectangles, originalArtwork.rectangles);
    assert.equal(fields.get(id).checked, true);
    assert.equal(app.history.undoStack.length, depth + 1);
    assert.deepEqual(cloneShapeGeometry(image), originalGeometry);
    app.history.undo();
    assert.equal(image.artwork, originalArtwork);
    assert.equal(fields.get(id).checked, false);
    app.history.redo();
    assert.equal(fields.get(id).checked, true);
    fields.get(id).toggle(false);
    assert.equal(image.artwork[property], false);
}
console.log('PASS image invert and flip checkboxes, immutable artwork, stable bounds and undo/redo');