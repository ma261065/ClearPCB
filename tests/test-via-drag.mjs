/** Headless regression tests for via-drag derived-overlay deferral. */
import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { Component } from '../src/components/Component.js';
import { areDragOverlaysDeferred, setDragOverlaysDeferred } from '../src/pcb/modules/refresh-state.js';
import { getPcbPaste } from '../src/pcb/modules/pcb-paste.js';

globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById() { return null; },
    createElementNS() {
        const attributes = new Map();
        return {
            setAttribute(name, value) { attributes.set(name, String(value)); },
            getAttribute(name) { return attributes.get(name); },
            remove() {
                if (this.parentNode) {
                    const siblings = this.parentNode.children;
                    siblings.splice(siblings.indexOf(this), 1);
                    this.parentNode = null;
                }
            },
            classList: { add() {} },
            dataset: {},
        };
    },
};

const { Via } = await import('../src/shapes/via.js');
const { Track } = await import('../src/shapes/track.js');
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { setPcbSelection, getPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const { collectBondedCopper, reconcileRatsnest } = await import('../src/pcb/modules/track-draw.js');
const { AddTrackCommand, RemoveTrackCommand, AddViaCommand, RemoveViaCommand, MoveViaCommand,
    ModifyViaCommand, ModifyViasCommand, ModifyTrackCommand, ModifyTrackGraphCommand,
    MoveVertexCommand, CompoundCommand } = await import('../src/pcb/modules/track-commands.js');
const {
    FlipPlacementCommand,
    MovePlacementCommand,
    RotatePlacementCommand,
    SetPlacementLockedCommand,
    SetPlacementSideCommand,
    applyPlacementPose,
} = await import('../src/pcb/modules/track-commands.js');
const { beginGroupDrag, updateGroupDrag, cancelGroupDrag, endGroupDrag } = await import('../src/pcb/modules/box-select.js');
const {
    startVertexDrag,
    updateVertexDrag,
    finishVertexDrag,
    cancelVertexDrag,
    startViaDrag,
    updateViaDrag,
    finishViaDrag,
    cancelViaDrag,
} = await import('../src/pcb/modules/track-drag.js');

let failures = 0;

function expect(name, condition) {
    if (condition) {
        console.log(`PASS: ${name}`);
        return;
    }
    failures++;
    console.error(`FAIL: ${name}`);
}

function appFor(via) {
    const pcbDocument = new PcbDocument();
    pcbDocument.vias.push(via);
    let fillRefreshes = 0;
    let clearanceRefreshes = 0;
    const crosshairs = [];
    const app = {
        pcbDocument,
        placementState: pcbDocument.placementState,
        tracks: pcbDocument.tracks,
        vias: pcbDocument.vias,
        placements: new Map(),
        netlist: [],
        _layerGroups: new Map(),
        getLayerGroup() {
            for (const track of this.tracks) assert.deepEqual(track.getBounds(), track._calculateBounds(),
                'Track bounds follow preview geometry before rendering');
            return null;
        },
        refreshFills() { fillRefreshes++; },
        fillRefreshes() { return fillRefreshes; },
        refreshClearanceHalos() { clearanceRefreshes++; },
        clearanceRefreshes() { return clearanceRefreshes; },
        crosshairs,
        viewport: {
            scale: 100,
            gridVisible: false,
            setCrosshair(point) { crosshairs.push(point); },
            hideCrosshair() {},
        },
        history: { execute(command) { command.execute(); } },
        alert(message, options) { this.lastAlert = { message, options }; },
        openPropertyPanel() { return true; },
        refreshPropertyPanel() {},
    };
    for (const key of ['tracks', 'vias', 'pads']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    return app;
}

function trackAppFor(track, previousDeferral = false) {
    const project = new ProjectDocument();
    const pcbDocument = project.pcbDocument;
    pcbDocument.tracks.push(track);
    let fillRefreshes = 0;
    let clearanceRefreshes = 0;
    const app = {
        project,
        pcbDocument,
        placementState: pcbDocument.placementState,
        tracks: pcbDocument.tracks,
        vias: pcbDocument.vias,
        placements: new Map(),
        netlist: [],
        boardShapes: [],
        copperFills: [],
        _layerGroups: new Map(),
        getLayerGroup() {
            for (const track of this.tracks) assert.deepEqual(track.getBounds(), track._calculateBounds(),
                'Track bounds follow preview geometry before rendering');
            return null;
        },
        refreshFills() { fillRefreshes++; },
        snapToGrid(point) { return point; },
        fillRefreshes() { return fillRefreshes; },
        refreshClearanceHalos() { clearanceRefreshes++; },
        clearanceRefreshes() { return clearanceRefreshes; },
        viewport: {
            scale: 100,
            gridVisible: false,
            setCrosshair() {},
            hideCrosshair() {},
        },
        history: { execute(command) { command.execute(); } },
        alert(message, options) { this.lastAlert = { message, options }; },
        openPropertyPanel() { return true; },
        refreshPropertyPanel() {},
    };
    setDragOverlaysDeferred(app, previousDeferral);
    return app;
}

for (const commit of [false, true]) {
    const via = new Via({ x: 0, y: 0, net: 'GND' });
    const app = appFor(via);
    app.tracks.push(
        new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], net: 'GND' }),
        new Track({ points: [{ x: 0, y: 0 }, { x: 0, y: 10 }], net: 'GND' }));
    const before = app.tracks.map(track => track.getBounds());
    startViaDrag(app, via, { x: 0, y: 0 });
    updateViaDrag(app, { x: -4, y: -3 });
    updateViaDrag(app, { x: -6, y: -5 });
    assert.ok(app.tracks.every(track => track.getBounds().minX === -6.1));
    if (commit) finishViaDrag(app);
    else cancelViaDrag(app);
    for (const [index, track] of app.tracks.entries()) {
        assert.deepEqual(track.getBounds(), track._calculateBounds());
        if (!commit) assert.deepEqual(track.getBounds(), before[index]);
    }
}

{
    const { createTrackSelectionAdapter } = await import('../src/pcb/modules/track-select.js');
    const { default: PCBApp } = await import('../src/ui/PCBApp.js');
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    const app = trackAppFor(track);
    const before = track.getBounds();
    const adapter = createTrackSelectionAdapter(app, track, track.id);
    adapter.beginAnchorDrag('bulge:e0', { x: 5, y: 0 });
    adapter.updateAnchorDrag({ x: 5, y: 4 });
    assert.notDeepEqual(adapter.getBounds(), before);
    assert.equal(track.getBounds(), before, 'Canonical bounds remain cached during bulge preview');
    adapter.endAnchorDrag(false);
    assert.deepEqual(track.getBounds(), before);
    const pasted = new Track({ id: 'pasted-track' });
    pasted.applyState(track.captureState());
    PCBApp.prototype._beginPasteDrop.call(app, { tracks: [pasted] });
    getPcbPaste(app).anchorWorld = { x: 0, y: 0 };
    for (const point of [{ x: -3, y: -2 }, { x: -6, y: -4 }]) {
        PCBApp.prototype._updatePasteDrop.call(app, point);
        assert.deepEqual(pasted.getBounds(), pasted._calculateBounds());
        assert.equal(pasted.getBounds().minX, point.x - 0.1);
        assert.deepEqual(track.getBounds(), before);
    }
    PCBApp.prototype._cancelPasteDrop.call(app);
}

{
    const via = new Via({ x: 1, y: 2, diameter: 2, drill: 0.3 });
    const app = appFor(via);
    startViaDrag(app, via, { x: 1.5, y: 2.25 });
    expect('off-center via pickup keeps the via at its origin', via.x === 1 && via.y === 2
        && app.crosshairs.at(-1).x === 1 && app.crosshairs.at(-1).y === 2);
    updateViaDrag(app, { x: 4.5, y: 6.25 });
    expect('off-center via drag preserves the cursor offset', app.vias[0].x === 4 && app.vias[0].y === 6
        && app.crosshairs.at(-1).x === 4 && app.crosshairs.at(-1).y === 6);
    assert.deepEqual([via.x, via.y], [1, 2], 'Canonical via stays at its authored position during preview');
    cancelViaDrag(app);
}

{
    const via = new Via({ x: 1, y: 2, diameter: 0.6, drill: 0.3 });
    const app = appFor(via);
    expect('via pickup begins derived-overlay deferral', startViaDrag(app, via, { x: 1, y: 2 })
        && areDragOverlaysDeferred(app) === true);
    updateViaDrag(app, { x: 4, y: 5 });
    expect('via mousemove does not refresh copper pours', app.fillRefreshes() === 0);
    expect('via mousemove does not rebuild clearance', app.clearanceRefreshes() === 0);
    finishViaDrag(app);
    expect('via drop restores derived-overlay refreshes', areDragOverlaysDeferred(app) === false);
    expect('via drop refreshes copper pours once', app.fillRefreshes() === 1);
    expect('via drop explicitly refreshes clearance once', app.clearanceRefreshes() === 1);
}

{
    const via = new Via({ x: 1, y: 2, diameter: 0.6, drill: 0.3 });
    const app = appFor(via);
    startViaDrag(app, via, { x: 1, y: 2 });
    updateViaDrag(app, { x: 4, y: 5 });
    cancelViaDrag(app);
    expect('via cancel restores derived-overlay refreshes', areDragOverlaysDeferred(app) === false);
    expect('via cancel does not refresh unchanged copper pours', app.fillRefreshes() === 0);
    expect('via cancel restores its original position', via.x === 1 && via.y === 2);
    expect('via cancel restores clearance', app.clearanceRefreshes() === 1);
}

{
    const via = new Via({ x: 1, y: 2, diameter: 0.6, drill: 0.3, net: 'GND' });
    const track = new Track({ points: [{ x: 0, y: 5 }, { x: 10, y: 5 }], net: 'GND' });
    const app = appFor(via);
    app.tracks.push(track);
    startViaDrag(app, via, { x: 1, y: 2 });
    updateViaDrag(app, { x: 5, y: 5.1 });
    finishViaDrag(app);
    const bonded = collectBondedCopper(app, { via });
    expect('via snaps onto and bonds with a same-net track segment',
        via.x === 5 && via.y === 5 && bonded.tracks.has(track));
}

{
    const via = new Via({ x: 1, y: 2, diameter: 0.6, drill: 0.3, net: 'GND' });
    const track = new Track({ points: [{ x: 0, y: 5 }, { x: 10, y: 5 }], net: 'VCC' });
    const app = appFor(via);
    app.tracks.push(track);
    startViaDrag(app, via, { x: 1, y: 2 });
    updateViaDrag(app, { x: 5, y: 5.1 });
    finishViaDrag(app);
    expect('via drop onto a different-net track is rejected',
        via.x === 1 && via.y === 2 && app.lastAlert?.options?.title === 'Net Conflict');
}

{
    const via = new Via({ x: 1, y: 2, diameter: 0.6, drill: 0.3, net: 'GND' });
    const track = new Track({ points: [{ x: 5, y: 5 }, { x: 10, y: 5 }], net: 'VCC' });
    const app = appFor(via);
    app.tracks.push(track);
    startViaDrag(app, via, { x: 1, y: 2 });
    updateViaDrag(app, { x: 5.02, y: 5.02 });
    finishViaDrag(app);
    expect('via drop onto a different-net track endpoint is rejected',
        via.x === 1 && via.y === 2 && app.lastAlert?.options?.title === 'Net Conflict');
}

{
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], net: 'GND' });
    const app = trackAppFor(track);
    expect('track pickup begins derived-overlay deferral', startVertexDrag(app, track, { x: 0, y: 0 })
        && areDragOverlaysDeferred(app) === true);
    updateVertexDrag(app, { x: 2, y: 2 });
    expect('track mousemove does not refresh copper pours', app.fillRefreshes() === 0);
    expect('track mousemove does not rebuild clearance', app.clearanceRefreshes() === 0);
    finishVertexDrag(app);
    expect('track drop restores derived-overlay refreshes', areDragOverlaysDeferred(app) === false);
    expect('track drop refreshes copper pours once', app.fillRefreshes() === 1);
    expect('track drop explicitly refreshes clearance once', app.clearanceRefreshes() === 1);
}

{
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], net: 'GND' });
    const app = trackAppFor(track);
    startVertexDrag(app, track, { x: 0, y: 0 });
    updateVertexDrag(app, { x: 2, y: 2 });
    cancelVertexDrag(app);
    expect('track cancel restores derived-overlay refreshes', areDragOverlaysDeferred(app) === false);
    expect('track cancel does not refresh unchanged copper pours', app.fillRefreshes() === 0);
    expect('track cancel restores its original position', track.nodes.get('n0')?.x === 0 && track.nodes.get('n0')?.y === 0);
    expect('track cancel restores clearance', app.clearanceRefreshes() === 1);
}

{
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 0, y: 4 }], net: 'GND' });
    const via = new Via({ x: 5, y: 5, diameter: 0.6, drill: 0.3, net: 'GND' });
    const app = trackAppFor(track);
    app.vias.push(via);
    startVertexDrag(app, track, { x: 0, y: 0 });
    updateVertexDrag(app, { x: 5.05, y: 5.05 });
    finishVertexDrag(app);
    const bonded = collectBondedCopper(app, { track });
    expect('track node snaps onto and bonds with a same-net via',
        track.nodes.get('n0')?.x === 5 && track.nodes.get('n0')?.y === 5 && bonded.vias.has(via));
}

{
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 0, y: 4 }], net: 'GND' });
    const via = new Via({ x: 5, y: 5, diameter: 0.6, drill: 0.3, net: 'VCC' });
    const app = trackAppFor(track);
    app.vias.push(via);
    startVertexDrag(app, track, { x: 0, y: 0 });
    updateVertexDrag(app, { x: 5.05, y: 5.05 });
    finishVertexDrag(app);
    expect('track node drop onto a different-net via is rejected',
        track.nodes.get('n0')?.x === 0 && track.nodes.get('n0')?.y === 0
        && app.lastAlert?.options?.title === 'Net Conflict');
}

{
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], net: 'GND' });
    const app = trackAppFor(track, true);
    startVertexDrag(app, track, { x: 0, y: 0 });
    updateVertexDrag(app, { x: 2, y: 2 });
    finishVertexDrag(app);
    expect('track drop preserves an existing overlay deferral', areDragOverlaysDeferred(app) === true);
    expect('nested track drop does not refresh copper pours', app.fillRefreshes() === 0);
    expect('nested track drop does not rebuild clearance', app.clearanceRefreshes() === 0);
}

{
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], net: 'GND' });
    const via = new Via({ x: 1, y: 2, diameter: 0.6, drill: 0.3 });
    const app = trackAppFor(track);
    reconcileRatsnest(app);
    expect('connectivity alone does not refresh clearance', app.clearanceRefreshes() === 0);
    for (const command of [new AddTrackCommand(app, track), new RemoveTrackCommand(app, track),
        new AddViaCommand(app, via), new RemoveViaCommand(app, via), new MoveViaCommand(app, via, 1, 2, 3, 4)]) {
        const before = app.clearanceRefreshes();
        command.execute();
        command.undo();
        expect(`${command.constructor.name} owns execute and undo clearance`, app.clearanceRefreshes() === before + 2);
    }
    const before = app.clearanceRefreshes();
    const compound = new CompoundCommand([new AddTrackCommand(app, track), new AddViaCommand(app, via)]);
    compound.execute();
    compound.undo();
    expect('compound edits coalesce clearance independently', app.clearanceRefreshes() === before + 2);
}

{
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], net: 'GND' });
    const app = trackAppFor(track);
    app.placements.set('component', { x: 0, y: 0, rotation: 0, pads: new Map(), padOffsets: [] });
    app.project.schematicDocument.components.push(new Component({ name: 'EmptyFootprint', symbol: { pins: [] } },
        { id: 'component' }));
    for (const command of [new MovePlacementCommand(app, 'component', 0, 0, 3, 4),
        new RotatePlacementCommand(app, 'component', 0, 90), new FlipPlacementCommand(app, 'component', 'H'),
        new SetPlacementSideCommand(app, 'component', 'bottom')]) {
        const before = app.clearanceRefreshes();
        command.execute();
        command.undo();
        expect(`${command.constructor.name} owns execute and undo clearance`, app.clearanceRefreshes() === before + 2);
    }
    const lock = new SetPlacementLockedCommand(app, 'component', true);
    lock.execute();
    expect('component lock command applies and persists', app.placements.get('component').locked === true);
    lock.undo();
    expect('component lock command is undoable', app.placements.get('component').locked === false);
}

for (const previousDeferral of [false, true]) {
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], net: 'GND' });
    const app = trackAppFor(track, previousDeferral);
    Object.defineProperty(app, 'tracks', Object.getOwnPropertyDescriptor(PCBApp.prototype, 'tracks'));
    const before = track.captureState();
    setPcbSelection(app, [{ kind: 'track', object: track }]);
    beginGroupDrag(app, { x: 0, y: 0 });
    updateGroupDrag(app, { x: 3, y: 0 }, { snap: false });
    expect('group track display follows movement', app.tracks[0].nodes.get('n0').x === 3);
    assert.deepEqual(track.captureState(), before, 'Group movement leaves canonical track geometry unchanged');
    cancelGroupDrag(app);
    expect('group cancellation restores canonical track presentation', app.tracks[0] === track && track.nodes.get('n0').x === 0);
    expect(`group cancellation respects existing deferral (${previousDeferral})`, app.clearanceRefreshes() === (previousDeferral ? 0 : 1));
    const count = app.clearanceRefreshes();
    beginGroupDrag(app, { x: 0, y: 0 });
    endGroupDrag(app);
    expect(`unchanged group drop restores clearance (${previousDeferral})`, app.clearanceRefreshes() === count + (previousDeferral ? 0 : 1));
}

{
    const first = new Via({ x: 1, y: 2, net: 'GND' });
    const second = new Via({ x: 5, y: 6, net: 'GND' });
    const app = appFor(first);
    app.vias.push(second);
    const vias = app.pcbDocument.vias;
    const layer = { children: [], appendChild(element) {
        this.children.push(element);
        element.parentNode = this;
    } };
    const renderedStates = [];
    let reconciles = 0;
    app.getLayerGroup = id => {
        if (id === 'ratlines') reconciles++;
        if (id !== 'vias') return null;
        renderedStates.push(vias.map(via => via.captureState()));
        return layer;
    };
    const before = vias.map(via => via.captureState());
    const after = before.map(state => ({ ...state, diameter: 0.876543, drill: 0.345678, net: 'POWER' }));
    const batch = new ModifyViasCommand(app, vias.map((via, index) => ({
        via, before: before[index], after: after[index],
    })));
    for (const deferred of [false, true]) {
        setDragOverlaysDeferred(app, deferred);
        for (const [action, expected] of [['execute', after], ['undo', before]]) {
            renderedStates.length = 0;
            const counts = [app.clearanceRefreshes(), app.fillRefreshes(), reconciles];
            batch[action]();
            assert.equal(app.vias, vias);
            assert.deepEqual(renderedStates, [expected, expected], 'Every via is updated before the first SVG render');
            assert.equal(layer.children.length, 4, 'Each refresh replaces, rather than duplicates, the ring and drill');
            assert.equal(app.clearanceRefreshes() - counts[0], deferred ? 0 : 1);
            assert.equal(app.fillRefreshes() - counts[1], deferred ? 0 : 1);
            assert.equal(reconciles - counts[2], 1, 'Batch property edits reconcile only once');
        }
    }
    setDragOverlaysDeferred(app, false);
    const compound = new CompoundCommand(vias.map(via =>
        new ModifyViaCommand(app, via, { net: via.net }, { net: 'COMPOUND' })));
    const counts = [app.clearanceRefreshes(), app.fillRefreshes(), reconciles];
    compound.execute();
    compound.undo();
    assert.deepEqual(vias.map(via => via.captureState()), before);
    assert.equal(app.clearanceRefreshes() - counts[0], 2);
    assert.equal(app.fillRefreshes() - counts[1], 2);
    assert.equal(reconciles - counts[2], 2, 'Editor adapters still participate in compound refresh batching');
    const move = new MoveViaCommand(app, first, first.x, first.y, 3.123456, -4.123456);
    const beforeMove = [app.clearanceRefreshes(), app.fillRefreshes(), reconciles];
    move.execute();
    const ring = layer.children.find(element => element.dataset.viaId === first.id
        && element.getAttribute('class') === 'pcb-via');
    assert.equal(ring.getAttribute('data-via-x'), '3.123456');
    assert.equal(ring.getAttribute('data-via-y'), '-4.123456');
    move.undo();
    assert.equal(layer.children.length, 4);
    assert.equal(app.clearanceRefreshes() - beforeMove[0], 2);
    assert.equal(app.fillRefreshes(), beforeMove[1], 'Via movement preserves caller-owned pour refresh timing');
    assert.equal(reconciles, beforeMove[2], 'Via movement preserves caller-owned connectivity timing');
    const remove = new RemoveViaCommand(app, first);
    remove.execute();
    assert.deepEqual(vias, [second]);
    assert.equal(layer.children.length, 2, 'Removal clears the via SVG along with its model entry');
    remove.undo();
    assert.deepEqual(vias, [second, first]);
    assert.equal(layer.children.length, 4);
    const added = new Via({ x: 10, y: 20 });
    const add = new AddViaCommand(app, added);
    add.execute();
    assert.equal(vias[2], added);
    assert.equal(layer.children.length, 6);
    add.undo();
    assert.deepEqual(vias, [second, first]);
    assert.equal(layer.children.length, 4, 'Undo addition removes only the newly added via SVG');
    assert.equal(app.vias, app.pcbDocument.vias);
}

{
    const app = appFor(new Via({ x: 50, y: 50 }));
    const quietVia = app.vias[0];
    const route = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    const routeVia = new Via({ x: 10, y: 0 });
    const layer = () => ({ children: [], appendChild(element) {
        this.children.push(element);
        element.parentNode = this;
    } });
    const copper = layer(), holes = layer();
    const observedOwnership = [];
    let reconciles = 0, propertyClears = 0;
    app.clearProperties = () => { propertyClears++; };
    app.getLayerGroup = id => {
        if (id === 'ratlines') reconciles++;
        if (id !== 'top-copper' && id !== 'vias') return null;
        observedOwnership.push([app.tracks.includes(route), app.vias.includes(routeVia)]);
        return id === 'top-copper' ? copper : holes;
    };
    const associated = [routeVia];
    const add = new AddTrackCommand(app, route, associated);
    associated.length = 0;
    add.execute();
    assert.deepEqual(observedOwnership[0], [true, true], 'The complete route is in the model before rendering');
    assert.equal(copper.children.length, 1);
    assert.equal(holes.children.length, 2, 'Associated vias use the command-owned membership during rendering');
    assert.equal(app.tracks, app.pcbDocument.tracks);
    assert.equal(app.vias, app.pcbDocument.vias);
    setPcbSelection(app, [{ kind: 'track', object: route }]);
    const graphBefore = route.captureState();
    const graphAfter = structuredClone(graphBefore);
    graphAfter.nodes.n0.x = -2.123456;
    graphAfter.edges.e0.bulge = 0.25;
    graphAfter.edges.e0.width = 0.456789;
    for (const command of [
        new MoveVertexCommand(app, route, 'n0', 0, 0, 3.123456, -4.123456),
        new ModifyTrackGraphCommand(app, route, graphBefore, graphAfter),
        new ModifyTrackCommand(app, route, { net: '' }, { net: 'POWER' }),
    ]) {
        const counts = [app.clearanceRefreshes(), app.fillRefreshes(), reconciles];
        command.execute();
        assert.equal(copper.children.length, 1, 'Selected track redraw replaces its old SVG without labels');
        const path = copper.children.find(element => element.getAttribute('class') === 'pcb-track');
        if (command instanceof MoveVertexCommand) assert.ok(path.getAttribute('points').startsWith('3.123456,-4.123456 '));
        if (command instanceof ModifyTrackGraphCommand) assert.equal(path.getAttribute('stroke-width'), '0.456789');
        if (command instanceof ModifyTrackCommand) assert.equal(path.dataset.net, 'POWER');
        command.undo();
        assert.deepEqual(route.captureState(), graphBefore);
        assert.equal(app.clearanceRefreshes() - counts[0], 2);
        assert.equal(app.fillRefreshes() - counts[1], 2);
        assert.equal(reconciles - counts[2], 2);
    }
    const remove = new RemoveTrackCommand(app, route);
    remove.execute();
    assert.deepEqual(app.tracks, []);
    assert.deepEqual(getPcbSelection(app, 'track'), []);
    assert.equal(propertyClears, 1);
    assert.equal(copper.children.length, 0);
    assert.equal(holes.children.length, 2, 'Track deletion leaves standalone via SVG intact');
    remove.undo();
    assert.equal(app.tracks[0], route);
    assert.equal(copper.children.length, 1);
    add.undo();
    assert.deepEqual(app.tracks, []);
    assert.deepEqual(app.vias, [quietVia]);
    assert.equal(copper.children.length, 0);
    assert.equal(holes.children.length, 0);
}

{
    const component = new Component({
        name: 'PoseFixture', _source: 'KiCad', symbol: { pins: [{ number: '1' }] },
        footprintShapes: ['PAD~RECT~-2~0~1~1~1~both~1~0~0.5', 'PAD~RECT~2~0~1~1~1~both~1~0~0.5'],
    }, { id: 'pose-part' });
    const track = new Track({ points: [{ x: -2, y: 0 }, { x: 2, y: 0 }],
        padConnections: { n0: { componentId: component.id, pinNumber: '1' },
            n1: { componentId: component.id, pinNumber: '1#2' } } });
    const app = trackAppFor(track);
    app.project.schematicDocument.components.push(component);
    const group = { children: [], appendChild(child) { this.children.push(child); child.parentNode = this; } };
    app.getLayerGroup = id => id === 'top-copper' ? group : null;
    const stages = [];
    const attributes = new Map();
    const placement = {
        x: 0, y: 0, rotation: 0, pads: new Map([['unrelated', { x: 100, y: 100 }]]),
        // Deliberately stale projection geometry must not re-apply movement after the model command.
        padOffsets: [{ padId: '1', dx: -999, dy: 0 }, { padId: '1#2', dx: 999, dy: 0 }],
        elements: [{
            setAttribute(name, value) {
                assert.equal(app.placementState.overrides.get(component.id).x, app.placements.get(component.id).x,
                    'Canonical pose precedes rendering');
                attributes.set(name, value);
                stages.push('pose');
            },
            querySelectorAll() { return []; },
        }],
    };
    const pads = placement.pads;
    app.placements.set(component.id, placement);
    app._recordPlacementOverride = () => assert.fail('Physical adapters must not re-record generated placements');
    app.refreshClearanceHalos = () => stages.push('clearance');
    app._markDirty = () => stages.push('dirty');
    app.updateRatsnest = () => stages.push('ratsnest');
    app.refreshFills = () => stages.push('fills');
    app._board3d = { refresh() { stages.push('3d'); } };
    const verify = () => {
        const pose = app.placementState.overrides.get(component.id);
        const radians = pose.rotation * Math.PI / 180;
        const sign = pose.mirror !== (pose.side === 'bottom') ? -1 : 1;
        const projected = app.placements.get(component.id);
        for (const [id, padId, dx] of [['n0', '1', -2], ['n1', '1#2', 2]]) {
            const node = track.nodes.get(id);
            assert.ok(Math.abs(node.x - pose.x - sign * dx * Math.cos(radians)) < 1e-12);
            assert.ok(Math.abs(node.y - pose.y - sign * dx * Math.sin(radians)) < 1e-12);
            if (projected) assert.deepEqual(projected.pads.get(padId), { ...node, number: '1' });
        }
        assert.equal(group.children.length, 1, 'Each redraw replaces the previous track SVG');
        assert.equal(group.children[0].getAttribute('points'),
            [...track.nodes.values()].map(node => `${node.x},${node.y}`).join(' '));
        assert.equal(stages.filter(stage => stage === 'dirty').length, 1);
    };
    for (const create of [
        () => new MovePlacementCommand(app, component.id, 0, 0, 3.123456, 4.234567),
        () => new RotatePlacementCommand(app, component.id, 0, 90),
        () => new FlipPlacementCommand(app, component.id, 'H'),
        () => new FlipPlacementCommand(app, component.id, 'V'),
    ]) {
        const command = create();
        for (const action of ['execute', 'undo', 'execute']) {
            stages.length = 0;
            command[action]();
            verify();
            assert.deepEqual(stages, ['pose', 'clearance', 'dirty', 'ratsnest', 'fills', '3d']);
            assert.equal(placement.pads, pads);
            assert.deepEqual(pads.get('unrelated'), { x: 100, y: 100 });
        }
    }
    assert.match(attributes.get('transform'), /^translate\(3\.123456, 4\.234567\)/);
    const current = app.placementState.overrides.get(component.id);
    const pending = new MovePlacementCommand(app, component.id, current.x, current.y, 10, 20);
    app.placements.set(component.id, { ...placement, x: 999, pads: new Map() });
    stages.length = 0;
    pending.execute();
    verify();
    assert.equal(app.placements.get(component.id).x, 10, 'The current projection receives the model result');
    app.placements.delete(component.id);
    stages.length = 0;
    pending.undo();
    verify();
    assert.deepEqual(stages, ['clearance', 'dirty', 'ratsnest', 'fills', '3d'],
        'Undo updates model bonds and presentation even with no rendered footprint');
}

{
    const attached = (pinNumber, layer) => new Track({
        points: [{ x: 0, y: 0 }, { x: 30, y: 0 }], layer, net: 'GND',
        padConnections: { n0: { componentId: 'component', pinNumber } },
    });
    const topSmd = attached('1', 'top-copper');
    const bottomSmd = attached('2', 'bottom-copper');
    const topThrough = attached('3', 'top-copper');
    const duplicateThrough = attached('3#2', 'bottom-copper');
    const app = trackAppFor(topSmd);
    app.tracks.push(bottomSmd, topThrough, duplicateThrough);
    app.project.schematicDocument.components.push(new Component({
        name: 'SideFixture', _source: 'KiCad', symbol: { pins: [] },
        footprintShapes: [
            'PAD~RECT~2~0~1~1~1~top', 'PAD~RECT~0~2~1~1~2~bottom',
            'PAD~RECT~-4~-2~1~1~3~both~1~0~0.5', 'PAD~RECT~4~0~1~1~3~both~1~0~0.5',
            'PASTE~RECT~0~0~1~1~top', 'PASTE~RECT~0~0~1~1~bottom',
        ],
    }, { id: 'component' }));
    const footprint = app.project.getPcbFootprint('component');
    const placement = {
        x: 10, y: 20, rotation: 0, side: 'top', pads: new Map(),
        padOffsets: footprint.padOffsets, pasteOffsets: footprint.pasteOffsets,
    };
    const svg = attributes => {
        const values = new Map(Object.entries(attributes));
        return {
            getAttribute: name => values.get(name),
            hasAttribute: name => values.has(name),
            setAttribute(name, value) { values.set(name, String(value)); },
            removeAttribute(name) { values.delete(name); },
        };
    };
    const smdShape = svg({ fill: '#e74c3c' }), thShape = svg({ fill: '#b8860b' });
    const padLabel = svg({ 'data-mx-center': '1' });
    const refLabel = svg({ 'data-fp-ref': '', 'data-mx-center': '1', 'data-ref-cy': '0' });
    const copperArtwork = { ...svg({ 'data-fp-layer': 'top-copper' }),
        querySelectorAll(selector) {
            return selector === '.pcb-pad'
                ? [{ getAttribute: () => 'smd', querySelector: () => smdShape },
                    { getAttribute: () => 'th', querySelector: () => thShape }]
                : selector === '.pcb-mirror-text' ? [padLabel] : [];
        },
    };
    const silkArtwork = { ...svg({ 'data-fp-layer': 'top-silk' }),
        querySelectorAll: selector => selector === '.pcb-mirror-text' ? [refLabel] : [],
    };
    const layers = new Map(['top-copper', 'bottom-copper', 'top-silk', 'bottom-silk'].map(id => [id, {
        children: [],
        appendChild(child) {
            child.parentNode?.removeChild(child);
            this.children.push(child);
            child.parentNode = this;
        },
        removeChild(child) {
            this.children = this.children.filter(element => element !== child);
            child.parentNode = null;
        },
    }]));
    layers.get('top-copper').appendChild(copperArtwork);
    layers.get('top-silk').appendChild(silkArtwork);
    placement.elements = [copperArtwork, silkArtwork];
    placement.lodEl = svg({});
    const halo = svg({});
    app._padHaloGroups = new Map([['component', halo]]);
    app.getLayerGroup = id => layers.get(id) || null;
    app.placements.set('component', placement);
    app._recordPlacementOverride = () => assert.fail('Side adapters must not re-record generated placement data');
    let dirty = 0;
    app._markDirty = () => { dirty++; };
    applyPlacementPose(app, 'component');
    const before = app.tracks.map(track => track.captureState());
    const command = new SetPlacementSideCommand(app, 'component', 'bottom');
    for (let cycle = 0; cycle < 2; cycle++) {
        command.execute();
        assert.equal(topSmd.padConnections.size, 0);
        assert.equal(bottomSmd.padConnections.size, 0);
        assert.equal(topThrough.padConnections.has('n0'), true);
        assert.equal(duplicateThrough.padConnections.has('n0'), true,
            'Duplicate physical through-hole pads retain bottom-layer bonds during a side change');
        assert.deepEqual(topSmd.nodes.get('n0'), before[0].nodes.n0, 'Disconnected SMD endpoints stay in place');
        assert.deepEqual(duplicateThrough.nodes.get('n0'), { x: 6, y: 20 });
        assert.deepEqual(placement.padOffsets.map(pad => pad.layer), ['bottom', 'top', 'both', 'both']);
        assert.deepEqual(placement.pasteOffsets.map(pad => pad.side), ['bottom', 'top']);
        assert.equal(app.placementState.overrides.get('component').side, 'bottom');
        assert.equal(copperArtwork.parentNode, layers.get('bottom-copper'));
        assert.equal(silkArtwork.parentNode, layers.get('bottom-silk'));
        assert.equal(smdShape.getAttribute('fill'), '#3498db');
        assert.equal(thShape.getAttribute('fill'), '#b8860b');
        for (const element of [copperArtwork, silkArtwork, placement.lodEl, halo]) {
            assert.equal(element.getAttribute('transform'), 'translate(10, 20) scale(-1, 1)');
        }
        assert.equal(padLabel.getAttribute('transform'), 'translate(2, 0) scale(-1, 1)');
        assert.equal(refLabel.getAttribute('transform'), undefined, 'Bottom-side references retain their board-side mirroring');
        command.undo();
        assert.deepEqual(app.tracks.map(track => track.captureState()), before, 'Side undo restores every bond and endpoint');
        assert.deepEqual(placement.padOffsets.map(pad => pad.layer), ['top', 'bottom', 'both', 'both']);
        assert.deepEqual(placement.pasteOffsets.map(pad => pad.side), ['top', 'bottom']);
        assert.equal(app.placementState.overrides.get('component').side, 'top');
        assert.equal(copperArtwork.parentNode, layers.get('top-copper'));
        assert.equal(silkArtwork.parentNode, layers.get('top-silk'));
        assert.equal(smdShape.getAttribute('fill'), '#e74c3c');
        assert.equal(copperArtwork.getAttribute('transform'), 'translate(10, 20)');
        assert.equal(padLabel.getAttribute('transform'), undefined);
        assert.equal(dirty, (cycle + 1) * 2, 'Each side execute/undo notifies dirty once');
    }
    command.execute();
    app.placements.delete('component');
    command.undo();
    assert.deepEqual(app.tracks.map(track => track.captureState()), before, 'Side undo restores bonds without a rendered footprint');
    assert.equal(app.placementState.overrides.get('component').side, 'top');
}

if (failures) process.exitCode = 1;