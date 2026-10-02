import assert from 'node:assert/strict';
import { getComputedFill } from '../src/pcb/modules/computed-fill-cache.js';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { isFillRefreshScheduled, isPictureCopperRefreshPending } from '../src/pcb/modules/refresh-state.js';

globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById: () => null,
    createElementNS() {
        const attributes = new Map();
        return { style: {}, dataset: {}, setAttribute: (key, value) => attributes.set(key, value),
            getAttribute: key => attributes.get(key), appendChild() {}, remove() {} };
    },
};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { CopperFill } = await import('../src/shapes/copper-fill.js');
const { loadClipper } = await import('../src/pcb/modules/copper-fill-geom.js');
const { ModifyBoardShapeCommand } = await import('../src/pcb/modules/shape-commands.js');
const { AddFillCommand, RemoveFillCommand, ModifyFillCommand } = await import('../src/pcb/modules/copper-fill-commands.js');
const { captureBoardShapeState } = await import('../src/pcb/modules/board-shapes.js');
const { bindPictureRefreshHold } = await import('../src/pcb/modules/picture-refresh.js');
const { runDRC } = await import('../src/pcb/modules/drc.js');
await loadClipper();

const original = {
    requestAnimationFrame: globalThis.requestAnimationFrame,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
};
const frames = [], timers = new Map();
let id = 0;
const flushFrames = () => {
    let count = 0;
    while (frames.length) {
        assert.ok(++count < 20, 'DRC must not spin while waiting for geometry');
        frames.shift()();
    }
};
const flushTimers = () => {
    const callbacks = [...timers.values()];
    timers.clear();
    for (const callback of callbacks) callback();
};
const rectangle = (left, top, right, bottom) => [
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
];
function fixture(withFill = true) {
    const shape = { id: 'rotated', kind: 'rect', layer: 'top-copper', net: 'SIGNAL',
        copperMode: 'add', filled: true, lineWidth: 0.2, points: rectangle(-4, -1, 4, 1) };
    const reports = [];
    const app = Object.assign(Object.create(PCBApp.prototype), {
        pcbDocument: new PcbDocument(),
        _boardWidth: 40, _boardHeight: 40, _boardRadius: 0,
        placements: new Map(), texts: new Map(), tracks: [], pads: [], netlist: [],
        vias: [{ id: 'ground', x: 8, y: 8, diameter: 1, drill: 0.3, net: 'GND' }],
        boardShapes: [{ id: 'board-outline', kind: 'rect', layer: 'board-outline',
            points: rectangle(-20, -20, 20, 20) }, shape, ...(withFill ? [new CopperFill({ net: 'GND', layer: 'top-copper',
            outline: rectangle(-10, -10, 10, 10) })] : [])], _shapeElements: new Map(),
        _drcViolations: [], _drcSelectedId: null,
        getRoutingParams: () => ({ clearance: 0.2 }),
        getLayerGroup: () => null, _clearFillGroups() {}, updateCopperCuts() {},
        _refreshBoardShapeClearance() {}, _collectRatlines: () => [],
        _drcShouldRun: () => true, _renderDRCList() {},
        _updateDRCStatus(result, pending) { if (!pending) reports.push(result); },
    });
    app._getDrcPresentation().updateStatus = app._updateDRCStatus;
    app._getDrcPresentation().renderList = app._renderDRCList;
    const before = captureBoardShapeState(shape);
    shape.points = shape.points.map(({ x, y }) => ({ x: -y, y: x }));
    const after = captureBoardShapeState(shape);
    shape.points = before.geom.points.map(point => ({ ...point }));
    return { app, reports, command: new ModifyBoardShapeCommand(app, shape, before, after) };
}

try {
    globalThis.requestAnimationFrame = callback => { frames.push(callback); return ++id; };
    globalThis.setTimeout = (callback, delay) => {
        assert.equal(delay, 100, 'keep the existing geometry debounce');
        timers.set(++id, callback);
        return id;
    };
    globalThis.clearTimeout = timer => timers.delete(timer);

    const { app, reports, command } = fixture();
    app._recomputeFillsNow();
    flushFrames();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].ok, true, 'initial pour clears the unrotated shape');
    for (const action of ['execute', 'undo', 'execute']) {
        const previous = app._drcViolations;
        const reportCount = reports.length;
        command[action]();
        assert.equal(isPictureCopperRefreshPending(app), true);
        assert.ok(runDRC(app, { clearance: 0.2 }).violations.some(v =>
            v.rule === 'short' || v.rule === 'clearance'), 'stale pour really intersects the rotated geometry');
        app._scheduleDRC();
        flushFrames();
        app._runDRCLive();
        assert.equal(reports.length, reportCount, 'neither scheduled nor direct DRC publishes a stale-copper report');
        assert.equal(app._drcViolations, previous, 'retain the last coherent results during debounce');
        flushTimers();
        assert.equal(isPictureCopperRefreshPending(app), false);
        assert.equal(isFillRefreshScheduled(app), true);
        app._runDRCLive();
        assert.equal(reports.length, reportCount, 'still wait for the queued pour rebuild');
        flushFrames();
        assert.equal(reports.length, reportCount + 1, 'pour completion runs DRC once');
        assert.equal(reports.at(-1).ok, true, 'rebuilt pour clears the new shape orientation');
    }

    const noFill = fixture(false);
    noFill.app.boardShapes.push({ id: 'real-conflict', kind: 'circle', layer: 'top-copper',
        net: 'GND', copperMode: 'add', x: 0, y: 3, radius: 0.5, filled: true, lineWidth: 0.2 });
    noFill.command.execute();
    noFill.app._scheduleDRC();
    flushFrames();
    assert.equal(noFill.reports.length, 0);
    flushTimers();
    flushFrames();
    assert.equal(noFill.reports.length, 1, 'without pours, the geometry refresh still reschedules DRC');
    assert.ok(noFill.reports[0].violations.some(v => v.rule === 'clearance' || v.rule === 'short'),
        'genuine conflicts are still reported once geometry settles');

    const eventTarget = () => {
        const handlers = new Map();
        return { addEventListener: (type, fn) => handlers.set(type, fn),
            removeEventListener: type => handlers.delete(type),
            fire: (type, event) => handlers.get(type)?.({ type, ...event }) };
    };
    const input = eventTarget(), host = eventTarget();
    bindPictureRefreshHold(app, input, host);
    input.fire('pointerdown', { button: 0, pointerId: 1 });
    command.undo();
    const count = reports.length;
    assert.ok(timers.size <= 1, 'held input postpones geometry; only deferred DRC debt may poll');
    app._scheduleDRC();
    flushFrames();
    assert.equal(reports.length, count, 'DRC also waits throughout held property edits');
    host.fire('pointerup', { pointerId: 1 });
    flushTimers();
    flushFrames();
    assert.equal(reports.length, count + 1);
    assert.equal(reports.at(-1).ok, true);

    const gated = fixture(false);
    let visible = false;
    gated.app._drcShouldRun = () => visible;
    gated.app._scheduleDRC();
    assert.equal(frames.length, 0, 'The scheduler owns visibility gating, not its callers');
    visible = true;
    gated.app._scheduleDRC();
    gated.app._scheduleDRC();
    assert.equal(frames.length, 1, 'Multiple requests still coalesce into one frame');
    visible = false;
    flushFrames();
    assert.equal(gated.reports.length, 0, 'Closing the DRC UI suppresses an already queued check');
    assert.equal(gated.app._drcRaf, 0, 'A skipped check releases the scheduling slot');
    visible = true;
    gated.app._scheduleDRC();
    flushFrames();
    assert.equal(gated.reports.length, 1, 'Reopening allows subsequent refresh requests');

    for (const operation of ['add', 'remove', 'modify']) {
        const { app: edited } = fixture();
        edited.vias.push({ id: 'other-ground', x: -8, y: 8, diameter: 1, drill: 0.3, net: 'GND' });
        const ratlines = { children: [], appendChild(line) {
            this.children.push(line);
            line.remove = () => this.children.splice(this.children.indexOf(line), 1);
        } };
        edited.getLayerGroup = layer => layer === 'ratlines' ? ratlines : null;
        const fill = edited.copperFills[0], before = fill.captureState();
        if (operation === 'add') edited.boardShapes.splice(edited.boardShapes.indexOf(fill), 1);
        const edit = operation === 'add' ? new AddFillCommand(edited, fill)
            : operation === 'remove' ? new RemoveFillCommand(edited, fill)
            : new ModifyFillCommand(edited, fill, before, { ...before, net: 'POWER' });
        let recomputes = 0;
        const recompute = edited._recomputeFillsNow.bind(edited);
        edited._recomputeFillsNow = () => { recomputes++; return recompute(); };
        for (const action of ['execute', 'undo', 'execute']) {
            const previous = recomputes;
            edit[action]();
            if (edited.copperFills.length) assert.ok(getComputedFill(fill).length, 'Fill edits remain synchronous');
            const expected = edited.copperFills.some(pour => pour.net === 'GND') ? 0 : 1;
            assert.equal(ratlines.children.length, expected, 'Connectivity immediately follows fill add/remove/net changes');
            edited._scheduleDRC();
            flushFrames();
            assert.equal(recomputes, previous + 1, `${operation}/${action} must not schedule a second pour`);
            assert.equal(ratlines.children.length, expected, 'Last-fill removal and undo/redo retain correct ratlines');
        }
    }
    const { app: deferredFillApp } = fixture();
    const deferredFill = deferredFillApp.copperFills[0];
    const beforeFill = deferredFill.captureState();
    const fillProperties = [];
    let deferredRecomputes = 0;
    deferredFillApp._recomputeFillsNow = () => { deferredRecomputes++; return true; };
    deferredFillApp._refreshFillProperties = fill => fillProperties.push(fill.net);
    deferredFillApp._deferDragOverlays = true;
    const fillEdit = new ModifyFillCommand(deferredFillApp, deferredFill, beforeFill, { ...beforeFill, net: 'POWER' });
    fillEdit.execute();
    fillEdit.undo();
    fillEdit.execute();
    assert.equal(deferredRecomputes, 0, 'Authored fill history preserves drag-time pour deferral');
    assert.deepEqual(fillProperties, ['POWER', 'GND', 'POWER'], 'Properties observe each applied model state');
    deferredFillApp._deferDragOverlays = false;
    fillEdit.undo();
    assert.equal(deferredRecomputes, 1, 'Settled history still recomputes pours synchronously once');
    assert.deepEqual(fillProperties, ['POWER', 'GND', 'POWER', 'GND']);
} finally {
    for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete globalThis[name];
        else globalThis[name] = value;
    }
}
console.log('PASS DRC waits for rotated-shape copper refresh, pour completion, undo/redo and held edits');
