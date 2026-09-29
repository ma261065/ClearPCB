/** Headless regression tests for via-drag derived-overlay deferral. */
import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';

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
const { collectBondedCopper, reconcileRatsnest } = await import('../src/pcb/modules/track-draw.js');
const { AddTrackCommand, RemoveTrackCommand, AddViaCommand, RemoveViaCommand, MoveViaCommand,
    ModifyViaCommand, ModifyViasCommand, CompoundCommand } = await import('../src/pcb/modules/track-commands.js');
const {
    FlipPlacementCommand,
    MovePlacementCommand,
    RotatePlacementCommand,
    SetPlacementLockedCommand,
    SetPlacementSideCommand,
} = await import('../src/pcb/modules/track-commands.js');
const { cancelGroupDrag, endGroupDrag } = await import('../src/pcb/modules/box-select.js');
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
    return {
        pcbDocument,
        tracks: [],
        vias: pcbDocument.vias,
        placements: new Map(),
        netlist: [],
        _layerGroups: new Map(),
        _getLayerGroup() { return null; },
        _refreshFills() { fillRefreshes++; },
        fillRefreshes() { return fillRefreshes; },
        _refreshClearanceHalos() { clearanceRefreshes++; },
        clearanceRefreshes() { return clearanceRefreshes; },
        crosshairs,
        viewport: {
            scale: 100,
            gridVisible: false,
            setCrosshair(point) { crosshairs.push(point); },
            hideCrosshair() {},
        },
        history: { execute(command) { command.execute(); } },
        _alert(message, options) { this.lastAlert = { message, options }; },
    };
}

function trackAppFor(track, previousDeferral = false) {
    const pcbDocument = new PcbDocument();
    let fillRefreshes = 0;
    let clearanceRefreshes = 0;
    return {
        pcbDocument,
        tracks: [track],
        vias: pcbDocument.vias,
        placements: new Map(),
        netlist: [],
        boardShapes: [],
        copperFills: [],
        _layerGroups: new Map(),
        _deferDragOverlays: previousDeferral,
        _getLayerGroup() { return null; },
        _refreshFills() { fillRefreshes++; },
        _snapToGrid(point) { return point; },
        fillRefreshes() { return fillRefreshes; },
        _refreshClearanceHalos() { clearanceRefreshes++; },
        clearanceRefreshes() { return clearanceRefreshes; },
        viewport: {
            scale: 100,
            gridVisible: false,
            setCrosshair() {},
            hideCrosshair() {},
        },
        history: { execute(command) { command.execute(); } },
        _alert(message, options) { this.lastAlert = { message, options }; },
    };
}

{
    const via = new Via({ x: 1, y: 2, diameter: 2, drill: 0.3 });
    const app = appFor(via);
    startViaDrag(app, via, { x: 1.5, y: 2.25 });
    expect('off-center via pickup keeps the via at its origin', via.x === 1 && via.y === 2
        && app.crosshairs.at(-1).x === 1 && app.crosshairs.at(-1).y === 2);
    updateViaDrag(app, { x: 4.5, y: 6.25 });
    expect('off-center via drag preserves the cursor offset', via.x === 4 && via.y === 6
        && app.crosshairs.at(-1).x === 4 && app.crosshairs.at(-1).y === 6);
    cancelViaDrag(app);
}

{
    const via = new Via({ x: 1, y: 2, diameter: 0.6, drill: 0.3 });
    const app = appFor(via);
    expect('via pickup begins derived-overlay deferral', startViaDrag(app, via, { x: 1, y: 2 })
        && app._deferDragOverlays === true);
    updateViaDrag(app, { x: 4, y: 5 });
    expect('via mousemove does not refresh copper pours', app.fillRefreshes() === 0);
    expect('via mousemove does not rebuild clearance', app.clearanceRefreshes() === 0);
    finishViaDrag(app);
    expect('via drop restores derived-overlay refreshes', app._deferDragOverlays === false);
    expect('via drop refreshes copper pours once', app.fillRefreshes() === 1);
    expect('via drop explicitly refreshes clearance once', app.clearanceRefreshes() === 1);
}

{
    const via = new Via({ x: 1, y: 2, diameter: 0.6, drill: 0.3 });
    const app = appFor(via);
    startViaDrag(app, via, { x: 1, y: 2 });
    updateViaDrag(app, { x: 4, y: 5 });
    cancelViaDrag(app);
    expect('via cancel restores derived-overlay refreshes', app._deferDragOverlays === false);
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
        && app._deferDragOverlays === true);
    updateVertexDrag(app, { x: 2, y: 2 });
    expect('track mousemove does not refresh copper pours', app.fillRefreshes() === 0);
    expect('track mousemove does not rebuild clearance', app.clearanceRefreshes() === 0);
    finishVertexDrag(app);
    expect('track drop restores derived-overlay refreshes', app._deferDragOverlays === false);
    expect('track drop refreshes copper pours once', app.fillRefreshes() === 1);
    expect('track drop explicitly refreshes clearance once', app.clearanceRefreshes() === 1);
}

{
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], net: 'GND' });
    const app = trackAppFor(track);
    startVertexDrag(app, track, { x: 0, y: 0 });
    updateVertexDrag(app, { x: 2, y: 2 });
    cancelVertexDrag(app);
    expect('track cancel restores derived-overlay refreshes', app._deferDragOverlays === false);
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
    expect('track drop preserves an existing overlay deferral', app._deferDragOverlays === true);
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
    const app = trackAppFor(track);
    const before = track.captureState();
    app._groupDrag = { comps: [], vias: [], tracks: [{ track, before }], previousDeferDragOverlays: previousDeferral };
    app._deferDragOverlays = true;
    track.nodes.get('n0').x = 3;
    cancelGroupDrag(app);
    expect('group cancellation restores track geometry', track.nodes.get('n0').x === 0);
    expect(`group cancellation respects existing deferral (${previousDeferral})`, app.clearanceRefreshes() === (previousDeferral ? 0 : 1));
    const count = app.clearanceRefreshes();
    app._groupDrag = { comps: [], vias: [], tracks: [{ track, before }], previousDeferDragOverlays: previousDeferral };
    app._deferDragOverlays = true;
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
    app._getLayerGroup = id => {
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
        app._deferDragOverlays = deferred;
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
    app._deferDragOverlays = false;
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
    assert.equal(first._svgElements[0].getAttribute('data-via-x'), '3.123456');
    assert.equal(first._svgElements[0].getAttribute('data-via-y'), '-4.123456');
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

if (failures) process.exitCode = 1;