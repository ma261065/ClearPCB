import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { compactProjectAliases, normalizeProjectAliases } from '../src/core/project-field-aliases.js';
import { defaultPcbStackup, validateEditableProject } from '../src/core/project-format.js';
import { PANEL_DEFAULTS } from '../src/core/pcb-panelization.js';
import { createPcbText } from '../src/core/pcb-text.js';

assert.equal(typeof document, 'undefined');
assert.equal(typeof window, 'undefined');
const blank = () => ({ type: 'clearpcb-project', version: '1.0', schematic: { shapes: [], components: [] } });
const design = { trackWidth: 0.2345, clearance: 0.1234, viaDiameter: 0.6, viaDrill: 0.3,
    units: 'inch', router: 'pathfinder' };
const input = {
    ...blank(),
    schematic: { shapes: [{ id: 'shape_1', type: 'circle', x: 5, y: 4, r: 2 }], components: [] },
    pcb: {
        stackup: defaultPcbStackup(), design, board: { width: 43.1234, height: 27.2345, radius: 2 },
        settings: { gridSize: 0.123456, gridStyle: 'dots', units: 'inch', gridVisible: true, snapToGrid: true },
        panelization: { ...PANEL_DEFAULTS, rowSpacing: 2.123456, noteCreated: true },
        tracks: [{ id: 'track-1', type: 'track', nd: { a: [0, 0], b: [5, 0] },
            ed: { edge: ['a', 'b'] }, w: 0.2345, n: 'GND' }],
        vias: [{ type: 'via', id: 'via_9', x: 5, y: 0, d: 0.6, dr: 0.3, n: 'GND' }],
        pads: [{ type: 'pad', id: 'pad_9', x: 8, y: 0, shape: 'round', size: 2, drill: 0.8, layers: 'both' }],
        boardShapes: [{ id: 'pshape_9', kind: 'circle', layer: 'top-silk', x: 4, y: 4, radius: 2,
            lineWidth: 0.2, filled: false, copperMode: 'add', plated: false, net: '' }],
        texts: [{ id: 'note', content: 'Panel note', x: 0, y: 5, size: 1, rotation: 0,
            strokeWidth: 0.15, layer: 'top-document' }],
        placements: { U1: { x: 3.1234, y: -4.2345, rotation: 90, side: 'bottom', refVisible: false } },
    },
};
const original = structuredClone(input);
const content = project => {
    const { schematic, pcb } = project.serialize();
    return { schematic, pcb };
};

for (const schematicView of [false, true]) {
    const project = new ProjectDocument();
    if (schematicView) {
        const model = project.schematicDocument;
        project.registerView('schematic', {
            getViewSettings: () => undefined,
            prepareSection: data => model.prepare(data),
            loadSection: (data, prepared) => model.load(data, prepared),
            clearSection: () => model.clear(),
        });
    }
    assert.equal('pcb' in project.serialize(), false, 'A new headless project has no invented PCB section');
    for (const data of [input, compactProjectAliases(input)]) {
        await project.load(data);
        const model = project.pcbDocument;
        assert.equal(model.tracks[0].id, 'track-1', 'The absent PCB editor must not discard authored data');
        assert.equal(model.vias[0].id, 'via_9');
        assert.equal(model.pads[0].id, 'pad_9');
        assert.equal(model.boardShapes[0].id, 'pshape_9');
        assert.equal(model.texts.size, 1, 'Headless loading does not regenerate panel notes');
        assert.deepEqual(model.designSettings.values, design);
        assert.deepEqual(model.board, input.pcb.board);
        assert.deepEqual(model.panelization, input.pcb.panelization);
        assert.deepEqual(model.settings, input.pcb.settings);
        assert.notEqual(model.settings, data.pcb.settings);
        assert.equal(model.placementState.overrides.get('U1').x, 3.1234);
        const saved = project.serialize();
        assert.deepEqual(saved.pcb, model.serialize(), 'Project saves use current PCB model state');
        assert.doesNotThrow(() => validateEditableProject(saved));
        assert.deepEqual(saved.pcb.settings, { gs: 0.123456, gt: 'dots', u: 'inch', gv: true, sg: true });
        const copy = new ProjectDocument();
        await copy.load(saved);
        assert.deepEqual(content(copy), content(project), 'Both sections survive a full headless project round-trip');
        saved.pcb.settings.gs = 999;
        saved.pcb.placements.U1.x = 999;
        assert.equal(model.settings.gridSize, 0.123456);
        assert.equal(model.placementState.overrides.get('U1').x, 3.1234);
        model.vias[0].x = 7.123456;
        assert.equal(project.serialize().pcb.vias[0].x, 7.1235, 'Saves reflect model edits, not a cached PCB section');
    }
    assert.deepEqual(input, original);
    const before = content(project);
    const oldTrack = project.pcbDocument.tracks[0], oldShape = project.schematicDocument.shapes[0];
    const revision = project.fileManager.revision;
    const invalid = structuredClone(input);
    invalid.pcb.panelization.rows = 0;
    await assert.rejects(project.load(invalid), /whole numbers/);
    assert.deepEqual(content(project), before);
    assert.equal(project.pcbDocument.tracks[0], oldTrack);
    assert.equal(project.schematicDocument.shapes[0], oldShape, 'PCB preflight precedes replacement of either section');
    assert.equal(project.fileManager.revision, revision);
    assert.equal(project.fileManager.loading, false);

    const load = project.pcbDocument.load.bind(project.pcbDocument);
    let failOnce = true;
    project.pcbDocument.load = (data, prepared) => {
        load(data, prepared);
        if (failOnce) {
            failOnce = false;
            throw new Error('Simulated adoption failure');
        }
    };
    project.fileManager.setDirty(true);
    await assert.rejects(project.load({ ...input, pcb: { ...input.pcb, settings: { gridSize: 5 } } }),
        /Simulated adoption failure/);
    assert.deepEqual(content(project), before, 'Existing serialized recovery restores both sections without a PCB view');
    assert.equal(project.fileManager.isDirty, true);
    assert.equal(project.fileManager.loading, false);
    project.pcbDocument.load = load;

    await project.load(blank());
    assert.equal(project.pcbDocument.tracks.length, 0);
    assert.equal(project.pcbDocument.settings, undefined);
    assert.equal('pcb' in project.serialize(), false, 'Loading a schematic-only project clears the old PCB');
    await project.load({ ...blank(), pcb: { stackup: defaultPcbStackup(), design } });
    assert.ok(project.serialize().pcb, 'An explicitly present metadata-only section is preserved');
    assert.equal('settings' in JSON.parse(JSON.stringify(project.serialize().pcb)), false,
        'Missing viewport settings do not become invented defaults');
    await project.load(input);
    let recovery;
    project.fileManager.autoSaveToStorage = data => { recovery = data; };
    await project.reset();
    assert.equal('pcb' in project.serialize(), false);
    assert.equal('pcb' in recovery, false, 'New recovery does not include old PCB data or preferences');
    assert.deepEqual(project.pcbDocument.designSettings.values, design, 'Reset still retains last-used design defaults');
    assert.equal(project.fileManager.fileName, 'untitled.cpcb');
    assert.equal(project.fileManager.loading, false);
}

const edited = new ProjectDocument();
const text = createPcbText({ id: 'new-note', content: 'Headless edit' });
edited.pcbDocument.texts.set(text.id, text);
assert.equal(edited.serialize().pcb.texts[0].t, 'Headless edit', 'Fresh model content also creates a saved PCB section');
edited.pcbDocument.clear();
edited.pcbDocument.board.width = 55;
assert.equal(edited.serialize().pcb.board.w, 55);

const registered = new ProjectDocument();
registered.pcbDocument.load(input.pcb);
const calls = [];
const registeredLoad = registered.pcbDocument.load.bind(registered.pcbDocument);
const registeredClear = registered.pcbDocument.clear.bind(registered.pcbDocument);
const modelCalls = [];
registered.pcbDocument.load = (...args) => { modelCalls.push('load'); registeredLoad(...args); };
registered.pcbDocument.clear = () => { modelCalls.push('clear'); registeredClear(); };
registered.registerView('pcb', {
    serializeSection() { assert.fail('PCB view serialization must not hide authored model data'); },
    prepareSection(data) { calls.push('prepare'); return PcbDocument.prepare(data); },
    loadSection(data, prepared) { calls.push('load'); registered.pcbDocument.load(data, prepared); },
    clearSection() { calls.push('clear'); registered.pcbDocument.clear(); },
});
assert.deepEqual(registered.serialize().pcb, registered.pcbDocument.serialize(),
    'A registered adapter cannot omit authored model state');
await registered.load(blank());
assert.deepEqual(modelCalls, ['load', 'clear'], 'The view loads its model once, including the load-time clear');
registered.fileManager.autoSaveToStorage = () => {};
await registered.reset();
assert.deepEqual(modelCalls, ['load', 'clear', 'clear'], 'Reset clears once through the registered view');
assert.equal(calls.filter(call => call === 'prepare').length, 1);
assert.equal(calls.filter(call => call === 'load').length, 1);
assert.equal(calls.filter(call => call === 'clear').length, 1);
assert.equal(typeof document, 'undefined');
assert.deepEqual(normalizeProjectAliases(compactProjectAliases(input)), normalizeProjectAliases(input));
console.log('PASS viewless project PCB load/save, preferences, preflight, recovery, omission, reset and registered-view dispatch');
