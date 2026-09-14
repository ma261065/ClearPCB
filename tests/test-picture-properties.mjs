import assert from 'node:assert/strict';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { pictureShape } from '../src/pcb/modules/picture-raster.js';

const fields = new Map();
const items = { html: '', set innerHTML(html) {
    this.html = html;
    fields.clear();
    for (const match of html.matchAll(/id="([^"]+)"/g)) {
        const listeners = new Map();
        fields.set(match[1], { value: '',
            get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); },
            addEventListener(name, listener) {
                if (!listeners.has(name)) listeners.set(name, []);
                listeners.get(name).push(listener);
            },
            input(value) { this.value = value; for (const listener of listeners.get('input') || []) listener(); },
            change(value) { this.value = value; for (const listener of listeners.get('change') || []) listener(); } });
    }
} };
globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById(id) { return fields.get(id) || null; }, createElementNS() {
    const attributes = new Map();
    return { style: {}, setAttribute(name, value) { attributes.set(name, value); }, getAttribute(name) { return attributes.get(name); },
        removeAttribute(name) { attributes.delete(name); }, appendChild() {}, remove() {}, querySelectorAll() { return []; } };
} };
const { showBoardShapeProperties, cloneShapeGeometry, createBoardShapeSelectionAdapter } = await import('../src/pcb/modules/board-shapes.js');
const { setPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const image = { ...pictureShape({ width: 4, height: 2, rectangles: [{ x: 0, y: 0, width: 1, height: 2 }] },
    { widthMm: 4, layer: 'top-silk' }), id: 'pshape_1' };
const app = { boardShapes: [image], placements: new Map(), tracks: [], vias: [], texts: new Map(),
    _shapeElements: new Map(), _getLayerGroup() { return null; }, viewport: { scale: 10, setCrosshair() {}, hideCrosshair() {} },
    history: new CommandHistory(), _pcbPropsItems() { return items; }, _snapToGrid(point) { return point; } };
setPcbSelection(app, [{ kind: 'shape', object: image }]);
showBoardShapeProperties(app, image);
assert.ok(fields.has('pcbPropImageWidth'));
assert.ok(!items.html.includes('Corner Radius') && !items.html.includes('Line Thickness'));
const before = cloneShapeGeometry(image);
app.netlist = [{ net: 'GND' }, { net: 'VCC' }, { net: 'GND' }, { net: 'A<&"' }];
fields.get('pcbPropImageWidth').change('8');
assert.equal(image.points[1].x - image.points[0].x, 8);
assert.equal(image.points[3].y - image.points[0].y, 4);
assert.equal(app.history.undoStack.length, 1);
app.history.undo();
assert.deepEqual(cloneShapeGeometry(image), before);
app.history.redo();
fields.get('pcbPropImageHeight').change('2');
assert.deepEqual(cloneShapeGeometry(image), before);
fields.get('pcbPropImageLayer').change('bottom-copper');
assert.equal(image.layer, 'bottom-copper');
assert.ok(items.html.includes('<select id="pcbPropImageNet">'));
assert.ok(items.html.includes('<option value="">Unassigned</option>'));
assert.equal(items.html.match(/<option value="GND">/g).length, 1);
assert.ok(items.html.includes('<option value="VCC">VCC</option>'));
assert.ok(items.html.includes('<option value="A&lt;&amp;&quot;">A&lt;&amp;&quot;</option>'));
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
const artwork = image.artwork;
assert.ok(items.html.includes('id="pcbPropImageRot" type="number" step="15"'));
fields.get('pcbPropImageRot').change('90');
assert.ok(Math.abs(image.points[0].x + 1) < 1e-9);
assert.ok(Math.abs(image.points[0].y - 2) < 1e-9, 'Positive rotation matches text counterclockwise convention');
assert.ok(Math.abs(Math.hypot(image.points[1].x - image.points[0].x, image.points[1].y - image.points[0].y) - 4) < 1e-9);
assert.ok(Math.abs(image.points[0].x + image.points[2].x) < 1e-9, 'Centre stays fixed');
assert.equal(image.artwork, artwork);
app.history.undo();
assert.deepEqual(cloneShapeGeometry(image), before);
app.history.redo();
assert.ok(items.html.includes('value="90"'));
fields.get('pcbPropImageRot').change('-15');
assert.ok(items.html.includes('value="345"'));
fields.get('pcbPropImageRot').change('375');
assert.ok(items.html.includes('value="15"'));
const rotated = cloneShapeGeometry(image);
fields.get('pcbPropImageRot').change('');
assert.deepEqual(cloneShapeGeometry(image), rotated);
console.log('PASS image rotation spinner, text-compatible direction, angle wrapping and undo/redo');
const spinner = fields.get('pcbPropImageRot');
const historyDepth = app.history.undoStack.length;
for (const angle of [30, 45, 60, 90, 345, 360, 15, 0, -15, 360, 375]) {
    spinner.input(String(angle));
    const actual = -Math.atan2(image.points[1].y - image.points[0].y,
        image.points[1].x - image.points[0].x) * 180 / Math.PI;
    const wrapped = ((angle % 360) + 360) % 360;
    const difference = ((actual - wrapped + 180) % 360 + 360) % 360 - 180;
    assert.ok(Math.abs(difference) < 1e-9, 'Input previews the absolute angle immediately');
    assert.equal(spinner.value, String(wrapped), 'Displayed angle wraps immediately like text');
    assert.equal(fields.get('pcbPropImageRot'), spinner, 'Live preview preserves the held spinner');
    assert.equal(app.history.undoStack.length, historyDepth, 'Preview does not create undo entries');
}
assert.equal(spinner.value, '15');
spinner.input('60');
spinner.change('60');
const finalRotation = cloneShapeGeometry(image);
assert.equal(app.history.undoStack.length, historyDepth + 1);
app.history.undo();
assert.deepEqual(cloneShapeGeometry(image), rotated, 'Undo restores geometry before the entire spinner edit');
app.history.redo();
assert.deepEqual(cloneShapeGeometry(image), finalRotation);
console.log('PASS live image rotation preserves spinner and commits a single undo entry');
for (const [layer, label] of [['top-document', 'Top Document'], ['bottom-document', 'Bottom Document']]) {
    assert.ok(items.html.includes(`<option value="${layer}">${label}</option>`));
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
let hatchRefreshes = 0;
app._hasCopperCuts = true;
app._updateCopperCuts = () => { copperCutRefreshes++; };
app._scheduleRemovalHatchRender = () => { hatchRefreshes++; };
app._refreshFills = () => { fillRefreshes++; };
app._updateRatsnest = () => { ratsnestRefreshes++; };
for (let step = 1; step <= 20; step++) fields.get('pcbPropImageWidth').change(String(4 + step / 10));
fields.get('pcbPropImageRot').input('90');
fields.get('pcbPropImageRot').change('90');
assert.equal(fillRefreshes, 0, 'Silk spinner edits do not recompute copper pours');
assert.equal(ratsnestRefreshes, 0, 'Silk spinner edits do not rebuild copper connectivity');
assert.equal(copperCutRefreshes, 0, 'Silk spinner edits do not rebuild board-wide copper clipping');
assert.equal(hatchRefreshes, 0, 'Silk spinner edits do not redraw copper-removal hatching');
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
app._refreshBoardShapeClearance = shape => {
    if (app._pictureCopperRefreshPending && app._pendingShapeClearances?.has(shape.id)) return;
    imageClearanceRefreshes++;
};
app._updateRatsnest = options => {
    ratsnestRefreshes++;
};
const cutsBeforeBurst = copperCutRefreshes;
const hatchesBeforeBurst = hatchRefreshes;
try {
    globalThis.setTimeout = (callback, delay) => {
        assert.equal(delay, 100);
        pendingCopper.set(++copperTimerId, callback);
        return copperTimerId;
    };
    globalThis.clearTimeout = id => { pendingCopper.delete(id); };
    for (const [id, pairedId, edge] of [
        ['pcbPropImageWidth', 'pcbPropImageHeight', 1],
        ['pcbPropImageHeight', 'pcbPropImageWidth', 3],
    ]) {
        const spinner = fields.get(id);
        const original = cloneShapeGeometry(image);
        const dimension = Math.hypot(image.points[edge].x - image.points[0].x, image.points[edge].y - image.points[0].y);
        const historySize = app.history.undoStack.length;
        const halo = { parentNode: { removeChild(child) { child.parentNode = null; } } };
        app._boardShapeClearanceCache = new Map([[image.id, { elements: [halo] }]]);
        for (const factor of [1.1, 1.2, 1.3]) {
            spinner.input(String(dimension * factor));
            const actual = Math.hypot(image.points[edge].x - image.points[0].x, image.points[edge].y - image.points[0].y);
            assert.ok(Math.abs(actual - dimension * factor) < 1e-9, 'Held spinner previews absolute size without compounding');
            assert.equal(fields.get(id), spinner, 'Live resizing preserves the held input');
            assert.match(fields.get(pairedId).value, /^\d+\.\d{2}$/, 'Paired dimension updates with two decimals');
            assert.equal(app.history.undoStack.length, historySize);
            assert.equal(halo.parentNode, null, 'Live resizing hides clearance immediately');
            assert.equal(pendingCopper.size, 1);
        }
        spinner.change(String(dimension * 1.3));
        assert.equal(app.history.undoStack.length, historySize + 1);
        const resized = cloneShapeGeometry(image);
        app.history.undo();
        assert.deepEqual(cloneShapeGeometry(image), original);
        app.history.redo();
        assert.deepEqual(cloneShapeGeometry(image), resized);
        app.history.undo();
    }
    for (let step = 1; step <= 20; step++) fields.get('pcbPropImageWidth').change(String(6 + step / 10));
    fields.get('pcbPropImageRot').input('105');
    fields.get('pcbPropImageRot').change('105');
    app.history.undo();
    assert.equal(fillRefreshes, 3, 'Copper spinner clicks and undo do not pour synchronously');
    assert.equal(ratsnestRefreshes, 3, 'Copper spinner clicks and undo do not reconcile synchronously');
    assert.equal(imageClearanceRefreshes, 0, 'Width, rotation and undo do not calculate image clearance before the debounce');
    assert.equal(copperCutRefreshes, cutsBeforeBurst, 'Additive copper image edits do not rebuild unrelated copper cuts');
    assert.equal(hatchRefreshes, hatchesBeforeBurst, 'Additive copper image edits do not rebuild unrelated removal hatching');
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