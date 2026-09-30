import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { Track } from '../src/shapes/track.js';
import { Via } from '../src/shapes/via.js';
import { MoveVertexCommand, RemoveTrackCommand, previewPlacementPoses, finishPlacementPreview } from '../src/pcb/modules/track-commands.js';
import { renderTrack, buildTrackLayerRuns } from '../src/pcb/modules/track-render.js';
import { createTrackSelectionAdapter, selectTrackOrVia, setHoverHighlight } from '../src/pcb/modules/track-select.js';
import { startVertexDrag, updateVertexDrag, finishVertexDrag, cancelVertexDrag,
    startMidpointInsertDrag, splitTrackNodeAndDrag, startViaDrag, updateViaDrag } from '../src/pcb/modules/track-drag.js';
import { syncPcbSelection, getPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { finishSelectionInteraction } from '../src/pcb/modules/selection-interaction.js';
import { prepareFabricationSnapshot } from '../src/pcb/modules/fabrication-snapshot.js';
import { loadPcb } from '../src/pcb/modules/project-state.js';
import { PCB_LAYERS } from '../src/pcb/modules/layers.js';

let allocations = 0;
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { setItem() {} };
class Element {
    constructor(tag) {
        allocations++; this.tag = tag; this.children = []; this.attributes = new Map();
        this.dataset = {}; this.style = {};
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    addEventListener() {}
    set className(value) { this.setAttribute('class', value); }
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
globalThis.document = {
    createElementNS: (_, tag) => new Element(tag), createElement: tag => new Element(tag),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}, body: new Element('body'),
};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

function fixture(mode, deferred = false, unrelatedCount = 1) {
    const project = new ProjectDocument(), model = project.pcbDocument;
    const track = new Track({ width: 0.234567891, cornerRadius: 0.345678912,
        points: [{ x: Math.PI, y: -Math.E }, { x: 20, y: -Math.E }, { x: 20, y: 20 }],
        sourceBoardShape: { id: 'source', kind: 'line', points: [{ x: Math.PI, y: -Math.E }] } });
    const edgeId = track.edges.keys().next().value, nodeId = [...track.nodes.keys()][0];
    if (mode === 'bulge') track.setEdgeAttr(edgeId, 'bulge', 0.25);
    track.padConnections.set(nodeId, { componentId: 'U1', pinNumber: '1' });
    const unrelated = Array.from({ length: unrelatedCount }, (_, index) => new Track({
        points: [{ x: 100 + index, y: 100 }, { x: 101 + index, y: 100 }] }));
    model.tracks.push(track, ...unrelated);
    if (mode === 'bridge') model.vias.push(new Via({ x: Math.PI, y: -Math.E }));
    const groups = new Map(['top-copper', 'bottom-copper', 'selection-overlay'].map(id => [id, new Element('g')]));
    let fills = 0, clearances = 0, boardRefreshes = 0;
    const app = {};
    for (const key of ['pads', 'vias', 'tracks', 'boardShapes', 'texts']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    for (const key of ['_setPcbPropsTitle', '_clearProperties', '_cancelPosePreviews', 'isSectionEditing',
        'deactivate', '_onLayerLockChanged', '_onLayerVisibilityChanged']) app[key] = PCBApp.prototype[key];
    Object.assign(app, {
        project, pcbDocument: model, placements: new Map(), netlist: [], history: new CommandHistory(),
        _active: true, _layerGroups: groups, _textElements: new Map(), _shapeElements: new Map(),
        _deferDragOverlays: deferred, _suspendBoardViewRefresh: deferred,
        viewport: { scale: 100, svg: new Element('svg'), shiftHeld: true, setCrosshair() {}, hideCrosshair() {} },
        _pcbPropsItems: () => ({ innerHTML: '' }), _getLayerGroup: id => groups.get(id) || null,
        _setActiveRibbonTab() {}, _setPcbStatus() {}, _refreshFills() { fills++; },
        _refreshClearanceHalos() { clearances++; }, _board3d: { refresh() { boardRefreshes++; } },
        _cancelDrawingMode() {}, _ensureViewport() {}, markSectionClean() {},
        _refreshPcbSelectionHighlights() {}, _scheduleRemovalHatchRender() {},
        _alert(message) { this.lastAlert = message; },
    });
    project.registerView('pcb', app);
    for (const object of [track, unrelated[0]].filter(Boolean)) renderTrack(object, app._getLayerGroup);
    selectTrackOrVia(app, { type: 'track', track });
    const adapter = createTrackSelectionAdapter(app, track, track.id);
    const initial = mode === 'bulge' ? adapter.getAnchors().find(anchor => anchor.id === `bulge:${edgeId}`)
        : mode === 'whole' || mode === 'node' ? { ...track.nodes.get(nodeId) }
            : mode === 'split' ? { ...[...track.nodes.values()][1] } : { x: (Math.PI + 20) / 2, y: -Math.E };
    const start = () => mode === 'bulge' ? adapter.beginAnchorDrag(`bulge:${edgeId}`, initial)
        : mode === 'midpoint' ? startMidpointInsertDrag(app, track, edgeId)
            : mode === 'split' ? splitTrackNodeAndDrag(app, track, [...track.nodes.keys()][1])
                : startVertexDrag(app, track, initial, mode === 'whole' ? { whole: true }
                    : mode === 'node' ? { nodeId } : { edgeId, allowMidpointInsert: false });
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
    return { app, project, model, track, edgeId, nodeId, unrelated, groups, adapter, initial, start,
        artwork, assertArtwork, work: () => [allocations, fills, clearances, boardRefreshes], fills: () => fills };
}

let cases = 0;
for (const mode of ['whole', 'segment', 'bridge', 'node', 'midpoint', 'split', 'bulge']) {
    for (const deferred of [false, true]) for (const finish of [
        'commit', 'cancel', 'no-op', 'deactivate', 'load', 'failure', 'missing', 'lock', 'hide', 'shared',
    ]) {
        const f = fixture(mode, deferred), { app, model, project, track, adapter, initial } = f;
        const before = track.captureState(), original = model.captureGeometry(), serialized = model.serialize();
        const bounds = track.getBounds(), nodes = track.nodes, edges = track.edges;
        const metadata = [track.nodeCornerRadii, track.padConnections, track.sourceBoardShape];
        const otherArtwork = f.artwork(f.unrelated[0]), redo = { execute() {}, undo() {} };
        app.history.redoStack.push(redo);
        if (finish === 'cancel') {
            for (const value of [...nodes.values(), ...edges.values(), track.nodeCornerRadii]) Object.freeze(value);
            Object.freeze(track);
        }
        assert.equal(f.start(), true, mode);
        assert.equal(app._vertexDrag.original, track);
        if (!['midpoint', 'split'].includes(mode)) {
            assert.equal(app._vertexDrag.preview, undefined, `${mode}: pickup does not allocate a graph copy`);
            assert.equal(app.tracks, model.tracks);
        }
        assert.deepEqual(track.captureState(), before, 'Topology pickup is detached too');
        const point = { x: initial.x + 2.123456789, y: initial.y + 3.765432198 };
        updateVertexDrag(app, point);
        const copy = app.tracks[0], collection = app.tracks, copyNodes = copy.nodes, copyEdges = copy.edges;
        assert.notEqual(copy, track);
        assert.equal(adapter.object, copy);
        assert.equal(copy.id, track.id);
        assert.equal(app.tracks[1], f.unrelated[0]);
        assert.deepEqual(model.captureGeometry(), original);
        assert.deepEqual(model.serialize(), serialized);
        assert.equal(track.getBounds(), bounds);
        assert.equal(track.nodes, nodes);
        assert.equal(track.edges, edges);
        [track.nodeCornerRadii, track.padConnections, track.sourceBoardShape]
            .forEach((item, index) => assert.equal(item, metadata[index]));
        f.assertArtwork(copy);
        assert.equal(app.isSectionEditing(), true);
        assert.throws(() => project.serialize(), /current edit/i);
        await assert.rejects(prepareFabricationSnapshot(app), /current edit/i);
        syncPcbSelection(app);
        const rebuilt = createTrackSelectionAdapter(app, copy, track.id);
        assert.equal(rebuilt.object, copy);
        assert.equal(getPcbSelection(app, 'track')[0], copy);
        assert.deepEqual(rebuilt.getBounds(), copy.getBounds());
        assert.deepEqual(rebuilt.getAnchors(), adapter.getAnchors());
        setHoverHighlight(app, { type: 'track', track });
        const work = f.work();
        for (let i = 0; i < 100; i++) updateVertexDrag(app, point);
        assert.deepEqual(f.work(), work, 'Unchanged positions do no SVG or derived work');
        assert.equal(app.tracks, collection);
        assert.equal(copy.nodes, copyNodes);
        assert.equal(copy.edges, copyEdges);
        if (finish === 'commit') {
            const execute = app.history.execute.bind(app.history);
            app.history.execute = command => {
                assert.equal(app._vertexDrag, null);
                assert.equal(app.tracks, model.tracks);
                assert.deepEqual(model.captureGeometry(), original);
                execute(command);
            };
            finishVertexDrag(app);
            assert.equal(app.history.undoStack.length, 1);
            const after = model.captureGeometry();
            app.history.undo();
            assert.deepEqual(model.captureGeometry(), original);
            app.history.redo();
            assert.deepEqual(model.captureGeometry(), after);
        } else if (finish === 'load') {
            loadPcb(app, null);
        } else {
            if (finish === 'no-op') {
                updateVertexDrag(app, initial);
                finishVertexDrag(app);
            } else if (finish === 'deactivate') app.deactivate();
            else if (finish === 'shared') {
                if (!finishSelectionInteraction(app, false)) app._cancelPosePreviews();
            } else if (finish === 'failure') {
                app.history.execute = () => { throw new Error('Rejected track gesture'); };
                assert.throws(() => finishVertexDrag(app), /Rejected track gesture/);
            } else if (finish === 'missing') {
                model.tracks.shift();
                assert.throws(() => finishVertexDrag(app), /missing track/);
            } else if (finish === 'lock' || finish === 'hide') {
                const layer = PCB_LAYERS.find(layer => layer.id === 'top-copper');
                try {
                    if (finish === 'lock') { layer.locked = true; app._onLayerLockChanged(layer.id, true); }
                    else { layer.visible = false; app._onLayerVisibilityChanged(layer.id, false); }
                } finally { layer.locked = false; layer.visible = true; }
            } else cancelVertexDrag(app);
            assert.deepEqual(track.captureState(), before);
            if (finish !== 'missing') {
                assert.deepEqual(model.captureGeometry(), original);
                assert.deepEqual(model.serialize(), serialized);
            }
            assert.equal(app.history.canUndo(), false);
            assert.equal(app.history.redoStack[0], redo);
            assert.equal(f.fills(), 0, 'Discarding a preview does not repour unchanged copper');
        }
        assert.equal(app._vertexDrag, null);
        assert.equal(app._deferDragOverlays, deferred);
        assert.equal(app._suspendBoardViewRefresh, deferred);
        assert.equal(rebuilt.object, track);
        assert.equal(app.tracks, model.tracks);
        if (finish === 'load' || finish === 'missing') assert.equal(f.artwork().length, 0);
        else f.assertArtwork(track);
        if (finish !== 'load') assert.deepEqual(f.artwork(f.unrelated[0]), otherArtwork);
        cases++;
    }
}

for (const mode of ['whole', 'segment', 'node', 'midpoint', 'split', 'bulge']) {
    const f = fixture(mode, false, 4000), { app, model, initial } = f;
    const original = model.captureGeometry();
    f.start();
    updateVertexDrag(app, { x: initial.x + 1, y: initial.y + 2 });
    const collection = app.tracks, copy = collection[0], nodes = copy.nodes, edges = copy.edges;
    for (let i = 0; i < 20; i++) {
        updateVertexDrag(app, { x: initial.x + 1 + i / 100, y: initial.y + 2 + i / 50 });
        assert.equal(app.tracks, collection);
        assert.equal(app.tracks[0], copy);
        assert.equal(copy.nodes, nodes);
        assert.equal(copy.edges, edges);
    }
    assert.deepEqual(model.captureGeometry(), original);
    cancelVertexDrag(app);
    assert.deepEqual(model.captureGeometry(), original);
    cases++;
}

for (const targetKind of ['same-track', 'same-layer', 'cross-layer', 'conflict', 'missing']) {
    const f = fixture('node'), { app, model, track, nodeId } = f;
    app.viewport.shiftHeld = false;
    let target = track, targetId = [...track.nodes.keys()][2];
    if (targetKind !== 'same-track') {
        target = new Track({ points: [{ x: -12, y: 7 }, { x: -20, y: 7 }],
            layer: targetKind === 'cross-layer' ? 'bottom-copper' : 'top-copper', net: 'SIGNAL' });
        targetId = target.nodes.keys().next().value;
        model.tracks.push(target);
        renderTrack(target, app._getLayerGroup);
    }
    if (targetKind === 'conflict') track.net = 'OTHER';
    const original = model.captureGeometry(), serialized = model.serialize();
    const before = track.captureState(), targetBefore = target.captureState(), bounds = track.getBounds();
    f.start();
    updateVertexDrag(app, target.nodes.get(targetId));
    assert.deepEqual(track.captureState(), before);
    assert.deepEqual(target.captureState(), targetBefore);
    assert.deepEqual(model.serialize(), serialized);
    assert.equal(track.getBounds(), bounds);
    assert.equal(app._vertexDrag.snapTargetNode.nodeId, targetId);
    if (targetKind === 'missing') {
        model.tracks.splice(model.tracks.indexOf(target), 1);
        assert.throws(() => finishVertexDrag(app), /missing track node/);
        assert.equal(app.history.canUndo(), false);
    } else {
        finishVertexDrag(app);
        if (targetKind === 'conflict') {
            assert.ok(app.lastAlert);
            assert.deepEqual(model.captureGeometry(), original);
            assert.equal(app.history.canUndo(), false);
        } else {
            assert.equal(app.history.undoStack.length, 1);
            if (targetKind === 'same-layer') {
                assert.equal(model.tracks.includes(target), false);
                assert.equal(track.net, 'SIGNAL');
                assert.equal(f.artwork(target).length, 0);
            } else if (targetKind === 'cross-layer') {
                assert.ok(model.tracks.includes(target));
                assert.equal(model.vias.length, 1);
                assert.equal(model.vias[0].net, 'SIGNAL');
            } else assert.equal(track.nodes.has(nodeId), false);
            const after = model.captureGeometry();
            app.history.undo();
            assert.deepEqual(model.captureGeometry(), original, 'Merge undo restores exact graphs and original attachment');
            app.history.redo();
            assert.deepEqual(model.captureGeometry(), after);
        }
    }
    assert.equal(app._vertexDrag, null);
    f.assertArtwork(track);
    cases++;
}

for (const removed of ['node', 'edge', 'terminal', 'before-preview']) {
    const f = fixture('node'), { app, model, track, nodeId, edgeId, initial } = f;
    const via = new Via({ x: -12, y: 7 });
    if (removed === 'terminal') {
        model.vias.push(via);
        app.viewport.shiftHeld = false;
    }
    f.start();
    if (removed === 'before-preview') {
        model.tracks.shift();
        assert.throws(() => updateVertexDrag(app, { x: initial.x + 2, y: initial.y + 3 }), /missing track/);
        assert.equal(f.artwork().length, 0);
    } else {
        updateVertexDrag(app, removed === 'terminal' ? via : { x: initial.x + 2, y: initial.y + 3 });
        if (removed === 'node') track.nodes.delete(nodeId);
        else if (removed === 'edge') track.edges.delete(edgeId);
        else model.vias.pop();
        const before = track.captureState();
        assert.throws(() => finishVertexDrag(app), /missing/);
        assert.deepEqual(track.captureState(), before);
    }
    assert.equal(app._vertexDrag, null);
    assert.equal(app._deferDragOverlays, false);
    assert.equal(app._suspendBoardViewRefresh, false);
    assert.equal(app.history.canUndo(), false);
    cases++;
}

for (const commandKind of ['remove', 'move']) {
    const f = fixture('node'), { app, track, nodeId, initial, model } = f;
    const before = track.captureState();
    f.start();
    updateVertexDrag(app, { x: initial.x + 2, y: initial.y + 3 });
    const copy = app.tracks[0];
    const command = commandKind === 'remove' ? new RemoveTrackCommand(app, copy)
        : new MoveVertexCommand(app, copy, nodeId, initial.x, initial.y, 15, 16);
    assert.equal(command.track, track);
    app.history.execute(command);
    assert.equal(app._vertexDrag, null, 'Independent commands cancel pending pointer ownership first');
    if (commandKind === 'remove') {
        assert.equal(model.tracks.includes(track), false);
        assert.equal(f.artwork().length, 0);
    } else assert.deepEqual(track.nodes.get(nodeId), { x: 15, y: 16 });
    app.history.undo();
    assert.deepEqual(track.captureState(), before);
    cases++;
}

{
    const f = fixture('node'), { app, track, initial } = f;
    const before = track.captureState();
    app.placements.set('U1', { x: 0, y: 0, rotation: 0,
        padOffsets: [{ padId: '1', number: '1', dx: Math.PI, dy: -Math.E }],
        pads: new Map([['1', { x: Math.PI, y: -Math.E, number: '1' }]]) });
    previewPlacementPoses(app, new Map([['U1', { x: 2, y: 3, rotation: 0 }]]));
    const copy = app.tracks[0], rebuilt = createTrackSelectionAdapter(app, copy, track.id);
    assert.equal(rebuilt.object, copy, 'Placement copies retain dynamic track selection geometry');
    assert.equal(startVertexDrag(app, copy, initial, { nodeId: f.nodeId }), false);
    assert.equal(app._vertexDrag, undefined, 'Pointer pickup cannot take ownership of an active placement copy');
    finishPlacementPreview(app);
    assert.equal(rebuilt.object, track);
    assert.deepEqual(track.captureState(), before);
    cases++;
}

{
    const f = fixture('whole', false, 0), { app, track, model, initial } = f;
    track.applyState(new Track({ points: Array.from({ length: 4000 }, (_, i) => ({ x: i, y: i % 2 })) }).captureState());
    renderTrack(track, app._getLayerGroup);
    const before = model.captureGeometry();
    f.start();
    assert.equal(app._vertexDrag.preview, undefined);
    const point = { x: initial.x + 2, y: initial.y + 3 };
    updateVertexDrag(app, point);
    const copy = app.tracks[0], collection = app.tracks, nodes = copy.nodes;
    const work = f.work();
    for (let i = 0; i < 100; i++) updateVertexDrag(app, point);
    assert.deepEqual(f.work(), work);
    for (let i = 1; i <= 20; i++) {
        updateVertexDrag(app, { x: point.x + i / 10, y: point.y + i / 20 });
        assert.equal(app.tracks, collection);
        assert.equal(app.tracks[0], copy);
        assert.equal(copy.nodes, nodes);
        assert.equal(f.artwork().length, 1);
        assert.equal(f.artwork()[0].getAttribute('points').split(' ').length, 4000);
    }
    assert.deepEqual(model.captureGeometry(), before);
    cancelVertexDrag(app);
    assert.deepEqual(model.captureGeometry(), before);
    f.assertArtwork(track);
    cases++;
}

{
    const f = fixture('bridge'), { app, initial } = f;
    app.viewport.shiftHeld = false;
    f.start();
    const point = { x: initial.x + 2, y: initial.y + 0.02 };
    updateVertexDrag(app, point);
    const state = app._vertexDrag.track.captureState(), work = f.work();
    for (let i = 0; i < 100; i++) updateVertexDrag(app, point);
    assert.deepEqual(app._vertexDrag.track.captureState(), state, 'Pinned-via constraints apply on the first preview');
    assert.deepEqual(f.work(), work, 'Lazy bridge insertion does not change subsequent same-position snaps');
    cancelVertexDrag(app);
    cases++;
}

{
    const f = fixture('node'), { app, track, model, nodeId } = f;
    app.viewport.shiftHeld = false;
    app.placements.set('U2', { x: -12, y: 7, rotation: 0,
        pads: new Map([['1', { x: -12, y: 7, number: '1' }]]),
        padOffsets: [{ padId: '1', number: '1', dx: 0, dy: 0, width: 2, height: 2, shape: 'rect' }] });
    app.netlist = [{ net: 'SIGNAL', pins: [{ componentId: 'U2', pinNumber: '1' }] }];
    const before = track.captureState(), geometry = model.captureGeometry();
    f.start();
    updateVertexDrag(app, { x: -12, y: 7 });
    assert.deepEqual(track.captureState(), before);
    assert.deepEqual(app.tracks[0].padConnections.get(nodeId), { componentId: 'U2', pinNumber: '1' });
    finishVertexDrag(app);
    assert.deepEqual(track.padConnections.get(nodeId), { componentId: 'U2', pinNumber: '1' });
    assert.equal(track.net, 'SIGNAL');
    const after = model.captureGeometry();
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), geometry);
    assert.deepEqual(track.captureState(), before);
    app.history.redo();
    assert.deepEqual(model.captureGeometry(), after);
    cases++;
}

for (const mode of ['whole', 'segment', 'node', 'midpoint', 'split', 'bulge']) {
    const f = fixture(mode), { app, track } = f;
    const before = track.captureState();
    f.start();
    assert.throws(() => updateVertexDrag(app, { x: NaN, y: 2 }), /finite position/);
    assert.equal(app._vertexDrag, null);
    assert.deepEqual(track.captureState(), before);
    assert.equal(app._deferDragOverlays, false);
    cases++;
}

{
    const f = fixture('node'), { app, track, initial } = f;
    const before = track.captureState(), bounds = track.getBounds();
    f.start();
    updateVertexDrag(app, { x: initial.x + 5e-8, y: initial.y });
    finishVertexDrag(app);
    assert.equal(app.history.canUndo(), false);
    assert.deepEqual(track.captureState(), before);
    assert.equal(track.getBounds(), bounds, 'Sub-tolerance drops discard the copy without a model rollback');
    cases++;
}

for (const mode of ['node', 'bulge']) for (const commit of [false, true]) {
    const f = fixture(mode), { app, track, model, initial } = f;
    const before = model.captureGeometry();
    f.start();
    updateVertexDrag(app, { x: initial.x + 2, y: initial.y + 3 });
    const rebuilt = createTrackSelectionAdapter(app, app.tracks[0], track.id);
    rebuilt.endAnchorDrag(commit, { moved: true });
    assert.equal(app._vertexDrag, null);
    const after = model.captureGeometry();
    rebuilt.updateAnchorDrag({ x: 50, y: 60 });
    rebuilt.endAnchorDrag(true);
    assert.deepEqual(model.captureGeometry(), after, 'Stale adapter callbacks cannot resume a finished gesture');
    assert.equal(app.history.undoStack.length, commit ? 1 : 0);
    if (commit) app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    cases++;
}

for (const deferred of [false, true]) {
    const f = fixture('node', deferred), { app, initial } = f;
    app._suspendBoardViewRefresh = !deferred;
    f.start();
    updateVertexDrag(app, { x: initial.x + 2, y: initial.y + 3 });
    cancelVertexDrag(app);
    assert.equal(app._deferDragOverlays, deferred);
    assert.equal(app._suspendBoardViewRefresh, !deferred, 'Independent nesting flags are restored separately');
    cases++;
}

{
    const f = fixture('node'), { app, model, track, nodeId, initial } = f;
    const via = new Via(initial);
    model.vias.push(via);
    startViaDrag(app, via, initial);
    updateViaDrag(app, { x: initial.x + 2, y: initial.y + 3 });
    const terminalCopy = app.tracks[0], rebuilt = createTrackSelectionAdapter(app, terminalCopy, track.id);
    assert.equal(rebuilt.object, terminalCopy);
    const point = { ...terminalCopy.nodes.get(nodeId) };
    assert.equal(startVertexDrag(app, terminalCopy, point, { nodeId }), true);
    assert.equal(app._viaDrag, null);
    assert.equal(app._vertexDrag.original, track);
    assert.deepEqual(track.nodes.get(nodeId), point, 'Terminal movement commits before direct-track pickup');
    assert.equal(app.history.undoStack.length, 1);
    cancelVertexDrag(app);
    assert.equal(rebuilt.object, track);
    app.history.undo();
    assert.deepEqual(track.nodes.get(nodeId), initial);
    cases++;
}

console.log(`PASS ${cases} direct-track pointer isolation cases: canonical state/cache/SVG, stable copies, work counts, exact history and lifecycle`);
