import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { formatNumberInputValue } from '../src/core/number-inputs.js';
import { getPadToolDefaults, setPadToolDefaults } from '../src/pcb/modules/pad-tool.js';

installFakeDom();

let allocations = 0, frameId = 0, timerId = 0;
const frames = new Map(), timers = new Map();
globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
globalThis.setTimeout = callback => { timers.set(++timerId, callback); return timerId; };
globalThis.clearTimeout = id => timers.delete(id);
globalThis.window.requestAnimationFrame = globalThis.requestAnimationFrame;
globalThis.window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
function flushFrames() {
    for (const [id, callback] of [...frames]) { frames.delete(id); callback(); }
}
const createElementNS = document.createElementNS.bind(document);
document.createElementNS = (namespace, tag) => {
    allocations++;
    const element = createElementNS(namespace, tag);
    element.tag = tag;
    return element;
};
function resetPanel() {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    const panel = document.createElement('div');
    panel.id = 'pcbPropertiesPanel';
    const items = document.createElement('div');
    items.id = 'pcbPropsItems';
    panel.appendChild(items);
    document.body.appendChild(panel);
    return items;
}
function fire(control, type, extra = {}) {
    control.dispatchEvent({ type, ...extra });
}
function withEmit(control) {
    control.emit ??= (type, value = control.value, extra = {}) => {
        control.value = String(value);
        fire(control, type, extra);
    };
    return control;
}

const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { ProjectDocument } = await import('../src/core/ProjectDocument.js');
const { CommandHistory } = await import('../src/core/CommandHistory.js');
const { Pad } = await import('../src/shapes/pad.js');
const { Track } = await import('../src/shapes/track.js');
const { renderPad, padCopperPathD } = await import('../src/pcb/modules/pad.js');
const { getPadPropertyPreview } = await import('../src/pcb/modules/pad-commands.js');
const { createPadSelectionAdapter } = await import('../src/pcb/modules/pad-selection.js');
const { setPcbSelection, syncPcbSelection, getPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const { prepareFabricationSnapshot } = await import('../src/pcb/modules/fabrication-snapshot.js');
const { loadPcb } = await import('../src/pcb/modules/project-state.js');
const { PCB_LAYERS, notifyLayerVisibilityChanged, notifyLayerLockChanged } = await import('../src/pcb/modules/layers.js');
const { cancelPictureCopperRefresh } = await import('../src/pcb/modules/picture-refresh.js');
const { getPropertyEditor } = await import('../src/pcb/modules/property-editors.js');
const { flushSettledChanges } = await import('../src/shared/ui/settled-input.js');

function fixture(count = 1, layers = 'both', unrelatedCount = 1) {
    const items = resetPanel();
    const project = new ProjectDocument(), model = project.pcbDocument;
    const pads = Array.from({ length: count }, (_, index) => new Pad({
        x: Math.PI + index * 10, y: -Math.E, shape: 'rectangle', layers,
        size: 2.123456789, ratio: 2.345678901, drill: 0.456789123, rotation: 37.123456789,
    }));
    const unrelated = Array.from({ length: unrelatedCount }, (_, index) => new Pad({ x: 100 + index }));
    const attached = new Track({ points: [{ x: pads[0].x, y: pads[0].y }, { x: 0, y: 0 }] });
    model.pads.push(...pads, ...unrelated);
    model.tracks.push(attached);
    const groups = new Map(['top-copper', 'bottom-copper', 'top-copper-pad-drills', 'bottom-copper-pad-drills']
        .map(id => [id, document.createElementNS('http://www.w3.org/2000/svg', 'g')]));
    const app = {};
    for (const key of ['pads', 'vias', 'tracks', 'boardShapes', 'texts']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    for (const key of ['_showPadEditor', 'openPropertyPanel', 'refreshPropertyPanel', 'showPropertiesTab', 'netNames',
        'setPropertiesTitle', 'clearProperties', '_cancelPosePreviews', 'isSectionEditing', 'deactivate',
        ]) app[key] = PCBApp.prototype[key];
    Object.assign(app, {
        project, pcbDocument: model, placements: new Map(), netlist: [], history: new CommandHistory(),
        _layerGroups: new Map(), existingLayerGroups() { return this._layerGroups; }, _shapeElements: new Map(),
        viewport: { scale: 100, svg: document.createElementNS('http://www.w3.org/2000/svg', 'svg'), shiftHeld: true, setCrosshair() {}, hideCrosshair() {} },
        propertiesItems: () => items, getLayerGroup: id => groups.get(id) || null,
        setActiveRibbonTab() {}, setPcbStatus() {}, refreshFills() {}, refreshClearanceHalos() {},
        _cancelDrawingMode() {}, _ensureViewport() {}, markSectionClean() {},
        _refreshPcbSelectionHighlights() {},
    });
    project.registerView('pcb', app);
    setPcbSelection(app, pads.map(object => ({ kind: 'pad', object })));
    for (const pad of [...pads, unrelated[0]].filter(Boolean)) renderPad(pad, app.getLayerGroup);
    app._showPadEditor(pads[0]);
    const artwork = () => [...groups.values()].flatMap(group => group.children);
    return { app, project, model, pads, unrelated, attached, artwork,
        input: name => withEmit(document.getElementById(`pcbPropPad${name}`)) };
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
            for (let i = 0; i < 100; i++) input.emit('input', value);
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
                flushSettledChanges();
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
                flushSettledChanges();
            } else {
                if (finish === 'no-op') {
                    input.emit('input', baseline[0][property]);
                    input.emit('change');
                    flushSettledChanges();
                } else if (finish === 'panel') {
                    app.clearProperties();
                    input.emit('input', value + 1);
                    input.emit('change');
                    flushSettledChanges();
                } else if (finish === 'deactivate') {
                    app.deactivate();
                    input.emit('input', value + 1);
                    input.emit('change');
                    flushSettledChanges();
                } else if (finish === 'failure') {
                    app.history.execute = () => { throw new Error('Rejected pad property command'); };
                    assert.throws(() => { input.emit('change'); flushSettledChanges(); }, /Rejected pad property command/);
                } else if (finish === 'missing') {
                    model.pads.splice(count - 1, 1);
                    assert.throws(() => { input.emit('change'); flushSettledChanges(); }, /Cannot edit a missing pad/);
                    assert.deepEqual(pads.map(pad => pad.captureState()), baseline, 'Preflight checks every target before commands');
                } else if (finish === 'lock' || finish === 'hide') {
                    const layer = PCB_LAYERS.find(layer => layer.id === (layers === 'both' ? 'top-copper' : layers));
                    try {
                        if (finish === 'lock') {
                            layer.locked = true;
                            notifyLayerLockChanged(app, layer.id, true);
                        } else {
                            layer.visible = false;
                            notifyLayerVisibilityChanged(app, layer.id, false);
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
    flushSettledChanges();
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
    flushSettledChanges();
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
    else getPropertyEditor(app, 'pad').cancel();
    if (commit) flushSettledChanges();
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
    flushSettledChanges();
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
    flushSettledChanges();
    assert.equal(app.history.canUndo(), false, 'Untouched mixed fields do not author zero');
    input('Rotation').emit('change', -450.25);
    flushSettledChanges();
    assert.ok(pads.every(pad => pad.rotation === 269.75), 'Change-only spinner events normalize rotation');
    input('Drill').emit('change', 100);
    flushSettledChanges();
    assert.ok(pads.every(pad => pad.drill === pad.size), 'Drill remains constrained by the smallest selected size');
    const before = model.captureGeometry();
    input('Size').emit('input', '');
    input('Size').emit('change', '');
    flushSettledChanges();
    assert.deepEqual(model.captureGeometry(), before);
    const stale = input('Ratio');
    input('Size').emit('input', 3);
    const copy = app.pads[0];
    app._showPadEditor(copy);
    assert.equal(getPadPropertyPreview(app), undefined);
    assert.equal(input('Size').value, formatNumberInputValue(pads[0].size), 'Replacing the panel renders canonical values');
    stale.emit('change', 4);
    assert.deepEqual(model.captureGeometry(), before, 'Detached fields cannot restart an edit');
    cancelPictureCopperRefresh(app);
    cases++;
}
{
    const { app, input } = fixture();
    setPadToolDefaults(app, { shape: 'rectangle', size: 2, ratio: 2, drill: 1, rotation: 0, layers: 'both', net: '' });
    app._showPadEditor(null);
    input('Size').emit('input', 0.5);
    assert.equal(getPadToolDefaults(app).size, 0.5);
    assert.equal(getPadToolDefaults(app).drill, 0.5);
    input('Rotation').emit('change', -450.25);
    assert.equal(getPadToolDefaults(app).rotation, 269.75);
    assert.equal(getPadPropertyPreview(app), undefined);
    assert.equal(app.history.canUndo(), false, 'Placement defaults remain outside document history');
    const stale = input('Ratio');
    app.clearProperties();
    stale.emit('change', 4);
    assert.equal(getPadToolDefaults(app).ratio, 2, 'Detached default controls cannot alter the next tool');
    cases++;
}
for (const count of [1, 4]) for (const value of ['', '-', 'Infinity', '0.01', '3']) {
    for (const handoff of ['change', 'commit', 'Shape', 'Ratio', 'move', 'rotate']) {
        const { app, pads, model, input } = fixture(count);
        const before = model.captureGeometry(), originalSize = pads[0].size;
        const sizeInput = input('Size');
        sizeInput.emit('input', 3);
        sizeInput.emit('input', value);
        const valid = value === '3', additional = !['change', 'commit'].includes(handoff);
        if (handoff === 'change') sizeInput.emit('change', value);
        else if (handoff === 'commit') {
            if (valid) getPropertyEditor(app, 'pad').commit();
            else {
                sizeInput.emit('change', value);
                flushSettledChanges();
            }
        } else {
            if (!valid) {
                sizeInput.emit('change', value);
                flushSettledChanges();
            }
            if (handoff === 'Shape') input('Shape').emit('change', 'oval');
            else if (handoff === 'Ratio') input('Ratio').emit('change', 4);
        }
        if (handoff === 'move' || handoff === 'rotate') {
            const adapter = createPadSelectionAdapter(app, pads[0], `pad:${pads[0].id}`);
            const start = { x: pads[0].x + 10, y: pads[0].y };
            if (handoff === 'move') {
                adapter.beginMove(start);
                adapter.updateMove({ x: start.x + 2, y: start.y });
                adapter.endMove(true);
            } else {
                adapter.beginAnchorDrag('rotate', start);
                adapter.updateAnchorDrag({ x: pads[0].x, y: pads[0].y - 10 });
                adapter.endAnchorDrag(true);
            }
        }
        flushSettledChanges();
        assert.equal(getPadPropertyPreview(app), undefined);
        assert.ok(pads.every(pad => pad.size === (valid ? 3 : originalSize)),
            `${count}/${value}/${handoff}: pad sizes follow valid source edits only`);
        assert.equal(app.history.undoStack.length, Number(valid) + Number(additional),
            `${handoff}: history contains only valid source/destination edits`);
        while (app.history.canUndo()) app.history.undo();
        assert.deepEqual(model.captureGeometry(), before);
        cancelPictureCopperRefresh(app);
        cases++;
    }
}
console.log(`PASS ${cases} pad property isolation cases: numeric events, model/geometry isolation, stable previews, SVG, history and lifecycle`);
