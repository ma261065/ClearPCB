import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: () => ({ setAttribute() {}, appendChild() {},
    classList: { add() {} }, dataset: {} }) };
const { scheduleFillRefresh } = await import('../src/pcb/modules/fill-refresh.js');
const { reconcileRatsnest } = await import('../src/pcb/modules/track-draw.js');
const { loadClipper, computeFillPolygons } = await import('../src/pcb/modules/copper-fill-geom.js');
const { CopperFill } = await import('../src/shapes/copper-fill.js');
const { buildFillContext } = await import('../src/pcb/modules/fill-context.js');
const { batchDerivedUpdates } = await import('../src/core/DerivedUpdates.js');
const originalRaf = globalThis.requestAnimationFrame;
const frames = [];
globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
const flush = () => {
    assert.equal(frames.length, 1);
    frames.shift()();
    assert.equal(frames.length, 0);
};

function board() {
    const counts = { rebuilds: 0, pours: 0, halos: 0, clears: 0, lines: 0 };
    const ratLayer = { get children() { counts.rebuilds++; return []; },
        appendChild() { counts.lines++; } };
    const app = {
        counts, tracks: [], vias: [], boardShapes: [], placements: new Map(), netlist: [], texts: new Map(),
        copperFills: [new CopperFill({ net: 'GND', outline: [
            { x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 },
        ] })],
        _getLayerGroup: () => ratLayer,
        _getRoutingParams: () => ({ clearance: 0.2 }),
        _refreshClearanceHalos() { counts.halos++; },
        _clearFillGroups() { counts.clears++; },
        _refreshFills() { return scheduleFillRefresh(this); },
        _recomputeFillsNow() {
            if (this._deferDragOverlays || this._suspendFillRefresh) {
                this._fillRefreshPending = true;
                return;
            }
            if (!this.copperFills.length) { this._clearFillGroups(); return; }
            this._fillRefreshPending = false;
            counts.pours++;
            const context = buildFillContext(this);
            for (const fill of this.copperFills) fill._computed = computeFillPolygons(fill, context);
            reconcileRatsnest(this, { skipFillRefresh: true });
        },
    };
    return app;
}

try {
    const loading = board();
    assert.equal(scheduleFillRefresh(loading), false);
    reconcileRatsnest(loading);
    assert.equal(loading.counts.rebuilds, 1);
    await loadClipper();
    flush();

    const app = board();
    app.vias.push({ id: 'via_1', x: -2, y: 0, net: 'GND', diameter: 0.6, drill: 0.3 },
        { id: 'via_2', x: 2, y: 0, net: 'GND', diameter: 0.6, drill: 0.3 });
    for (let index = 0; index < 10; index++) reconcileRatsnest(app);
    assert.equal(app.counts.rebuilds, 0);
    assert.equal(app.counts.halos, 0);
    flush();
    assert.equal(app.counts.pours, 1);
    assert.equal(app.counts.rebuilds, 1);
    assert.equal(app.counts.halos, 1);
    assert.equal(app.counts.lines, 0);
    assert.ok(app.copperFills[0]._computed.length);

    batchDerivedUpdates(app, () => {
        reconcileRatsnest(app);
        reconcileRatsnest(app);
    });
    assert.equal(app.counts.rebuilds, 1);
    flush();
    assert.equal(app.counts.rebuilds, 2);
    assert.equal(app.counts.pours, 2);

    const noFills = board();
    noFills.copperFills = [];
    reconcileRatsnest(noFills);
    assert.equal(noFills.counts.rebuilds, 1);
    assert.equal(noFills.counts.halos, 1);
    assert.equal(frames.length, 0);

    const drag = board();
    drag._deferDragOverlays = true;
    reconcileRatsnest(drag);
    assert.equal(drag.counts.rebuilds, 1);
    assert.equal(drag.counts.halos, 0);
    assert.equal(frames.length, 0);
    drag._deferDragOverlays = false;
    reconcileRatsnest(drag);
    flush();
    assert.equal(drag.counts.rebuilds, 2);

    const suspended = board();
    suspended._suspendFillRefresh = true;
    reconcileRatsnest(suspended);
    assert.equal(suspended.counts.rebuilds, 1);
    assert.equal(suspended._fillRefreshPending, true);
    assert.equal(frames.length, 0);
    suspended._suspendFillRefresh = false;
    reconcileRatsnest(suspended);
    flush();
    assert.equal(suspended.counts.rebuilds, 2);
    assert.equal(suspended._fillRefreshPending, false);

    const interrupted = board();
    reconcileRatsnest(interrupted);
    interrupted._deferDragOverlays = true;
    flush();
    assert.equal(interrupted.counts.pours, 0);
    assert.equal(interrupted._fillRefreshPending, true);
    interrupted._deferDragOverlays = false;
    reconcileRatsnest(interrupted);
    flush();
    assert.equal(interrupted.counts.rebuilds, 1);

    const removed = board();
    reconcileRatsnest(removed);
    removed.copperFills = [];
    reconcileRatsnest(removed);
    assert.equal(removed.counts.rebuilds, 1);
    flush();
    assert.equal(removed.counts.rebuilds, 1);
    assert.equal(removed.counts.pours, 0);

    console.log('Fill refresh scheduling and ratsnest coalescing regressions passed.');
} finally {
    if (originalRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRaf;
}