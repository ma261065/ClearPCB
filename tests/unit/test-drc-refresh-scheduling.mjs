import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { getComputedFill } from '../../src/pcb/modules/computed-fill-cache.js';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { isFillRefreshScheduled, isPictureCopperRefreshPending, setDragOverlaysDeferred } from '../../src/pcb/modules/refresh-state.js';
import { getDrcPresentation, scheduleDrc } from '../../src/pcb/modules/drc-state.js';
import { runDrcNow } from '../../src/pcb/modules/drc-refresh.js';
import { recomputeFillsNow } from '../../src/pcb/modules/fill-refresh.js';

installFakeDom();
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');
const { CopperFill } = await import('../../src/shapes/copper-fill.js');
const { loadClipper } = await import('../../src/pcb/modules/copper-fill-geom.js');
const { ModifyBoardShapeCommand } = await import('../../src/pcb/modules/shape-commands.js');
const { AddFillCommand, RemoveFillCommand, ModifyFillCommand } = await import('../../src/pcb/modules/copper-fill-commands.js');
const { captureBoardShapeState } = await import('../../src/core/pcb-board-shapes.js');
const { pictureRefreshHold } = await import('../../src/pcb/modules/picture-refresh.js');
const { runDRC } = await import('../../src/pcb/modules/drc.js');
const { setPcbSelection } = await import('../../src/pcb/modules/selection-registry.js');
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
    let fillRefreshes = 0, countedThisRefresh = false;
    const makeFillGroup = (count = false) => ({
        children: [],
        get firstChild() {
            if (count) {
                if (!countedThisRefresh) fillRefreshes++;
                countedThisRefresh = false;
            }
            return null;
        },
        cloneNode() { return makeFillGroup(); },
        querySelectorAll() { return []; },
        querySelector() { return null; },
        appendChild(child) { this.children.push(child); },
        insertBefore(child) { this.children.push(child); },
        remove() {},
    });
    const topFillGroup = makeFillGroup(true), bottomFillGroup = makeFillGroup();
    const app = Object.assign(Object.create(PCBApp.prototype), {
        pcbDocument: new PcbDocument(),
        board: { width: 40, height: 40, radius: 0 },
        placements: new Map(), texts: new Map(), tracks: [], pads: [], netlist: [],
        vias: [{ id: 'ground', x: 8, y: 8, diameter: 1, drill: 0.3, net: 'GND' }],
        boardShapes: [{ id: 'board-outline', kind: 'rect', layer: 'board-outline',
            points: rectangle(-20, -20, 20, 20) }, shape, ...(withFill ? [new CopperFill({ net: 'GND', layer: 'top-copper',
            outline: rectangle(-10, -10, 10, 10) })] : [])], _shapeElements: new Map(),
        // Every pour builds its fill context, which reads the routing parameters: count each one.
        // A renamed function makes the count 0, so the assertions fail loudly rather than pass.
        getRoutingParams: () => {
            if (new Error().stack.includes('buildFillContext')) {
                fillRefreshes++;
                countedThisRefresh = true;
            }
            return { clearance: 0.2 };
        },
        getLayerGroup: id => id === 'top-fill' ? topFillGroup : id === 'bottom-fill' ? bottomFillGroup : null,
        _layerGroups: new Map([['top-fill', topFillGroup], ['bottom-fill', bottomFillGroup]]),
        existingLayerGroups() { return this._layerGroups; },
        status: {},
        updateCopperCuts() {},
        _refreshBoardShapeClearance() {},
    });
    const drc = getDrcPresentation(app);
    drc.shouldRun = () => true;
    drc.updateStatus = (result, pending) => { if (!pending) reports.push(result); };
    drc.renderList = () => {};
    const before = captureBoardShapeState(shape);
    shape.points = shape.points.map(({ x, y }) => ({ x: -y, y: x }));
    const after = captureBoardShapeState(shape);
    shape.points = before.geom.points.map(point => ({ ...point }));
    return { app, reports, drc, fillRefreshes: () => fillRefreshes,
        command: new ModifyBoardShapeCommand(app, shape, before, after) };
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
    recomputeFillsNow(app);
    flushFrames();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].ok, true, 'initial pour clears the unrotated shape');
    for (const action of ['execute', 'undo', 'execute']) {
        const previous = getDrcPresentation(app).violations;
        const reportCount = reports.length;
        command[action]();
        assert.equal(isPictureCopperRefreshPending(app), true);
        assert.ok(runDRC(app, { clearance: 0.2 }).violations.some(v =>
            v.rule === 'short' || v.rule === 'clearance'), 'stale pour really intersects the rotated geometry');
        scheduleDrc(app);
        flushFrames();
        runDrcNow(app);
        assert.equal(reports.length, reportCount, 'neither scheduled nor direct DRC publishes a stale-copper report');
        assert.equal(getDrcPresentation(app).violations, previous, 'retain the last coherent results during debounce');
        flushTimers();
        assert.equal(isPictureCopperRefreshPending(app), false);
        assert.equal(isFillRefreshScheduled(app), true);
        runDrcNow(app);
        assert.equal(reports.length, reportCount, 'still wait for the queued pour rebuild');
        flushFrames();
        assert.equal(reports.length, reportCount + 1, 'pour completion runs DRC once');
        assert.equal(reports.at(-1).ok, true, 'rebuilt pour clears the new shape orientation');
    }

    const noFill = fixture(false);
    noFill.app.boardShapes.push({ id: 'real-conflict', kind: 'circle', layer: 'top-copper',
        net: 'GND', copperMode: 'add', x: 0, y: 3, radius: 0.5, filled: true, lineWidth: 0.2 });
    noFill.command.execute();
    scheduleDrc(noFill.app);
    flushFrames();
    assert.equal(noFill.reports.length, 0);
    flushTimers();
    flushFrames();
    assert.equal(noFill.reports.length, 1, 'without pours, the geometry refresh still reschedules DRC');
    assert.ok(noFill.reports[0].violations.some(v => v.rule === 'clearance' || v.rule === 'short'),
        'genuine conflicts are still reported once geometry settles');

    const hold = pictureRefreshHold(app);
    hold.begin();
    command.undo();
    const count = reports.length;
    assert.ok(timers.size <= 1, 'held input postpones geometry; only deferred DRC debt may poll');
    scheduleDrc(app);
    flushFrames();
    assert.equal(reports.length, count, 'DRC also waits throughout held property edits');
    hold.end();
    flushTimers();
    flushFrames();
    assert.equal(reports.length, count + 1);
    assert.equal(reports.at(-1).ok, true);

    const gated = fixture(false);
    let visible = false;
    getDrcPresentation(gated.app).shouldRun = () => visible;
    scheduleDrc(gated.app);
    assert.equal(frames.length, 0, 'The scheduler owns visibility gating, not its callers');
    visible = true;
    scheduleDrc(gated.app);
    scheduleDrc(gated.app);
    assert.equal(frames.length, 1, 'Multiple requests still coalesce into one frame');
    visible = false;
    flushFrames();
    assert.equal(gated.reports.length, 0, 'Closing the DRC UI suppresses an already queued check');
    assert.equal(frames.length, 0, 'A skipped check releases the scheduling slot');
    visible = true;
    scheduleDrc(gated.app);
    flushFrames();
    assert.equal(gated.reports.length, 1, 'Reopening allows subsequent refresh requests');

    for (const operation of ['add', 'remove', 'modify']) {
        const { app: edited, fillRefreshes } = fixture();
        edited.vias.push({ id: 'other-ground', x: -8, y: 8, diameter: 1, drill: 0.3, net: 'GND' });
        const ratlines = { children: [], appendChild(line) {
            this.children.push(line);
            line.remove = () => this.children.splice(this.children.indexOf(line), 1);
        } };
        const getLayerGroup = edited.getLayerGroup;
        edited.getLayerGroup = layer => layer === 'ratlines' ? ratlines : getLayerGroup(layer);
        const fill = edited.copperFills[0], before = fill.captureState();
        if (operation === 'add') edited.boardShapes.splice(edited.boardShapes.indexOf(fill), 1);
        const edit = operation === 'add' ? new AddFillCommand(edited, fill)
            : operation === 'remove' ? new RemoveFillCommand(edited, fill)
            : new ModifyFillCommand(edited, fill, before, { ...before, net: 'POWER' });
        for (const action of ['execute', 'undo', 'execute']) {
            const previous = fillRefreshes();
            edit[action]();
            if (edited.copperFills.length) assert.ok(getComputedFill(fill).length, 'Fill edits remain synchronous');
            const expected = edited.copperFills.some(pour => pour.net === 'GND') ? 0 : 1;
            assert.equal(ratlines.children.length, expected, 'Connectivity immediately follows fill add/remove/net changes');
            scheduleDrc(edited);
            flushFrames();
            assert.equal(fillRefreshes(), previous + 1, `${operation}/${action} must not schedule a second pour`);
            assert.equal(ratlines.children.length, expected, 'Last-fill removal and undo/redo retain correct ratlines');
        }
    }
    const { app: deferredFillApp, fillRefreshes: deferredFillRefreshes } = fixture();
    const deferredFill = deferredFillApp.copperFills[0];
    const beforeFill = deferredFill.captureState();
    const fillProperties = [];
    deferredFillApp.openPropertyPanel = panel => { fillProperties.push(panel.fields.find(item => item.key === 'net').value); return true; };
    deferredFillApp.refreshPropertyPanel = panel => { fillProperties.push(panel.fields.find(item => item.key === 'net').value); };
    setPcbSelection(deferredFillApp, [{ kind: 'fill', object: deferredFill }]);
    setDragOverlaysDeferred(deferredFillApp, true);
    const fillEdit = new ModifyFillCommand(deferredFillApp, deferredFill, beforeFill, { ...beforeFill, net: 'POWER' });
    fillEdit.execute();
    fillEdit.undo();
    fillEdit.execute();
    assert.equal(getComputedFill(deferredFill), null, 'Authored fill history preserves drag-time pour deferral');
    assert.deepEqual(fillProperties, ['POWER', 'GND', 'POWER'], 'Properties observe each applied model state');
    setDragOverlaysDeferred(deferredFillApp, false);
    const previousDeferredRefreshes = deferredFillRefreshes();
    fillEdit.undo();
    assert.equal(deferredFillRefreshes(), previousDeferredRefreshes + 1, 'Settled history still recomputes pours synchronously once');
    assert.deepEqual(fillProperties, ['POWER', 'GND', 'POWER', 'GND']);
} finally {
    for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete globalThis[name];
        else globalThis[name] = value;
    }
}
console.log('PASS DRC waits for rotated-shape copper refresh, pour completion, undo/redo and held edits');
