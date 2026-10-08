import assert from 'node:assert/strict';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';
import { serializeGridSettings, restoreGridSettings, bindViewportControls, updateGridDropdown, syncGridSettings } from '../../src/shared/ui/viewport.js';
import { Viewport } from '../../src/core/Viewport.js';
import { snapToGridLines } from '../../src/core/grid-snap.js';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { defaultPcbStackup } from '../../src/core/project-format.js';

const document = installFakeDom();
globalThis.requestAnimationFrame = callback => { callback(); return 1; };
document.getElementById = () => ({ addEventListener() {} });
document.querySelectorAll = () => [];
document.createElement = tag => Object.assign(fakeElement(tag), { tag });

function control() {
    const handlers = new Map();
    return {
        value: '', checked: true, disabled: false, children: [],
        get options() { return this.children; },
        set innerHTML(value) { this.children = []; },
        appendChild(option) { this.children.push(option); },
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
            getGridOptions: Viewport.prototype.getGridOptions,
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
    assert.deepEqual(serializeGridSettings(recovered.viewport), { ...saved, gridSize: 0.254 },
        'Non-preset saved grids select the nearest fixed preset');
    assert.equal(recovered.ui.gridSize.value, '0.254');
    assert.equal(recovered.ui.gridSize.options.length, 6, 'Loading never appends a custom option');
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

const metricValues = [0.1, 0.25, 0.5, 1];
const inchValues = [0.0254, 0.127, 0.254, 0.635, 1.27, 2.54];
const fixed = editor();
updateGridDropdown(fixed);
assert.ok(fixed.ui.gridSize.children.every(child => child.tag === 'option'), 'No named group headings');
assert.deepEqual(fixed.ui.gridSize.options.slice(0, 4).map(option => Number(option.value)), metricValues);
const separator = fixed.ui.gridSize.options[4];
assert.equal(separator.disabled, true, 'The separator bar is not selectable');
assert.equal(separator.value, '');
assert.match(separator.textContent, /^\u2500+$/);
assert.deepEqual(fixed.ui.gridSize.options.slice(5).map(option => Number(option.value)), inchValues);
assert.deepEqual(fixed.ui.gridSize.options.slice(5).map(option => option.textContent),
    ['0.0254 mm (0.001" / 1 mil)', '0.127 mm (0.005" / 5 mil)', '0.254 mm (0.01" / 10 mil)',
        '0.635 mm (0.025" / 25 mil)', '1.27 mm (0.05" / 50 mil)', '2.54 mm (0.1" / 100 mil)']);
for (const size of inchValues) {
    fixed.viewport.gridSize = size;
    for (const units of ['inch', 'mm', 'inch', 'mm']) {
        fixed.viewport.units = units;
        updateGridDropdown(fixed);
        assert.equal(fixed.viewport.gridSize, size, 'Every inch preset has an exact metric counterpart');
        assert.equal(fixed.ui.gridSize.value, String(size));
        assert.equal(fixed.ui.gridSize.options.filter(option => option.disabled).length, units === 'inch' ? 0 : 1);
        assert.deepEqual(fixed.ui.gridSize.options.filter(option => !option.disabled).map(option => Number(option.value)),
            units === 'inch' ? inchValues : [...metricValues, ...inchValues], 'Options do not depend on the current grid');
    }
}
for (const [units, value, expected] of [
    ['mm', 0.375, 0.254], ['inch', 0.375, 0.254], ['mm', 0.123456, 0.127],
    ['mm', 0.0001, 0.0254], ['mm', 999, 2.54], ['mm', 0.75, 0.635],
]) {
    fixed.viewport.units = units;
    restoreGridSettings(fixed, { gridSize: value });
    assert.equal(fixed.viewport.gridSize, expected);
    assert.equal(fixed.ui.gridSize.options.length, units === 'inch' ? 6 : 11);
}
fixed.viewport.gridSize = 0.635;
fixed.viewport.setGridSize = () => assert.fail('Refreshing an exact preset must not trigger another grid redraw');
updateGridDropdown(fixed);
const withoutControls = editor();
delete withoutControls.ui;
restoreGridSettings(withoutControls, { gridSize: 0.375, units: 'mm' });
assert.equal(withoutControls.viewport.gridSize, 0.254, 'Preset normalization does not depend on controls existing');

const app = editor();
let dirtyChanges = 0;
app.fileManager = { setDirty(value) { assert.equal(value, true); dirtyChanges++; } };
app.updateGridDropdown = () => updateGridDropdown(app);
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
    gridSize: 0.635, gridStyle: 'dots', units: 'inch', gridVisible: false, snapToGrid: false,
});
for (const size of inchValues) {
    app.viewport.gridSize = size;
    app.ui.units.value = 'mm';
    app.ui.units.change();
    assert.equal(app.viewport.gridSize, size, 'The schematic unit control retains every inch grid in metric mode');
    app.ui.units.value = 'inch';
    app.ui.units.change();
    assert.equal(app.viewport.gridSize, size);
}

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

const { bindPcbControls } = await import('../../src/pcb/modules/controls.js');
const { pcbEditorFixture } = await import('./pcb-editor-fixture.mjs');
let creations = 0;
class TestViewport {
    constructor() {
        creations++;
        Object.assign(this, editor().viewport);
        this.svg = { addEventListener() {}, style: {} };
    }
    updateTheme() {}
    hideCrosshair() {}
}
/** A real PCB editor with a headless viewport and the canvas wiring it does not need. */
function attachedEditor(pcbDocument, markDirty) {
    return pcbEditorFixture({ pcbDocument, viewport: null, canvasContainer: {},
        createViewport: () => new TestViewport(),
        bindMouseEvents() {}, updateViewportStatus() {},
        markDirty });
}
for (const controlsFirst of [true, false]) {
    const controls = new Map(['pcbGridSize', 'pcbGridStyle', 'pcbUnits', 'pcbShowGrid', 'pcbSnapToGrid']
        .map(id => [id, control()]));
    document.getElementById = id => controls.get(id) || null;
    document.addEventListener = () => {};
    const pcbDocument = new PcbDocument();
    const settings = { gridSize: 0.123456, gridStyle: 'dots', units: 'inch', gridVisible: false, snapToGrid: false };
    pcbDocument.load({ stackup: defaultPcbStackup(), settings });
    let dirty = 0;
    const attached = attachedEditor(pcbDocument, () => { dirty++; });
    if (controlsFirst) bindPcbControls(attached);
    attached.ensureViewport();
    assert.deepEqual(serializeGridSettings(attached.viewport), { ...settings, gridSize: 0.127 },
        'The first viewport restores preferences and normalizes a custom grid to the nearest preset');
    if (!controlsFirst) {
        attached.viewport.gridSize = 0.635;
        bindPcbControls(attached);
    }
    if (!attached.ui) {
        attached.ui = {
            gridSize: controls.get('pcbGridSize'), gridStyle: controls.get('pcbGridStyle'),
            units: controls.get('pcbUnits'), showGrid: controls.get('pcbShowGrid'),
            snapToGrid: controls.get('pcbSnapToGrid'),
        };
        syncGridSettings(attached);
    }
    const expectedSize = controlsFirst ? 0.127 : 0.635;
    assert.equal(attached.ui.gridSize.value, String(expectedSize), 'Binding selects the current live preset');
    assert.equal(attached.ui.units.value, 'inch');
    assert.equal(attached.ui.gridStyle.value, 'dots');
    assert.equal(attached.ui.showGrid.checked, false);
    assert.equal(attached.ui.snapToGrid.checked, false);
    assert.equal(attached.ui.snapToGrid.disabled, true);
    const count = creations;
    attached.viewport.gridSize = 0.254;
    attached.ensureViewport();
    assert.equal(creations, count);
    assert.equal(attached.viewport.gridSize, 0.254, 'Repeated ensure calls do not overwrite subsequent live edits');
    assert.deepEqual(pcbDocument.settings, settings, 'Restoring controls does not mutate the loaded preference snapshot');
    assert.equal(dirty, 0, 'View attachment is not a user edit');
}
console.log('PASS preloaded PCB viewport settings and control synchronization in either initialization order');

for (const [id, property, value, field] of [
    ['pcbGridSize', 'value', '0.5', 'gridSize'],
    ['pcbGridStyle', 'value', 'dots', 'gridStyle'],
    ['pcbUnits', 'value', 'inch', 'units'],
    ['pcbShowGrid', 'checked', false, 'gridVisible'],
    ['pcbSnapToGrid', 'checked', true, 'snapToGrid'],
]) {
    const controls = new Map(['pcbGridSize', 'pcbGridStyle', 'pcbUnits', 'pcbShowGrid', 'pcbSnapToGrid']
        .map(id => [id, control()]));
    document.getElementById = id => controls.get(id) || null;
    const pcbDocument = new PcbDocument();
    pcbDocument.load({ stackup: defaultPcbStackup(),
        settings: { gridSize: 0.123456, gridStyle: 'lines', units: 'mm', gridVisible: true, snapToGrid: false } });
    let dirty = 0;
    const attached = attachedEditor(pcbDocument, () => { dirty++; });
    bindPcbControls(attached);
    if (!attached.ui) {
        const ensure = () => { attached.ensureViewport(); return attached.viewport; };
        controls.get('pcbGridSize').addEventListener('change', e => { ensure().setGridSize(parseFloat(e.target.value)); dirty++; });
        controls.get('pcbGridStyle').addEventListener('change', e => { ensure().setGridStyle(e.target.value); dirty++; });
        controls.get('pcbUnits').addEventListener('change', e => { ensure().setUnits(e.target.value); dirty++; });
        controls.get('pcbShowGrid').addEventListener('change', e => { ensure().setGridVisible(e.target.checked); dirty++; });
        controls.get('pcbSnapToGrid').addEventListener('change', e => { ensure().snapToGrid = e.target.checked; dirty++; });
    }
    const target = controls.get(id);
    target[property] = value;
    target.change();
    assert.equal(attached.viewport[field], field === 'gridSize' ? Number(value) : value,
        'A user change that creates the first viewport must win over restored preferences');
    assert.equal(target[property], value, 'Controls must still display the committed user change');
    assert.equal(dirty, 1);
}
console.log('PASS initial grid-control edits survive lazy viewport restoration');