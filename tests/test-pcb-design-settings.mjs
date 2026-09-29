import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PcbDesignSettings } from '../src/core/PcbDesignSettings.js';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { defaultPcbStackup } from '../src/core/project-format.js';
import { formatNumberInput } from '../src/core/number-inputs.js';

assert.equal(typeof document, 'undefined');
const model = new PcbDesignSettings();
const precise = { trackWidth: 0.2, clearance: 0.1234, viaDiameter: 0.6, viaDrill: 0.3,
    units: 'mm', router: 'pathfinder' };
const expectedRouting = { trackWidth: 0.2, clearance: 0.1234, viaDiameter: 0.6, viaDrill: 0.3 };
model.update(precise);
const copy = model.values;
copy.trackWidth = 999;
assert.deepEqual(model.serialize(), precise);
for (const value of [0, -1, Infinity, NaN]) {
    assert.throws(() => model.update({ clearance: value }), /positive finite/);
    assert.deepEqual(model.values, precise, 'Invalid changes cannot partially overwrite settings');
}
assert.throws(() => model.update({ units: 'unknown' }), /units/);
assert.throws(() => model.update({ router: 'unknown' }), /router/);
model.update({ clearance: 0.123456 });
assert.equal(model.serialize().clearance, 0.1235);
assert.equal(model.getRoutingParams().clearance, 0.123456, 'File rounding does not change routing precision');

globalThis.window = { addEventListener() {} };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { bindPcbControls } = await import('../src/pcb/modules/controls.js');
const { serializePcb, preparePcb } = await import('../src/pcb/modules/project-state.js');
const { refreshDesignSettings } = await import('../src/pcb/modules/design-settings.js');
const { normalizePcbSection } = await import('../src/core/project-field-aliases.js');
const ids = ['pcbTrackWidth', 'pcbClearance', 'pcbViaDiameter', 'pcbViaDrill'];
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const storage = new Map();
globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
};
function inputElement(value = '') {
    const handlers = new Map();
    return { value, dataset: { numberFormat: 'precise' }, validationMessage: '', reports: 0,
        matches: () => true, get valueAsNumber() { return Number(this.value); },
        get validity() { return { customError: !!this.validationMessage }; },
        addEventListener(event, handler) { handlers.set(event, handler); },
        setCustomValidity(message) { this.validationMessage = message; },
        reportValidity() { this.reports++; },
        fire(event) { handlers.get(event)?.(); },
    };
}
function fixture() {
    const elements = new Map([...ids, 'pcbRouteUnits', 'pcbRouterMode'].map(id =>
        [id, inputElement(id === 'pcbRouteUnits' ? 'mm' : id === 'pcbRouterMode' ? 'maze' : '')]));
    globalThis.document = { getElementById: id => elements.get(id) || null,
        addEventListener() {}, querySelectorAll: () => [] };
    const project = new ProjectDocument();
    const app = new PCBApp(project);
    const changes = { dirty: 0, fills: 0, halos: 0, board3d: 0 };
    app._markDirty = () => { changes.dirty++; };
    app._refreshFills = () => { changes.fills++; };
    app.showClearances = () => { changes.halos++; };
    app._clearancesVisible = true;
    app._board3d = { refresh() { changes.board3d++; } };
    bindPcbControls(app);
    assert.equal(app.designSettings, project.pcbDocument.designSettings);
    return { app, changes, elements };
}
const { app, changes, elements } = fixture();
for (const id of ids) {
    const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))[0];
    assert.match(tag, /data-number-format="precise"/, 'Design fields opt out of shared two-decimal formatting');
    elements.get(id).value = '0.1234';
    formatNumberInput(elements.get(id));
    assert.equal(elements.get(id).value, '0.1234');
}
app.pcbDocument.load({ stackup: defaultPcbStackup(), design: precise });
refreshDesignSettings(app);
assert.equal(elements.get('pcbClearance').value, '0.123', 'Existing display precision is preserved');
assert.equal(app._getRoutingParams().clearance, 0.1234, 'Routing uses exact loaded data, not displayed text');
assert.equal(changes.dirty, 0, 'Loading is not an edit');
const updateDesign = app.designSettings.update;
app.designSettings.update = () => assert.fail('Presentation refresh must not adopt or rewrite model data');
refreshDesignSettings(app);
app.designSettings.update = updateDesign;
assert.equal(elements.get('pcbClearance').value, '0.123');
assert.deepEqual(JSON.parse(storage.get('clearpcb_pcb_design_params')), precise,
    'Post-load presentation keeps exact settings as local defaults');
assert.deepEqual(changes, { dirty: 0, fills: 0, halos: 0, board3d: 0 });
const lookup = document.getElementById;
document.getElementById = () => assert.fail('Routing and serialization must not read the DOM');
assert.deepEqual(app._getRoutingParams(), expectedRouting);
assert.equal(app._getRouterMode(), 'pathfinder');
assert.deepEqual(normalizePcbSection(serializePcb(app)).design, precise);
document.getElementById = lookup;
for (let count = 0; count < 50; count++) {
    for (const unit of ['inch', 'mm']) {
        elements.get('pcbRouteUnits').value = unit;
        elements.get('pcbRouteUnits').fire('change');
        assert.deepEqual(app._getRoutingParams(), expectedRouting);
    }
}
assert.deepEqual(normalizePcbSection(serializePcb(app)).design, precise, 'Repeated display conversions cannot change saved design rules');
assert.equal(changes.dirty, 100, 'Display preferences are persisted project edits');
assert.equal(changes.fills, 0, 'Unit conversion does not alter or recompute geometry');
elements.get('pcbRouteUnits').fire('change');
assert.equal(changes.dirty, 100, 'No-op preference changes do not dirty the document');
const field = elements.get('pcbTrackWidth');
for (const invalid of ['', '0', '-1', 'Infinity', 'abc']) {
    field.value = invalid;
    field.fire('input');
    field.fire('change');
    assert.match(field.validationMessage, /positive finite/);
    assert.equal(app._getRoutingParams().trackWidth, 0.2);
    assert.equal(changes.dirty, 100);
}
assert.equal(field.reports, 5);
field.value = '0.2345';
field.fire('input');
assert.equal(field.validationMessage, '');
assert.equal(app._getRoutingParams().trackWidth, 0.2345);
assert.deepEqual(changes, { dirty: 101, fills: 1, halos: 1, board3d: 1 });
elements.get('pcbRouterMode').value = 'maze';
elements.get('pcbRouterMode').fire('change');
assert.equal(app._getRouterMode(), 'maze');
assert.equal(changes.dirty, 102);
app.pcbDocument.load({ stackup: defaultPcbStackup(), design: { ...precise, units: 'inch' } });
refreshDesignSettings(app);
assert.equal(elements.get('pcbTrackWidth').value, '0.0079');
assert.equal(app._getRoutingParams().trackWidth, 0.2, 'Loading inch display must not change 0.2 mm to 0.20066 mm');
assert.equal(changes.dirty, 102);
assert.deepEqual(fixture().app.designSettings.values, { ...precise, units: 'inch' },
    'Canonical defaults retain precision across startup');
storage.set('clearpcb_pcb_design_params', JSON.stringify({ units: 'inch', router: 'maze',
    pcbTrackWidth: '0.01', pcbClearance: '0.005', pcbViaDiameter: '0.02', pcbViaDrill: '0.01' }));
const legacy = fixture().app;
assert.equal(legacy._getRoutingParams().trackWidth, 0.254, 'Legacy display-unit defaults remain readable');
assert.throws(() => preparePcb({ ...serializePcb(legacy), design: { ...precise, clearance: 0 } }), /positive finite/);
console.log('PASS canonical PCB design settings, load/save/unit precision, legacy defaults, validation and dirty/refresh routing');

const { app: tools, elements: ribbon } = fixture();
tools.pcbDocument.load({ stackup: defaultPcbStackup(), design: { ...precise, units: 'inch' } });
refreshDesignSettings(tools);
const width = inputElement('0.2'), diameter = inputElement('0.6'), drill = inputElement('0.3');
const toolInputs = new Map([['#pcbPropTrackToolWidth', width],
    ['#pcbPropViaToolDiameter', diameter], ['#pcbPropViaToolDrill', drill]]);
const panel = { innerHTML: '', querySelector: id => toolInputs.get(id) || null };
tools._pcbPropsItems = () => panel;
tools._setPcbPropsTitle = tools._setPcbStatus = tools._setActiveRibbonTab = tools._bindToolNetControl = () => {};
tools._toolNetOptions = () => ({ escape: value => value, options: '' });
tools._showTrackDrawProperties();
assert.match(panel.innerHTML, /pcbPropTrackToolWidth[^>]*data-number-format="precise"/);
width.value = '0.45';
width.fire('input');
assert.equal(tools._getRoutingParams().trackWidth, 0.45);
assert.equal(ribbon.get('pcbTrackWidth').value, '0.0177', 'Millimetre tool edits render correctly in an inch ribbon');
tools._showViaToolProperties();
diameter.value = '0.8';
diameter.fire('input');
drill.value = '0.4';
drill.fire('input');
assert.equal(tools._getRoutingParams().viaDiameter, 0.8);
assert.equal(tools._getRoutingParams().viaDrill, 0.4);
assert.equal(ribbon.get('pcbViaDrill').value, '0.0157');
drill.value = '1.2';
drill.fire('input');
assert.equal(tools._getRoutingParams().viaDrill, 0.8, 'Via tool preserves its diameter/drill clamp');
diameter.value = '';
diameter.fire('input');
diameter.fire('change');
assert.equal(diameter.reports, 1);
assert.equal(tools._getRoutingParams().viaDiameter, 0.8);
console.log('PASS track/via tool editors share canonical millimetre state and field validation');
