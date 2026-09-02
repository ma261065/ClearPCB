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

const { Via } = await import('./src/shapes/via.js');
const { Track } = await import('./src/shapes/track.js');
const {
    startVertexDrag,
    updateVertexDrag,
    finishVertexDrag,
    cancelVertexDrag,
    startViaDrag,
    updateViaDrag,
    finishViaDrag,
    cancelViaDrag,
} = await import('./src/pcb/modules/track-drag.js');

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
    return {
        tracks: [],
        vias: [via],
        placements: new Map(),
        netlist: [],
        _layerGroups: new Map(),
        _getLayerGroup() { return null; },
        _refreshFills() { fillRefreshes++; },
        fillRefreshes() { return fillRefreshes; },
        viewport: {
            scale: 1,
            gridVisible: false,
            setCrosshair() {},
            hideCrosshair() {},
        },
        history: { execute(command) { command.execute(); } },
    };
}

function trackAppFor(track, previousDeferral = false) {
    let fillRefreshes = 0;
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
    const via = new Via({ x: 1, y: 2, diameter: 0.6, drill: 0.3 });
    const app = appFor(via);
    expect('via pickup begins derived-overlay deferral', startViaDrag(app, via, { x: 1, y: 2 })
        && app._deferDragOverlays === true);
    updateViaDrag(app, { x: 4, y: 5 });
    expect('via mousemove does not refresh copper pours', app.fillRefreshes() === 0);
    finishViaDrag(app);
    expect('via drop restores derived-overlay refreshes', app._deferDragOverlays === false);
    expect('via drop refreshes copper pours once', app.fillRefreshes() === 1);
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
}

{
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], net: 'GND' });
    const app = trackAppFor(track);
    expect('track pickup begins derived-overlay deferral', startVertexDrag(app, track, { x: 0, y: 0 })
        && app._deferDragOverlays === true);
    updateVertexDrag(app, { x: 2, y: 2 });
    expect('track mousemove does not refresh copper pours', app.fillRefreshes() === 0);
    finishVertexDrag(app);
    expect('track drop restores derived-overlay refreshes', app._deferDragOverlays === false);
    expect('track drop refreshes copper pours once', app.fillRefreshes() === 1);
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
}

{
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], net: 'GND' });
    const app = trackAppFor(track, true);
    startVertexDrag(app, track, { x: 0, y: 0 });
    updateVertexDrag(app, { x: 2, y: 2 });
    finishVertexDrag(app);
    expect('track drop preserves an existing overlay deferral', app._deferDragOverlays === true);
    expect('nested track drop does not refresh copper pours', app.fillRefreshes() === 0);
}

if (failures) process.exitCode = 1;