import assert from 'node:assert/strict';
import { PcbDesignSettings, viaDimensionError } from '../../src/core/PcbDesignSettings.js';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { ProjectDocument } from '../../src/core/ProjectDocument.js';
import { defaultPcbStackup } from '../../src/core/project-format.js';
import { formatNumberInput } from '../../src/core/number-inputs.js';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { showTrackDrawProperties } from '../../src/pcb/modules/track-draw.js';
import { showViaToolProperties } from '../../src/pcb/modules/via-tool.js';
import { setBoardViewPanel } from '../../src/pcb/modules/refresh-state.js';
import { clearanceOverlayState } from '../../src/pcb/modules/clearance-overlay.js';

assert.equal(typeof document, 'undefined');
const model = new PcbDesignSettings();
assert.equal(model.hasAppliedSettings, false);
assert.throws(() => model.update({ clearance: 0 }), /positive finite/);
assert.equal(model.hasAppliedSettings, false, 'Rejected settings must not suppress startup defaults');
const precise = { trackWidth: 0.2, clearance: 0.1234, viaDiameter: 0.6, viaDrill: 0.3,
    units: 'mm', router: 'pathfinder', excludeSameFootprintPadClearance: false };
const expectedRouting = { trackWidth: 0.2, clearance: 0.1234, viaDiameter: 0.6, viaDrill: 0.3 };
{
    const document = new PcbDocument();
    document.designSettings.update({ ...precise, excludeSameFootprintPadClearance: true });
    const loaded = new PcbDocument();
    loaded.load(document.serialize());
    assert.equal(loaded.designSettings.values.excludeSameFootprintPadClearance, true,
        'Project round trip preserves the exclusion');
    const legacyDesign = { ...precise };
    delete legacyDesign.excludeSameFootprintPadClearance;
    loaded.load({ stackup: defaultPcbStackup(), design: legacyDesign });
    assert.equal(loaded.designSettings.values.excludeSameFootprintPadClearance, false,
        'Older files do not inherit the previous project exclusion');
}
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
assert.throws(() => model.update({ excludeSameFootprintPadClearance: 'true' }), /boolean/);
for (const via of [
    { viaDiameter: 0.1, viaDrill: 0.7 },
    { viaDiameter: 0.3, viaDrill: 0.3 },
    { viaDiameter: 0.6, viaDrill: 0.55 },
]) {
    assert.throws(() => model.update(via), /Via Diameter must be at least/);
    assert.deepEqual(model.values, precise, 'Incompatible Via sizes cannot partially overwrite settings');
    assert.throws(() => new PcbDocument().load({ stackup: defaultPcbStackup(), design: { ...precise, ...via } }),
        /Via Diameter must be at least/, 'Loading invalid Via settings is rejected, not corrected');
}
assert.equal(viaDimensionError(0.8, 0.7), '', 'Exact minimum annular ring is allowed');
assert.match(viaDimensionError(0.7999, 0.7), /at least 0.800 mm/);
model.update({ clearance: 0.123456 });
assert.equal(model.serialize().clearance, 0.1235);
assert.equal(model.getRoutingParams().clearance, 0.123456, 'File rounding does not change routing precision');

const { default: PCBApp } = await import('../../src/ui/PCBApp.js');
const { bindPcbControls } = await import('../../src/pcb/modules/controls.js');
const { serializePcb, preparePcb } = await import('../../src/pcb/modules/project-state.js');
const { refreshDesignSettings, commitSameFootprintPadClearanceExclusion } = await import('../../src/pcb/modules/design-settings.js');
const { normalizePcbSection } = await import('../../src/core/project-field-aliases.js');
const ids = ['pcbTrackWidth', 'pcbClearance', 'pcbViaDiameter', 'pcbViaDrill'];
const storage = new Map();
globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
};
function addElement(id, tag = 'div') {
    const element = document.createElement(tag);
    element.id = id;
    document.body.appendChild(element);
    return element;
}

function fixture(prepareModel = () => {}) {
    installFakeDom();
    for (const id of ['ribbonPCB', 'pcbCanvasContainer', 'pcbCursorPos', 'pcbGridSnap',
        'pcbViewportInfo', 'pcbZoomPercent', 'pcbStatusTip', 'pcbModeStatus', 'pcbDocTitle']) {
        addElement(id);
    }
    const project = new ProjectDocument();
    prepareModel(project.pcbDocument);
    const app = new PCBApp(project);
    const changes = { dirty: 0, fills: 0, halos: 0, board3d: 0 };
    app.markDirty = () => { changes.dirty++; };
    app.refreshFills = () => { changes.fills++; };
    app.showClearances = () => { changes.halos++; };
    clearanceOverlayState(app).clearancesVisible = true;
    setBoardViewPanel(app, { refresh() { changes.board3d++; } });
    bindPcbControls(app);
    const elements = new Map([...ids, 'pcbRouteUnits', 'pcbRouterMode'].map(id => [id, document.getElementById(id)]));
    assert.equal(app.designSettings, project.pcbDocument.designSettings);
    return { app, changes, elements };
}
{
    const loadedDesign = { ...precise, clearance: 0.123456, units: 'inch' };
    const savedGrid = { gridSize: 0.123456, units: 'inch', gridStyle: 'dots', gridVisible: false, snapToGrid: false };
    storage.set('clearpcb_pcb_design_params', JSON.stringify({ ...precise, clearance: 0.9 }));
    for (const prepareModel of [
        model => model.load({ stackup: defaultPcbStackup(), design: loadedDesign, settings: savedGrid }),
        model => model.designSettings.update(loadedDesign),
        model => { model.designSettings.update(loadedDesign); model.clear(); },
    ]) {
        const attached = fixture(prepareModel);
        assert.deepEqual(attached.app.designSettings.values, loadedDesign,
            'Binding controls must not replace already supplied model settings with local defaults');
        assert.equal(attached.elements.get('pcbRouteUnits').value, 'inch');
        assert.equal(attached.elements.get('pcbClearance').value, '0.0049');
        assert.deepEqual(attached.changes, { dirty: 0, fills: 0, halos: 0, board3d: 0 });
        if (attached.app.pcbDocument.settings) {
            assert.equal(attached.app.viewport, null);
            assert.deepEqual(attached.app.serializeSection(), attached.app.pcbDocument.serialize(),
                'A newly attached editor preserves a loaded metadata-only section before viewport creation');
        }
    }
    storage.clear();
}
const { app, changes, elements } = fixture();
for (const id of ids) {
    assert.equal(elements.get(id).dataset.numberFormat, 'precise', 'Design fields opt out of shared two-decimal formatting');
    elements.get(id).value = '0.1234';
    formatNumberInput(elements.get(id));
    assert.equal(elements.get(id).value, '0.1234');
}
app.pcbDocument.load({ stackup: defaultPcbStackup(), design: precise });
refreshDesignSettings(app);
assert.equal(elements.get('pcbClearance').value, '0.123', 'Existing display precision is preserved');
assert.equal(app.getRoutingParams().clearance, 0.1234, 'Routing uses exact loaded data, not displayed text');
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
assert.deepEqual(app.getRoutingParams(), expectedRouting);
assert.equal(app._getRouterMode(), 'pathfinder');
assert.deepEqual(normalizePcbSection(serializePcb(app)).design, precise);
document.getElementById = lookup;
for (let count = 0; count < 50; count++) {
    for (const unit of ['inch', 'mm']) {
        elements.get('pcbRouteUnits').value = unit;
        elements.get('pcbRouteUnits').fire('change');
        assert.deepEqual(app.getRoutingParams(), expectedRouting);
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
    assert.equal(app.getRoutingParams().trackWidth, 0.2);
    assert.equal(changes.dirty, 100);
}
assert.equal(field.reports, 5);
field.value = '0.2345';
field.fire('input');
assert.equal(field.validationMessage, '');
assert.equal(app.getRoutingParams().trackWidth, 0.2345);
assert.deepEqual(changes, { dirty: 101, fills: 1, halos: 1, board3d: 1 });
elements.get('pcbRouterMode').value = 'maze';
elements.get('pcbRouterMode').fire('change');
assert.equal(app._getRouterMode(), 'maze');
assert.equal(changes.dirty, 102);
assert.equal(document.getElementById('pcbExcludeSameFootprintPadClearance'), null, 'Exclusion is no longer a ribbon control');
assert.equal(app.designSettings.values.excludeSameFootprintPadClearance, false, 'Footprint exclusion defaults off');
commitSameFootprintPadClearanceExclusion(app, true);
assert.equal(app.designSettings.values.excludeSameFootprintPadClearance, true);
assert.equal(JSON.parse(storage.get('clearpcb_pcb_design_params')).excludeSameFootprintPadClearance, true);
assert.equal(normalizePcbSection(serializePcb(app)).design.excludeSameFootprintPadClearance, true);
assert.equal(changes.dirty, 103, 'Exclusion is a persisted project edit');
assert.equal(changes.fills, 1, 'Exclusion does not recompute authored copper');
commitSameFootprintPadClearanceExclusion(app, true);
assert.equal(changes.dirty, 103, 'No-op exclusion does not dirty the project');
commitSameFootprintPadClearanceExclusion(app, false);
app.pcbDocument.load({ stackup: defaultPcbStackup(), design: { ...precise, units: 'inch' } });
refreshDesignSettings(app);
assert.equal(elements.get('pcbTrackWidth').value, '0.0079');
assert.equal(app.getRoutingParams().trackWidth, 0.2, 'Loading inch display must not change 0.2 mm to 0.20066 mm');
assert.equal(changes.dirty, 104);
assert.deepEqual(fixture().app.designSettings.values, { ...precise, units: 'inch' },
    'Canonical defaults retain precision across startup');
storage.set('clearpcb_pcb_design_params', JSON.stringify({ units: 'inch', router: 'maze',
    pcbTrackWidth: '0.01', pcbClearance: '0.005', pcbViaDiameter: '0.02', pcbViaDrill: '0.01' }));
const legacy = fixture().app;
assert.equal(legacy.getRoutingParams().trackWidth, 0.254, 'Legacy display-unit defaults remain readable');
assert.throws(() => preparePcb({ ...serializePcb(legacy), design: { ...precise, clearance: 0 } }), /positive finite/);

assert.throws(() => new PcbDesignSettings().update({ clearance: 5020.02 }), /no larger than 10 mm/);
assert.throws(() => new PcbDesignSettings().update({ trackWidth: 25.5 }), /no larger than 25 mm/);
{
    const { app, changes, elements } = fixture();
    const slipped = { ...precise, clearance: 5020.02, viaDiameter: 25 };
    assert.doesNotThrow(() => preparePcb({ ...serializePcb(legacy), design: slipped }), 'A slipped saved value still opens');
    app.pcbDocument.load({ stackup: defaultPcbStackup(), design: slipped });
    assert.equal(app.getRoutingParams().clearance, 10, 'Oversized saved clearances load clamped to the maximum');
    assert.equal(app.getRoutingParams().viaDiameter, 25, 'The maximum itself is kept');
    assert.equal(app.getRoutingParams().trackWidth, precise.trackWidth, 'In-range values are untouched');
    app.pcbDocument.load({ stackup: defaultPcbStackup(), design: { ...precise, units: 'mm' } });
    refreshDesignSettings(app);
    const clearance = elements.get('pcbClearance');
    assert.equal(clearance.max, '10');
    const before = changes.dirty;
    clearance.value = '5020.02';
    clearance.fire('input');
    clearance.fire('change');
    assert.match(clearance.validationMessage, /no larger than 10 mm/);
    assert.equal(app.getRoutingParams().clearance, precise.clearance, 'An oversized typed clearance is never committed');
    assert.equal(changes.dirty, before);
    elements.get('pcbRouteUnits').value = 'inch';
    elements.get('pcbRouteUnits').fire('change');
    assert.equal(clearance.max, '0.3937');
    clearance.value = '0.3937';
    clearance.fire('input');
    assert.equal(clearance.validationMessage, '', 'The rounded inch display of the maximum is accepted');
    assert.ok(Math.abs(app.getRoutingParams().clearance - 10) < 1e-3);
    const width = elements.get('pcbTrackWidth');
    assert.equal(width.max, '0.9843');
    width.value = '0.9843';
    width.fire('input');
    assert.equal(width.validationMessage, '', 'A rounded inch maximum just above the limit is accepted');
    assert.equal(app.getRoutingParams().trackWidth, 25, 'and committed as the exact maximum');
    clearance.value = '0.5';
    clearance.fire('input');
    assert.match(clearance.validationMessage, /no larger than 0\.3937 in/);
    assert.ok(Math.abs(app.getRoutingParams().clearance - 10) < 1e-3);
    storage.set('clearpcb_pcb_design_params', JSON.stringify({ ...precise, clearance: 5020.02 }));
    assert.equal(fixture().app.getRoutingParams().clearance, 10, 'Oversized local defaults are clamped on startup');
    storage.clear();
}
for (const units of ['mm', 'inch']) {
    storage.clear();
    const { app, changes, elements } = fixture();
    app.designSettings.update({ viaDiameter: 0.6, viaDrill: 0.3, units });
    refreshDesignSettings(app);
    const drill = elements.get('pcbViaDrill'), diameter = elements.get('pcbViaDiameter');
    const display = value => String(units === 'inch' ? value / 25.4 : value);
    for (const [input, value] of [[drill, 0.7], [drill, 0.6], [drill, 0.55], [diameter, 0.3]]) {
        input.value = display(value);
        input.fire('input');
        input.fire('change');
        assert.match(input.validationMessage, /Via Diameter must be at least/);
        assert.equal(app.getRoutingParams().viaDiameter, 0.6);
        assert.equal(app.getRoutingParams().viaDrill, 0.3);
        assert.equal(changes.dirty, 0, 'Rejected size edits leave model and history untouched');
    }
    diameter.value = display(0.8);
    diameter.fire('input');
    assert.equal(diameter.value, display(0.8), 'Valid input is not reformatted while typing');
    assert.ok(Math.abs(app.getRoutingParams().viaDiameter - 0.8) < 1e-12);
    drill.value = display(0.7);
    drill.fire('input');
    assert.equal(drill.validationMessage, '');
    assert.ok(Math.abs(app.getRoutingParams().viaDrill - 0.7) < 1e-12);
    assert.equal(changes.dirty, 2, 'Corrected, exact-boundary dimensions commit in both display units');
    assert.ok(Math.abs(Number(diameter.min) * (units === 'inch' ? 25.4 : 1) - 0.8) < 1e-9);
}
storage.clear();
console.log('PASS canonical PCB design settings, precision, atomic Via validation and dirty/refresh routing');

const { app: tools, elements: ribbon } = fixture();
tools.pcbDocument.load({ stackup: defaultPcbStackup(), design: { ...precise, units: 'inch' } });
refreshDesignSettings(tools);
let panel = null;
tools.openPropertyPanel = next => { panel = next; return true; };
tools.refreshPropertyPanel = next => { panel = next; };
tools.setPcbStatus = tools.setActiveRibbonTab = tools.setStatus = () => {};
showTrackDrawProperties(tools);
let width = panel.fields.find(field => field.id === 'pcbPropTrackToolWidth');
assert.equal(width.numberFormat, 'precise');
width.preview(0.45);
assert.equal(tools.getRoutingParams().trackWidth, 0.45);
assert.equal(ribbon.get('pcbTrackWidth').value, '0.0177', 'Millimetre tool edits render correctly in an inch ribbon');
showViaToolProperties(tools);
let diameter = panel.fields.find(field => field.id === 'pcbPropViaToolDiameter');
let drill = panel.fields.find(field => field.id === 'pcbPropViaToolDrill');
assert.equal(diameter.numberFormat, 'precise');
assert.equal(drill.numberFormat, 'precise');
diameter.preview(0.8);
drill.preview(0.4);
assert.equal(tools.getRoutingParams().viaDiameter, 0.8);
assert.equal(tools.getRoutingParams().viaDrill, 0.4);
assert.equal(ribbon.get('pcbViaDrill').value, '0.0157');
drill.preview(1.2);
assert.equal(tools.getRoutingParams().viaDrill, 0.4, 'Via tool rejects an oversized drill without silently clamping it');
drill = panel.fields.find(field => field.id === 'pcbPropViaToolDrill');
assert.match(drill.error, /Via Diameter must be at least/);
diameter = panel.fields.find(field => field.id === 'pcbPropViaToolDiameter');
diameter.preview(0.45);
assert.equal(tools.getRoutingParams().viaDiameter, 0.8, 'Via tool rejects a diameter with too little annular ring');
diameter = panel.fields.find(field => field.id === 'pcbPropViaToolDiameter');
assert.match(diameter.error, /Via Diameter must be at least/);
diameter.preview(-1);
diameter = panel.fields.find(field => field.id === 'pcbPropViaToolDiameter');
assert.match(diameter.error, /positive finite/);
assert.equal(tools.getRoutingParams().viaDiameter, 0.8);
console.log('PASS track/via tool editors share canonical millimetre state and field validation');
