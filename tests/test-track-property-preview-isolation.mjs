import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { Track } from '../src/shapes/track.js';
import { Via } from '../src/shapes/via.js';
import { renderTrack, buildTrackLayerRuns } from '../src/pcb/modules/track-render.js';
import { getTrackPropertyPreview, RemoveTrackCommand } from '../src/pcb/modules/track-commands.js';
import { createTrackSelectionAdapter, selectTrackOrVia, selectTrackSegment, selectTrackNode,
    showTrackSelectionProperties, setHoverHighlight } from '../src/pcb/modules/track-select.js';
import { startVertexDrag, startMidpointInsertDrag, splitTrackNodeAndDrag, cancelVertexDrag,
    startViaDrag, cancelViaDrag } from '../src/pcb/modules/track-drag.js';
import { syncPcbSelection, getPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { prepareFabricationSnapshot } from '../src/pcb/modules/fabrication-snapshot.js';
import { loadPcb } from '../src/pcb/modules/project-state.js';
import { PCB_LAYERS } from '../src/pcb/modules/layers.js';
import { formatNumberInputValue } from '../src/core/number-inputs.js';
import { getPropertyEditor } from '../src/pcb/modules/property-editors.js';
import { renderPropertyFields } from '../src/shared/ui/property-fields.js';
import { flushSettledChanges } from '../src/shared/ui/settled-input.js';
import { getSelectionInteraction } from '../src/pcb/modules/selection-interaction.js';
import { getVertexDrag } from '../src/pcb/modules/track-drag.js';
import { setPcbInteraction } from '../src/pcb/modules/pcb-interactions.js';

let allocations = 0, inputs = new Map();
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { setItem() {} };
class Element {
    constructor(tag) {
        allocations++; this.tag = tag; this.children = []; this.attributes = new Map();
        this.dataset = {}; this.style = {}; this.listeners = new Map();
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
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
    append(...children) { for (const child of children) this.appendChild(child); }
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
    removeChild(child) {
        this.children.splice(this.children.indexOf(child), 1);
        child.parentNode = null;
        return child;
    }
    dispatchEvent(event) {
        for (const callback of this.listeners.get(event.type) || []) callback(event);
        return true;
    }
    emit(type, value = this.value, extra = {}) {
        if (value !== undefined) this.value = String(value);
        return this.dispatchEvent({ type, target: this, preventDefault() {}, stopPropagation() {}, ...extra });
    }
    focus() { document.activeElement = this; }
    get valueAsNumber() { return this.value?.trim?.() === '' ? NaN : Number(this.value); }
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
    get valueAsNumber() { return this.value.trim() === '' ? NaN : Number(this.value); }
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

function fixture(scope = 'whole', unrelatedCount = 1) {
    const project = new ProjectDocument(), model = project.pcbDocument;
    const track = new Track({ net: 'GND', width: 0.234567891, cornerRadius: 0.345678912,
        points: [{ x: Math.PI, y: -Math.E }, { x: 20, y: -Math.E }, { x: 20, y: 20 }],
        sourceBoardShape: { id: 'source', kind: 'line', points: [{ x: Math.PI, y: -Math.E }] } });
    const edgeId = track.edges.keys().next().value, nodeId = [...track.nodes.keys()][1];
    if (scope === 'bulge') track.setEdgeAttr(edgeId, 'bulge', 0.25);
    track.padConnections.set(track.nodes.keys().next().value, { componentId: 'U1', pinNumber: '1' });
    const unrelated = Array.from({ length: unrelatedCount }, (_, index) => new Track({
        points: [{ x: 100 + index, y: 100 }, { x: 101 + index, y: 100 }], net: 'OTHER' }));
    model.tracks.push(track, ...unrelated);
    inputs = new Map();
    const items = new Element('div');
    const groups = new Map(['top-copper', 'bottom-copper', 'selection-overlay'].map(id => [id, new Element('g')]));
    let fills = 0, clearances = 0;
    const app = {};
    for (const key of ['pads', 'vias', 'tracks', 'boardShapes', 'texts']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    for (const key of ['setPropertiesTitle', 'clearProperties', '_cancelPosePreviews', 'isSectionEditing',
        'deactivate', '_onLayerLockChanged', '_onLayerVisibilityChanged']) app[key] = PCBApp.prototype[key];
    Object.assign(app, {
        project, pcbDocument: model, placements: new Map(), netlist: [], history: new CommandHistory(),
        _active: true, _layerGroups: groups, existingLayerGroups() { return this._layerGroups; }, _shapeElements: new Map(),
        viewport: { scale: 100, svg: new Element('svg'), shiftHeld: true, setCrosshair() {}, hideCrosshair() {} },
        propertiesItems: () => items, getLayerGroup: id => groups.get(id) || null,
        openPropertyPanel(panel) { this.setPropertiesTitle?.(panel.title); this.refreshPropertyPanel(panel); this.showPropertiesTab?.(); return true; },
        refreshPropertyPanel(panel) {
            const controls = renderPropertyFields(items, panel.fields, { placeholder: panel.placeholder });
            inputs = new Map([...controls.values()].filter(control => control.id).map(control => [control.id, control]));
        },
        setActiveRibbonTab() {}, setPcbStatus() {}, refreshFills() { fills++; },
        refreshClearanceHalos() { clearances++; },
        _cancelDrawingMode() {}, _ensureViewport() {}, markSectionClean() {},
        _refreshPcbSelectionHighlights() {},
    });
    project.registerView('pcb', app);
    for (const object of [track, unrelated[0]].filter(Boolean)) renderTrack(object, app.getLayerGroup);
    selectTrackOrVia(app, { type: 'track', track });
    if (scope === 'node') selectTrackNode(app, track, nodeId);
    else if (scope !== 'whole') selectTrackSegment(app, track, edgeId);
    const artwork = (object = track) => [...groups.values()].flatMap(group => group.children)
        .filter(element => element.dataset.trackId === object.id && element.tag === 'polyline');
    const assertArtwork = object => {
        const runs = buildTrackLayerRuns(object), actual = artwork(object);
        assert.equal(actual.length, runs.length, 'Exactly one SVG polyline per rendered run');
        for (let i = 0; i < runs.length; i++) {
            assert.equal(actual[i].getAttribute('points'), runs[i].points.map(point => `${point.x},${point.y}`).join(' '));
            assert.equal(actual[i].getAttribute('stroke-width'), String(runs[i].width));
        }
    };
    return { app, project, model, track, edgeId, nodeId, unrelated, groups, artwork, assertArtwork,
        fills: () => fills, clearances: () => clearances, input: name => inputs.get(`pcbPropTrack${name}`) };
}

let cases = 0;
for (const [scope, field, value] of [
    ['whole', 'Width', 2.345678912], ['segment', 'Width', 2.345678912],
    ['whole', 'CornerRadius', 4.567891234], ['node', 'CornerRadius', 4.567891234],
    ['bulge', 'Bulge', 0.54321987],
]) for (const finish of ['commit', 'cancel', 'no-op', 'panel', 'deactivate', 'load', 'failure', 'missing', 'lock', 'hide', 'shared']) {
    const f = fixture(scope), { app, project, model, track, edgeId, nodeId } = f;
    const input = f.input(field), original = model.captureGeometry(), serialized = model.serialize();
    const before = track.captureState(), bounds = track.getBounds(), runs = buildTrackLayerRuns(track);
    const references = [track.nodes, track.edges, track.nodeCornerRadii, track.padConnections, track.sourceBoardShape];
    const initialValue = field === 'Width' ? track.width : field === 'Bulge' ? track.edges.get(edgeId).bulge
        : scope === 'node' ? track.nodeCornerRadius(nodeId) : track.cornerRadius;
    const redo = { execute() {}, undo() {} };
    app.history.redoStack.push(redo);
    const adapter = createTrackSelectionAdapter(app, track, track.id), otherArtwork = f.artwork(f.unrelated[0]);
    const anchors = adapter.getAnchors();
    if (finish === 'cancel') {
        for (const value of [...track.nodes.values(), ...track.edges.values(), track.nodeCornerRadii]) Object.freeze(value);
        Object.freeze(track);
    }
    input.emit('input', initialValue);
    const idleWork = [allocations, f.fills(), f.clearances()];
    for (const invalid of ['', 'invalid', 'Infinity']) input.emit('input', invalid);
    assert.deepEqual([allocations, f.fills(), f.clearances()], idleWork);
    assert.equal(getTrackPropertyPreview(app), undefined);
    assert.equal(app.tracks, model.tracks);
    input.emit('input', value);
    const collection = app.tracks, copy = collection[0];
    assert.notEqual(copy, track);
    assert.equal(copy.id, track.id);
    assert.deepEqual(copy.nodes, track.nodes);
    assert.deepEqual(copy.padConnections, track.padConnections);
    assert.deepEqual(copy.sourceBoardShape, track.sourceBoardShape);
    assert.notEqual(copy.sourceBoardShape, track.sourceBoardShape);
    assert.equal(collection[1], f.unrelated[0]);
    assert.equal(adapter.object, copy);
    assert.deepEqual(adapter.getBounds(), copy.getBounds());
    assert.notDeepEqual(buildTrackLayerRuns(copy), runs, 'Live numeric field changes rendered copper paths/widths');
    assert.deepEqual(model.captureGeometry(), original);
    assert.deepEqual(model.serialize(), serialized);
    assert.equal(track.getBounds(), bounds);
    assert.deepEqual(track.captureState(), before);
    [track.nodes, track.edges, track.nodeCornerRadii, track.padConnections, track.sourceBoardShape]
        .forEach((reference, index) => assert.equal(reference, references[index]));
    assert.equal(app.isSectionEditing(), true);
    assert.throws(() => project.serialize(), /current edit/i);
    await assert.rejects(prepareFabricationSnapshot(app), /current edit/i);
    f.assertArtwork(copy);
    syncPcbSelection(app);
    const rebuilt = createTrackSelectionAdapter(app, copy, track.id);
    assert.equal(getPcbSelection(app, 'track')[0], copy);
    assert.equal(rebuilt.object, copy);
    assert.deepEqual(rebuilt.getLockPosition({ x: 0, y: 0 }, 100), adapter.getLockPosition({ x: 0, y: 0 }, 100));
    if (field === 'Width') {
        const point = { x: 10, y: -Math.E + value * 0.4 };
        assert.equal(track.hitTest(point, 0), false);
        assert.equal(adapter.hitTest(point, 0), true);
    }
    if (field === 'Bulge') assert.notDeepEqual(adapter.getAnchors(), anchors);
    if (scope !== 'whole') assert.equal(app._trackEdit.track, track);
    setHoverHighlight(app, { type: 'track', track });
    assert.equal(f.groups.get('top-copper').querySelectorAll('.pcb-track-hover').length, 0);
    const work = [allocations, f.fills(), f.clearances()];
    for (let i = 0; i < 5; i++) input.emit('input', value);
    assert.deepEqual([allocations, f.fills(), f.clearances()], work, 'Identical inputs do no SVG/derived work');
    assert.equal(app.tracks, collection);
    if (finish === 'commit') {
        const execute = app.history.execute.bind(app.history);
        app.history.execute = command => {
            assert.equal(command.track, track);
            assert.equal(getTrackPropertyPreview(app), undefined);
            assert.deepEqual(model.captureGeometry(), original, 'Command begins without a canonical rollback');
            execute(command);
        };
        input.emit('change');
        flushSettledChanges();
        assert.equal(app.history.undoStack.length, 1);
        const after = model.captureGeometry();
        assert.notDeepEqual(after, original);
        app.history.undo();
        assert.deepEqual(model.captureGeometry(), original);
        app.history.redo();
        assert.deepEqual(model.captureGeometry(), after);
    } else if (finish === 'load') {
        loadPcb(app, null);
        input.emit('input', value + 1);
        input.emit('change');
        flushSettledChanges();
    } else {
        if (finish === 'no-op') {
            input.emit('input', initialValue);
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
            app.history.execute = () => { throw new Error('Rejected track property command'); };
            assert.throws(() => { input.emit('change'); flushSettledChanges(); }, /Rejected track property command/);
        } else if (finish === 'missing') {
            model.tracks.shift();
            assert.throws(() => { input.emit('change'); flushSettledChanges(); }, /Cannot edit a missing track/);
        } else if (finish === 'lock' || finish === 'hide') {
            const layer = PCB_LAYERS.find(layer => layer.id === 'top-copper');
            try {
                if (finish === 'lock') { layer.locked = true; app._onLayerLockChanged(layer.id, true); }
                else { layer.visible = false; app._onLayerVisibilityChanged(layer.id, false); }
                input.emit('input', value + 1);
            } finally { layer.locked = false; layer.visible = true; }
        } else if (finish === 'shared') app._cancelPosePreviews();
        else {
            input.emit('keydown', input.value, { key: 'Escape' });
            input.emit('change');
            input.emit('blur');
        }
        if (finish !== 'missing') {
            assert.deepEqual(model.captureGeometry(), original);
            assert.deepEqual(model.serialize(), serialized);
        }
        assert.deepEqual(track.captureState(), before);
        assert.equal(app.history.canUndo(), false);
        assert.equal(app.history.redoStack[0], redo);
    }
    assert.equal(getTrackPropertyPreview(app), undefined);
    assert.equal(app.isSectionEditing(), false);
    assert.equal(app.tracks, model.tracks);
    assert.equal(rebuilt.object, track);
    if (finish === 'load' || finish === 'missing') assert.equal(f.artwork().length, 0);
    else f.assertArtwork(track);
    if (finish !== 'load') assert.deepEqual(f.artwork(f.unrelated[0]), otherArtwork);
    cases++;
}

{
    const f = fixture('whole', 5000), { app, model, track } = f;
    const input = f.input('CornerRadius'), original = model.captureGeometry();
    input.emit('input', 1);
    const collection = app.tracks, copy = collection[0], nodes = copy.nodes, edges = copy.edges;
    for (let i = 0; i < 100; i++) {
        input.emit('input', 1 + i / 100);
        assert.equal(app.tracks, collection);
        assert.equal(app.tracks[0], copy);
        assert.equal(copy.nodes, nodes);
        assert.equal(copy.edges, edges);
    }
    assert.deepEqual(model.captureGeometry(), original);
    input.emit('change');
    flushSettledChanges();
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), original);
    assert.equal(app.tracks[0], track);
    cases++;
}

for (const next of ['width', 'net', 'move', 'midpoint', 'split', 'bulge', 'delete', 'via']) {
    const f = fixture(next === 'bulge' ? 'bulge' : 'whole'), { app, model, track, edgeId, nodeId } = f;
    const input = f.input(next === 'bulge' ? 'Width' : 'CornerRadius');
    input.emit('input', 2);
    const copy = app.tracks[0];
    if (next === 'width') {
        f.input('Width').emit('input', 3.456789123);
        assert.equal(track.cornerRadius, 2);
        assert.equal(track.width, 0.234567891);
        assert.equal(app.tracks[0].width, 3.456789123);
        assert.equal(f.input('Width').value, formatNumberInputValue(3.456789123));
        f.input('Width').emit('change');
        flushSettledChanges();
        assert.equal(app.history.undoStack.length, 2);
    } else if (next === 'net') {
        f.input('Net').emit('change', 'POWER');
        assert.equal(track.cornerRadius, 2);
        assert.equal(track.net, 'POWER');
        app.history.undo();
        assert.equal(track.net, 'GND');
    } else if (next === 'via') {
        const via = new Via({ x: Math.PI, y: -Math.E, net: 'GND' });
        model.vias.push(via);
        assert.equal(startViaDrag(app, via, via), true);
        assert.equal(track.cornerRadius, 2);
        assert.equal(getTrackPropertyPreview(app), undefined);
        cancelViaDrag(app);
        assert.equal(track.cornerRadius, 2);
    } else if (next === 'delete') {
        const command = new RemoveTrackCommand(app, copy);
        assert.equal(command.track, track);
        app.history.execute(command);
        assert.equal(model.tracks.includes(track), false);
        assert.equal(getTrackPropertyPreview(app), undefined);
        app.history.undo();
        assert.equal(model.tracks.includes(track), true);
        assert.equal(track.cornerRadius, 0.345678912);
    } else if (next === 'bulge') {
        const adapter = createTrackSelectionAdapter(app, copy, track.id);
        assert.equal(adapter.beginAnchorDrag(`bulge:${edgeId}`, { x: 8, y: -5 }), true);
        assert.equal(track.getEdgeWidth(edgeId), 2);
        assert.equal(getTrackPropertyPreview(app), undefined);
        adapter.endAnchorDrag(false);
    } else {
        const started = next === 'move' ? startVertexDrag(app, copy, { x: 20, y: 20 }, { whole: true })
            : next === 'midpoint' ? startMidpointInsertDrag(app, copy, edgeId)
                : splitTrackNodeAndDrag(app, copy, nodeId);
        assert.equal(started, true);
        assert.equal(track.cornerRadius, 2);
        assert.equal(getVertexDrag(app).original, track);
        assert.equal(getTrackPropertyPreview(app), undefined);
        cancelVertexDrag(app);
        assert.equal(track.cornerRadius, 2);
    }
    cases++;
}

for (const [field, value] of [['Layer', 'bottom-copper'], ['Width', 0.75]]) {
    // A midpoint "+" click picks up a new node: the board shows a preview copy of the
    // track until it is placed. A panel edit made meanwhile must drop the pickup and
    // reach the real track instead of silently doing nothing.
    const f = fixture('whole'), { app, model, track, edgeId } = f;
    const edge = track.edges.get(edgeId), from = track.nodes.get(edge.from), to = track.nodes.get(edge.to);
    const midpoint = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    assert.equal(startMidpointInsertDrag(app, app.tracks[0], edgeId), true);
    setPcbInteraction(app, '_pcbSelectionInteraction', { mode: 'floating-anchor' });
    assert.notEqual(app.tracks[0], track, 'the pickup shows a preview copy');
    f.input(field).emit('change', value);
    if (field === 'Width') flushSettledChanges();
    assert.equal(getVertexDrag(app), null, `${field}: the pickup is dropped`);
    assert.equal(getSelectionInteraction(app), null);
    if (field === 'Layer') {
        assert.ok(model.tracks.some(item => [...item.edges.keys()].some(id => item.getEdgeLayer(id) === 'bottom-copper')),
            'the layer change reaches the track');
    } else {
        assert.equal(model.tracks[0], track);
        assert.equal(track.width, 0.75, 'the width change reaches the track');
    }
    assert.ok(model.tracks.every(item => [...item.nodes.values()].every(node =>
        Math.hypot(node.x - midpoint.x, node.y - midpoint.y) > 1e-6)), 'the picked-up node is not kept');
    assert.equal(app.history.undoStack.length, 1, 'only the panel edit is recorded');
    cases++;
}

for (const scope of ['segment', 'node']) {
    const f = fixture(scope), { app, track, edgeId, nodeId } = f;
    const input = f.input(scope === 'node' ? 'CornerRadius' : 'Width');
    input.emit('input', 3);
    if (scope === 'node') track.nodes.delete(nodeId);
    else track.edges.delete(edgeId);
    const before = track.captureState();
    assert.throws(() => { input.emit('change'); flushSettledChanges(); }, /missing track, segment or node/);
    assert.deepEqual(track.captureState(), before);
    assert.equal(getTrackPropertyPreview(app), undefined);
    assert.equal(app.history.canUndo(), false);
    cases++;
}

for (const scope of ['whole', 'segment']) {
    const f = fixture(scope), { app, model, track } = f;
    f.input('Width').emit('input', 2);
    const layerInput = inputs.get(scope === 'whole' ? 'pcbPropTrackLayer' : 'pcbPropSegLayer');
    layerInput.emit('change', 'bottom-copper');
    assert.equal(getTrackPropertyPreview(app), undefined);
    assert.equal(app.history.undoStack.length, 2, 'Numeric edit completes before discrete layer/topology commands');
    assert.ok(model.tracks.some(item => [...item.edges.keys()].some(id => item.getEdgeLayer(id) === 'bottom-copper')));
    app.history.undo();
    assert.ok(model.tracks.includes(track));
    assert.ok([...track.edges.keys()].every(id => track.getEdgeLayer(id) === 'top-copper'));
    app.history.undo();
    assert.equal(track.width, 0.234567891);
    assert.ok([...track.edges.keys()].every(id => track.getEdgeWidth(id) === 0.234567891));
    cases++;
}

{
    const f = fixture('segment'), { app, track, edgeId } = f;
    const input = f.input('Width');
    track.setEdgeAttr(edgeId, 'width', 0.876543219);
    const before = track.captureState();
    input.emit('change', 1.765432198);
    flushSettledChanges();
    assert.equal(track.getEdgeWidth(edgeId), 1.765432198, 'Change-only events preview before committing');
    app.history.undo();
    assert.deepEqual(track.captureState(), before, 'Baseline is captured at first edit, not panel opening');
    input.emit('input', 4);
    input.emit('input', 0.876543219);
    input.emit('change');
    flushSettledChanges();
    assert.equal(app.history.canRedo(), true);
    cases++;
}

{
    const f = fixture('bulge'), { app, track, edgeId } = f;
    const input = f.input('Bulge');
    input.emit('input', 9);
    assert.equal(app.tracks[0].edges.get(edgeId).bulge, 1);
    input.emit('input', -0.123456789);
    assert.equal(app.tracks[0].edges.get(edgeId).bulge, Number(formatNumberInputValue(-0.123456789)));
    input.emit('input', 0);
    input.emit('blur');
    await Promise.resolve();
    assert.equal(track.edges.get(edgeId).bulge, 0);
    assert.equal(f.input('Bulge'), undefined, 'Straightening rebuilds the existing segment panel');
    input.emit('change', 0.9);
    assert.equal(track.edges.get(edgeId).bulge, 0, 'Detached old controls cannot restart edits');
    app.history.undo();
    assert.equal(track.edges.get(edgeId).bulge, 0.25);
    showTrackSelectionProperties(app, track);
    assert.ok(f.input('Bulge'));
    cases++;
}

for (const [scope, field, value] of [
    ['whole', 'Width', 2], ['segment', 'Width', 2], ['whole', 'CornerRadius', 2],
    ['node', 'CornerRadius', 2], ['bulge', 'Bulge', 0.6],
]) for (const invalid of ['', 'bad', '2junk', 'Infinity', '-Infinity', ...(field === 'Width' ? ['0', '-1'] : [])]) {
    for (const finish of ['change', 'blur', 'binding', 'pointer', 'cancel', 'net', 'layer']) {
        if ((finish === 'net' || finish === 'layer') && scope === 'node') continue;
        const f = fixture(scope, finish === 'layer' ? 0 : 1), { app, model, track } = f;
        const input = f.input(field), before = model.captureGeometry();
        const redo = { execute() {}, undo() {} };
        app.history.redoStack.push(redo);
        input.emit('input', value);
        input.emit('input', invalid);
        if (finish === 'binding') getPropertyEditor(app, 'track').commit();
        else if (finish === 'pointer') {
            assert.equal(startVertexDrag(app, track, { x: 20, y: 20 }, { whole: true }), true);
            cancelVertexDrag(app);
        } else if (finish === 'cancel') input.emit('keydown', input.value, { key: 'Escape' });
        else if (finish === 'net') f.input('Net').emit('change', 'SIGNAL');
        else if (finish === 'layer') inputs.get(scope === 'whole' ? 'pcbPropTrackLayer' : 'pcbPropSegLayer')
            .emit('change', 'bottom-copper');
        else input.emit(finish);
        if (finish === 'change') flushSettledChanges();
        await Promise.resolve();
        assert.equal(getTrackPropertyPreview(app), undefined, `${scope} ${field}: ${finish} ends invalid preview`);
        assert.equal(app.isSectionEditing(), false);
        const discrete = finish === 'net' || finish === 'layer';
        assert.equal(app.history.undoStack.length, discrete ? 1 : 0);
        assert.ok(Number.isFinite(Number(input.value)) && input.value !== '', 'Invalid text is restored');
        if (discrete) app.history.undo();
        else assert.equal(app.history.redoStack[0], redo, 'Rejected numeric completion preserves redo');
        assert.deepEqual(model.captureGeometry(), before, `${scope} ${field}: ${finish} rejects intermediate value`);
        f.assertArtwork(track);
        cases++;
    }
}

for (const invalidFirst of [false, true]) for (const invalidSecond of [false, true]) {
    const f = fixture(), { app, model, track } = f;
    const before = model.captureGeometry(), radius = f.input('CornerRadius'), width = f.input('Width');
    radius.emit('input', 2);
    if (invalidFirst) radius.emit('input', '');
    radius.emit('blur');
    width.emit('input', invalidSecond ? '' : 3);
    assert.equal(track.cornerRadius, invalidFirst ? 0.345678912 : 2);
    await Promise.resolve();
    assert.equal(!!getTrackPropertyPreview(app), !invalidSecond, 'Old blur does not finish the new field');
    if (!invalidSecond) assert.equal(width.value, '3', 'Canceling the previous field preserves incoming text');
    width.emit('change');
    flushSettledChanges();
    assert.equal(app.history.undoStack.length, Number(!invalidFirst) + Number(!invalidSecond));
    while (app.history.canUndo()) app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    cases++;
}

for (const finish of ['binding', 'blur', 'pointer']) {
    const f = fixture(), { app, model, track } = f;
    const before = model.captureGeometry(), input = f.input('Width');
    input.emit('input', 2);
    if (finish === 'binding') getPropertyEditor(app, 'track').commit();
    else if (finish === 'blur') { input.emit('blur'); await Promise.resolve(); }
    else {
        assert.equal(startVertexDrag(app, track, { x: 20, y: 20 }, { whole: true }), true);
        cancelVertexDrag(app);
    }
    assert.equal(track.width, 2);
    assert.equal(app.history.undoStack.length, 1, 'Valid handoff commits exactly once');
    input.emit('change');
    assert.equal(app.history.undoStack.length, 1);
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    cases++;
}

console.log(`PASS ${cases} track property isolation cases: exact model/cache/geometry isolation, stable copies, SVG/work counts, history and lifecycle/handoff`);
