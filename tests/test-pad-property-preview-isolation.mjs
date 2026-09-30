import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { Pad } from '../src/shapes/pad.js';
import { Track } from '../src/shapes/track.js';
import { renderPad, padCopperPathD } from '../src/pcb/modules/pad.js';
import { getPadPropertyPreview } from '../src/pcb/modules/pad-commands.js';
import { createPadSelectionAdapter } from '../src/pcb/modules/pad-selection.js';
import { setPcbSelection, syncPcbSelection, getPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { prepareFabricationSnapshot } from '../src/pcb/modules/fabrication-snapshot.js';
import { loadPcb } from '../src/pcb/modules/project-state.js';
import { PCB_LAYERS } from '../src/pcb/modules/layers.js';
import { cancelPictureCopperRefresh } from '../src/pcb/modules/picture-refresh.js';

let allocations = 0, frameId = 0, timerId = 0, inputs = new Map();
const frames = new Map(), timers = new Map();
globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
globalThis.setTimeout = callback => { timers.set(++timerId, callback); return timerId; };
globalThis.clearTimeout = id => timers.delete(id);
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { setItem() {} };
function flushFrames() {
    for (const [id, callback] of [...frames]) { frames.delete(id); callback(); }
}
class Element {
    constructor(tag) { allocations++; this.tag = tag; this.children = []; this.attributes = new Map(); this.dataset = {}; this.style = {}; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; }
    insertBefore(child, before) {
        child.remove();
        const index = this.children.indexOf(before);
        this.children.splice(index < 0 ? this.children.length : index, 0, child);
        child.parentNode = this;
    }
    get firstChild() { return this.children[0] || null; }
    remove() {
        if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
        this.parentNode = null;
    }
}
class Input {
    constructor(value) { this.value = String(value); this.listeners = new Map(); }
    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(callback);
    }
    emit(type, value = this.value, extra = {}) {
        this.value = String(value);
        const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...extra };
        for (const callback of this.listeners.get(type) || []) callback(event);
    }
}
globalThis.document = {
    createElementNS: (_, tag) => new Element(tag),
    getElementById: id => inputs.get(id) || null,
    querySelector: () => null, querySelectorAll: () => [],
};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

function fixture(count = 1, layers = 'both', unrelatedCount = 1) {
    const project = new ProjectDocument(), model = project.pcbDocument;
    const pads = Array.from({ length: count }, (_, index) => new Pad({
        x: Math.PI + index * 10, y: -Math.E, shape: 'rectangle', layers,
        size: 2.123456789, ratio: 2.345678901, drill: 0.456789123, rotation: 37.123456789,
    }));
    const unrelated = Array.from({ length: unrelatedCount }, (_, index) => new Pad({ x: 100 + index }));
    const attached = new Track({ points: [{ x: pads[0].x, y: pads[0].y }, { x: 0, y: 0 }] });
    model.pads.push(...pads, ...unrelated);
    model.tracks.push(attached);
    inputs = new Map();
    const items = {
        set innerHTML(html) {
            inputs = new Map();
            for (const match of html.matchAll(/<input\b([^>]+)>/g)) {
                const id = match[1].match(/id="([^"]+)"/)?.[1];
                if (id) inputs.set(id, new Input(match[1].match(/value="([^"]*)"/)?.[1] || ''));
            }
            for (const match of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
                const options = [...match[2].matchAll(/<option value="([^"]*)"([^>]*)>/g)];
                inputs.set(match[1], new Input((options.find(option => option[2].includes('selected')) || options[0])[1]));
            }
        },
        querySelector: selector => inputs.get(selector.slice(1)) || null,
    };
    const groups = new Map(['top-copper', 'bottom-copper', 'top-copper-pad-drills', 'bottom-copper-pad-drills']
        .map(id => [id, new Element('g')]));
    const app = {};
    for (const key of ['pads', 'vias', 'tracks', 'boardShapes', 'texts']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    for (const key of ['_showPadEditor', '_toolNetOptions', '_setPcbPropsTitle', '_bindToolNetControl',
        '_clearProperties', '_cancelPosePreviews', 'isSectionEditing', 'deactivate',
        '_onLayerLockChanged', '_onLayerVisibilityChanged']) app[key] = PCBApp.prototype[key];
    Object.assign(app, {
        project, pcbDocument: model, placements: new Map(), netlist: [], history: new CommandHistory(),
        _active: true, _layerGroups: new Map(), _textElements: new Map(), _shapeElements: new Map(),
        viewport: { scale: 100, svg: new Element('svg'), shiftHeld: true, setCrosshair() {}, hideCrosshair() {} },
        _pcbPropsItems: () => items, _getLayerGroup: id => groups.get(id) || null,
        _setActiveRibbonTab() {}, _setPcbStatus() {}, _refreshFills() {}, _refreshClearanceHalos() {},
        _cancelDrawingMode() {}, _ensureViewport() {}, markSectionClean() {},
        _refreshPcbSelectionHighlights() {}, _scheduleRemovalHatchRender() {},
    });
    project.registerView('pcb', app);
    setPcbSelection(app, pads.map(object => ({ kind: 'pad', object })));
    for (const pad of [...pads, unrelated[0]].filter(Boolean)) renderPad(pad, app._getLayerGroup);
    app._showPadEditor(pads[0]);
    const artwork = () => [...groups.values()].flatMap(group => group.children);
    return { app, project, model, pads, unrelated, attached, artwork, input: name => inputs.get(`pcbPropPad${name}`) };
}

let cases = 0;
for (const count of [1, 4]) for (const layers of ['top-copper', 'bottom-copper', 'both']) {
    for (const [name, property, value] of [['Size', 'size', 3.456789123], ['Ratio', 'ratio', 3.123456789],
        ['Drill', 'drill', 0.654321987], ['Rotation', 'rotation', 90.123456789]]) {
        for (const finish of ['commit', 'cancel', 'no-op', 'panel', 'deactivate', 'load', 'failure', 'missing', 'lock', 'hide']) {
            const f = fixture(count, layers);
            const { app, project, model, pads, unrelated, attached } = f;
            const input = f.input(name), original = model.captureGeometry(), serialized = model.serialize();
            const bounds = attached.getBounds(), originalArtwork = f.artwork().length;
            const otherArtwork = f.artwork().filter(element => element.dataset.padId === unrelated[0].id);
            const baseline = pads.map(pad => pad.captureState()), redo = { execute() {}, undo() {} };
            app.history.redoStack.push(redo);
            const adapter = createPadSelectionAdapter(app, pads[0], `pad:${pads[0].id}`);
            input.emit('input', pads[0][property]);
            assert.equal(getPadPropertyPreview(app), undefined, 'Identical initial values do not allocate previews');
            assert.equal(app.pads, model.pads);
            input.emit('input', value);
            const projected = app.pads, copies = projected.slice(0, count);
            flushFrames();
            assert.equal(f.artwork().length, originalArtwork);
            for (let i = 0; i < count; i++) {
                assert.notEqual(copies[i], pads[i]);
                assert.equal(copies[i].id, pads[i].id);
            }
            assert.equal(projected[count], unrelated[0]);
            const rendered = allocations, scheduled = timerId;
            for (let i = 0; i < 100; i++) input.emit('input');
            flushFrames();
            assert.equal(allocations, rendered, 'Identical values do not rebuild SVG');
            assert.equal(timerId, scheduled, 'Identical values do not reschedule copper work');
            assert.equal(app.pads, projected);
            assert.deepEqual(adapter.getBounds(), copies[0].getBounds());
            assert.equal(adapter.object, copies[0]);
            syncPcbSelection(app);
            assert.equal(getPcbSelection(app, 'pad')[0], copies[0]);
            const rebuilt = createPadSelectionAdapter(app, copies[0], adapter.id);
            assert.deepEqual(model.captureGeometry(), original);
            assert.deepEqual(model.serialize(), serialized);
            assert.equal(attached._bounds, bounds);
            assert.equal(app.isSectionEditing(), true);
            assert.throws(() => project.serialize(), /Finish the current edit before saving/);
            await assert.rejects(prepareFabricationSnapshot(app), /Finish the current edit before exporting/);
            if (finish === 'commit') {
                const execute = app.history.execute.bind(app.history);
                app.history.execute = command => {
                    assert.equal(app.pads, model.pads);
                    assert.equal(getPadPropertyPreview(app), undefined);
                    assert.deepEqual(model.captureGeometry(), original, 'No temporary canonical rollback on commit');
                    execute(command);
                };
                input.emit('change');
                assert.equal(app.history.undoStack.length, 1);
                const after = model.captureGeometry();
                assert.notDeepEqual(after, original);
                app.history.undo();
                assert.deepEqual(model.captureGeometry(), original, 'Undo retains full precision');
                app.history.redo();
                assert.deepEqual(model.captureGeometry(), after);
            } else if (finish === 'load') {
                loadPcb(app, null);
                input.emit('input', value + 1);
                input.emit('change');
            } else {
                if (finish === 'no-op') {
                    input.emit('input', baseline[0][property]);
                    input.emit('change');
                } else if (finish === 'panel') {
                    app._clearProperties();
                    input.emit('input', value + 1);
                    input.emit('change');
                } else if (finish === 'deactivate') {
                    app.deactivate();
                    input.emit('input', value + 1);
                    input.emit('change');
                } else if (finish === 'failure') {
                    app.history.execute = () => { throw new Error('Rejected pad property command'); };
                    assert.throws(() => input.emit('change'), /Rejected pad property command/);
                } else if (finish === 'missing') {
                    model.pads.splice(count - 1, 1);
                    assert.throws(() => input.emit('change'), /Cannot edit a missing pad/);
                    assert.deepEqual(pads.map(pad => pad.captureState()), baseline, 'Preflight checks every target before commands');
                } else if (finish === 'lock' || finish === 'hide') {
                    const layer = PCB_LAYERS.find(layer => layer.id === (layers === 'both' ? 'top-copper' : layers));
                    try {
                        if (finish === 'lock') {
                            layer.locked = true;
                            app._onLayerLockChanged(layer.id, true);
                        } else {
                            layer.visible = false;
                            app._onLayerVisibilityChanged(layer.id, false);
                        }
                        input.emit('input', value + 1);
                    } finally { layer.locked = false; layer.visible = true; }
                } else {
                    for (const pad of pads) Object.freeze(pad);
                    input.emit('keydown', input.value, { key: 'Escape' });
                }
                if (finish !== 'missing') {
                    assert.deepEqual(model.captureGeometry(), original);
                    assert.deepEqual(model.serialize(), serialized);
                }
                assert.equal(app.history.canUndo(), false);
                assert.equal(app.history.redoStack[0], redo);
            }
            flushFrames();
            assert.equal(getPadPropertyPreview(app), undefined);
            assert.equal(app.isSectionEditing(), false);
            assert.equal(app.pads, model.pads);
            assert.equal(rebuilt.object, pads[0]);
            if (finish === 'load') assert.equal(f.artwork().length, 0);
            else {
                assert.deepEqual(f.artwork().filter(element => element.dataset.padId === unrelated[0].id), otherArtwork);
                if (finish !== 'missing') assert.equal(f.artwork().length, originalArtwork);
                for (const pad of model.pads.slice(0, count)) {
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

{
    const { app, pads, model, input } = fixture(4, 'both', 5000);
    const field = input('Ratio'), before = model.captureGeometry();
    field.emit('input', 3);
    const collection = app.pads, copies = collection.slice(0, 4);
    for (let i = 0; i < 100; i++) {
        field.emit('input', 3 + i / 100);
        flushFrames();
        assert.equal(app.pads, collection);
        for (let j = 0; j < 4; j++) assert.equal(app.pads[j], copies[j]);
    }
    assert.deepEqual(model.captureGeometry(), before);
    assert.equal(getPadPropertyPreview(app).copies.size, 4);
    field.emit('change');
    assert.equal(app.history.undoStack.length, 1);
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    assert.equal(app.pads[0], pads[0]);
    cancelPictureCopperRefresh(app);
    cases++;
}

for (const count of [1, 4]) for (const subsequent of ['Shape', 'Layers', 'Net', 'Ratio', 'move', 'rotate']) {
    const { app, pads, model, input } = fixture(count);
    const before = model.captureGeometry();
    input('Size').emit('input', 0.2);
    assert.equal(app.pads[0].drill, 0.2, 'Shrinking size clamps only the preview drill');
    assert.equal(pads[0].drill, 0.456789123);
    const rebuilt = createPadSelectionAdapter(app, app.pads[0], `pad:${pads[0].id}`);
    if (subsequent === 'move') {
        rebuilt.beginMove({ x: pads[0].x, y: pads[0].y });
        rebuilt.updateMove({ x: pads[0].x + 3, y: pads[0].y + 2 });
        rebuilt.endMove(true);
    } else if (subsequent === 'rotate') {
        rebuilt.beginAnchorDrag('rotate', { x: pads[0].x + 10, y: pads[0].y });
        rebuilt.updateAnchorDrag({ x: pads[0].x, y: pads[0].y - 10 });
        rebuilt.endAnchorDrag(true);
    } else {
        const value = { Shape: 'oval', Layers: 'bottom-copper', Net: 'SIGNAL', Ratio: 3 }[subsequent];
        input(subsequent).emit('change', value);
    }
    assert.equal(getPadPropertyPreview(app), undefined);
    assert.equal(app.history.undoStack.length, 2, 'Pending numeric edit commits independently before the next action');
    app.history.undo();
    assert.equal(pads[0].size, 0.2);
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    cancelPictureCopperRefresh(app);
    cases++;
}

for (const commit of [false, true]) {
    const { app, model, input, artwork } = fixture(4);
    const before = model.captureGeometry(), count = artwork().length;
    input('Size').emit('input', 3);
    assert.ok(frames.size);
    if (commit) input('Size').emit('change');
    else app._padPropertyBinding.cancel();
    const rendered = allocations;
    flushFrames();
    assert.equal(allocations, rendered, 'Completion cancels a pending preview frame');
    assert.equal(artwork().length, count, 'Completion before the first frame restores all artwork');
    if (!commit) assert.deepEqual(model.captureGeometry(), before);
    cancelPictureCopperRefresh(app);
    cases++;
}

{
    const { app, pads, model, input, artwork } = fixture(4);
    pads[1].size = 4;
    app._showPadEditor(pads[0]);
    const before = model.captureGeometry(), count = artwork().length;
    assert.equal(input('Size').value, '');
    input('Size').emit('input', pads[0].size);
    flushFrames();
    input('Size').emit('change');
    assert.equal(artwork().length, count, 'Unchanged selected pads regain canonical artwork on commit');
    assert.ok(pads.every(pad => pad.size === pads[0].size));
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    cancelPictureCopperRefresh(app);
    cases++;
}

{
    const { app, pads, input, model } = fixture(4);
    pads[1].rotation = 10;
    app._showPadEditor(pads[0]);
    assert.equal(input('Rotation').value, '');
    input('Rotation').emit('change');
    assert.equal(app.history.canUndo(), false, 'Untouched mixed fields do not author zero');
    input('Rotation').emit('change', -450.25);
    assert.ok(pads.every(pad => pad.rotation === 269.75), 'Change-only spinner events normalize rotation');
    input('Drill').emit('change', 100);
    assert.ok(pads.every(pad => pad.drill === pad.size), 'Drill remains constrained by the smallest selected size');
    const before = model.captureGeometry();
    input('Size').emit('input', '');
    input('Size').emit('change', '');
    assert.deepEqual(model.captureGeometry(), before);
    const stale = input('Ratio');
    input('Size').emit('input', 3);
    const copy = app.pads[0];
    app._showPadEditor(copy);
    assert.equal(getPadPropertyPreview(app), undefined);
    assert.equal(Number(input('Size').value), pads[0].size, 'Replacing the panel renders canonical values');
    stale.emit('change', 4);
    assert.deepEqual(model.captureGeometry(), before, 'Detached fields cannot restart an edit');
    cancelPictureCopperRefresh(app);
    cases++;
}
{
    const { app, input } = fixture();
    app._padDefaults = { shape: 'rectangle', size: 2, ratio: 2, drill: 1, rotation: 0, layers: 'both', net: '' };
    app._showPadEditor(null);
    input('Size').emit('input', 0.5);
    assert.equal(app._padDefaults.size, 0.5);
    assert.equal(app._padDefaults.drill, 0.5);
    input('Rotation').emit('change', -450.25);
    assert.equal(app._padDefaults.rotation, 269.75);
    assert.equal(getPadPropertyPreview(app), undefined);
    assert.equal(app.history.canUndo(), false, 'Placement defaults remain outside document history');
    const stale = input('Ratio');
    app._clearProperties();
    stale.emit('change', 4);
    assert.equal(app._padDefaults.ratio, 2, 'Detached default controls cannot alter the next tool');
    cases++;
}
console.log(`PASS ${cases} pad property isolation cases: numeric events, model/geometry isolation, stable previews, SVG, history and lifecycle`);
