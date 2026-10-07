import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { Track } from '../../src/shapes/track.js';
import { Via } from '../../src/shapes/via.js';
import { Pad } from '../../src/shapes/pad.js';
import { renderTrack, renderVia } from '../../src/pcb/modules/track-render.js';
import { renderPad } from '../../src/pcb/modules/pad.js';
import { createViaSelectionAdapter } from '../../src/pcb/modules/track-select.js';
import { createPadSelectionAdapter } from '../../src/pcb/modules/pad-selection.js';
import { setPcbSelection, syncPcbSelection, getPcbSelection } from '../../src/pcb/modules/selection-registry.js';
import { finishSelectionInteraction } from '../../src/pcb/modules/selection-interaction.js';
import { loadPcb } from '../../src/pcb/modules/project-state.js';
import { areDragOverlaysDeferred, setDragOverlaysDeferred } from '../../src/pcb/modules/refresh-state.js';
import { getSelectionInteraction } from '../../src/pcb/modules/selection-interaction.js';
import { getViaDrag } from '../../src/pcb/modules/track-drag.js';
import { setPcbInteraction } from '../../src/pcb/modules/pcb-interactions.js';

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
globalThis.document = { createElementNS: (_, tag) => new Element(tag), getElementById() { return null; } };
globalThis.window = { addEventListener() {} };
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');

function fixture(kind, deferred = false) {
    const model = new PcbDocument();
    const terminal = kind === 'via' ? new Via({ diameter: 0.7, drill: 0.25 }) :
        new Pad({ shape: 'rectangle', rotation: 37.125, layers: 'both' });
    const shared = new Track({
        points: [{ x: 0, y: 0 }, { x: 10, y: 7 }, { x: 0.00003, y: 0.00002 }],
        edgeWidths: { e1: 0.32123456789 }, edgeBulges: { e0: 0.123456789 },
        padConnections: { n1: { componentId: 'unrelated', pinNumber: '1#2' } },
    });
    const unrelated = new Track({ points: [{ x: 40, y: 40 }, { x: 45, y: 43 }] });
    const collection = kind === 'via' ? 'vias' : 'pads';
    model[collection].push(terminal);
    model.tracks.push(shared, unrelated);
    const groups = new Map(['top-copper', 'bottom-copper', 'vias'].map(layer => [layer, new Element('g')]));
    let fills = 0;
    const app = {
        pcbDocument: model, placements: new Map(), netlist: [],
        history: new CommandHistory(),
        viewport: { scale: 100, shiftHeld: true, gridVisible: false,
            setCrosshair() {}, hideCrosshair() {}, svg: new Element('svg') },
        getLayerGroup: id => groups.get(id) || null,
        existingLayerGroups: () => groups,
        refreshClearanceHalos() {}, refreshFills() { fills++; },
        _cancelPosePreviews: PCBApp.prototype._cancelPosePreviews,
        _cancelDrawingMode() {}, markSectionClean() {}, _ensureViewport() {},
        _shapeElements: new Map(),
        alert(message) { this.lastAlert = message; },
    };
    setDragOverlaysDeferred(app, deferred);
    for (const key of ['tracks', 'vias', 'pads', 'boardShapes', 'texts']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    const factory = kind === 'via' ? createViaSelectionAdapter : createPadSelectionAdapter;
    const adapter = factory(app, terminal, `${kind}:${terminal.id}`);
    setPcbSelection(app, [{ kind, object: terminal }]);
    for (const track of model.tracks) renderTrack(track, app.getLayerGroup);
    (kind === 'via' ? renderVia : renderPad)(terminal, app.getLayerGroup);
    return { app, model, terminal, shared, unrelated, adapter, factory, collection, groups,
        fills: () => fills,
        artwork: () => [...groups.values()].flatMap(group => group.children)
            .filter(element => element.dataset.trackId || element.dataset.viaId || element.dataset.padId) };
}

let cases = 0;
for (const kind of ['via', 'pad']) for (const deferred of [false, true]) {
    for (const finish of ['commit', 'cancel', 'no-op', 'sub-tolerance', 'deactivate', 'load', 'failure']) {
        const f = fixture(kind, deferred);
        const { app, model, terminal, shared, unrelated, adapter, collection } = f;
        const before = model.captureGeometry(), serialized = model.serialize(), bounds = shared.getBounds();
        const initialArtwork = f.artwork().length;
        const unrelatedArtwork = f.artwork().filter(element => element.dataset.trackId === unrelated.id);
        const redo = { execute() {}, undo() {} };
        app.history.redoStack.push(redo);
        const start = { x: 0.1, y: 0.1 };
        adapter.beginMove(start);
        adapter.updateMove(start);
        assert.equal(getViaDrag(app).preview, undefined, 'Pickup/unchanged movement does not clone');
        adapter.updateMove({ x: 3.1, y: -3.9 });
        const projected = app[collection][0], tracks = app.tracks, copiedTrack = tracks[0];
        assert.notEqual(projected, terminal);
        assert.notEqual(copiedTrack, shared);
        assert.equal(projected.id, terminal.id);
        assert.equal(copiedTrack.id, shared.id);
        assert.equal(tracks[1], unrelated);
        assert.equal(getViaDrag(app).preview.copies.size, 1, 'Two attached endpoints share one copy');
        assert.deepEqual(copiedTrack.captureState().edgeBulges, shared.captureState().edgeBulges);
        assert.deepEqual(copiedTrack.padConnections, shared.padConnections);
        for (let step = 0; step < 100; step++) {
            adapter.updateMove({ x: 3.1 + step / 1000, y: -3.9 });
            assert.equal(app[collection][0], projected);
            assert.equal(app.tracks, tracks);
            assert.equal(app.tracks[0], copiedTrack);
            assert.deepEqual(copiedTrack.nodes.get('n0'), { x: projected.x, y: projected.y });
            assert.deepEqual(copiedTrack.nodes.get('n2'), { x: projected.x, y: projected.y });
            assert.equal(f.artwork().length, initialArtwork, 'No duplicate SVG during preview');
        }
        const allocated = allocations;
        for (let i = 0; i < 100; i++) adapter.updateMove({ x: 3.1 + 99 / 1000, y: -3.9 });
        assert.equal(allocations, allocated, 'Unchanged pointer positions do not rebuild SVG');
        assert.deepEqual(adapter.getPosition(), { x: projected.x, y: projected.y });
        assert.deepEqual(adapter.getBounds(), projected.getBounds());
        assert.equal(adapter.hitTest({ x: projected.x, y: projected.y }, 0), true);
        syncPcbSelection(app);
        assert.equal(getPcbSelection(app, kind)[0], projected, 'Selection rebuild follows preview');
        const during = f.factory(app, projected, adapter.id);
        assert.deepEqual(model.captureGeometry(), before);
        assert.deepEqual(model.serialize(), serialized);
        assert.equal(shared._bounds, bounds, 'Canonical bounds cache is untouched');
        assert.equal(f.fills(), 0);
        assert.equal(app.history.canUndo(), false);
        const target = { x: projected.x, y: projected.y };
        setPcbInteraction(app, '_pcbSelectionInteraction', { mode: 'move-adapter', entry: adapter, moved: true });
        if (finish === 'commit') {
            finishSelectionInteraction(app, true);
            assert.deepEqual({ x: terminal.x, y: terminal.y }, target);
            assert.equal(app.history.undoStack.length, 1);
            const after = model.captureGeometry();
            app.history.undo();
            assert.deepEqual(model.captureGeometry(), before);
            app.history.redo();
            assert.deepEqual(model.captureGeometry(), after);
        } else {
            if (finish === 'no-op' || finish === 'sub-tolerance') {
                adapter.updateMove({ x: 0.1 + (finish === 'sub-tolerance' ? 1e-7 : 0), y: 0.1 });
                finishSelectionInteraction(app, true);
            } else if (finish === 'deactivate') {
                PCBApp.prototype.deactivate.call(app);
            } else if (finish === 'load') {
                loadPcb(app, null);
            } else if (finish === 'failure') {
                app.history.execute = () => { throw new Error('Rejected terminal command'); };
                assert.throws(() => finishSelectionInteraction(app, true), /Rejected terminal command/);
            } else {
                Object.freeze(terminal);
                for (const node of shared.nodes.values()) Object.freeze(node);
                finishSelectionInteraction(app, false);
            }
            if (finish !== 'load') {
                assert.deepEqual(model.captureGeometry(), before);
                assert.deepEqual(model.serialize(), serialized);
                assert.equal(shared._bounds, bounds);
                assert.equal(f.fills(), 0, 'Discarding previews does not repour unchanged copper');
                assert.equal(app.history.redoStack[0], redo);
            }
            assert.equal(app.history.canUndo(), false);
        }
        assert.equal(getViaDrag(app), null);
        assert.equal(getSelectionInteraction(app), null);
        assert.equal(areDragOverlaysDeferred(app), deferred);
        assert.equal(app.tracks, model.tracks);
        assert.equal(app[collection], model[collection]);
        assert.equal(during.object, terminal, 'Adapters created during preview return to canonical identity');
        if (finish !== 'load') {
            assert.equal(f.artwork().length, initialArtwork);
            assert.deepEqual(f.artwork().filter(element => element.dataset.trackId === unrelated.id), unrelatedArtwork);
        } else assert.equal(f.artwork().length, 0);
        cases++;
    }
}

for (const kind of ['via', 'pad']) for (const targetKind of ['segment', 'conflict', 'missing-terminal', 'missing-track']) {
    const { app, model, terminal, adapter, shared, collection } = fixture(kind);
    terminal.net = 'GND';
    const target = new Track({ points: [{ x: 20, y: -10 }, { x: 20, y: 10 }],
        net: targetKind === 'conflict' ? 'OTHER' : 'GND' });
    model.tracks.push(target);
    const before = model.captureGeometry();
    app.viewport.shiftHeld = false;
    adapter.beginMove({ x: 0, y: 0 });
    adapter.updateMove({ x: 20.02, y: 0 });
    assert.deepEqual(model.captureGeometry(), before);
    assert.equal(target.nodes.size, 2);
    if (targetKind === 'missing-terminal') model[collection].length = 0;
    if (targetKind === 'missing-track') model.tracks.splice(model.tracks.indexOf(shared), 1);
    const priorCommit = model.captureGeometry();
    const execute = app.history.execute.bind(app.history);
    app.history.execute = command => {
        assert.deepEqual(model.captureGeometry(), priorCommit, 'Command construction never splits the authored target');
        execute(command);
    };
    if (targetKind.startsWith('missing')) {
        assert.throws(() => adapter.endMove(true), /Cannot move a missing/);
        assert.deepEqual(model.captureGeometry(), priorCommit, 'Preflight rejects before any compound member changes');
    } else if (targetKind === 'conflict') {
        adapter.endMove(true);
        assert.deepEqual(model.captureGeometry(), before);
        assert.match(app.lastAlert, /net/i);
        assert.equal(app.history.canUndo(), false);
    } else {
        adapter.endMove(true);
        assert.equal(target.nodes.size, 3);
        assert.deepEqual({ x: terminal.x, y: terminal.y }, { x: 20, y: 0 });
        const after = model.captureGeometry();
        app.history.undo();
        assert.deepEqual(model.captureGeometry(), before);
        app.history.redo();
        assert.deepEqual(model.captureGeometry(), after);
    }
    assert.equal(getViaDrag(app), null);
    assert.equal(app.tracks, model.tracks);
    cases++;
}
console.log(`PASS ${cases} terminal preview cases: model/cache isolation, stable copies, SVG handoff/reuse, selection, history, lifecycle and failures`);
