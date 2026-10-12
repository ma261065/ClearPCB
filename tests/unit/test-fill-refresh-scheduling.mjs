import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { getComputedFill } from '../../src/pcb/modules/computed-fill-cache.js';
import { isFillRefreshPending, setDragOverlaysDeferred, setFillRefreshPending, setFillRefreshSuspended, setPictureCopperRefreshPending } from '../../src/pcb/modules/refresh-state.js';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';

globalThis.window = { addEventListener() {} };
function element() {
    return {
        children: [], attributes: new Map(), classList: { add() {} }, dataset: {},
        setAttribute(key, value) { this.attributes.set(key, String(value)); },
        getAttribute(key) { return this.attributes.get(key) ?? null; },
        appendChild(child) { child.remove?.(); this.children.push(child); child.parentNode = this; },
        insertBefore(child, before) {
            child.remove?.();
            const index = this.children.indexOf(before);
            this.children.splice(index < 0 ? this.children.length : index, 0, child);
            child.parentNode = this;
        },
        remove() {
            if (!this.parentNode) return;
            this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
            this.parentNode = null;
        },
        get firstChild() { return this.children[0] || null; },
        cloneNode() { return element(); },
        querySelectorAll(selector) {
            const matches = child => selector.startsWith('.')
                && (child.getAttribute?.('class') || '').split(' ').includes(selector.slice(1));
            return this.children.flatMap(child => [
                ...(matches(child) ? [child] : []),
                ...(child.querySelectorAll?.(selector) || []),
            ]);
        },
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    };
}
const document = installFakeDom();
document.createElementNS = () => element();
const { scheduleFillRefresh } = await import('../../src/pcb/modules/fill-refresh.js');
const { reconcileRatsnest } = await import('../../src/pcb/modules/ratsnest.js');
const { loadClipper } = await import('../../src/pcb/modules/copper-fill-geom.js');
const { CopperFill } = await import('../../src/shapes/copper-fill.js');
const { batchDerivedUpdates } = await import('../../src/core/DerivedUpdates.js');
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
    const topFill = element(), bottomFill = element();
    topFill.cloneNode = () => { counts.pours++; return element(); };
    const fillGroups = new Map([['top-fill', topFill], ['bottom-fill', bottomFill]]);
    const app = {
        ...pcbEditorStubs(),
        counts, tracks: [], vias: [], boardShapes: [], placements: new Map(), netlist: [], texts: new Map(),
        board: {},
        copperFills: [new CopperFill({ net: 'GND', outline: [
            { x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 5 }, { x: -5, y: 5 },
        ] })],
        get pcbDocument() { return this; },
        getLayerGroup: id => id === 'ratlines' ? ratLayer : fillGroups.get(id),
        existingLayerGroups() { return this._layerGroups; },
        _layerGroups: fillGroups,
        getRoutingParams: () => ({ clearance: 0.2 }),
        refreshClearanceHalos() { counts.halos++; },
        refreshFills() { return scheduleFillRefresh(this); },
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
    assert.equal(app.counts.halos, 0, 'Pour and connectivity updates do not own clearance rendering');
    assert.equal(app.counts.lines, 0);
    assert.ok(getComputedFill(app.copperFills[0]).length);

    batchDerivedUpdates(app, () => {
        reconcileRatsnest(app);
        reconcileRatsnest(app);
    });
    assert.equal(app.counts.rebuilds, 1);
    flush();
    assert.equal(app.counts.rebuilds, 2);
    assert.equal(app.counts.pours, 2);

    const noFills = board();
    const targeted = board();
    scheduleFillRefresh(targeted);
    flush();
    assert.equal(targeted.counts.pours, 1);
    assert.equal(targeted.counts.rebuilds, 1, 'Targeted halo updates still reconcile pour connectivity');
    assert.equal(targeted.counts.halos, 0, 'Pour completion does not rebuild already updated clearance');
    noFills.copperFills = [];
    reconcileRatsnest(noFills);
    assert.equal(noFills.counts.rebuilds, 1);
    assert.equal(noFills.counts.halos, 0, 'Connectivity without pours also leaves clearance untouched');
    assert.equal(frames.length, 0);

    const drag = board();
    setDragOverlaysDeferred(drag, true);
    reconcileRatsnest(drag);
    assert.equal(drag.counts.rebuilds, 1);
    assert.equal(drag.counts.halos, 0);
    assert.equal(frames.length, 0);
    setDragOverlaysDeferred(drag, false);
    reconcileRatsnest(drag);
    flush();
    assert.equal(drag.counts.rebuilds, 2);

    const suspended = board();
    setFillRefreshSuspended(suspended, true);
    reconcileRatsnest(suspended);
    assert.equal(suspended.counts.rebuilds, 1);
    assert.equal(isFillRefreshPending(suspended), true);
    assert.equal(frames.length, 0);
    setFillRefreshSuspended(suspended, false);
    reconcileRatsnest(suspended);
    flush();
    assert.equal(suspended.counts.rebuilds, 2);
    assert.equal(isFillRefreshPending(suspended), false);

    const interrupted = board();
    reconcileRatsnest(interrupted);
    setDragOverlaysDeferred(interrupted, true);
    flush();
    assert.equal(interrupted.counts.pours, 0);
    assert.equal(isFillRefreshPending(interrupted), true);
    setDragOverlaysDeferred(interrupted, false);
    reconcileRatsnest(interrupted);
    flush();
    assert.equal(interrupted.counts.rebuilds, 1);

    const removed = board();
    const editing = board();
    reconcileRatsnest(editing);
    setPictureCopperRefreshPending(editing, true);
    flush();
    assert.equal(editing.counts.pours, 0, 'An already queued pour cannot run during a property edit');
    assert.equal(scheduleFillRefresh(editing), true);
    reconcileRatsnest(editing, { skipFillRefresh: true });
    assert.equal(frames.length, 0);
    assert.equal(editing.counts.halos, 0);
    assert.equal(editing.counts.rebuilds, 0);
    setPictureCopperRefreshPending(editing, false);
    reconcileRatsnest(editing);
    flush();
    assert.equal(editing.counts.pours, 1);
    assert.equal(editing.counts.halos, 0);

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