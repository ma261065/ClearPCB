import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
const frames = [];
globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
globalThis.cancelAnimationFrame = () => {};
// Waiting out an edit must not need a timer: record any the refreshes start.
const timerDelays = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => { timerDelays.push(delay); return realSetTimeout(callback, delay, ...args); };

const { pcbEditorFixture } = await import('./pcb-editor-fixture.mjs');
const { setEditorActive } = await import('../../src/pcb/modules/pcb-editor-api.js');
const { PCB_INTERACTIONS, setPcbInteraction } = await import('../../src/pcb/modules/pcb-interactions.js');
const {
    isFillRefreshScheduled, setDragOverlaysDeferred, setFillRefreshError, setFillRefreshPending,
    setFillRefreshScheduled, setFillRefreshSuspended, setPictureCopperRefreshPending,
} = await import('../../src/pcb/modules/refresh-state.js');
const { disposeFillRefresh, scheduleFillRefresh } = await import('../../src/pcb/modules/fill-refresh.js');
const { disposeDrcRefresh, scheduleDrcRefresh } = await import('../../src/pcb/modules/drc-refresh.js');
const { getDrcPresentation } = await import('../../src/pcb/modules/drc-state.js');
const { CopperFill } = await import('../../src/shapes/copper-fill.js');

// A pour recompute or DRC check that comes due while an edit is under way waits for it
// to end; whatever ends last notes the edit settled and the refresh runs then, without
// polling. Each thing that can hold a refresh back is raised while one is due, then
// ended, and the refresh must be queued straight afterwards.

const microtasks = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

/** Things that defer both pours and DRC. */
const holds = [
    { name: 'drag overlay deferral', raise: app => setDragOverlaysDeferred(app, true), end: app => setDragOverlaysDeferred(app, false) },
    { name: 'paste fill suspension', raise: app => setFillRefreshSuspended(app, true), end: app => setFillRefreshSuspended(app, false) },
    { name: 'batched picture refresh', raise: app => setPictureCopperRefreshPending(app, true),
        end: app => setPictureCopperRefreshPending(app, false) },
    // Gestures count as an edit in progress (inline text edit, drags, rotations, paste…).
    ...PCB_INTERACTIONS.filter(entry => entry.category === 'gesture').map(({ key }) => ({
        name: `interaction ${key}`, raise: app => setPcbInteraction(app, key, {}), end: app => setPcbInteraction(app, key, null),
    })),
];

function editor({ fill = false } = {}) {
    const app = pcbEditorFixture({ getRoutingParams: () => ({ clearance: 0.2 }), setStatus() {} });
    if (fill) app.pcbDocument.boardShapes.push(new CopperFill({ id: 'pour', layer: 'top-copper', net: 'GND',
        outline: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }));
    setEditorActive(app, true);
    return app;
}

for (const hold of holds) {
    const app = editor({ fill: true });
    hold.raise(app);
    assert.equal(app.isSectionEditing() || hold.name.includes('picture'), true, `${hold.name} holds refreshes back`);
    frames.length = 0;
    scheduleFillRefresh(app);
    await microtasks();
    assert.equal(frames.length, 0, `${hold.name}: the pour recompute waits`);
    hold.end(app);
    await microtasks();
    assert.equal(frames.length, 1, `${hold.name}: ending it queues the waiting pour recompute`);
    assert.equal(isFillRefreshScheduled(app), true);
    disposeFillRefresh(app);
    setEditorActive(app, false);
}

/** DRC also waits for a queued or running pour recompute, until it succeeds or fails. */
const drcHolds = [
    ...holds,
    { name: 'queued pour recompute', raise: app => setFillRefreshScheduled(app, true), end: app => setFillRefreshScheduled(app, false) },
    { name: 'running pour recompute', raise: app => setFillRefreshPending(app, true), end: app => setFillRefreshPending(app, false) },
    { name: 'failed pour recompute', raise: app => setFillRefreshPending(app, true),
        end: app => setFillRefreshError(app, new Error('pour failed')) },
];
for (const hold of drcHolds) {
    const app = editor();
    Object.assign(getDrcPresentation(app), { shouldRun: () => true, updateStatus() {} });
    hold.raise(app);
    frames.length = 0;
    scheduleDrcRefresh(app);
    await microtasks();
    assert.equal(frames.length, 0, `${hold.name}: the DRC check waits`);
    hold.end(app);
    await microtasks();
    assert.equal(frames.length, 1, `${hold.name}: ending it queues the waiting DRC check`);
    disposeDrcRefresh(app);
    setEditorActive(app, false);
}

// Nothing ending, nothing resumed: an unrelated settle does not restart a check already queued.
{
    const app = editor();
    Object.assign(getDrcPresentation(app), { shouldRun: () => true, updateStatus() {} });
    frames.length = 0;
    scheduleDrcRefresh(app);
    assert.equal(frames.length, 1);
    setPcbInteraction(app, '_textDrag', {});
    setPcbInteraction(app, '_textDrag', null);
    await microtasks();
    assert.equal(frames.length, 1, 'a settle with nothing waiting queues nothing');
    disposeDrcRefresh(app);
    setEditorActive(app, false);
}
assert.deepEqual(timerDelays, [], 'no refresh waited on a timer');

// Every Properties binding whose preview ends on its own says so, directly or by
// releasing the drag session it holds (the overlay deferral dropping notes it).
const modules = new URL('../../src/pcb/modules/', import.meta.url);
const DELEGATES = new Map([
    ['component-properties.js', "active only through its reference text's binding (text-properties.js)"],
    ['autorouter-session.js', 'its sessionEnded capability notes it (test-autorouter-owner)'],
]);
const silent = readdirSync(modules).filter(name => name.endsWith('.js') && !DELEGATES.has(name))
    .filter(name => {
        const source = readFileSync(new URL(name, modules), 'utf8');
        return /get active\(\)/.test(source) && !/noteEditSettled\(|beginDragSession\(/.test(source);
    });
assert.deepEqual(silent, [], 'a binding with an active preview notes the edit settled when the preview ends');

console.log(`PASS refresh settling: ${holds.length} holds on pours and ${drcHolds.length} on DRC resume when they end, with no polling`);
