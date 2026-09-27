import assert from 'node:assert/strict';
import { serializeGridSettings, restoreGridSettings, bindViewportControls } from '../src/ui/modules/viewport.js';
import { Viewport } from '../src/core/Viewport.js';
import { snapToGridLines } from '../src/core/grid-snap.js';

globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById() { return { addEventListener() {} }; },
    createElement() { return {}; },
};

function control() {
    const handlers = new Map();
    return {
        value: '', checked: true, disabled: false, options: [],
        set innerHTML(value) { this.options = []; },
        appendChild(option) { this.options.push(option); },
        addEventListener(event, handler) { handlers.set(event, handler); },
        change() { handlers.get('change')({ target: this }); },
    };
}

function editor() {
    return {
        viewport: {
            gridSize: 1.27, gridStyle: 'lines', gridVisible: true, snapToGrid: true, units: 'mm',
            setGridSize(value) { this.gridSize = value; },
            setGridStyle(value) { this.gridStyle = value; },
            setGridVisible(value) { this.gridVisible = value; },
            setUnits(value) { this.units = value; },
            getGridOptions() { return [{ value: 1.27, label: '1.27 mm' }, { value: 2.54, label: '2.54 mm' }]; },
        },
        ui: Object.fromEntries(['gridSize', 'gridStyle', 'showGrid', 'snapToGrid', 'units'].map(key => [key, control()])),
    };
}

for (const visible of [true, false]) {
    const source = editor();
    Object.assign(source.viewport, { gridSize: 0.375, gridStyle: 'dots', gridVisible: visible, snapToGrid: false, units: 'inch' });
    const saved = JSON.parse(JSON.stringify(serializeGridSettings(source.viewport)));
    const recovered = editor();
    restoreGridSettings(recovered, saved);
    assert.deepEqual(serializeGridSettings(recovered.viewport), saved);
    assert.equal(recovered.ui.gridSize.value, '0.375');
    assert.equal(recovered.ui.gridStyle.value, 'dots');
    assert.equal(recovered.ui.units.value, 'inch');
    assert.equal(recovered.ui.showGrid.checked, visible);
    assert.equal(recovered.ui.snapToGrid.checked, false);
    assert.equal(recovered.ui.snapToGrid.disabled, !visible);
}
const legacy = editor();
const defaults = serializeGridSettings(legacy.viewport);
restoreGridSettings(legacy, undefined);
assert.deepEqual(serializeGridSettings(legacy.viewport), defaults);
restoreGridSettings(legacy, { gridSize: -1, units: 'invalid', gridStyle: 'invalid' });
assert.deepEqual(serializeGridSettings(legacy.viewport), defaults);
restoreGridSettings(legacy, { gridVisible: false, snapToGrid: true });
assert.equal(legacy.viewport.snapToGrid, false);

const app = editor();
let dirtyChanges = 0;
app.fileManager = { setDirty(value) { assert.equal(value, true); dirtyChanges++; } };
app._updateGridDropdown = () => {};
bindViewportControls(app);
app.ui.gridSize.value = '0.5';
app.ui.gridSize.change();
app.ui.gridStyle.value = 'dots';
app.ui.gridStyle.change();
app.ui.units.value = 'inch';
app.ui.units.change();
app.ui.snapToGrid.checked = false;
app.ui.snapToGrid.change();
app.ui.showGrid.checked = false;
app.ui.showGrid.change();
assert.equal(dirtyChanges, 5);
assert.deepEqual(serializeGridSettings(app.viewport), {
    gridSize: 0.5, gridStyle: 'dots', units: 'inch', gridVisible: false, snapToGrid: false,
});

const magnetViewport = {
    snapToGrid: true, gridVisible: true, shiftHeld: false, gridSize: 1, scale: 4,
    getEffectiveGridSize() { return 10; },
};
const snap = point => Viewport.prototype.getSnappedPosition.call(magnetViewport, point);
assert.deepEqual(snap({ x: 4, y: 6 }), { x: 4, y: 6 }, 'Move freely between visible grid lines');
assert.deepEqual(snap({ x: 1.5, y: 6 }), { x: 0, y: 6 }, 'Only X sticks near a vertical grid line');
assert.deepEqual(snap({ x: 4, y: 8.5 }), { x: 4, y: 10 }, 'Only Y sticks near a horizontal grid line');
assert.deepEqual(snap({ x: -1.5, y: -8.5 }), { x: -0, y: -10 }, 'Negative coordinates use the same magnet');
assert.deepEqual(snap({ x: 2, y: 8 }), { x: 0, y: 10 }, 'Eight screen pixels is inside the magnet');
assert.deepEqual(snap({ x: 2.01, y: 7.99 }), { x: 2.01, y: 7.99 }, 'Outside the magnet stays free');
assert.deepEqual(snap({ x: 3.1, y: 6.1 }), { x: 3.1, y: 6.1 }, 'Do not snap to invisible base-grid lines');
for (const scale of [1, 4, 20]) {
    magnetViewport.scale = scale;
    const point = { x: 7 / scale, y: 50 - 7 / scale };
    const result = snapToGridLines(point, 50, scale);
    assert.deepEqual(result, { x: 0, y: 50, snappedX: true, snappedY: true }, 'Magnet range is screen-based');
}
magnetViewport.scale = 4;
const closeToGrid = { x: 1, y: 9 };
magnetViewport.shiftHeld = true;
assert.deepEqual(snap(closeToGrid), closeToGrid, 'Shift releases the grid magnet');
magnetViewport.shiftHeld = false;
magnetViewport.snapToGrid = false;
assert.deepEqual(snap(closeToGrid), closeToGrid, 'Snap toggle disables the magnet');
magnetViewport.shiftHeld = true;
assert.deepEqual(snap(closeToGrid), { x: 0, y: 10 }, 'Shift retains the schematic temporary snap override');
magnetViewport.snapToGrid = true;
magnetViewport.shiftHeld = false;
magnetViewport.gridVisible = false;
assert.deepEqual(snap(closeToGrid), closeToGrid, 'Hidden grid does not attract movement');

console.log('PASS grid settings, screen-space grid magnet, controls, and autosave dirtiness');