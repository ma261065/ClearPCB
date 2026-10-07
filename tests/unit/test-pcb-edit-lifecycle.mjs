import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { capturePlacementOverride } from '../../src/core/PcbPlacementState.js';
import { createRefTextSelectionAdapter } from '../../src/pcb/modules/ref-text-selection.js';
import { loadPcb } from '../../src/pcb/modules/project-state.js';
import { PROPERTY_EDITOR_KINDS, getPropertyEditor, setPropertyEditor } from '../../src/pcb/modules/property-editors.js';
import { getSelectionInteraction } from '../../src/pcb/modules/selection-interaction.js';
import { getRefDrag } from '../../src/pcb/modules/ref-text-selection.js';
import { setPcbInteraction } from '../../src/pcb/modules/pcb-interactions.js';
import { cancelPcbPosePreviews } from '../../src/pcb/modules/edit-lifecycle.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { querySelector: () => null, getElementById: () => null };
const frames = new Map();
let frameId = 0;
globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');

function fixture() {
    const pcbDocument = new PcbDocument();
    const placement = { x: 0, y: 0, side: 'top', rotation: 0, refDx: Math.PI, refDy: -Math.E,
        refRot: 0, refSize: 1.2, refStrokeWidth: 0.15, reference: 'R1', elements: [] };
    pcbDocument.placementState.record('part', placement);
    const app = {
        pcbDocument, placements: new Map([['part', placement]]), history: new CommandHistory(),
        tracks: [], vias: [], pads: [], boardShapes: [], texts: new Map(), netlist: [],
        _layerGroups: new Map(), _shapeElements: new Map(),
        viewport: { scale: 10, svg: { style: {} }, snapToGrid: false },
        currentTool: 'select',
        existingLayerGroups() { return this._layerGroups; },
        getLayerGroup: () => null, drawRefOverlay() {}, ensureViewport() {},
        _refreshRefHighlight() {}, markSectionClean() {},
    };
    for (const name of ['_worldToPlacementLocal', 'snapToGrid',
        'setPropertiesTitle', 'isSectionEditing', 'deactivate']) app[name] = PCBApp.prototype[name];
    app.history.execute({ execute() {}, undo() {} });
    app.history.undo();
    return { app, placement, adapter: createRefTextSelectionAdapter(app, 'part', 'reftext:part') };
}

for (const boundary of ['cancel', 'deactivate', 'replace']) {
    for (const shared of [false, true]) {
        const { app, placement, adapter } = fixture();
        const original = capturePlacementOverride(placement);
        const redo = [...app.history.redoStack];
        adapter.beginMove({ x: 0, y: 0 });
        adapter.updateMove({ x: 5, y: 7 });
        if (shared) setPcbInteraction(app, '_pcbSelectionInteraction', { mode: 'move-adapter', entry: adapter });
        assert.notDeepEqual(capturePlacementOverride(placement), original);
        assert.equal(app.isSectionEditing(), true);
        if (boundary === 'replace') loadPcb(app, null);
        else if (boundary === 'deactivate') app.deactivate();
        else cancelPcbPosePreviews(app);
        assert.equal(getRefDrag(app), null, `${boundary}: end the reference drag`);
        assert.equal(getSelectionInteraction(app) ?? null, null, `${boundary}: release the selection gesture`);
        assert.deepEqual(capturePlacementOverride(placement), original, `${boundary}: discard the displayed preview`);
        assert.equal(app.isSectionEditing(), false, `${boundary}: do not leave saving blocked`);
        assert.equal(app.history.canUndo(), false, `${boundary}: cancellation must not commit`);
        if (boundary !== 'replace') assert.deepEqual(app.history.redoStack, redo);
    }
}

for (const kind of ['component', 'shape', 'track', 'via', 'pad', 'fill', 'text', 'reftext']) {
for (const mode of ['cycle', 'anchor', 'floating-anchor', 'move-adapter', 'move']) {
    const { app } = fixture();
    let cancellations = 0;
    const adapter = {
        kind,
        endMove(commit) { assert.equal(commit, false); cancellations++; },
        endAnchorDrag(commit) { assert.equal(commit, false); cancellations++; },
    };
    setPcbInteraction(app, '_pcbSelectionInteraction', { mode, adapter, entry: adapter });
    app.deactivate();
    assert.equal(getSelectionInteraction(app), null, `${kind}/${mode}: selection ends on deactivation`);
    const expected = ['cycle', 'move'].includes(mode) ? 0 : 1;
    assert.equal(cancellations, expected);
    app.deactivate();
    assert.equal(cancellations, expected, 'Repeated cancellation is harmless');
}
}

for (const key of PROPERTY_EDITOR_KINDS) {
    for (const boundary of ['cancel', 'deactivate', 'panel', 'replace']) {
        const { app } = fixture();
        let disposed = 0, cancelled = 0;
        const binding = {
            active: true,
            cancel() { if (this.active) cancelled++; this.active = false; },
            dispose() { disposed++; this.cancel(); setPropertyEditor(app, key, null); },
        };
        setPropertyEditor(app, key, binding);
        assert.equal(app.isSectionEditing(), true, `${key}: block snapshots during editing`);
        if (boundary === 'replace') loadPcb(app, null);
        else if (boundary === 'panel') app.setPropertiesTitle('Next');
        else if (boundary === 'deactivate') app.deactivate();
        else cancelPcbPosePreviews(app);
        assert.equal(cancelled, 1, `${key}/${boundary}: cancel the old edit once`);
        assert.equal(app.isSectionEditing(), false);
        const shouldDispose = ['panel', 'replace'].includes(boundary) || key === 'boardDimension';
        assert.equal(disposed, shouldDispose ? 1 : 0, `${key}/${boundary}: dispose only at its lifetime boundary`);
        if (shouldDispose) assert.equal(getPropertyEditor(app, key), null);
        else assert.equal(getPropertyEditor(app, key), binding, 'View deactivation retains reusable property controls');
        assert.equal(app.history.canUndo(), false);
    }
}

for (const boundary of ['cancel', 'panel', 'replace']) {
    const { app } = fixture();
    const failure = new Error('Fixture editor cleanup failed');
    const binding = { active: true, cancel() { throw failure; }, dispose() { throw failure; } };
    setPropertyEditor(app, 'pad', binding);
    const original = app.pcbDocument.serialize();
    assert.throws(() => {
        if (boundary === 'replace') loadPcb(app, null);
        else if (boundary === 'panel') app.setPropertiesTitle('Next');
        else cancelPcbPosePreviews(app);
    }, error => error === failure);
    assert.equal(getPropertyEditor(app, 'pad'), binding, 'Failed cleanup retains the unresolved editor');
    assert.equal(app.isSectionEditing(), true, 'Failed cleanup must not permit a success-shaped snapshot');
    assert.deepEqual(app.pcbDocument.serialize(), original, 'Cleanup failure precedes document clearing');
}

console.log('PASS PCB edit lifecycle cancels reference previews and every selection gesture without history changes');
