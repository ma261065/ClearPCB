import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { pictureRefreshHold, cancelPictureCopperRefresh, schedulePictureCopperRefresh, setShapeCopperCutsDeferred } from '../src/pcb/modules/picture-refresh.js';
import { Pad } from '../src/shapes/pad.js';
import { AddPadCommand, RemovePadCommand, ModifyPadCommand, MovePadCommand } from '../src/pcb/modules/pad-commands.js';
import { isPictureCopperRefreshPending } from '../src/pcb/modules/refresh-state.js';
import { getDrcPresentation } from '../src/pcb/modules/drc-state.js';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { clearanceOverlayState } from '../src/pcb/modules/clearance-overlay.js';

installFakeDom();
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
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
};
getDrcPresentation(app).shouldRun = () => true;
const shape = { id: 'image', kind: 'image' };
const halo = { parentNode: { removeChild(element) { element.parentNode = null; } } };
clearanceOverlayState(app).boardShapeClearanceCache.set(shape.id, { elements: [halo] });
try {
    globalThis.setTimeout = (callback, delay) => {
        assert.equal(delay, 100);
        timers.set(++timerId, { callback, due: now + delay });
        return timerId;
    };
    globalThis.clearTimeout = id => { timers.delete(id); };
    globalThis.requestAnimationFrame = () => { drcRequests++; return drcRequests; };
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
    // A held Properties spinner (the renderer detects the press and its release:
    // test-property-fields) holds refreshes until it is released.
    const hold = pictureRefreshHold(app);
    for (let run = 0; run < 3; run++) {
        const before = fills;
        schedulePictureCopperRefresh(app, shape);
        hold.begin();
        schedulePictureCopperRefresh(app, shape);
        advance(1000);
        assert.equal(fills, before, 'Initial auto-repeat delay cannot refresh clearance during a hold');
        assert.equal(timers.size, 0);
        assert.equal(isPictureCopperRefreshPending(app), true);
        schedulePictureCopperRefresh(app, shape);
        advance(300);
        assert.equal(fills, before, 'Repeat events keep clearance deferred');
        hold.end();
        hold.end();
        advance(99);
        assert.equal(fills, before);
        advance(1);
        assert.equal(fills, before + 1, 'Refresh occurs 100 ms after release');
    }
    let cutRefreshes = 0;
    app.updateCopperCuts = () => { cutRefreshes++; };
    setShapeCopperCutsDeferred(app, true);
    schedulePictureCopperRefresh(app);
    schedulePictureCopperRefresh(app);
    assert.equal(cutRefreshes, 0, 'Restarting the debounce does not flush copper cuts');
    flush();
    assert.equal(cutRefreshes, 1);
    setShapeCopperCutsDeferred(app, true);
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
    if (originalRequestAnimationFrame) globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    else delete globalThis.requestAnimationFrame;
}
console.log('PASS copper image refresh burst coalescing, latest state, pour reconciliation and cancellation');