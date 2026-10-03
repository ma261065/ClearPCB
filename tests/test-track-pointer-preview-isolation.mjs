import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { Track } from '../src/shapes/track.js';
import { Via } from '../src/shapes/via.js';
import { MoveVertexCommand, RemoveTrackCommand, previewPlacementPoses, finishPlacementPreview } from '../src/pcb/modules/track-commands.js';
import { renderTrack, renderVia, buildTrackLayerRuns } from '../src/pcb/modules/track-render.js';
import { createTrackSelectionAdapter, selectTrackNode, selectTrackOrVia, setHoverHighlight } from '../src/pcb/modules/track-select.js';
import { renderPcbSelectionAnchors } from '../src/pcb/modules/selection-anchors.js';
import { arcEdgePathD } from '../src/shapes/arc-edge.js';
import { startVertexDrag, updateVertexDrag, finishVertexDrag, cancelVertexDrag,
    startMidpointInsertDrag, splitTrackNodeAndDrag, startViaDrag, updateViaDrag, finishViaDrag, cancelViaDrag } from '../src/pcb/modules/track-drag.js';
import { syncPcbSelection, getPcbSelection, clearPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { finishSelectionInteraction } from '../src/pcb/modules/selection-interaction.js';
import { prepareFabricationSnapshot } from '../src/pcb/modules/fabrication-snapshot.js';
import { loadPcb } from '../src/pcb/modules/project-state.js';
import { PCB_LAYERS } from '../src/pcb/modules/layers.js';
import { areDragOverlaysDeferred, isBoardViewRefreshSuspended, setBoardViewRefreshSuspended, setDragOverlaysDeferred } from '../src/pcb/modules/refresh-state.js';

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
    get tagName() { return this.tag; }
    get localName() { return this.tag; }
    removeChild(child) { child.remove(); }
    remove() {
        if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
        this.parentNode = null;
    }
    querySelectorAll(selector) {
        return this.children.flatMap(child => [
            ...(selector.split(',').some(part => {
                const [tag, cls] = part.trim().split('.');
                return cls && (!tag || tag === child.tag) && child.classList.contains(cls);
            }) ? [child] : []),
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
    setDragOverlaysDeferred(app, deferred);
    setBoardViewRefreshSuspended(app, deferred);
    for (const key of ['pads', 'vias', 'tracks', 'boardShapes', 'texts']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    for (const key of ['setPropertiesTitle', 'clearProperties', '_cancelPosePreviews', 'isSectionEditing',
        'deactivate', '_onLayerLockChanged', '_onLayerVisibilityChanged']) app[key] = PCBApp.prototype[key];
    Object.assign(app, {
        project, pcbDocument: model, placements: new Map(), netlist: [], history: new CommandHistory(),
        _active: true, _layerGroups: groups, _textElements: new Map(), _shapeElements: new Map(),
        viewport: { scale: 100, svg: new Element('svg'), shiftHeld: true, setCrosshair() {}, hideCrosshair() {} },
        propertiesItems: () => ({ innerHTML: '' }), getLayerGroup: id => groups.get(id) || null,
        _setActiveRibbonTab() {}, setPcbStatus() {}, refreshFills() { fills++; },
        refreshClearanceHalos() { clearances++; }, _board3d: { refresh() { boardRefreshes++; } },
        _cancelDrawingMode() {}, _ensureViewport() {}, markSectionClean() {},
        _refreshPcbSelectionHighlights() {}, _scheduleRemovalHatchRender() {},
        _alert(message) { this.lastAlert = message; },
    });
    project.registerView('pcb', app);
    for (const object of [track, unrelated[0]].filter(Boolean)) renderTrack(object, app.getLayerGroup);
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

{
    const { app, track, adapter, groups } = fixture('node');
    const nodeId = [...track.nodes.keys()][1];
    track.setNodeCornerRadius(nodeId, 4);
    const before = track.captureState();
    const guide = `M ${Math.PI} ${-Math.E} L 20 ${-Math.E} M 20 ${-Math.E} L 20 20`;
    assert.equal(adapter.getEditPath(), guide, 'Guides use authored nodes, not global or per-node corner rounding');
    const guideElement = () => groups.get('selection-overlay').querySelectorAll('.pcb-selection-anchors')
        .flatMap(group => group.children).find(child => child.tag === 'path' && child.getAttribute('d') === adapter.getEditPath());
    selectTrackNode(app, track, nodeId);
    assert.equal(adapter.getEditPath(), '', 'Idle node focus suppresses the whole-path guide, like Lines');
    for (const commit of [false, true]) {
        assert.equal(adapter.beginAnchorDrag(nodeId, track.nodes.get(nodeId)), true);
        adapter.updateAnchorDrag({ x: 23, y: 4 });
        const moved = `M ${Math.PI} ${-Math.E} L 23 4 M 23 4 L 20 20`;
        assert.equal(adapter.getEditPath(), moved, 'Focused-node dragging shows the live unrounded path');
        assert.deepEqual(track.captureState(), before, 'Guides do not mutate authored geometry');
        const path = guideElement();
        assert.ok(path, 'Drag refresh renders the shared selection guide');
        assert.equal(path.getAttribute('stroke-width'), '1');
        assert.equal(path.getAttribute('vector-effect'), 'non-scaling-stroke');
        assert.equal(path.getAttribute('pointer-events'), 'none');
        app.viewport.scale = 50;
        renderPcbSelectionAnchors(app);
        assert.equal(guideElement().getAttribute('stroke-width'), '1', 'Guide thickness remains screen-space');
        adapter.endAnchorDrag(commit, { moved: true });
        assert.equal(adapter.getEditPath(), '', 'Ending the gesture restores node-focus presentation');
        if (commit) {
            selectTrackOrVia(app, { type: 'track', track });
            assert.equal(adapter.getEditPath(), moved);
            app.history.undo();
            assert.equal(adapter.getEditPath(), guide, 'Undo restores the guide with the original graph');
            app.history.redo();
            assert.equal(adapter.getEditPath(), moved, 'Redo restores the committed guide');
        } else assert.deepEqual(track.captureState(), before);
    }
    clearPcbSelection(app);
    renderPcbSelectionAnchors(app);
    assert.equal(groups.get('selection-overlay').querySelectorAll('.pcb-selection-anchors').length, 0,
        'Deselecting removes editing guides');
}

{
    const { app, track, adapter, edgeId, groups } = fixture('bulge');
    const branch = track.addNode(30, 20);
    track.addEdge([...track.nodes.keys()][1], branch);
    const from = track.addNode(40, 0), to = track.addNode(50, 0);
    track.addEdge(from, to, { layer: 'bottom-copper' });
    const edge = track.edges.get(edgeId);
    const arc = arcEdgePathD(track.nodes.get(edge.from), track.nodes.get(edge.to), 0.25);
    const visible = `${arc} M 20 ${-Math.E} L 20 20 M 20 ${-Math.E} L 30 20`;
    assert.equal(adapter.getEditPath(), `${visible} M 40 0 L 50 0`,
        'Branch and disconnected edges remain separate, preserving authored arcs');
    const bottom = PCB_LAYERS.find(layer => layer.id === 'bottom-copper');
    const previousVisible = bottom.visible;
    try {
        bottom.visible = false;
        assert.equal(adapter.getEditPath(), visible, 'Hidden-layer edges do not leak through the guide');
        track.visible = false;
        renderPcbSelectionAnchors(app);
        assert.equal(groups.get('selection-overlay').querySelectorAll('.pcb-selection-anchors').length, 0);
    } finally {
        bottom.visible = previousVisible;
    }
}

for (const finish of ['commit', 'failure', 'no-op', 'cancel']) {
    const { app, track, initial, start, groups } = fixture('node');
    const before = track.captureState();
    assert.equal(start(), true);
    if (finish !== 'no-op') updateVertexDrag(app, { x: initial.x + 2, y: initial.y + 3 });
    let crosshairVisible = true;
    app.viewport.hideCrosshair = () => { crosshairVisible = false; };
    const guide = new Element('line'), marker = new Element('circle');
    groups.get('selection-overlay').appendChild(guide);
    groups.get('selection-overlay').appendChild(marker);
    app._netGuideLine = guide;
    app._trackSnapMarker = marker;
    const assertCleared = () => {
        assert.equal(crosshairVisible, false, 'Crosshair hides before drop validation or history work');
        assert.equal(app._netGuideLine, null, 'Nearest-net guide clears before drop processing');
        assert.equal(app._trackSnapMarker, null);
        assert.equal(guide.parentNode, null);
        assert.equal(marker.parentNode, null);
    };
    Object.defineProperty(app, '_active', { get() { assertCleared(); return true; } });
    const execute = app.history.execute.bind(app.history);
    app.history.execute = command => {
        assertCleared();
        if (finish === 'failure') throw new Error('Rejected drop after guide cleanup');
        execute(command);
    };
    if (finish === 'failure') assert.throws(() => finishVertexDrag(app), /Rejected drop after guide cleanup/);
    else if (finish === 'cancel') cancelVertexDrag(app);
    else finishVertexDrag(app);
    assertCleared();
    assert.equal(app._vertexDrag, null);
    assert.equal(app.history.undoStack.length, finish === 'commit' ? 1 : 0);
    if (finish !== 'commit') assert.deepEqual(track.captureState(), before);
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
        assert.equal(areDragOverlaysDeferred(app), deferred);
        assert.equal(isBoardViewRefreshSuspended(app), deferred);
        assert.equal(rebuilt.object, track);
        assert.equal(app.tracks, model.tracks);
        if (finish === 'load' || finish === 'missing') assert.equal(f.artwork().length, 0);
        else f.assertArtwork(track);
        if (finish !== 'load') assert.deepEqual(f.artwork(f.unrelated[0]), otherArtwork);
        cases++;
    }
}

function enableClearances({ app, groups }) {
    groups.set('clearance-overlay', new Element('g'));
    groups.set('vias', new Element('g'));
    const work = { trackScans: 0, viaScans: 0, fullRedraws: 0 };
    for (const group of groups.values()) {
        const query = group.querySelectorAll.bind(group);
        group.querySelectorAll = selector => {
            if (selector.includes('.pcb-routed-track')) work.trackScans++;
            if (selector.includes('.pcb-routed-via')) work.viaScans++;
            return query(selector);
        };
    }
    app.getRoutingParams = () => ({ clearance: 0.25, trackWidth: 0.2 });
    app.showClearances = (show, liveTrack) => {
        if (!liveTrack) work.fullRedraws++;
        return PCBApp.prototype.showClearances.call(app, show, liveTrack);
    };
    app._refreshTrackClearance = PCBApp.prototype._refreshTrackClearance;
    app._refreshViaClearance = PCBApp.prototype._refreshViaClearance;
    app.refreshClearanceHalos = PCBApp.prototype.refreshClearanceHalos;
    app.history.onChanged = () => app.refreshClearanceHalos();
    return work;
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
        renderTrack(target, app.getLayerGroup);
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
    assert.equal(areDragOverlaysDeferred(app), false);
    assert.equal(isBoardViewRefreshSuspended(app), false);
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
    renderTrack(track, app.getLayerGroup);
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
    assert.equal(areDragOverlaysDeferred(app), false);
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
    setBoardViewRefreshSuspended(app, !deferred);
    f.start();
    updateVertexDrag(app, { x: initial.x + 2, y: initial.y + 3 });
    cancelVertexDrag(app);
    assert.equal(areDragOverlaysDeferred(app), deferred);
    assert.equal(isBoardViewRefreshSuspended(app), !deferred, 'Independent nesting flags are restored separately');
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

for (const mode of ['whole', 'segment', 'node', 'midpoint', 'split', 'bulge']) {
    for (const deferred of [false, true]) {
        const f = fixture(mode, deferred), { app, track, initial, groups, model } = f;
        const work = enableClearances(f);
        if (mode === 'whole') {
            const edgeId = [...track.edges.keys()].at(-1);
            track.setEdgeAttr(edgeId, 'width', 0.8);
            track.setEdgeAttr(edgeId, 'layer', 'bottom-copper');
            renderTrack(track, app.getLayerGroup);
        }
        app.showClearances(true);
        const haloPoints = () => (app._trackClearanceElements.get(track.id) || [])
            .map(element => element.getAttribute('points'));
        const before = haloPoints(), canonical = model.captureGeometry();
        const stationary = [...app._trackClearanceElements.get(f.unrelated[0].id)];
        const overlay = groups.get('clearance-overlay');
        assert.ok(before.length);
        const initialScans = work.trackScans;
        f.start();
        const position = { x: initial.x + 2.123456789, y: initial.y + 3.765432198 };
        updateVertexDrag(app, position);
        const preview = haloPoints();
        assert.notDeepEqual(preview, before, `${mode}: clearance follows preview before drop`);
        assert.equal(work.fullRedraws, 1, 'pointer updates never rebuild the full-board overlay');
        assert.equal(work.trackScans, initialScans, 'targeted clearance never scans unrelated track SVG');
        assert.deepEqual(model.captureGeometry(), canonical, 'clearance reads detached preview, not authored geometry');
        for (const element of stationary) assert.ok(overlay.children.includes(element),
            'unrelated clearance SVG is retained without detach/rebuild');
        const currentElements = [...app._trackClearanceElements.get(track.id)];
        updateVertexDrag(app, position);
        assert.deepEqual(app._trackClearanceElements.get(track.id), currentElements,
            'stationary pointer creates no clearance churn');
        app.showClearances(true);
        assert.deepEqual(haloPoints(), preview, 'targeted preview is identical to the normal full clearance renderer');
        app.showClearances(false);
        updateVertexDrag(app, { x: position.x + 1, y: position.y + 1 });
        assert.equal(overlay.children.length, 0, 'drag cannot resurrect disabled clearance');
        app.showClearances(true);
        cancelVertexDrag(app);
        assert.deepEqual(haloPoints(), before, `${mode}: cancellation restores clearance, including nested deferral`);
        assert.equal(areDragOverlaysDeferred(app), deferred);
        f.start();
        updateVertexDrag(app, position);
        finishVertexDrag(app);
        const committed = haloPoints();
        assert.notDeepEqual(committed, before, `${mode}: committed clearance retains moved geometry`);
        app.history.undo();
        assert.deepEqual(haloPoints(), before, `${mode}: undo restores clearance`);
        app.history.redo();
        assert.deepEqual(haloPoints(), committed, `${mode}: redo restores committed clearance`);
        cases++;
    }
}

for (const deferred of [false, true]) for (const coincident of [false, true]) {
    const f = fixture('node', deferred), { app, track, initial, model, groups } = f;
    const work = enableClearances(f);
    const via = new Via({ ...initial, diameter: 1.2 }), stationary = new Via({ x: -100, y: -100, diameter: 0.8 });
    model.vias.push(via, stationary);
    if (coincident) model.vias.push(new Via({ ...initial, diameter: 0.6 }));
    const bottom = new Track({ layer: 'bottom-copper', width: 0.7,
        points: [initial, { x: initial.x - 10, y: initial.y - 10 }] });
    model.tracks.push(bottom);
    renderTrack(bottom, app.getLayerGroup);
    for (const object of model.vias) renderVia(object, app.getLayerGroup);
    app.showClearances(true);
    const overlay = groups.get('clearance-overlay');
    const halo = object => app._viaClearanceCache.get(app._viaClearanceKeys.get(object.id))?.element;
    const snapshot = () => ({
        via: [...app._viaClearanceCache.values()].map(({ element }) =>
            ['cx', 'cy', 'r'].map(key => element.getAttribute(key)).join(',')).sort(),
        tracks: [track, bottom].map(object => app._trackClearanceElements.get(object.id).map(el => el.getAttribute('points'))),
    });
    const before = snapshot(), saved = model.captureGeometry();
    const stable = [halo(stationary), ...app._trackClearanceElements.get(f.unrelated[0].id)];
    const counts = { ...work }, position = { x: initial.x + 2, y: initial.y + 3 };
    startViaDrag(app, via, initial);
    updateViaDrag(app, position);
    const preview = snapshot();
    assert.notDeepEqual(preview.tracks, before.tracks, 'via drag updates attached tracks on both copper layers');
    assert.deepEqual(model.captureGeometry(), saved, 'live halos use detached geometry');
    assert.equal(halo(via).getAttribute('cx'), String(position.x));
    assert.equal(halo(via).getAttribute('cy'), String(position.y));
    assert.equal(halo(via).getAttribute('r'), '0.85', 'via halo has its diameter plus the exact clearance');
    assert.deepEqual(work, counts, 'no full redraw or unrelated SVG scan during a via drag');
    for (const element of stable) assert.equal(element.parentNode, overlay, 'unrelated outlines remain attached');
    if (coincident) assert.equal(halo(model.vias[2]).getAttribute('r'), '0.55',
        'moving the larger coincident via restores the remaining smaller ring');
    const current = halo(via);
    updateViaDrag(app, position);
    assert.equal(halo(via), current, 'stationary pointer does not redraw clearance');
    app.showClearances(true);
    assert.deepEqual(snapshot(), preview, 'incremental via and track halos equal full overlay output');
    app.showClearances(false);
    updateViaDrag(app, { x: position.x + 1, y: position.y + 1 });
    assert.equal(overlay.children.length, 0, 'disabled outlines stay disabled');
    app.showClearances(true);
    cancelViaDrag(app);
    assert.deepEqual(snapshot(), before, 'cancel restores via and attached halos, even under nested deferral');
    assert.equal(areDragOverlaysDeferred(app), deferred);
    startViaDrag(app, via, initial);
    updateViaDrag(app, position);
    finishViaDrag(app);
    assert.deepEqual(snapshot(), preview, 'drop retains the preview outlines');
    app.history.undo();
    assert.deepEqual(snapshot(), before, 'undo restores all moved outlines');
    app.history.redo();
    assert.deepEqual(snapshot(), preview, 'redo restores all moved outlines');
    via.net = track.net = bottom.net = 'GND';
    f.unrelated[0].net = 'OTHER';
    app.viewport.shiftHeld = false;
    startViaDrag(app, via, position);
    updateViaDrag(app, { x: 100, y: 100 });
    assert.equal(app._viaDrag.snapTargetTrack?.track, f.unrelated[0], 'real pointer finds an incompatible drop target');
    finishViaDrag(app);
    assert.ok(app.lastAlert, 'incompatible drop warns');
    assert.deepEqual(snapshot(), preview, 'rejected drop restores the prior via and attached-track outlines');
    app.viewport.shiftHeld = true;
    groups.get('vias').style.display = 'none';
    app.showClearances(true);
    startViaDrag(app, via, position);
    updateViaDrag(app, { x: position.x + 2, y: position.y + 2 });
    assert.equal(app._viaClearanceCache.size, 0, 'hidden via layer does not gain live halos');
    cancelViaDrag(app);
    groups.get('vias').style.display = '';
    app.showClearances(true);
    startViaDrag(app, via, position);
    updateViaDrag(app, { x: position.x + 2, y: position.y + 2 });
    model.vias.splice(model.vias.indexOf(via), 1);
    cancelViaDrag(app);
    assert.equal(halo(via), undefined, 'cancel cannot restore a clearance ghost for a removed terminal');
    cases++;
}

console.log(`PASS ${cases} direct-track pointer cases: isolation, exact history and live clearance with bounded redraws`);
