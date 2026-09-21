/** Headless regression tests for via-drag derived-overlay deferral. */

globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById() { return null; },
    createElementNS() {
        return {
            setAttribute() {},
            remove() {},
            classList: { add() {} },
            dataset: {},
        };
    },
};

const { Via } = await import('../src/shapes/via.js');
const { Track } = await import('../src/shapes/track.js');
const { reconcileRatsnest } = await import('../src/pcb/modules/track-draw.js');
const { AddTrackCommand, RemoveTrackCommand, AddViaCommand, RemoveViaCommand, MoveViaCommand, CompoundCommand } = await import('../src/pcb/modules/track-commands.js');
const { MovePlacementCommand, RotatePlacementCommand, FlipPlacementCommand, SetPlacementSideCommand } = await import('../src/pcb/modules/track-commands.js');
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
    let fillRefreshes = 0;
    let clearanceRefreshes = 0;
    const crosshairs = [];
    return {
        tracks: [],
        vias: [via],
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
            scale: 1,
            gridVisible: false,
            setCrosshair(point) { crosshairs.push(point); },
            hideCrosshair() {},
        },
        history: { execute(command) { command.execute(); } },
    };
}

function trackAppFor(track, previousDeferral = false) {
    let fillRefreshes = 0;
    let clearanceRefreshes = 0;
    return {
        tracks: [track],
        vias: [],
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

if (failures) process.exitCode = 1;