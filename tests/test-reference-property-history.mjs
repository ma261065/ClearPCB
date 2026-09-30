import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { capturePlacementOverride } from '../src/core/PcbPlacementState.js';
import { setPcbSelection } from '../src/pcb/modules/selection-registry.js';

globalThis.window = { addEventListener() {} };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

class Input {
    constructor(value) { this.value = String(value); this.listeners = new Map(); }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }
    fire(type, value = this.value) {
        this.value = String(value);
        for (const listener of this.listeners.get(type) || []) listener({ type });
    }
}

function fixture(saved, selected = false) {
    const placement = { x: Math.PI, y: -Math.E, rotation: 37.1234567, side: 'bottom', mirror: true,
        reference: 'R12', refDx: 1.234567, refDy: -2.345678,
        refSize: 1.234567, refStrokeWidth: 0.1234567, refRot: 23.456789 };
    const inputs = new Map(Object.entries({
        pcbPropRefSize: placement.refSize, pcbPropRefRot: placement.refRot,
        pcbPropRefLW: placement.refStrokeWidth,
    }).map(([id, value]) => [id, new Input(value)]));
    const items = { innerHTML: '', querySelector: selector => inputs.get(selector.slice(1)) || null };
    const pcbDocument = new PcbDocument();
    if (saved) pcbDocument.placementState.record('part', placement);
    const renders = [], overlays = [];
    let dirty = 0, boardRefreshes = 0;
    const app = {
        pcbDocument, placementState: pcbDocument.placementState, placements: new Map([['part', placement]]),
        history: new CommandHistory(),
        _pcbPropsItems: () => items, _setPcbPropsTitle() {}, _layerLabel: layer => layer,
        _bindStrokeTextProps: PCBApp.prototype._bindStrokeTextProps,
        _rerenderRef: () => renders.push(capturePlacementOverride(placement)),
        _drawRefOverlay: (id, tether) => overlays.push({ id, tether, pose: capturePlacementOverride(placement) }),
        _markDirty: () => dirty++, _board3d: { refresh: () => boardRefreshes++ },
    };
    if (selected) setPcbSelection(app, [{ kind: 'reftext', object: 'part' }]);
    overlays.length = 0;
    PCBApp.prototype._showRefProperties.call(app, 'part');
    assert.match(items.innerHTML, /id="pcbPropRefRot"[^>]*step="1"/,
        'Reference rotation spinner uses one-degree increments');
    assert.equal(PCBApp.prototype._pcbMultiPropertyCapabilities.call(app,
        { kind: 'reftext', object: 'part' }).rotation.step, 1,
    'Single and multi-selection reference rotation increments agree');
    return { app, placement, inputs, renders, overlays, dirty: () => dirty, boardRefreshes: () => boardRefreshes };
}

for (const saved of [false, true]) for (const selected of [false, true]) {
    for (const [id, field, intermediate, final] of [
        ['pcbPropRefSize', 'refSize', 2, 2.3456789],
        ['pcbPropRefLW', 'refStrokeWidth', 0.2, 0.2345678],
        ['pcbPropRefRot', 'refRot', 24, 25],
    ]) {
        const f = fixture(saved, selected);
        const original = capturePlacementOverride(f.placement);
        const savedBefore = structuredClone(f.app.placementState.overrides);
        const input = f.inputs.get(id);
        input.fire('input', intermediate);
        input.fire('input', final);
        assert.equal(f.placement[field], final);
        assert.deepEqual(f.app.placementState.overrides, savedBefore, 'Preview does not persist authored settings');
        assert.equal(f.app.history.canUndo(), false);
        assert.equal(f.dirty(), 0);
        assert.equal(f.boardRefreshes(), 0);
        const beforeCommit = f.renders.length;
        const beforeCommitOverlays = f.overlays.length;
        input.fire('change');
        const committed = capturePlacementOverride(f.placement);
        assert.ok(f.renders.slice(beforeCommit).every(pose => pose[field] === final),
            'Commit must never regenerate glyphs at the temporary rollback value');
        assert.equal(f.renders.length - beforeCommit, 2, 'Only change preview and command redraw, with no rollback redraw');
        assert.equal(f.overlays.length - beforeCommitOverlays, selected ? 2 : 1);
        assert.ok(f.overlays.slice(beforeCommitOverlays).every(overlay => overlay.pose[field] === final),
            'Overlay updates must not display the temporary rollback');
        assert.equal(f.app.history.undoStack.length, 1);
        assert.deepEqual(f.app.placementState.overrides.get('part'), committed);
        assert.equal(f.overlays.at(-1).tether, false);
        f.app.history.undo();
        assert.deepEqual(capturePlacementOverride(f.placement), original);
        assert.deepEqual(f.app.placementState.overrides.get('part'), original,
            'Automatic placements capture their baseline before preview values are reapplied');
        assert.deepEqual(f.renders.at(-1), original);
        f.app.history.redo();
        assert.deepEqual(capturePlacementOverride(f.placement), committed);
        assert.deepEqual(f.renders.at(-1), committed);
        assert.equal(f.dirty(), 3);
        assert.equal(f.boardRefreshes(), 3);
        assert.equal(f.overlays.length, selected ? 6 : 3, 'Only previews and commands refresh the overlay');
    }
}

{
    const f = fixture(false);
    const original = capturePlacementOverride(f.placement);
    const input = f.inputs.get('pcbPropRefSize');
    input.fire('change', 2.25);
    assert.equal(f.placement.refSize, 2.25, 'Change-only spinner events still apply');
    f.app.history.undo();
    assert.deepEqual(capturePlacementOverride(f.placement), original);
    f.app.history.redo();
    let rendersBefore = f.renders.length;
    input.fire('input', '');
    input.fire('change', '');
    assert.equal(f.placement.refSize, 2.25);
    assert.equal(f.renders.length, rendersBefore, 'Blank edits need no glyph refresh');
    input.fire('input', 3);
    rendersBefore = f.renders.length;
    input.fire('change', 2.25);
    assert.equal(f.renders.length - rendersBefore, 1, 'Return-to-original needs only its preview refresh');
    assert.equal(f.app.history.undoStack.length, 1, 'No-op edits create no command');
    input.fire('change', 4);
    f.app.history.undo();
    assert.equal(f.placement.refSize, 2.25, 'Later edits start from a fresh snapshot');
    f.app.history.undo();
    assert.deepEqual(capturePlacementOverride(f.placement), original);
}

{
    const f = fixture(true);
    const input = f.inputs.get('pcbPropRefRot');
    const original = f.placement.refRot;
    const savedRotation = capturePlacementOverride(f.placement).refRot;
    input.fire('input', '-');
    assert.equal(f.placement.refRot, original, 'An incomplete number does not change rotation');
    input.fire('input', '-1');
    assert.equal(input.value, '-1', 'Do not rewrite a signed angle while the user is still typing');
    input.fire('input', '-15');
    assert.equal(input.value, '-15');
    assert.equal(f.placement.refRot, 345);
    input.fire('change');
    assert.equal(input.value, '345', 'Normalize the completed angle on commit');
    f.app.history.undo();
    assert.equal(f.placement.refRot, savedRotation);
    f.app.history.redo();
    assert.equal(f.placement.refRot, 345);
}

delete globalThis.window;
console.log('PASS reference property preview handoff, precise history, automatic placement baselines and no-op edits');
