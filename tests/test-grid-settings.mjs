import assert from 'node:assert/strict';
import { serializeGridSettings, restoreGridSettings, bindViewportControls } from '../src/ui/modules/viewport.js';

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

console.log('PASS grid settings round-trip, exact custom spacing, controls, legacy defaults, and autosave dirtiness');