import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { Track } from '../../src/shapes/track.js';
import { Via } from '../../src/shapes/via.js';
import { Pad } from '../../src/shapes/pad.js';
import { CopperFill } from '../../src/shapes/copper-fill.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { MovePadCommand } from '../../src/core/pcb-pad-commands.js';
import { runDRC, runDrcInputs } from '../../src/pcb/modules/drc.js';
import { captureDrcInputs } from '../../src/pcb/modules/drc-worker-inputs.js';
import { createDrcWorker } from '../../src/pcb/modules/drc-worker-client.js';
import { disposeDrcRefresh, invalidateDrcRefresh, runDrcNow } from '../../src/pcb/modules/drc-refresh.js';
import {
    collectDrcRatlines,
    getDrcPresentation,
    resetDrc,
    scheduleDrc,
    setDrcRatlines,
    storedDrcRatlines,
} from '../../src/pcb/modules/drc-state.js';
import { setComputedFill, getComputedFill } from '../../src/pcb/modules/computed-fill-cache.js';
import { resolveTrackSegments } from '../../src/shared/pcb/board-geometry.js';
import { setDragOverlaysDeferred, setFillRefreshError, setFillRefreshPending, setFillRefreshScheduled, setFillRefreshSuspended, setPictureCopperRefreshPending } from '../../src/pcb/modules/refresh-state.js';
import { setPcbInteraction } from '../../src/pcb/modules/pcb-interactions.js';
import { isEditorActive, setEditorActive } from '../../src/pcb/modules/pcb-editor-api.js';

class Element {
    constructor() { this.children = []; this.attributes = new Map(); this.dataset = {}; this.style = {}; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    get classList() { return { contains: value => (this.getAttribute('class') || '').split(' ').includes(value) }; }
    appendChild(child) { child.parentNode = this; this.children.push(child); }
    remove() {
        if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
        this.parentNode = null;
    }
    querySelectorAll(selector) {
        return this.children.filter(child => selector.split(',').some(part => {
            const name = part.trim().split('.')[1];
            return name && child.classList.contains(name);
        }));
    }
}
globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById: () => null, createElementNS: () => new Element() };
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');
const { reconcileRatsnest } = await import('../../src/pcb/modules/track-draw.js');
const rectangle = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const ring = (x, y, r, count = 32) => Array.from({ length: count }, (_, index) => ({
    x: x + r * Math.cos(index * Math.PI * 2 / count), y: y + r * Math.sin(index * Math.PI * 2 / count),
}));
function fixture() {
    const app = Object.create(PCBApp.prototype), model = new PcbDocument(), layer = new Element();
    const counts = { accepted: 0, pending: 0, lists: 0, markers: 0, cleared: 0, connectors: 0 };
    Object.assign(app, {
        pcbDocument: model, placements: new Map(), netlist: [],
        getRoutingParams: () => ({ clearance: 0.2 }),
        getLayerGroup: id => id === 'ratlines' ? layer : null,
        setStatus(message) { app.lastStatus = message; },
        _cancelDrawingMode() {}, _closeBoardDimensionsDialog() {},
    });
    const drc = getDrcPresentation(app);
    Object.assign(drc, {
        shouldRun: () => true,
        updateStatus(result, pending) {
            if (pending) counts.pending++;
            else { counts.accepted++; app.lastResult = result; }
        },
        renderList() { counts.lists++; },
        drawMarker() { counts.markers++; }, clearMarker() { counts.cleared++; },
        updateConnector() { counts.connectors++; },
    });
    setDrcRatlines(app, []);
    model.tracks.push(new Track({ id: 'track', net: 'N1', points: [{ x: Math.PI, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }],
        width: 0.3123456789, edgeWidths: { e0: 0.5123456789 }, edgeLayers: { e1: 'bottom-copper' },
        edgeBulges: { e0: 0.23456789 } }));
    model.pads.push(new Pad({ id: 'pad', x: 5, y: 2, size: 1.123456789, shape: 'stadium',
        ratio: 2.123456789, rotation: 23.123456789, drill: 0.3123456789, net: 'N2' }));
    model.vias.push(new Via({ id: 'via', x: 5, y: 2, diameter: 1.123456789, drill: 1.1, net: 'N3' }));
    app.placements.set('U1', { x: 12, y: 8, rotation: 17.123456789, side: 'bottom',
        padOffsets: [{ number: '1', padId: 'a', dx: 0, dy: 0, width: 2, height: 3,
            shape: 'oval', drill: 0.4, slotLength: 1.3, slotAngle: 37.123456789 }] });
    app.netlist = [{ net: 'N1', pins: [{ componentId: 'U1', pinNumber: '1' }] }];
    const fill = new CopperFill({ id: 'fill', layer: 'top-copper', net: 'N4', outline: rectangle(0, 0, 20, 20) });
    model.boardShapes.push(fill,
        { id: 'arc', kind: 'arc', layer: 'top-copper', lineWidth: 0.5123456789,
            start: { x: 2, y: 10 }, end: { x: 8, y: 10 }, bulge: { x: 5, y: 14 } },
        { id: 'cut', kind: 'circle', layer: 'top-copper', copperMode: 'remove-copper', filled: true,
            x: 6, y: 6, radius: 0.8123456789 },
        { id: 'image', kind: 'image', layer: 'top-copper', copperMode: 'remove-copper',
            points: rectangle(12, 12, 3, 2), artwork: { width: 3, height: 2, rectangles: [{ x: 0, y: 0, width: 3, height: 2 }] } });
    model.texts.set('text', { id: 'text', content: 'A', x: 2, y: 14, layer: 'top-copper',
        size: 1.5123456789, strokeWidth: 0.1123456789, rotation: 31 });
    setComputedFill(fill, [{ outer: fill.outline, holes: [ring(6, 6, 0.8123456789)] }]);
    const rules = () => ({ clearance: 0.2, minAnnularRing: 0.05, ratlines: collectDrcRatlines(app) });
    return { app, model, fill, counts, layer, rules, drc };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const nativeCases = [];

// Capture must not read any editor projection or DOM, and must strip incidental model refs/methods.
{
    const { app, model, fill, rules } = fixture();
    setDrcRatlines(app, [{ net: 'precise', x1: Math.PI, y1: Math.E, x2: 9.123456789, y2: 4.987654321 }]);
    const expected = runDRC(app, rules()), saved = model.captureGeometry(), serialized = model.serialize();
    const snapshots = model.tracks.map(resolveTrackSegments), pour = getComputedFill(fill);
    const identities = [...model.tracks, ...model.tracks[0].nodes.values(), ...model.tracks[0].edges.values(),
        ...model.pads, ...model.vias, ...model.boardShapes];
    for (const via of model.vias) via.svgCache = { method() { throw new Error('DOM cache read'); } };
    for (const item of [...model.pads, ...model.vias, ...model.boardShapes, ...model.tracks[0].nodes.values()]) Object.freeze(item);
    const keys = ['tracks', 'pads', 'vias', 'texts', 'boardShapes', 'copperFills'];
    for (const key of keys) Object.defineProperty(app, key, { configurable: true,
        get() { throw new Error(`Editor projection read: ${key}`); } });
    app.getLayerGroup = () => { throw new Error('SVG traversal during capture'); };
    const inputs = captureDrcInputs(app, rules());
    assert.deepEqual(runDrcInputs(inputs), expected);
    assert.equal(inputs.rules.ratlines[0].x1, Math.PI);
    assert.equal(inputs.copper.segments[0].ax, Math.PI);
    assert.equal(Object.hasOwn(inputs.copper.vias[0], 'ref'), false);
    for (const key of keys) delete app[key];
    assert.deepEqual(model.captureGeometry(), saved);
    assert.deepEqual(model.serialize(), serialized);
    model.tracks.forEach((track, index) => assert.deepEqual(resolveTrackSegments(track), snapshots[index]));
    [...model.tracks, ...model.tracks[0].nodes.values(), ...model.tracks[0].edges.values(),
        ...model.pads, ...model.vias, ...model.boardShapes].forEach((item, index) => assert.equal(item, identities[index]));
    assert.equal(getComputedFill(fill), pour);
    inputs.copper.pads[0].outline[0].x += 100;
    assert.deepEqual(model.captureGeometry(), saved);
    for (const state of ['pending', 'failed', 'missing']) {
        setFillRefreshPending(app, state !== 'missing');
        setFillRefreshError(app, state === 'failed' ? new Error('pour failed') : null);
        if (state === 'missing') setComputedFill(fill, null);
        const inputs = captureDrcInputs(app, rules()), expected = runDRC(app, rules());
        assert.deepEqual(runDrcInputs(inputs), expected);
        nativeCases.push({ inputs, expected });
        assert.ok(runDRC(app, rules()).violations.some(item => item.rule === 'fill'));
    }
}

{
    const { app, model, rules } = fixture();
    model.boardShapes = []; model.vias = []; model.pads = []; model.texts.clear();
    app.placements.clear();
    model.tracks = [
        new Track({ net: 'A', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }),
        new Track({ net: '', points: [{ x: 1, y: 0 }, { x: 5, y: 0 }] }),
        new Track({ net: 'B', points: [{ x: 5, y: 0 }, { x: 6, y: 0 }] }),
    ];
    for (const track of model.tracks) delete track.id;
    const inputs = captureDrcInputs(app, rules()), expected = runDRC(app, rules());
    assert.ok(expected.violations.some(item => item.rule === 'short' && item.message.includes('A and B')));
    assert.deepEqual(runDrcInputs(inputs), expected, 'No Net bridges and anonymous track identities survive neutral capture');
    assert.notEqual(inputs.copper.segments[0].trackId, inputs.copper.segments[1].trackId);
    assert.deepEqual(Object.keys(inputs.copper.segments[0].trackId), [], 'Identity tokens contain no model references');
    nativeCases.push({ inputs, expected });
}

// A real module worker: reject storage/network/file/UI imports and accesses, not merely fake math.
{
    const { app, model, rules } = fixture();
    for (let index = 0; index < 100; index++) {
        model.tracks.push(new Track({ id: `dense-${index}`, net: `N${index % 5}`, width: 0.1,
            points: Array.from({ length: 40 }, (_, node) => ({ x: node * 0.45, y: 0.5 + index * 0.18 })) }));
        model.pads.push(new Pad({ x: index % 10 * 1.8, y: Math.floor(index / 10) * 1.8,
            size: 0.6, drill: 0.2, net: `N${index % 7}` }));
        model.vias.push(new Via({ x: index % 10 * 1.8 + 0.8, y: Math.floor(index / 10) * 1.8,
            diameter: 0.5, drill: 0.2, net: `N${index % 5}` }));
    }
    setDrcRatlines(app, Array.from({ length: 38 }, (_, index) => ({
        net: `N${index % 5}`, x1: index * 0.41, y1: 0, x2: index * 0.41 + 0.3, y2: 1.123456789,
    })));
    const saved = model.serialize(), geometry = model.captureGeometry();
    const startCapture = performance.now(), inputs = captureDrcInputs(app, rules());
    const captureMs = performance.now() - startCapture;
    const startSync = performance.now(), expected = runDRC(app, rules());
    const syncMs = performance.now() - startSync;
    assert.ok(expected.violations.length > 600, 'The fixture exercises a substantial many-net result');
    let native, audit, started, completed = false;
    const startedPromise = new Promise(resolve => { started = resolve; });
    const url = new URL('../../src/pcb/modules/drc-worker.js', import.meta.url).href;
    const client = createDrcWorker(() => {
        native = new NodeWorker(`
            const { parentPort } = require('node:worker_threads');
            const { registerHooks } = require('node:module');
            const imports = [], accesses = [];
            registerHooks({ resolve(name, context, next) {
                const result = next(name, context);
                if (/StorageManager|\\/src\\/ui\\/|KiCadFetcher|ComponentPicker|node:(fs|http|https|child_process)/.test(result.url)) {
                    throw new Error('Forbidden worker import: ' + result.url);
                }
                imports.push(result.url); return result;
            } });
            for (const name of ['indexedDB', 'localStorage', 'sessionStorage', 'caches']) {
                Object.defineProperty(globalThis, name, { get() { accesses.push(name); throw new Error('Forbidden access: ' + name); } });
            }
            globalThis.fetch = () => { accesses.push('fetch'); throw new Error('Worker network access'); };
            globalThis.postMessage = data => parentPort.postMessage({ ...data, audit: { imports, accesses } });
            const ready = import(${JSON.stringify(url)});
            parentPort.on('message', async data => {
                await ready; parentPort.postMessage({ started: true }); globalThis.onmessage({ data });
            });
        `, { eval: true });
        const adapter = { terminate: () => native.terminate(), postMessage: data => native.postMessage(data) };
        native.on('message', data => {
            if (data.started) started();
            else { audit = data.audit; adapter.onmessage?.({ data }); }
        });
        native.on('error', error => adapter.onerror?.({ message: error.message }));
        return adapter;
    });
    try {
        const result = client.build(inputs).then(value => { completed = true; return value; });
        await startedPromise;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(completed, false, 'Main event loop remains responsive during the actual worker check');
        const actual = await result;
        assert.deepEqual(actual, expected, 'Exact violation objects, order, IDs, witnesses and counts survive IPC');
        assert.deepEqual(audit.accesses, []);
        assert.ok(audit.imports.some(url => url.endsWith('/drc.js')));
        const startAdopt = performance.now();
        getDrcPresentation(app).adoptResult(actual);
        const adoptionMs = performance.now() - startAdopt;
        for (const { inputs, expected } of nativeCases) {
            assert.deepEqual(await client.build(inputs), expected, 'Native parity includes anonymous No Net bridges and pending/failed/missing pours');
            assert.deepEqual(audit.accesses, []);
        }
        const captures = [];
        for (let pass = 0; pass < 5; pass++) {
            const start = performance.now();
            captureDrcInputs(app, rules());
            captures.push(performance.now() - start);
        }
        assert.deepEqual(model.serialize(), saved);
        assert.deepEqual(model.captureGeometry(), geometry);
        console.log('BENCH DRC worker (physical capture, headless adoption):', JSON.stringify({
            tracks: model.tracks.length, nodes: model.tracks.reduce((sum, track) => sum + track.nodes.size, 0),
            violations: actual.violations.length, captureMs,
            warmCaptureMedianMs: captures.sort((a, b) => a - b)[2], syncMs, adoptionMs,
        }));
    } finally { client.dispose(); }
}

const frames = [], workers = [], timers = new Map();
let nextTimer = 0;
const originalTimers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
globalThis.setTimeout = callback => { timers.set(++nextTimer, callback); return nextTimer; };
globalThis.clearTimeout = id => timers.delete(id);
const flush = () => {
    let count = 0;
    while (frames.length) { assert.ok(++count < 30, 'No frame spin'); frames.shift()(); }
};
const retry = () => { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); flush(); };
class FakeWorker {
    constructor() { this.jobs = []; this.terminated = false; workers.push(this); }
    postMessage(data) { this.jobs.push(structuredClone(data)); }
    terminate() { this.terminated = true; }
    finish(job = this.jobs.at(-1), result = runDrcInputs(job.inputs)) { this.onmessage?.({ data: { id: job.id, result } }); }
}
globalThis.Worker = FakeWorker;
try {
    {
        const { app, model, counts, drc } = fixture();
        const saved = model.serialize();
        runDrcNow(app);
        const previous = drc.violations, accepted = counts.accepted;
        for (let i = 0; i < 25; i++) scheduleDrc(app);
        assert.equal(frames.length, 1);
        assert.equal(drc.pending, true);
        assert.equal(app.isSectionEditing(), false, 'Derived DRC work does not broaden the file-action editing guard');
        assert.equal(drc.violations, previous);
        flush();
        const worker = workers.at(-1);
        assert.equal(worker.jobs.length, 1);
        for (let i = 0; i < 25; i++) { scheduleDrc(app); flush(); }
        assert.equal(worker.jobs.length, 1, 'One active check plus one replaceable pending snapshot');
        worker.finish(worker.jobs[0]); await tick();
        assert.equal(counts.accepted, accepted);
        assert.equal(worker.jobs.length, 2);
        worker.finish(worker.jobs[1]); await tick();
        assert.equal(counts.accepted, accepted + 1);
        assert.equal(drc.pending, false);
        assert.deepEqual(model.serialize(), saved);
        disposeDrcRefresh(app);
    }
    const refreshSetters = { _pictureCopperRefreshPending: setPictureCopperRefreshPending, _fillRefreshScheduled: setFillRefreshScheduled,
        _deferDragOverlays: setDragOverlaysDeferred, _suspendFillRefresh: setFillRefreshSuspended };
    for (const flag of ['_deferDragOverlays', '_suspendFillRefresh', '_pictureCopperRefreshPending',
        '_fillRefreshScheduled', '_textEdit']) {
        const { app, counts } = fixture();
        const setFlag = value => {
            if (refreshSetters[flag]) refreshSetters[flag](app, value);
            else setPcbInteraction(app, flag, value ? {} : null);
        };
        scheduleDrc(app); flush();
        const worker = workers.at(-1);
        setFlag(true);
        worker.finish(); await tick();
        assert.equal(counts.accepted, 0, `No acceptance during ${flag}`);
        retry();
        assert.equal(counts.accepted, 0);
        setFlag(false);
        retry();
        workers.at(-1).finish(); await tick();
        assert.equal(counts.accepted, 1, `Deferred debt resumes after ${flag}`);
        disposeDrcRefresh(app);
    }
    // Raising a suspension invalidates an in-flight check, even if it is lowered before the result arrives.
    for (const [label, suspend] of [['overlay deferral', setDragOverlaysDeferred], ['fill suspension', setFillRefreshSuspended]]) {
        const { app, counts } = fixture();
        scheduleDrc(app); flush();
        const stale = workers.at(-1).jobs.at(-1);
        suspend(app, true);
        suspend(app, false);
        workers.at(-1).finish(stale); await tick();
        assert.equal(counts.accepted, 0, `${label}: a check started before the suspension is discarded`);
        retry();
        workers.at(-1).finish(); await tick();
        assert.equal(counts.accepted, 1, `${label}: a fresh check runs afterwards`);
        disposeDrcRefresh(app);
    }
    {
        const { app, counts } = fixture();
        let visible = true;
        getDrcPresentation(app).shouldRun = () => visible;
        scheduleDrc(app); flush();
        visible = false;
        workers.at(-1).finish(); await tick();
        assert.equal(counts.accepted, 0);
        assert.equal(getDrcPresentation(app).pending, true);
        visible = true;
        scheduleDrc(app); flush();
        workers.at(-1).finish(); await tick();
        assert.equal(counts.accepted, 1, 'Reopening the UI resumes hidden result debt');
        disposeDrcRefresh(app);
    }
    {
        const { app, counts } = fixture(), before = workers.length;
        delete globalThis.Worker;
        try {
            scheduleDrc(app); flush();
            assert.equal(counts.accepted, 1);
            assert.equal(workers.length, before, 'No-Worker environments retain scheduled synchronous evaluation');
        } finally { globalThis.Worker = FakeWorker; disposeDrcRefresh(app); }
    }
    {
        const { app, model, counts } = fixture();
        app.history = new CommandHistory({ onChanged: () => scheduleDrc(app) });
        scheduleDrc(app); flush();
        const worker = workers.at(-1);
        app.history.execute(new MovePadCommand(model.pads[0], { x: 5, y: 2 }, { x: 8.123456789, y: 8 }));
        flush(); worker.finish(worker.jobs[0]); await tick();
        assert.equal(counts.accepted, 0);
        worker.finish(); await tick();
        const expected = app.lastResult;
        app.history.undo(); flush(); worker.finish(); await tick();
        app.history.redo(); flush(); worker.finish(); await tick();
        assert.deepEqual(app.lastResult, expected);
        disposeDrcRefresh(app);
    }
    for (const action of ['fill-cache', 'fill-replacement', 'document', 'deactivate', 'cancel', 'clear', 'dispose', 'sync']) {
        const { app, model, fill, counts } = fixture();
        scheduleDrc(app); flush();
        const worker = workers.at(-1), old = worker.jobs[0];
        if (action === 'fill-cache') setComputedFill(fill, []);
        if (action === 'fill-replacement') model.boardShapes[0] = new CopperFill({ id: fill.id, outline: fill.outline });
        if (action === 'document') app.pcbDocument = new PcbDocument();
        if (action === 'deactivate') app.deactivate();
        if (action === 'cancel') app._cancelPosePreviews();
        if (action === 'clear') { resetDrc(app); model.clear(); flush(); }
        if (action === 'dispose') app.dispose();
        if (action === 'sync') runDrcNow(app);
        const before = counts.accepted;
        worker.finish(old); await tick();
        assert.equal(counts.accepted, before, `Reject old result after ${action}`);
        if (['document', 'deactivate', 'cancel', 'dispose', 'sync'].includes(action)) assert.equal(worker.terminated, true);
        if (action === 'dispose') { scheduleDrc(app); flush(); assert.equal(workers.at(-1), worker); }
        if (['fill-cache', 'fill-replacement'].includes(action)) {
            retry(); workers.at(-1).finish(); await tick();
            assert.equal(counts.accepted, before + 1);
        }
        if (action === 'deactivate') {
            setEditorActive(app, true);
            scheduleDrc(app);
        }
        if (action === 'deactivate' || action === 'cancel') {
            flush();
            assert.notEqual(workers.at(-1), worker);
            workers.at(-1).finish(); await tick();
            assert.equal(counts.accepted, before + 1);
        }
        disposeDrcRefresh(app);
    }
    {
        const { app, counts } = fixture();
        setFillRefreshPending(app, true);
        const before = workers.length;
        scheduleDrc(app); flush();
        assert.equal(workers.length, before, 'Wait for outstanding pour math instead of checking stale copper');
        setFillRefreshError(app, new Error('Pour failure'));
        retry(); workers.at(-1).finish(); await tick();
        assert.equal(counts.accepted, 1);
        assert.equal(app.lastResult.ok, false);
        assert.ok(app.lastResult.violations.some(item => item.rule === 'fill' && /failed/.test(item.message)));
        disposeDrcRefresh(app);
    }
    {
        const { app, counts, drc } = fixture();
        runDrcNow(app);
        drc.selectedId = drc.violations[0].id;
        scheduleDrc(app); flush();
        drc.selectedId = drc.violations.at(-1).id;
        const selected = drc.selectedId;
        workers.at(-1).finish(); await tick();
        assert.equal(drc.selectedId, selected, 'Acceptance respects selection changed while the job was outstanding');
        assert.ok(counts.markers > 0 && counts.connectors > 0);
        const old = { id: 'old', rule: 'unrouted', marker: { type: 'ratline', net: 'N',
            a: { x: 0, y: 0 }, b: { x: 1, y: 1 } } };
        drc.violations = [old]; drc.selectedId = old.id;
        drc.adoptResult({ violations: [{ ...old, id: 'new' }], counts: { errors: 1, warnings: 0 }, ok: false });
        assert.equal(drc.selectedId, 'new');
        disposeDrcRefresh(app);
    }
    for (const mode of ['construct', 'post', 'error', 'messageerror', 'malformed', 'compute']) {
        const { app, counts } = fixture(), errors = [];
        const log = console.error;
        console.error = (...args) => errors.push(args);
        globalThis.Worker = class extends FakeWorker {
            constructor() { super(); if (mode === 'construct') throw new Error('construction failed'); }
            postMessage(data) { if (mode === 'post') throw new Error('post failed'); super.postMessage(data); }
        };
        try {
            scheduleDrc(app); flush();
            const worker = workers.at(-1);
            if (mode === 'error') worker.onerror({ message: 'worker failed' });
            if (mode === 'messageerror') worker.onmessageerror();
            if (mode === 'malformed') worker.finish(worker.jobs[0], { ok: true, violations: [], counts: { errors: 1, warnings: 0 } });
            if (mode === 'compute') worker.onmessage({ data: { id: worker.jobs[0].id, error: 'geometry failed' } });
            await tick();
            assert.equal(counts.accepted, 1, `${mode} recovers using synchronous DRC`);
            assert.ok(errors.length && app.lastStatus.includes('failed'));
            assert.equal(getDrcPresentation(app).error, null);
            if (mode === 'post') {
                app.deactivate();
                globalThis.Worker = FakeWorker;
                setEditorActive(app, true);
                scheduleDrc(app); flush();
                workers.at(-1).finish(); await tick();
                assert.equal(counts.accepted, 2, 'A new activation lifecycle retries the native transport');
            }
            disposeDrcRefresh(app);
        } finally { console.error = log; globalThis.Worker = FakeWorker; }
    }
    {
        const { app, counts, drc } = fixture();
        runDrcNow(app);
        const previous = drc.violations, before = counts.accepted;
        const log = console.error; console.error = () => {};
        const model = app.pcbDocument;
        Object.defineProperty(model, 'tracks', { configurable: true, get() { throw new Error('capture failed'); } });
        try {
            scheduleDrc(app); flush();
            assert.equal(counts.accepted, before);
            assert.equal(drc.violations, previous);
            assert.ok(drc.pending && drc.error);
        } finally {
            Object.defineProperty(model, 'tracks', { configurable: true, writable: true, value: [] });
            console.error = log; disposeDrcRefresh(app);
        }
    }
    {
        const { app, counts, drc } = fixture();
        runDrcNow(app);
        const previous = drc.violations, before = counts.accepted, rules = app.getRoutingParams;
        const log = console.error; console.error = () => {};
        try {
            scheduleDrc(app); flush();
            app.getRoutingParams = () => { throw new Error('Synchronous fallback failed'); };
            workers.at(-1).onerror({ message: 'Transport failed' }); await tick();
            assert.equal(counts.accepted, before);
            assert.equal(drc.violations, previous);
            assert.ok(drc.pending && drc.error);
            app.getRoutingParams = rules;
            scheduleDrc(app); flush();
            assert.equal(counts.accepted, before + 1, 'A later request can recover after both transport and fallback failure');
            assert.equal(drc.error, null);
        } finally { console.error = log; disposeDrcRefresh(app); }
    }
    {
        const { app, layer } = fixture();
        setDrcRatlines(app, [{ net: 'failed', x1: 1, y1: 2, x2: 3, y2: 4, failed: true }]);
        const failed = new Element(); failed.setAttribute('class', 'ratsnest-line ratsnest-failed'); failed.dataset.net = 'failed';
        for (const [key, value] of Object.entries(storedDrcRatlines(app)[0])) if (key !== 'net' && key !== 'failed') failed.setAttribute(key, value);
        layer.appendChild(failed);
        app.pcbDocument.boardShapes = [];
        app.pcbDocument.tracks = [];
        app.pcbDocument.pads = [];
        app.placements.clear();
        app.pcbDocument.vias = [new Via({ x: Math.PI, y: 0, net: 'N' }), new Via({ x: 15, y: Math.E, net: 'N' })];
        reconcileRatsnest(app, { skipFillRefresh: true });
        const svg = () => layer.children.map(line => ({ net: line.dataset.net,
            ...Object.fromEntries(['x1', 'y1', 'x2', 'y2'].map(key => [key, parseFloat(line.getAttribute(key))])) }));
        assert.deepEqual(collectDrcRatlines(app), svg(), 'Neutral data matches rendered order and precise failed/normal lines');
        reconcileRatsnest(app, { nets: new Set(['N']), skipFillRefresh: true });
        assert.deepEqual(collectDrcRatlines(app), svg(), 'Incremental rebuild preserves unaffected/failed records');
        app._flushRatsnestVisibilityQueue = () => {};
        app.refreshClearanceHalos = () => {};
        app.history = new CommandHistory();
        app.refreshFills = () => false;
        app.clearProperties = () => {};
        app.status = {};
        app._renderRouteResult({ tracks: [], vias: [], failedConnections: [
            { net: 'failed-again', from: { x: -0, y: Math.E }, to: { x: 8.123456789, y: 9.987654321 } },
        ] });
        assert.deepEqual(collectDrcRatlines(app), svg(), 'Actual autorouter failed-line producer publishes neutral data too');
        const expected = collectDrcRatlines(app);
        app.getLayerGroup = () => { throw new Error('Ratline capture traversed SVG'); };
        assert.deepEqual(collectDrcRatlines(app), expected);
        const plain = {};
        setDrcRatlines(plain, expected);
        assert.deepEqual(collectDrcRatlines(plain), expected, 'Neutral consumers share the plain-app model fallback');
    }
} finally {
    Object.assign(globalThis, originalTimers);
    delete globalThis.Worker;
    delete globalThis.requestAnimationFrame;
}
console.log('PASS DRC worker: exact native parity/purity, responsiveness, canonical isolation, latest-only/lifecycle/debt, selection and fallback');
