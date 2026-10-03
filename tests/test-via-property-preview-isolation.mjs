import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { Via } from '../src/shapes/via.js';
import { Pad } from '../src/shapes/pad.js';
import { Track } from '../src/shapes/track.js';
import { renderVia, viaCopperPathD } from '../src/pcb/modules/track-render.js';
import { getViaPropertyPreview } from '../src/pcb/modules/track-commands.js';
import { createViaSelectionAdapter, showViaProperties, setHoverHighlight } from '../src/pcb/modules/track-select.js';
import { setPcbSelection, syncPcbSelection, getPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { prepareFabricationSnapshot } from '../src/pcb/modules/fabrication-snapshot.js';
import { loadPcb } from '../src/pcb/modules/project-state.js';
import { PCB_LAYERS } from '../src/pcb/modules/layers.js';
import { getPropertyEditor } from '../src/pcb/modules/property-editors.js';

let allocations = 0, frameId = 0, inputs = new Map();
const frames = new Map();
globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { setItem() {} };
function flushFrames() {
    for (const [id, callback] of [...frames]) { frames.delete(id); callback(); }
}
class Element {
    constructor(tag) {
        allocations++; this.tag = tag; this.children = []; this.attributes = new Map();
        this.dataset = {}; this.style = {}; this.listeners = new Map();
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    set className(value) { this.setAttribute('class', value); }
    get classList() {
        return {
            add: name => this.setAttribute('class', `${this.getAttribute('class') || ''} ${name}`.trim()),
            contains: name => (this.getAttribute('class') || '').split(' ').includes(name),
        };
    }
    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(callback);
    }
    focus() {}
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
    querySelectorAll(selector) {
        return this.children.flatMap(child => [
            ...(selector.startsWith('.') && child.classList.contains(selector.slice(1)) ? [child] : []),
            ...child.querySelectorAll(selector),
        ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
class Input extends Element {
    constructor(value) { super('input'); this.value = String(value); }
    emit(type, value = this.value, extra = {}) {
        this.value = String(value);
        const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...extra };
        for (const callback of this.listeners.get(type) || []) callback(event);
    }
}
globalThis.document = {
    createElementNS: (_, tag) => new Element(tag), createElement: tag => new Element(tag),
    getElementById: id => inputs.get(id) || null,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, body: new Element('body'),
};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { ModalManager } = await import('../src/core/ModalManager.js');

function fixture(count = 1, unrelatedCount = 1) {
    const project = new ProjectDocument(), model = project.pcbDocument;
    const vias = Array.from({ length: count }, (_, index) => new Via({
        x: Math.PI + index * 10, y: -Math.E, diameter: 1.234567891, drill: 0.456789123, net: 'GND',
    }));
    const unrelated = Array.from({ length: unrelatedCount }, (_, index) => new Via({ x: 100 + index, net: 'OTHER' }));
    const attached = new Track({ points: [{ x: vias[0].x, y: vias[0].y }, { x: 0, y: 0 }], net: 'GND' });
    model.vias.push(...vias, ...unrelated);
    model.tracks.push(attached);
    inputs = new Map();
    const items = {
        set innerHTML(html) {
            inputs = new Map();
            for (const match of html.matchAll(/<input\b([^>]+)>/g)) {
                const id = match[1].match(/id="([^"]+)"/)?.[1];
                if (id) inputs.set(id, new Input(match[1].match(/value="([^"]*)"/)?.[1] || ''));
            }
        },
        querySelector: selector => inputs.get(selector.slice(1)) || null,
    };
    const groups = new Map([['vias', new Element('g')]]);
    let fills = 0, clearances = 0;
    const app = {};
    for (const key of ['pads', 'vias', 'tracks', 'boardShapes', 'texts']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    for (const key of ['setPropertiesTitle', 'clearProperties', '_cancelPosePreviews', 'isSectionEditing',
        'deactivate', '_onLayerLockChanged', '_onLayerVisibilityChanged']) app[key] = PCBApp.prototype[key];
    Object.assign(app, {
        project, pcbDocument: model, placements: new Map(), netlist: [], history: new CommandHistory(),
        _active: true, _layerGroups: groups, _textElements: new Map(), _shapeElements: new Map(),
        viewport: { scale: 100, svg: new Element('svg'), shiftHeld: true, setCrosshair() {}, hideCrosshair() {} },
        propertiesItems: () => items, getLayerGroup: id => groups.get(id) || null,
        _setActiveRibbonTab() {}, setPcbStatus() {}, refreshFills() { fills++; },
        refreshClearanceHalos() { clearances++; },
        _cancelDrawingMode() {}, _ensureViewport() {}, markSectionClean() {},
        _refreshPcbSelectionHighlights() {}, _scheduleRemovalHatchRender() {},
    });
    project.registerView('pcb', app);
    setPcbSelection(app, vias.map(object => ({ kind: 'via', object })));
    for (const via of [...vias, unrelated[0]].filter(Boolean)) renderVia(via, app.getLayerGroup);
    showViaProperties(app, vias[0]);
    const artwork = () => groups.get('vias').children.filter(element => element.dataset.viaId);
    return { app, project, model, vias, unrelated, attached, groups, artwork,
        fills: () => fills, clearances: () => clearances, input: name => inputs.get(`pcbPropVia${name}`) };
}

let cases = 0;
for (const count of [1, 4]) for (const [name, key, value] of [
    ['Dia', 'diameter', 2.345678912], ['Drill', 'drill', 0.765432198],
]) {
    for (const finish of ['commit', 'cancel', 'no-op', 'panel', 'deactivate', 'load', 'failure', 'missing', 'lock', 'hide']) {
        const f = fixture(count);
        const { app, project, model, vias, unrelated, attached } = f;
        const input = f.input(name), original = model.captureGeometry(), serialized = model.serialize();
        const bounds = attached.getBounds(), originalArtwork = f.artwork().length;
        const otherArtwork = f.artwork().filter(element => element.dataset.viaId === unrelated[0].id);
        const baseline = vias.map(via => via.captureState()), redo = { execute() {}, undo() {} };
        app.history.redoStack.push(redo);
        const adapter = createViaSelectionAdapter(app, vias[0], `via:${vias[0].id}`);
        input.emit('input', vias[0][key]);
        assert.equal(getViaPropertyPreview(app), undefined);
        assert.equal(app.vias, model.vias, 'Identical values allocate no projection');
        input.emit('input', value);
        const collection = app.vias, copies = collection.slice(0, count);
        flushFrames();
        assert.equal(f.artwork().length, originalArtwork);
        for (let i = 0; i < count; i++) {
            assert.notEqual(copies[i], vias[i]);
            assert.equal(copies[i].id, vias[i].id);
        }
        assert.equal(collection[count], unrelated[0]);
        const rendered = allocations, scheduled = frameId;
        for (let i = 0; i < 100; i++) input.emit('input');
        flushFrames();
        assert.equal(allocations, rendered, 'Identical values do not redraw SVG or selection halos');
        assert.equal(frameId, scheduled, 'Identical values do not schedule frames');
        assert.equal(f.fills(), 0);
        assert.equal(f.clearances(), 0, 'Live fields retain the existing deferred derived work');
        assert.equal(app.vias, collection);
        assert.deepEqual(adapter.getBounds(), copies[0].getBounds());
        assert.equal(adapter.object, copies[0]);
        if (key === 'diameter') {
            const point = { x: vias[0].x + value * 0.49, y: vias[0].y };
            assert.equal(vias[0].hitTest(point), false);
            assert.equal(adapter.hitTest(point), true);
        }
        syncPcbSelection(app);
        assert.equal(getPcbSelection(app, 'via')[0], copies[0]);
        const rebuilt = createViaSelectionAdapter(app, copies[0], adapter.id);
        assert.deepEqual(rebuilt.getLockPosition({ x: 0, y: 0 }, 100), adapter.getLockPosition({ x: 0, y: 0 }, 100));
        assert.deepEqual(model.captureGeometry(), original);
        assert.deepEqual(model.serialize(), serialized);
        assert.equal(attached._bounds, bounds);
        assert.equal(app.isSectionEditing(), true);
        assert.throws(() => project.serialize(), /Finish the current edit before saving/);
        await assert.rejects(prepareFabricationSnapshot(app), /Finish the current edit before exporting/);
        if (finish === 'commit') {
            const execute = app.history.execute.bind(app.history);
            app.history.execute = command => {
                assert.equal(app.vias, model.vias);
                assert.equal(getViaPropertyPreview(app), undefined);
                assert.deepEqual(model.captureGeometry(), original, 'No authored rollback before command execution');
                for (const target of command.changes?.map(change => change.via) || [command.via]) {
                    assert.ok(vias.includes(target), 'Commands target canonical vias only');
                }
                execute(command);
            };
            input.emit('change');
            assert.equal(app.history.undoStack.length, 1);
            assert.equal(f.fills(), 1, 'Batch modification performs one derived refresh');
            assert.equal(f.clearances(), 1);
            const after = model.captureGeometry();
            app.history.undo();
            assert.deepEqual(model.captureGeometry(), original);
            app.history.redo();
            assert.deepEqual(model.captureGeometry(), after);
        } else if (finish === 'load') {
            loadPcb(app, null);
            input.emit('input', value + 1);
            input.emit('change');
        } else {
            if (finish === 'no-op') {
                input.emit('input', baseline[0][key]);
                input.emit('change');
            } else if (finish === 'panel') {
                app.clearProperties();
                input.emit('input', value + 1);
                input.emit('change');
            } else if (finish === 'deactivate') {
                app.deactivate();
                input.emit('input', value + 1);
                input.emit('change');
            } else if (finish === 'failure') {
                app.history.execute = () => { throw new Error('Rejected via property command'); };
                assert.throws(() => input.emit('change'), /Rejected via property command/);
            } else if (finish === 'missing') {
                model.vias.splice(count - 1, 1);
                assert.throws(() => input.emit('change'), /Cannot edit a missing via/);
                assert.deepEqual(vias.map(via => via.captureState()), baseline);
            } else if (finish === 'lock' || finish === 'hide') {
                const layer = PCB_LAYERS.find(layer => layer.id === 'vias');
                try {
                    if (finish === 'lock') { layer.locked = true; app._onLayerLockChanged('vias', true); }
                    else { layer.visible = false; app._onLayerVisibilityChanged('vias', false); }
                    input.emit('input', value + 1);
                } finally { layer.locked = false; layer.visible = true; }
            } else {
                for (const via of vias) Object.freeze(via);
                input.emit('keydown', input.value, { key: 'Escape' });
            }
            if (finish !== 'missing') {
                assert.deepEqual(model.captureGeometry(), original);
                assert.deepEqual(model.serialize(), serialized);
                assert.equal(f.fills(), 0);
                assert.equal(f.clearances(), 0);
            }
            assert.equal(app.history.canUndo(), false);
            assert.equal(app.history.redoStack[0], redo);
        }
        flushFrames();
        assert.equal(getViaPropertyPreview(app), undefined);
        assert.equal(app.isSectionEditing(), false);
        assert.equal(app.vias, model.vias);
        assert.equal(rebuilt.object, vias[0]);
        if (finish === 'load') assert.equal(f.artwork().length, 0);
        else {
            assert.deepEqual(f.artwork().filter(element => element.dataset.viaId === unrelated[0].id), otherArtwork);
            if (finish !== 'missing') assert.equal(f.artwork().length, originalArtwork);
            for (const via of model.vias.slice(0, count)) {
                for (const path of f.artwork().filter(element => element.dataset.viaId === via.id && element.tag === 'path')) {
                    assert.equal(path.getAttribute('d'), viaCopperPathD(via));
                }
            }
        }
        cases++;
    }
}

{
    const { app, vias, model, input } = fixture(4, 5000);
    const field = input('Dia'), before = model.captureGeometry();
    field.emit('input', 2);
    const collection = app.vias, copies = collection.slice(0, 4);
    for (let i = 0; i < 100; i++) {
        field.emit('input', 2 + i / 100);
        flushFrames();
        assert.equal(app.vias, collection);
        for (let j = 0; j < 4; j++) assert.equal(app.vias[j], copies[j]);
    }
    assert.deepEqual(model.captureGeometry(), before);
    assert.equal(getViaPropertyPreview(app).copies.size, 4);
    field.emit('change');
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    assert.equal(app.vias[0], vias[0]);
    cases++;
}

for (const count of [1, 4]) for (const next of ['net', 'drill', 'move']) {
    const { app, vias, attached, unrelated, model, input } = fixture(count);
    const original = model.captureGeometry();
    input('Dia').emit('input', 2);
    const rebuilt = createViaSelectionAdapter(app, app.vias[0], `via:${vias[0].id}`);
    if (next === 'net') {
        input('Net').emit('change', 'SIGNAL');
        assert.equal(attached.net, 'SIGNAL');
        assert.ok(vias.every(via => via.net === 'SIGNAL'));
        assert.equal(unrelated[0].net, 'OTHER');
    } else if (next === 'drill') {
        input('Drill').emit('change', 0.6);
    } else {
        rebuilt.beginMove({ x: vias[0].x, y: vias[0].y });
        rebuilt.updateMove({ x: vias[0].x + 3, y: vias[0].y + 2 });
        rebuilt.endMove(true);
    }
    assert.equal(getViaPropertyPreview(app), undefined);
    assert.equal(app.history.undoStack.length, 2);
    app.history.undo();
    assert.ok(vias.every(via => via.diameter === 2));
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), original);
    cases++;
}

for (const commit of [false, true]) {
    const { app, model, input, artwork } = fixture(4);
    const before = model.captureGeometry(), count = artwork().length;
    input('Dia').emit('input', 2);
    assert.ok(frames.size);
    if (commit) input('Dia').emit('change');
    else getPropertyEditor(app, 'via').cancel();
    const rendered = allocations;
    flushFrames();
    assert.equal(allocations, rendered);
    assert.equal(artwork().length, count);
    if (!commit) assert.deepEqual(model.captureGeometry(), before);
    cases++;
}

{
    const { app, vias, model, input, artwork } = fixture(4);
    vias[1].diameter = 3;
    vias[2].drill = 0.8;
    showViaProperties(app, vias[0]);
    const before = model.captureGeometry(), count = artwork().length;
    assert.equal(input('Dia').value, '');
    assert.equal(input('Drill').value, '');
    input('Dia').emit('change');
    input('Drill').emit('change');
    assert.equal(app.history.canUndo(), false, 'Untouched mixed fields remain unchanged');
    input('Dia').emit('input', vias[0].diameter);
    flushFrames();
    input('Dia').emit('change');
    assert.equal(artwork().length, count, 'Partly unchanged selections regain every canonical SVG');
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    input('Dia').emit('change', 0.1);
    assert.ok(vias.every(via => via.diameter === 0.8), 'Diameter clamps to the largest selected drill');
    assert.equal(artwork().length, count, 'Unchanged selected targets retain artwork on batch commit');
    input('Drill').emit('change', 10);
    assert.ok(vias.every(via => via.drill === 0.8), 'Drill clamps to the smallest selected diameter');
    app.history.undo();
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    input('Dia').emit('change', 2);
    app.history.undo();
    input('Dia').emit('change', 2.25);
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), before, 'New edits after undo snapshot current model values, not panel-open values');
    const stale = input('Dia');
    input('Dia').emit('input', 2);
    const copy = app.vias[0];
    showViaProperties(app, copy);
    assert.equal(getViaPropertyPreview(app), undefined);
    stale.emit('change', 4);
    assert.deepEqual(model.captureGeometry(), before);
    for (const invalid of ['', 'bad', 'Infinity']) input('Dia').emit('change', invalid);
    assert.deepEqual(model.captureGeometry(), before);
    cases++;
}

{
    const { app, vias, unrelated, input, groups } = fixture(1);
    unrelated[0].net = 'GND';
    input('Dia').emit('input', 2);
    flushFrames();
    setHoverHighlight(app, { type: 'via', via: vias[0] });
    assert.equal(groups.get('vias').querySelectorAll('.pcb-track-hover').length, 1,
        'Canonical hover seeds resolve to the selected copy instead of adding a duplicate halo');
    setHoverHighlight(app, null);
    input('Dia').emit('keydown', input('Dia').value, { key: 'Escape' });
    setHoverHighlight(app, { type: 'via', via: vias[0] });
    assert.equal(groups.get('vias').querySelectorAll('.pcb-track-hover').length, 1);
    cases++;
}

{
    const { app, vias, input, model } = fixture(1);
    model.pads.push(new Pad({ x: 0, y: 0, net: 'GND' }));
    const before = model.captureGeometry();
    input('Dia').emit('input', 2);
    input('Net').emit('change', 'FORBIDDEN');
    assert.equal(vias[0].net, 'GND');
    assert.equal(input('Net').value, 'GND');
    assert.equal(app.history.undoStack.length, 1, 'Refused net change leaves the independently committed numeric field');
    assert.ok(ModalManager.top(), 'Schematic net conflict is explicitly reported');
    ModalManager.top().onEscape();
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    cases++;
}
{
    const { app, vias, input } = fixture(4);
    input('Dia').emit('input', 2);
    const execute = app.history.execute.bind(app.history);
    app.history.execute = command => {
        if (app.history.undoStack.length) throw new Error('Rejected via net command');
        execute(command);
    };
    assert.throws(() => input('Net').emit('change', 'SIGNAL'), /Rejected via net command/);
    assert.equal(input('Net').value, 'GND');
    assert.ok(vias.every(via => via.net === 'GND' && via.diameter === 2));
    assert.equal(app.history.undoStack.length, 1);
    assert.equal(app.isSectionEditing(), false);
    assert.equal(getViaPropertyPreview(app), undefined);
    cases++;
}
for (const count of [1, 4]) for (const [field, value] of [['Dia', 2], ['Drill', 0.6]]) {
    for (const invalid of ['', 'bad', '2junk', 'Infinity', '-Infinity', ...(field === 'Drill' ? ['0', '-1'] : [])]) {
        for (const finish of ['change', 'blur', 'binding', 'pointer', 'cancel', 'net']) {
            const f = fixture(count), { app, model, vias } = f;
            const input = f.input(field), before = model.captureGeometry();
            const redo = { execute() {}, undo() {} };
            app.history.redoStack.push(redo);
            input.emit('input', value);
            input.emit('input', invalid);
            if (finish === 'binding') getPropertyEditor(app, 'via').commit();
            else if (finish === 'pointer') {
                const adapter = createViaSelectionAdapter(app, vias[0], vias[0].id);
                assert.equal(adapter.beginMove(vias[0]), true);
                adapter.updateMove({ x: vias[0].x + 3, y: vias[0].y + 2 });
                adapter.endMove(false);
            } else if (finish === 'cancel') input.emit('keydown', input.value, { key: 'Escape' });
            else if (finish === 'net') f.input('Net').emit('change', 'SIGNAL');
            else input.emit(finish);
            await Promise.resolve();
            flushFrames();
            assert.equal(getViaPropertyPreview(app), undefined, `${field}: ${finish} ends invalid preview`);
            assert.equal(app.isSectionEditing(), false);
            assert.equal(app.history.undoStack.length, finish === 'net' ? 1 : 0);
            assert.ok(Number.isFinite(Number(input.value)) && input.value !== '', 'Invalid text is restored');
            if (finish === 'net') app.history.undo();
            else assert.equal(app.history.redoStack[0], redo, 'Rejected numeric completion preserves redo');
            assert.deepEqual(model.captureGeometry(), before, `${field}: ${finish} rejects intermediate value`);
            cases++;
        }
    }
}

for (const invalidFirst of [false, true]) for (const invalidSecond of [false, true]) {
    const f = fixture(4), { app, model, vias } = f;
    const before = model.captureGeometry(), diameter = f.input('Dia'), drill = f.input('Drill');
    diameter.emit('input', 2);
    if (invalidFirst) diameter.emit('input', '');
    diameter.emit('blur');
    drill.emit('input', invalidSecond ? '' : 1.8);
    assert.ok(vias.every(via => via.diameter === (invalidFirst ? 1.234567891 : 2)));
    await Promise.resolve();
    assert.equal(!!getViaPropertyPreview(app), !invalidSecond, 'Old blur does not finish the new field');
    if (!invalidSecond) {
        const expected = invalidFirst ? 1.234567891 : 1.8;
        assert.equal(Number(drill.value), expected, 'Clamp against canonical limits after rejected diameter handoff');
        assert.ok(app.vias.slice(0, 4).every(via => via.drill === expected));
    }
    drill.emit('change');
    assert.equal(app.history.undoStack.length, Number(!invalidFirst) + Number(!invalidSecond));
    while (app.history.canUndo()) app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    cases++;
}

for (const finish of ['binding', 'blur', 'pointer']) {
    const f = fixture(), { app, model, vias } = f;
    const before = model.captureGeometry(), input = f.input('Dia');
    input.emit('input', 2);
    if (finish === 'binding') getPropertyEditor(app, 'via').commit();
    else if (finish === 'blur') { input.emit('blur'); await Promise.resolve(); }
    else {
        const adapter = createViaSelectionAdapter(app, vias[0], vias[0].id);
        assert.equal(adapter.beginMove(vias[0]), true);
        adapter.updateMove({ x: vias[0].x + 3, y: vias[0].y + 2 });
        adapter.endMove(false);
    }
    assert.equal(vias[0].diameter, 2);
    assert.equal(app.history.undoStack.length, 1, 'Valid handoff commits exactly once');
    input.emit('change');
    assert.equal(app.history.undoStack.length, 1);
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    cases++;
}

for (const moves of [1, 2, 5]) for (const commit of [false, true]) {
    const f = fixture(), { app, model, vias, attached } = f;
    const before = model.captureGeometry(), adapter = createViaSelectionAdapter(app, vias[0], vias[0].id);
    app.viewport.shiftHeld = false;
    assert.equal(adapter.beginMove(vias[0]), true);
    for (let i = 0; i < moves; i++) adapter.updateMove({ x: 0, y: 0 });
    assert.equal(app._viaDrag.snapTargetTrack.track, attached, 'Snap target retains canonical track identity');
    assert.deepEqual(model.captureGeometry(), before, 'Snapping does not mutate authored geometry');
    adapter.endMove(commit);
    assert.equal(app._viaDrag, null);
    assert.equal(app.history.undoStack.length, commit ? 1 : 0);
    if (commit) {
        assert.equal(vias[0].x, 0);
        assert.equal(vias[0].y, 0);
        const after = model.captureGeometry();
        app.history.undo();
        assert.deepEqual(model.captureGeometry(), before);
        app.history.redo();
        assert.deepEqual(model.captureGeometry(), after);
    } else assert.deepEqual(model.captureGeometry(), before);
    cases++;
}

console.log(`PASS ${cases} via property isolation cases: model/geometry isolation, work counts, SVG/hover, precise history, constraints and lifecycle`);
