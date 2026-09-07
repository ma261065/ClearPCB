import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./src/pcb/modules/board3d.js', import.meta.url), 'utf8');
const start = source.indexOf('    let timingMouseUpAt = null;');
const listener = "    window.addEventListener('mouseup', onTimingMouseUp, true);";
const end = source.indexOf(listener, start) + listener.length;
assert.ok(start >= 0 && end > start);
let now = 100;
let mouseUp = null;
const statuses = [];
const panel = { closed: false, hidden: false, view: '3d' };
const app = { _active: true, _viaDrag: {} };
const timing = new Function('window', 'performance', 'app', 'panel', 'setStatus',
    `${source.slice(start, end)}
    return { finishRebuildTiming, startedAt: () => timingMouseUpAt };`)(
    { addEventListener(type, handler, capture) {
        assert.equal(type, 'mouseup');
        assert.equal(capture, true);
        mouseUp = handler;
    } }, { now: () => now }, app, panel, text => statuses.push(text),
);
const completionStart = source.indexOf('            const result = await surfaceBuilder.build(surfaces);');
const completionEnd = source.indexOf('        } catch (error)', completionStart);
assert.ok(completionStart >= 0 && completionEnd > completionStart);
assert.ok(source.replace(/\r\n/g, '\n').includes(
    'rebuildSurfaces = async (syncComponentBodies = false) => {\n        const timingStart = timingMouseUpAt;'));
let resolveWorker;
let invalidated = 0;
let swaps = 0;
let bodySyncs = 0;
const completeBuild = new Function('surfaceBuilder', 'panel', 'app', 'scene', 'viewSync',
    'surf', 'swapSurface', 'syncBodies', 'finishRebuildTiming', `return async (timingStart, syncComponentBodies = true) => {
        const surfaces = {};
        const w = 100, h = 80;
        let hasSurfaces = true;
        ${source.slice(completionStart, completionEnd)}
    };`)(
    { build: () => new Promise(resolve => { resolveWorker = resolve; }) }, panel, app,
    { positionGlint() {}, requestRender() {}, frameAll() {} },
    { invalidate() { invalidated++; } }, { board: null },
    () => { swaps++; now += 10; }, () => { bodySyncs++; now += 25; }, timing.finishRebuildTiming,
);
const refreshSource = source.match(/refresh3D: \(\) => \{([^}]+)\}/);
assert.ok(refreshSource);
let liveBuild;
const refresh = new Function('rebuildSurfaces', 'syncBodies', refreshSource[1]);
mouseUp({ button: 0, timeStamp: 90 });
app._viaDrag = null;
now += 50 + 300;
refresh(syncComponentBodies => {
    assert.equal(syncComponentBodies, true);
    liveBuild = completeBuild(timing.startedAt(), syncComponentBodies);
}, () => { throw new Error('Component bodies must not move before worker completion'); });
let pending = liveBuild;
assert.equal(statuses.length, 0, 'Dispatch must not complete the measurement');
assert.equal(bodySyncs, 0, 'Component bodies must stay in place while surfaces are pending');
now += 1000;
resolveWorker({ board: {} });
assert.equal(await pending, true);
assert.equal(swaps, 1);
assert.equal(bodySyncs, 1);
assert.equal(statuses.at(-1), 'Mouse-up -> 3D: 1395 ms [cebd3f0 + reuse]');
assert.equal(timing.startedAt(), null);

app._viaDrag = {};
mouseUp({ button: 0, timeStamp: now });
pending = completeBuild(timing.startedAt());
now += 100;
mouseUp({ button: 0, timeStamp: now });
const latest = timing.startedAt();
resolveWorker({ board: {} });
await pending;
assert.equal(statuses.length, 1, 'An older build must not consume a newer release');
assert.equal(timing.startedAt(), latest);
pending = completeBuild(latest);
const bodySyncsBeforeDiscard = bodySyncs;
resolveWorker(null);
assert.equal(await pending, false);
assert.equal(bodySyncs, bodySyncsBeforeDiscard, 'Discarded builds must not move component bodies');
assert.equal(timing.startedAt(), latest, 'Discarded worker results leave timing pending');
pending = completeBuild(latest);
panel.hidden = true;
resolveWorker({ board: {} });
assert.equal(await pending, false);
assert.equal(invalidated, 1);
assert.equal(bodySyncs, bodySyncsBeforeDiscard, 'Hidden-view builds must not move component bodies');
assert.equal(statuses.length, 1, 'Hidden-view results must not report completion');
panel.hidden = false;
pending = completeBuild(latest);
now += 300;
resolveWorker({ board: {} });
await pending;
assert.equal(statuses.length, 2);
assert.equal(timing.startedAt(), null);
app._viaDrag = null;
mouseUp({ button: 0, timeStamp: now });
assert.equal(timing.startedAt(), null, 'Unrelated clicks must not arm timing');
app._viaDrag = {};
mouseUp({ button: 2, timeStamp: now });
assert.equal(timing.startedAt(), null, 'Pan releases must not arm timing');
const bodySyncsBeforeInitial = bodySyncs;
pending = completeBuild(null, false);
resolveWorker({ board: {} });
await pending;
assert.equal(bodySyncs, bodySyncsBeforeInitial, 'Initial loading retains its separate body-loading pass');
assert.ok(source.includes("window.removeEventListener('mouseup', onTimingMouseUp, true);"));
console.log('PASS: bodies and surfaces update together after worker completion; timing includes both, with discard and initial-load guards');