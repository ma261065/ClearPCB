import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { Pad } from '../src/shapes/pad.js';
import { Track } from '../src/shapes/track.js';
import { renderPad, padCopperPathD } from '../src/pcb/modules/pad.js';
import { getPadRotationPreview } from '../src/pcb/modules/pad-commands.js';
import { createPadSelectionAdapter } from '../src/pcb/modules/pad-selection.js';
import { setPcbSelection, syncPcbSelection, getPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { rotationHandleAnchor } from '../src/pcb/modules/rotation-handle.js';
import { finishSelectionInteraction } from '../src/pcb/modules/selection-interaction.js';
import { prepareFabricationSnapshot } from '../src/pcb/modules/fabrication-snapshot.js';
import { loadPcb } from '../src/pcb/modules/project-state.js';
import { cancelPictureCopperRefresh } from '../src/pcb/modules/picture-refresh.js';
import { getSelectionInteraction } from '../src/pcb/modules/selection-interaction.js';
import { isRotationHandleDragActive } from '../src/pcb/modules/rotation-handle.js';
import { setPcbInteraction } from '../src/pcb/modules/pcb-interactions.js';

let allocations = 0;
class Element {
    constructor(tag) { allocations++; this.tag = tag; this.attributes = new Map(); this.dataset = {}; this.children = []; this.style = {}; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    get classList() {
        return {
            add: name => this.setAttribute('class', `${this.getAttribute('class') || ''} ${name}`.trim()),
            contains: name => (this.getAttribute('class') || '').split(' ').includes(name),
        };
    }
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; }
    insertBefore(child, before) {
        child.remove();
        const index = this.children.indexOf(before);
        this.children.splice(index < 0 ? this.children.length : index, 0, child);
        child.parentNode = this;
    }
    get firstChild() { return this.children[0] || null; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
    remove() { this.parentNode?.removeChild(this); }
    querySelectorAll(selector) {
        const matches = child => selector.startsWith('.')
            && (child.getAttribute?.('class') || '').split(' ').includes(selector.slice(1));
        return this.children.flatMap(child => [
            ...(matches(child) ? [child] : []),
            ...(child.querySelectorAll?.(selector) || []),
        ]);
    }
}
const input = { value: '' };
globalThis.document = {
    createElementNS: (_, tag) => new Element(tag),
    getElementById: id => id === 'pcbPropPadRotation' ? input : null,
};
globalThis.window = { addEventListener() {} };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

function fixture(shape = 'rectangle', layers = 'both') {
    const project = new ProjectDocument(), model = project.pcbDocument;
    const pad = new Pad({ shape, layers, x: Math.PI, y: -Math.E, rotation: 37.123456789,
        size: 1.23456789, ratio: 3.123456789, drill: 0.456789123, net: 'GND' });
    const unrelated = new Pad({ x: 30, y: 30 });
    const attached = new Track({ points: [{ x: pad.x, y: pad.y }, { x: 10, y: 10 }] });
    model.pads.push(pad, unrelated);
    model.tracks.push(attached);
    const groups = new Map(['top-copper', 'bottom-copper', 'top-copper-pad-drills', 'bottom-copper-pad-drills']
        .map(layer => [layer, new Element('g')]));
    let fills = 0;
    const app = {
        project, pcbDocument: model, placements: new Map(), netlist: [], history: new CommandHistory(),
        viewport: { scale: 100, svg: new Element('svg'), hideCrosshair() {} },
        getLayerGroup: id => groups.get(id) || null,
        existingLayerGroups: () => groups,
        refreshClearanceHalos() {}, refreshFills() { fills++; },
        _cancelPosePreviews: PCBApp.prototype._cancelPosePreviews,
        isSectionEditing: PCBApp.prototype.isSectionEditing,
        _cancelDrawingMode() {}, _clearCursorCrosshair() {}, markSectionClean() {}, _ensureViewport() {},
        _shapeElements: new Map(),
    };
    for (const key of ['tracks', 'vias', 'pads', 'boardShapes', 'texts']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    project.registerView('pcb', app);
    const adapter = createPadSelectionAdapter(app, pad, `pad:${pad.id}`);
    setPcbSelection(app, [{ kind: 'pad', object: pad }]);
    for (const item of model.pads) renderPad(item, app.getLayerGroup);
    const start = { x: pad.x + 10, y: pad.y };
    const pointFor = rotation => {
        const radians = (pad.rotation - rotation) * Math.PI / 180;
        return { x: pad.x + 10 * Math.cos(radians), y: pad.y + 10 * Math.sin(radians) };
    };
    const artwork = () => [...groups.values()].flatMap(group => group.children);
    return { app, project, model, pad, unrelated, attached, adapter, start, pointFor, artwork, fills: () => fills };
}

let cases = 0;
for (const shape of ['rectangle', 'stadium', 'oval', 'square']) {
    for (const layers of ['both', 'top-copper', 'bottom-copper']) {
        for (const finish of ['commit', 'cancel', 'no-op', 'deactivate', 'load', 'failure', 'missing']) {
            const f = fixture(shape, layers);
            const { app, project, model, pad, unrelated, attached, adapter, start, pointFor } = f;
            const before = model.captureGeometry(), serialized = model.serialize(), padState = pad.captureState();
            const bounds = attached.getBounds(), trackState = attached.captureState(), padBounds = pad.getBounds();
            const initialArtwork = f.artwork().length;
            const otherArtwork = f.artwork().filter(element => element.dataset.padId === unrelated.id);
            const redo = { execute() {}, undo() {} };
            app.history.redoStack.push(redo);
            assert.equal(adapter.beginAnchorDrag('rotate', start), true);
            assert.equal(app.isSectionEditing(), true);
            const pickupAllocations = allocations;
            for (let i = 0; i < 100; i++) adapter.updateAnchorDrag({ x: pad.x, y: pad.y });
            assert.equal(app.pads, model.pads, 'Unchanged pickup retains the canonical collection');
            assert.equal(getPadRotationPreview(app).pads, undefined, 'No lazy collection allocated yet');
            assert.equal(allocations, pickupAllocations, 'Unchanged pickup does not redraw geometry');
            adapter.updateAnchorDrag(pointFor(90));
            const copy = app.pads[0], collection = app.pads;
            assert.notEqual(copy, pad);
            assert.equal(copy.id, pad.id);
            assert.equal(copy.x, pad.x);
            assert.equal(copy.ratio, pad.ratio);
            assert.equal(collection[1], unrelated);
            assert.equal(app.tracks, model.tracks, 'Rotation does not project attached tracks');
            for (let rotation = 91; rotation <= 190; rotation++) {
                adapter.updateAnchorDrag(pointFor(rotation));
                assert.equal(app.pads, collection);
                assert.equal(app.pads[0], copy);
                assert.equal(copy.rotation, rotation);
                assert.equal(f.artwork().length, initialArtwork, 'Preview has no duplicate SVG');
            }
            const changedAllocations = allocations;
            for (let i = 0; i < 100; i++) adapter.updateAnchorDrag(pointFor(190.1));
            assert.equal(allocations, changedAllocations, 'Unchanged angles perform no geometry redraw');
            assert.deepEqual(adapter.getBounds(), copy.getBounds());
            assert.deepEqual(adapter.getAnchors(), [rotationHandleAnchor(copy.getBounds(), app.viewport.scale)]);
            const interior = copy.getOutline().map(point => ({
                x: pad.x + (point.x - pad.x) * 0.95, y: pad.y + (point.y - pad.y) * 0.95,
            })).find(point => copy.hitTest(point) !== pad.hitTest(point));
            assert.ok(interior, 'Fixture distinguishes projected and canonical hit regions');
            assert.equal(adapter.hitTest(interior), copy.hitTest(interior));
            syncPcbSelection(app);
            assert.equal(getPcbSelection(app, 'pad')[0], copy);
            const rebuilt = createPadSelectionAdapter(app, copy, adapter.id);
            assert.equal(rebuilt.object, copy);
            assert.deepEqual(rebuilt.getLockPosition(interior, 100), adapter.getLockPosition(interior, 100));
            assert.deepEqual(pad.captureState(), padState);
            assert.deepEqual(pad.getBounds(), padBounds);
            assert.deepEqual(attached.captureState(), trackState);
            assert.equal(attached._bounds, bounds);
            assert.deepEqual(model.captureGeometry(), before);
            assert.deepEqual(model.serialize(), serialized);
            assert.equal(f.fills(), 0);
            assert.equal(app.history.canUndo(), false);
            assert.throws(() => project.serialize(), /Finish the current edit before saving/);
            await assert.rejects(prepareFabricationSnapshot(app), /Finish the current edit before exporting/);
            setPcbInteraction(app, '_pcbSelectionInteraction', { mode: 'anchor', adapter: rebuilt, moved: true,
                anchorId: 'rotate', anchor: { symbol: 'rotate' } });
            if (finish === 'commit') {
                const execute = app.history.execute.bind(app.history);
                app.history.execute = command => {
                    assert.equal(command.pad, pad, 'Command targets canonical identity even after adapter rebuild');
                    assert.equal(app.pads, model.pads, 'Projection cleared before the command executes');
                    assert.equal(f.artwork().filter(element => element.dataset.padId === pad.id).length, 0);
                    assert.deepEqual(model.captureGeometry(), before);
                    execute(command);
                };
                finishSelectionInteraction(app, true);
                assert.equal(pad.rotation, 190);
                assert.equal(app.history.undoStack.length, 1);
                const after = model.captureGeometry();
                app.history.undo();
                assert.deepEqual(model.captureGeometry(), before, 'Undo retains full precision');
                app.history.redo();
                assert.deepEqual(model.captureGeometry(), after);
            } else if (finish === 'load') {
                loadPcb(app, null);
            } else {
                if (finish === 'no-op') {
                    rebuilt.updateAnchorDrag({ x: pad.x, y: pad.y });
                    assert.equal(copy.rotation, padState.rotation, 'Centre restores exact fractional rotation');
                    finishSelectionInteraction(app, true);
                } else if (finish === 'deactivate') {
                    PCBApp.prototype.deactivate.call(app);
                } else if (finish === 'failure') {
                    app.history.execute = () => { throw new Error('Rejected pad rotation'); };
                    assert.throws(() => finishSelectionInteraction(app, true), /Rejected pad rotation/);
                } else if (finish === 'missing') {
                    model.pads.splice(0, 1);
                    assert.throws(() => finishSelectionInteraction(app, true), /Cannot rotate a missing pad/);
                } else {
                    Object.freeze(pad);
                    assert.equal(PCBApp.prototype.handleKeyDown.call(app, { key: 'Escape' }), true);
                }
                if (finish !== 'missing') {
                    assert.deepEqual(model.captureGeometry(), before);
                    assert.deepEqual(model.serialize(), serialized);
                    assert.equal(f.fills(), 0, 'Discarded preview never repours unchanged copper');
                }
                assert.equal(app.history.canUndo(), false);
                assert.equal(app.history.redoStack[0], redo);
            }
            assert.equal(getPadRotationPreview(app), undefined);
            assert.equal(Number(input.value), pad.rotation);
            assert.equal(isRotationHandleDragActive(app), false);
            assert.equal(getSelectionInteraction(app), null);
            assert.equal(app.pads, model.pads);
            assert.equal(rebuilt.object, pad, 'Rebuilt adapter returns to canonical identity');
            assert.equal(app.isSectionEditing(), false);
            const artworkAfter = allocations;
            rebuilt.updateAnchorDrag(pointFor(240));
            adapter.endAnchorDrag(true);
            assert.equal(allocations, artworkAfter, 'Stale adapter callbacks cannot restart a finished preview');
            if (finish === 'load') assert.equal(f.artwork().length, 0);
            else {
                assert.deepEqual(f.artwork().filter(element => element.dataset.padId === unrelated.id), otherArtwork);
                if (finish === 'missing') {
                    assert.equal(f.artwork().filter(element => element.dataset.padId === pad.id).length, 0);
                } else {
                    assert.equal(f.artwork().length, initialArtwork);
                    for (const path of f.artwork().filter(element => element.dataset.padId === pad.id && element.tag === 'path')) {
                        assert.equal(path.getAttribute('d'), padCopperPathD(pad));
                    }
                }
            }
            cancelPictureCopperRefresh(app);
            cases++;
        }
    }
}

for (const changed of [false, true]) {
    const { app, adapter, start, pointFor, artwork, model } = fixture();
    const before = model.captureGeometry(), count = artwork().length;
    adapter.beginAnchorDrag('rotate', start);
    if (changed) adapter.updateAnchorDrag(pointFor(90));
    app._cancelPosePreviews();
    assert.equal(app.isSectionEditing(), false, 'Lifecycle also cleans orphaned rotation gestures');
    assert.equal(getPadRotationPreview(app), undefined);
    assert.equal(Number(input.value), model.pads[0].rotation);
    assert.deepEqual(model.captureGeometry(), before);
    assert.equal(artwork().length, count);
    adapter.updateAnchorDrag(pointFor(180));
    adapter.endAnchorDrag(true);
    assert.equal(app.history.canUndo(), false);
    cases++;
}
console.log(`PASS ${cases} pad rotation isolation cases: snapshots, stable identity, work counts, SVG, history, guards and lifecycle`);
