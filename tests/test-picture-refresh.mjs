import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { bindPictureRefreshHold, cancelPictureCopperRefresh, schedulePictureCopperRefresh } from '../src/pcb/modules/picture-refresh.js';
import { Pad } from '../src/shapes/pad.js';
import { AddPadCommand, RemovePadCommand, ModifyPadCommand, MovePadCommand } from '../src/pcb/modules/pad-commands.js';
import { isPictureCopperRefreshPending } from '../src/pcb/modules/refresh-state.js';

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const timers = new Map();
let timerId = 0;
let now = 0;
let fills = 0;
let ratsnest = 0;
let drcRequests = 0;
let poursHandleRatsnest = false;
let observedValue = 0;
const pcbDocument = new PcbDocument();
const app = {
    pcbDocument, pads: pcbDocument.pads,
    value: 0,
    getLayerGroup: () => null,
    refreshFills() { fills++; observedValue = this.value; return poursHandleRatsnest; },
    updateRatsnest(options) { assert.equal(options.skipFillRefresh, true); ratsnest++; },
    _scheduleDRC() { drcRequests++; },
};
const shape = { id: 'image', kind: 'image' };
const halo = { parentNode: { removeChild(element) { element.parentNode = null; } } };
app._boardShapeClearanceCache = new Map([[shape.id, { elements: [halo] }]]);
try {
    globalThis.setTimeout = (callback, delay) => {
        assert.equal(delay, 100);
        timers.set(++timerId, { callback, due: now + delay });
        return timerId;
    };
    globalThis.clearTimeout = id => { timers.delete(id); };
    const flush = () => {
        const callbacks = [...timers.values()];
        timers.clear();
        callbacks.forEach(timer => timer.callback());
    };
    for (let step = 1; step <= 30; step++) {
        app.value = step;
        schedulePictureCopperRefresh(app, shape);
    }
    assert.equal(halo.parentNode, null, 'The old halo is hidden immediately on edit, without waiting for another render');
    assert.equal(timers.size, 1);
    assert.equal(fills, 0);
    assert.equal(ratsnest, 0);
    flush();
    assert.equal(fills, 1);
    assert.equal(ratsnest, 1);
    assert.equal(drcRequests, 1, 'Geometry refresh requests DRC without knowing its UI visibility');
    assert.equal(observedValue, 30, 'Refresh uses the final geometry, not an earlier snapshot');
    poursHandleRatsnest = true;
    schedulePictureCopperRefresh(app);
    flush();
    assert.equal(fills, 2);
    assert.equal(ratsnest, 1, 'Pours already reconcile connectivity');
    assert.equal(drcRequests, 1, 'Pour completion owns its subsequent DRC request');
    schedulePictureCopperRefresh(app);
    cancelPictureCopperRefresh(app);
    assert.equal(timers.size, 0, 'Immediate layer/net refresh cancels deferred work');
    assert.equal(isPictureCopperRefreshPending(app), false);
    const advance = milliseconds => {
        now += milliseconds;
        for (const [id, timer] of timers) {
            if (timer.due <= now) {
                timers.delete(id);
                timer.callback();
            }
        }
    };
    for (let click = 0; click < 10; click++) {
        schedulePictureCopperRefresh(app);
        advance(50);
        assert.equal(fills, 2, 'Clicks less than 100 ms apart never trigger a refresh');
        assert.equal(isPictureCopperRefreshPending(app), true);
    }
    advance(49);
    assert.equal(fills, 2);
    advance(1);
    assert.equal(fills, 3, 'Exactly 100 ms after the final click triggers one refresh');
    assert.equal(isPictureCopperRefreshPending(app), false);
    const eventTarget = () => {
        const listeners = new Map();
        return {
            addEventListener(name, handler) { listeners.set(name, handler); },
            removeEventListener(name) { listeners.delete(name); },
            fire(type, details = {}) { listeners.get(type)?.({ type, ...details }); },
            get listenerCount() { return listeners.size; },
        };
    };
    const input = eventTarget();
    const host = eventTarget();
    bindPictureRefreshHold(app, input, host);
    for (const [start, end, details] of [
        ['pointerdown', 'pointerup', { button: 0, pointerId: 1 }],
        ['pointerdown', 'pointercancel', { button: 0, pointerId: 2 }],
        ['keydown', 'keyup', { key: 'ArrowUp' }],
        ['pointerdown', 'blur', { button: 0, pointerId: 3 }],
    ]) {
        const before = fills;
        schedulePictureCopperRefresh(app, shape);
        input.fire(start, details);
        schedulePictureCopperRefresh(app, shape);
        advance(1000);
        assert.equal(fills, before, 'Initial auto-repeat delay cannot refresh clearance during a hold');
        assert.equal(timers.size, 0);
        assert.equal(isPictureCopperRefreshPending(app), true);
        schedulePictureCopperRefresh(app, shape);
        advance(300);
        assert.equal(fills, before, 'Repeat events keep clearance deferred');
        host.fire(end, details);
        assert.equal(host.listenerCount, 0, 'Release listeners are cleaned up even if the input was replaced');
        advance(99);
        assert.equal(fills, before);
        advance(1);
        assert.equal(fills, before + 1, 'Refresh occurs 100 ms after release');
    }
    let cutRefreshes = 0;
    app.updateCopperCuts = () => { cutRefreshes++; };
    app._deferredShapeCopperCuts = true;
    schedulePictureCopperRefresh(app);
    schedulePictureCopperRefresh(app);
    assert.equal(cutRefreshes, 0, 'Restarting the debounce does not flush copper cuts');
    flush();
    assert.equal(cutRefreshes, 1);
    app._deferredShapeCopperCuts = true;
    schedulePictureCopperRefresh(app);
    cancelPictureCopperRefresh(app);
    assert.equal(cutRefreshes, 2, 'An immediate layer change flushes outstanding copper-cut work');

    for (const withPours of [false, true]) {
        poursHandleRatsnest = withPours;
        const pad = new Pad({ net: 'GND' }), before = pad.captureState();
        pcbDocument.pads.length = 0;
        for (const command of [
            new AddPadCommand(app, pad),
            new ModifyPadCommand(app, pad, before, { ...before, x: 1 }),
            new MovePadCommand(app, pad, { x: 1, y: 0 }, { x: 2, y: 0 }),
            new RemovePadCommand(app, pad),
        ]) {
            for (const action of ['execute', 'undo', 'execute']) {
                const previous = fills;
                command[action]();
                assert.equal(fills, previous, 'Pad commands leave fill requests to their existing debounce');
                assert.equal(timers.size, 1);
                flush();
                assert.equal(fills, previous + 1, 'Each settled pad edit makes exactly one fill request');
            }
        }
    }
} finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
}
console.log('PASS copper image refresh burst coalescing, latest state, pour reconciliation and cancellation');