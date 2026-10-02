import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { Track } from '../src/shapes/track.js';
import { Via } from '../src/shapes/via.js';
import { Pad } from '../src/shapes/pad.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { buildFillContext } from '../src/pcb/modules/fill-context.js';
import { captureFillInputs, computeFillBatch } from '../src/pcb/modules/fill-worker-geometry.js';
import { createFillWorker } from '../src/pcb/modules/fill-worker-client.js';
import { scheduleFillRefresh, invalidateFillRefresh, disposeFillRefresh, adoptFillResults } from '../src/pcb/modules/fill-refresh.js';
import { prepareCopperRegionContact, installCopperRegionContact, copperRegionShape,
    resolveTrackContactGeometry, copperContactsTouch } from '../src/pcb/modules/track-contact-geometry.js';
import { runDRC } from '../src/pcb/modules/drc.js';
import { computeFillPolygons, loadClipper } from '../src/pcb/modules/copper-fill-geom.js';
import { getComputedFill } from '../src/pcb/modules/computed-fill-cache.js';
import { schedulePictureCopperRefresh, cancelPictureCopperRefresh } from '../src/pcb/modules/picture-refresh.js';
import { EditTextCommand } from '../src/pcb/modules/text-commands.js';
import { loadPcb } from '../src/pcb/modules/project-state.js';

class Element {
    constructor() { this.children = []; this.attributes = new Map(); this.style = {}; this.dataset = {}; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; }
    insertBefore(child, sibling) {
        if (!sibling) return this.appendChild(child);
        child.remove(); this.children.splice(this.children.indexOf(sibling), 0, child); child.parentNode = this;
    }
    remove() {
        if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
        this.parentNode = null;
    }
    get firstChild() { return this.children[0] || null; }
    cloneNode() { const copy = new Element(); copy.attributes = new Map(this.attributes); return copy; }
    querySelectorAll(selector) {
        const attribute = /^\[([^=]+)="([^"]+)"\]$/.exec(selector);
        const matches = child => selector.startsWith('.')
            ? (child.getAttribute('class') || '').split(' ').includes(selector.slice(1))
            : attribute && child.getAttribute(attribute[1]) === attribute[2];
        return this.children.flatMap(child => [
            ...(matches(child) ? [child] : []),
            ...child.querySelectorAll(selector),
        ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: () => new Element(), getElementById: () => null };
globalThis.localStorage = { setItem() {} };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

const rectangle = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
function fixture() {
    const model = new PcbDocument();
    const app = Object.create(PCBApp.prototype);
    app.pcbDocument = model;
    app.designSettings = model.designSettings;
    app.placements = new Map();
    app.netlist = [];
    app._active = true;
    app._layerGroups = new Map(['top-fill', 'bottom-fill'].map(id => [id, new Element()]));
    for (const [id, group] of app._layerGroups) group.setAttribute('data-copper-cut', `${id}-cut`);
    const counts = { clear: 0, drc: 0, views: 0, rats: 0, sync: 0 }, drcStates = [];
    const ratlines = { get children() { counts.rats++; return []; }, appendChild() {} };
    app.getLayerGroup = id => id === 'ratlines' ? ratlines : app._layerGroups.get(id) || null;
    app._clearFillGroups = () => { counts.clear++; PCBApp.prototype._clearFillGroups.call(app); };
    app._scheduleDRC = () => { counts.drc++; drcStates.push([app._fillRefreshPending, app._fillRefreshError]); };
    app._board3d = { refresh() { counts.views++; } };
    app._recomputeFillsNow = () => { counts.sync++; return PCBApp.prototype._recomputeFillsNow.call(app); };
    app.setStatus = message => { app.lastStatus = message; };
    app._cancelDrawingMode = () => {};
    app._renderText = app.refreshText = app._selectText = () => {};
    app.history = new CommandHistory({ onChanged: () => invalidateFillRefresh(app) });
    const fill = new CopperFill({ id: 'top', kind: 'rect', net: 'GND',
        outline: rectangle(1.123456789, -39, 45, 37), cornerRadius: 0.312345678 });
    const bottom = new CopperFill({ id: 'bottom', kind: 'circle', layer: 'bottom-copper',
        net: 'GND', x: 25, y: -20, radius: 15.123456789 });
    model.boardShapes.push(fill, bottom, { id: 'hole', kind: 'circle', layer: 'hole', x: 12, y: -12, radius: 2.123456789 });
    model.tracks.push(new Track({ id: 'track', net: 'OTHER',
        points: [{ x: Math.PI, y: -6 }, { x: 20, y: -6 }, { x: 20, y: -26 }, { x: 39, y: -26 }],
        width: 0.231234567, edgeLayers: { e1: 'bottom-copper' }, edgeWidths: { e0: 0.713456789 },
        edgeBulges: { e0: 0.23456789 }, nodeCornerRadii: { n2: 2.123456789 } }));
    model.vias.push(new Via({ x: 22, y: -18, diameter: 1.123456789, drill: 0.3, net: 'OTHER' }));
    model.pads.push(new Pad({ x: 32, y: -18, shape: 'stadium', rotation: 37.123456789, size: 2, ratio: 3, net: 'GND' }));
    app.placements.set('U1', { x: 17, y: -14, rotation: 27, side: 'bottom', pads: new Map(),
        silks: [{ type: 'circle', layer: 'hole', cx: 5.123456789, cy: 4, r: 1.123456789 }],
        padOffsets: [{ number: '1', dx: 0, dy: 0, width: 2, height: 3, shape: 'rect', drill: 0.5, layer: 'both' }] });
    app.netlist = [{ net: 'OTHER', pins: [{ componentId: 'U1', pinNumber: '1' }] }];
    model.texts.set('text', { id: 'text', x: 5, y: -34, content: 'Copper', size: 2.123456789,
        strokeWidth: 0.312345678, rotation: 13.123456789, layer: 'top-copper', border: true });
    model.boardShapes.push(
        { id: 'image', kind: 'image', layer: 'top-copper', net: 'OTHER', copperMode: 'add',
            points: rectangle(28, -12, 6, 5), artwork: { width: 6, height: 5, rectangles: [{ x: 0, y: 0, width: 6, height: 5 }] } },
        { id: 'arc', kind: 'arc', layer: 'bottom-copper', lineWidth: 0.512345678,
            start: { x: 10, y: -20 }, end: { x: 35, y: -20 }, bulge: { x: 22, y: -30 } },
        new CopperFill({ id: 'other-fill', kind: 'polygon', layer: 'top-copper', net: 'OTHER',
            outline: rectangle(35, -36, 8, 6), segmentBulges: { 0: 0.123456789 } }),
    );
    return { app, model, fill, bottom, counts, drcStates };
}

{
    const { app, counts } = fixture(), coldFrames = [];
    globalThis.requestAnimationFrame = callback => { coldFrames.push(callback); return coldFrames.length; };
    try {
        assert.equal(app._recomputeFillsNow(), undefined);
        assert.equal(app._fillRefreshPending, true);
        invalidateFillRefresh(app);
        await loadClipper();
        await new Promise(resolve => setTimeout(resolve, 70));
        for (const frame of coldFrames) frame();
        assert.equal(counts.clear, 1, 'Cold synchronous refresh debt survives the following history notification');
        assert.equal(app._fillRefreshPending, false);
    } finally { disposeFillRefresh(app); delete globalThis.requestAnimationFrame; }
}

// Exercise the actual browser-worker module inside a native Node worker thread.
{
    const { app, model } = fixture();
    for (let index = 0; index < 100; index++) model.tracks.push(new Track({
        id: `dense-${index}`, net: index % 2 ? 'GND' : 'OTHER', width: 0.1,
        points: Array.from({ length: 40 }, (_, point) => ({
            x: 2 + point * 1.08, y: -3 - index * 0.33 + Math.sin(point * 0.3) * 0.08,
        })),
    }));
    const saved = model.serialize(), geometry = model.captureGeometry();
    const identities = [...model.tracks, ...model.vias, ...model.pads, ...model.boardShapes, ...model.texts.values()];
    const projected = ['tracks', 'vias', 'pads', 'boardShapes', 'texts', 'copperFills', '_boardWidth', '_boardHeight', '_boardRadius'];
    for (const key of projected) Object.defineProperty(app, key, {
        configurable: true, get() { throw new Error(`Editor projection read: ${key}`); },
    });
    const inputs = captureFillInputs(app);
    for (const key of projected) delete app[key];
    assert.equal(inputs.tracks[0].nodes.get('n0').x, Math.PI);
    assert.equal(inputs.tracks[0].edges.get('e0').width, 0.713456789);
    assert.equal(inputs.holes.length, 1, 'Detached context includes placed non-plated holes');
    assert.equal('artwork' in inputs.boardShapes.find(shape => shape.kind === 'image'), false);
    const expected = model.copperFills.map(fill => computeFillPolygons(fill, buildFillContext(app)));
    assert.ok(expected.some(regions => regions.some(region => region.holes.length)), 'Parity fixture includes real holes');
    let native, started, completed = false;
    const startedPromise = new Promise(resolve => { started = resolve; });
    const workerUrl = new URL('../src/pcb/modules/fill-worker.js', import.meta.url).href;
    const client = createFillWorker(() => {
        native = new NodeWorker(`
            const { parentPort } = require('node:worker_threads');
            globalThis.postMessage = (data, options) => parentPort.postMessage(data, options?.transfer);
            const ready = import(${JSON.stringify(workerUrl)});
            parentPort.on('message', async data => {
                await ready;
                parentPort.postMessage({ started: true });
                globalThis.onmessage({ data });
            });
        `, { eval: true });
        const adapter = { terminate: () => native.terminate(), postMessage: data => native.postMessage(data) };
        native.on('message', data => data.started ? started() : adapter.onmessage?.({ data }));
        native.on('error', error => adapter.onerror?.({ message: error.message }));
        return adapter;
    });
    try {
        const result = client.build(inputs).then(value => { completed = true; return value; });
        await startedPromise;
        let heartbeat = false;
        await new Promise(resolve => setImmediate(() => { heartbeat = true; resolve(); }));
        assert.equal(heartbeat, true);
        assert.equal(completed, false, 'Main event loop remains available while the worker owns the pour');
        const batch = await result;
        assert.deepEqual(batch.results, expected, 'Native worker matches every polygon/vertex/hole and per-edge layer/width');
        assert.deepEqual(model.serialize(), saved);
        assert.deepEqual(model.captureGeometry(), geometry);
        [...model.tracks, ...model.vias, ...model.pads, ...model.boardShapes, ...model.texts.values()]
            .forEach((object, index) => assert.equal(object, identities[index]));
        for (const fill of model.copperFills) assert.equal(getComputedFill(fill), null);
        assert.deepEqual(await computeFillBatch(structuredClone(inputs)), expected);
        const probe = resolveTrackContactGeometry({ kind: 'circle', x: 12, y: -12,
            radius: 0.2, lineWidth: 0, filled: true });
        batch.results.forEach((regions, fillIndex) => regions.forEach((region, index) => {
            const contact = batch.contacts[fillIndex][index];
            assert.equal(contact.region, region, 'Transferred metadata retains exact region identity');
            const cold = resolveTrackContactGeometry(copperRegionShape(structuredClone(region)));
            installCopperRegionContact(region, contact);
            const prepared = resolveTrackContactGeometry(copperRegionShape(region));
            assert.deepEqual(prepared.bounds, cold.bounds);
            assert.equal(copperContactsTouch(prepared, probe), copperContactsTouch(cold, probe));
        }));

        const timings = { cold: [], prepared: [], deliveryClone: [] }, contactWork = {};
        for (let trial = 0; trial < 6; trial++) {
            for (const kind of trial % 2 ? ['prepared', 'cold'] : ['cold', 'prepared']) {
                let payload = structuredClone(batch);
                const startClone = performance.now();
                payload = structuredClone(payload, { transfer: payload.contacts.flat().flatMap(contact =>
                    [contact.indices.buffer, contact.bounds.buffer, contact.triangleBounds.buffer]) });
                if (trial) timings.deliveryClone.push(performance.now() - startClone);
                const sort = Array.prototype.sort;
                let contactSorts = 0, sortedContacts = 0;
                try {
                    Array.prototype.sort = function (...args) {
                        if (this[0]?.item?.bounds && this[0].bounds) {
                            contactSorts++; sortedContacts += this.length;
                        }
                        return sort.apply(this, args);
                    };
                    const start = performance.now();
                    adoptFillResults(app, model.copperFills, payload.results, kind === 'prepared' ? payload.contacts : undefined);
                    if (trial) timings[kind].push(performance.now() - start);
                    contactWork[kind] = { contactSorts, sortedContacts };
                } finally { Array.prototype.sort = sort; }
            }
        }
        const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
        const regions = batch.results.flat(), contacts = batch.contacts.flat();
        console.log('BENCH prepared-region adoption (headless SVG, real connectivity):', JSON.stringify({
            tracks: model.tracks.length, nodes: model.tracks.reduce((sum, track) => sum + track.nodes.size, 0),
            regions: regions.length, vertices: regions.reduce((sum, region) => sum + region.outer.length
                + region.holes.reduce((total, hole) => total + hole.length, 0), 0),
            polygonJSONBytes: Buffer.byteLength(JSON.stringify(batch.results)),
            preparedBufferBytes: contacts.reduce((sum, contact) => sum + contact.indices.byteLength
                + contact.bounds.byteLength + contact.triangleBounds.byteLength, 0),
            coldAdoptionMedianMs: median(timings.cold), preparedAdoptionMedianMs: median(timings.prepared),
            transferredCloneMedianMs: median(timings.deliveryClone),
            contactWork,
        }));
        assert.deepEqual(model.serialize(), saved, 'Contact adoption never mutates authored state');
    } finally { client.dispose(); }
}

const frames = [], workers = [];
globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
class FakeWorker {
    constructor() { this.jobs = []; this.terminated = false; workers.push(this); }
    postMessage(data) { this.jobs.push(structuredClone(data)); }
    terminate() { this.terminated = true; }
    finish(job = this.jobs.at(-1), results = job.inputs.fills.map(fill => [{ outer: fill.outline, holes: [] }])) {
        const contacts = results.map(regions => regions.map(prepareCopperRegionContact));
        const data = { id: job.id, results, contacts };
        this.onmessage?.({ data });
        return data;
    }
}
globalThis.Worker = FakeWorker;
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const flush = () => { const pending = frames.splice(0); for (const frame of pending) frame(); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const paths = app => [...app._layerGroups.values()].flatMap(group => group.querySelectorAll('.pcb-fill-copper'));
function settled() {
    const f = fixture();
    assert.equal(f.app._recomputeFillsNow(), true);
    f.old = f.model.copperFills.map(getComputedFill);
    f.artwork = paths(f.app);
    for (const key of Object.keys(f.counts)) f.counts[key] = 0;
    return f;
}
function unchanged(f) {
    f.model.copperFills.forEach((fill, index) => assert.equal(getComputedFill(fill), f.old[index]));
    assert.deepEqual(paths(f.app), f.artwork);
    assert.deepEqual(f.counts, { clear: 0, drc: 0, views: 0, rats: 0, sync: 0 });
}

{
    const f = settled(), saved = f.model.serialize(), geometry = f.model.captureGeometry();
    let captures = 0;
    const track = f.model.tracks[0], capture = track.captureCopperGeometry;
    track.captureCopperGeometry = function () { captures++; return capture.call(this); };
    try {
        for (let i = 0; i < 100; i++) assert.equal(scheduleFillRefresh(f.app), true);
        assert.equal(frames.length, 1);
        assert.equal(f.app._fillRefreshPending, true);
        assert.equal(runDRC(f.app).violations.filter(item => item.rule === 'fill'
            && /refresh is pending/.test(item.message)).length, f.model.copperFills.length);
        unchanged(f);
        flush();
        assert.equal(captures, 1, 'One neutral capture per coalesced job');
        const worker = workers.at(-1);
        unchanged(f);
        assert.equal(f.app.isSectionEditing(), false, 'Derived work does not broaden the file-action editing guard');
        assert.deepEqual(f.model.serialize(), saved);
        assert.deepEqual(f.model.captureGeometry(), geometry);
        worker.finish();
        await tick();
        assert.deepEqual(f.counts, { clear: 1, drc: 1, views: 1, rats: 1, sync: 0 });
        assert.equal(f.app._fillRefreshPending, false);
        assert.deepEqual(f.drcStates.at(-1), [false, null], 'Complete cache and refresh status publish before DRC observes them');
        assert.equal(paths(f.app).length, f.model.copperFills.length);
        for (const path of paths(f.app)) assert.match(path.getAttribute('clip-path'), /^url\(#(?:top|bottom)-fill-cut\)$/);
        assert.deepEqual(f.model.serialize(), saved);
    } finally { disposeFillRefresh(f.app); }
}

{
    const f = settled();
    try {
        scheduleFillRefresh(f.app); flush();
        const worker = workers.at(-1), first = worker.jobs[0];
        f.model.tracks[0].nodes.get('n0').x = 6.123456789;
        scheduleFillRefresh(f.app); flush();
        f.model.tracks[0].nodes.get('n0').x = 7.987654321;
        scheduleFillRefresh(f.app); flush();
        assert.equal(worker.jobs.length, 1, 'No concurrent jobs enter the worker');
        assert.equal(first.inputs.tracks[0].nodes.get('n0').x, Math.PI, 'Transport owns detached geometry');
        worker.finish(first);
        await tick();
        unchanged(f);
        assert.equal(worker.jobs.length, 2, 'Only the latest pending job is posted');
        assert.equal(worker.jobs[1].inputs.tracks[0].nodes.get('n0').x, 7.987654321);
        worker.finish();
        await tick();
        assert.equal(f.counts.clear, 1);
    } finally { disposeFillRefresh(f.app); }
}

for (const mode of ['preview', 'preview-roundtrip', 'picture', 'sync', 'history', 'replacement', 'clear', 'fill-replacement', 'deactivate', 'dispose']) {
    const f = settled();
    try {
        scheduleFillRefresh(f.app); flush();
        const worker = workers.at(-1), job = worker.jobs[0];
        if (mode.startsWith('preview')) f.app._deferDragOverlays = true;
        if (mode === 'preview-roundtrip') f.app._deferDragOverlays = false;
        if (mode === 'picture') f.app._pictureCopperRefreshPending = true;
        if (mode === 'sync') f.app._recomputeFillsNow();
        if (mode === 'history') f.app.history.execute(new EditTextCommand(f.app, 'text', { size: 3.123456789 }));
        if (mode === 'replacement') f.app.pcbDocument = new PcbDocument();
        if (mode === 'clear') f.model.clear();
        if (mode === 'fill-replacement') f.model.boardShapes[0] = new CopperFill(f.fill.captureState());
        if (mode === 'deactivate') f.app.deactivate();
        if (mode === 'dispose') f.app.dispose();
        worker.finish(job);
        await tick();
        if (mode === 'sync') {
            assert.equal(f.counts.clear, 1, 'Synchronous command refresh supersedes the worker');
            assert.equal(worker.terminated, true);
        } else {
            assert.equal(f.counts.clear, 0, `${mode}: stale work never clears live SVG`);
            assert.deepEqual(paths(f.app), f.artwork);
        }
        if (mode.startsWith('preview') || mode === 'picture') {
            if (mode.startsWith('preview')) f.app._deferDragOverlays = false;
            else f.app._pictureCopperRefreshPending = false;
            await wait(70); flush();
            const latest = workers.at(-1);
            latest.finish(); await tick();
            assert.equal(f.counts.clear, 1, 'Previously accepted refresh debt resumes after preview cancellation');
        }
        if (mode === 'history') {
            cancelPictureCopperRefresh(f.app);
            f.app.history.undo();
            f.app.history.redo();
            cancelPictureCopperRefresh(f.app);
            scheduleFillRefresh(f.app); flush();
            const latest = workers.at(-1);
            assert.equal(latest.jobs.at(-1).inputs.texts[0].size, 3.123456789);
            latest.finish(); await tick();
            assert.equal(f.counts.clear, 1);
        }
        if (mode === 'fill-replacement') {
            assert.equal(getComputedFill(f.model.copperFills[0]), null, 'Same-ID replacement never inherits old results');
            flush();
            workers.at(-1).finish(); await tick();
            assert.equal(f.counts.clear, 1);
        }
        if (mode === 'deactivate' || mode === 'dispose') assert.equal(worker.terminated, true);
        if (mode === 'dispose') assert.equal(scheduleFillRefresh(f.app), false);
    } finally { cancelPictureCopperRefresh(f.app); disposeFillRefresh(f.app); flush(); }
}

for (const content of [null, 'reload']) {
    const f = settled();
    try {
        const data = content ? f.model.serialize() : null;
        scheduleFillRefresh(f.app); flush();
        const worker = workers.at(-1), job = worker.jobs[0];
        f.app._textElements = new Map();
        f.app._shapeElements = new Map();
        for (const method of ['_ensureViewport', '_closeDRCPanel', '_clearDRCMarker',
            '_closeBoardDimensionsDialog', '_selectBoardOutline', 'syncClipboardButtons',
            'updateCopperCuts', 'markSectionClean']) f.app[method] = () => {};
        f.app._active = false;
        loadPcb(f.app, data);
        const counts = { ...f.counts }, saved = f.model.serialize();
        assert.equal(worker.terminated, true, 'Actual project loading terminates prior worker ownership');
        worker.finish(job); await tick(); flush();
        assert.deepEqual(f.counts, counts);
        assert.deepEqual(f.model.serialize(), saved);
        for (const fill of f.model.copperFills) assert.equal(getComputedFill(fill), null);
    } finally { disposeFillRefresh(f.app); }
}

{
    const f = settled();
    try {
        scheduleFillRefresh(f.app);
        f.app._recomputeFillsNow();
        invalidateFillRefresh(f.app); // The command's history notification follows its synchronous refresh.
        flush();
        await wait(70); flush();
        assert.equal(f.counts.sync, 1);
        assert.equal(f.counts.clear, 1, 'A synchronous refresh satisfies queued debt without a redundant worker pass');
    } finally { disposeFillRefresh(f.app); }
}

for (const mode of ['error', 'messageerror', 'partial', 'malformed', 'contacts', 'post', 'constructor', 'compute', 'render', 'capture', 'fallback-failure']) {
    const f = settled(), errors = [], log = console.error;
    const outline = f.fill.getOutline, capture = f.fill.captureCopperGeometry;
    console.error = (...args) => errors.push(args);
    try {
        if (mode === 'post') globalThis.Worker = class extends FakeWorker { postMessage() { throw new Error('Post failed'); } };
        if (mode === 'constructor') globalThis.Worker = class { constructor() { throw new Error('Worker unavailable'); } };
        if (mode === 'capture') f.fill.captureCopperGeometry = () => { throw new Error('Capture failed'); };
        scheduleFillRefresh(f.app); flush();
        const worker = workers.at(-1);
        if (mode === 'error') worker.onerror({ message: 'Worker crashed' });
        if (mode === 'messageerror') worker.onmessageerror();
        if (mode === 'partial') worker.finish(undefined, []);
        if (mode === 'malformed') worker.onmessage({ data: { id: worker.jobs[0].id,
            results: f.model.copperFills.map(() => [{ outer: [{ x: NaN, y: 0 }], holes: [] }]) } });
        if (mode === 'contacts') worker.onmessage({ data: { id: worker.jobs[0].id,
            results: worker.jobs[0].inputs.fills.map(fill => [{ outer: fill.outline, holes: [] }]), contacts: [] } });
        if (mode === 'compute') worker.onmessage({ data: { id: worker.jobs[0].id, error: 'Computation failed' } });
        if (mode === 'render') {
            f.fill.getOutline = () => { throw new Error('Render failed'); };
            worker.finish();
        }
        if (mode === 'fallback-failure') {
            f.fill.getOutline = () => { throw new Error('Invalid current geometry'); };
            worker.onerror({ message: 'Worker crashed' });
        }
        await tick();
        assert.equal(errors.length, mode === 'fallback-failure' ? 2 : 1, `${mode}: each failure is explicitly reported`);
        if (['render', 'capture', 'fallback-failure'].includes(mode)) {
            if (mode === 'fallback-failure') {
                assert.equal(f.counts.sync, 1);
                f.counts.sync = 0;
            }
            unchanged(f);
            assert.equal(f.app._fillRefreshPending, true);
            assert.ok(f.app._fillRefreshError);
            const drc = runDRC(f.app);
            assert.equal(drc.ok, false);
            assert.equal(drc.violations.filter(item => item.rule === 'fill' && /refresh failed/.test(item.message)).length,
                f.model.copperFills.length, 'DRC never certifies retained settled pours after refresh failure');
            f.fill.getOutline = outline;
            f.fill.captureCopperGeometry = capture;
            scheduleFillRefresh(f.app); flush();
            if (mode !== 'fallback-failure') workers.at(-1).finish();
            await tick();
            assert.equal(f.counts.clear, 1, 'A later valid refresh recovers without replacing authored objects');
            assert.equal(f.app._fillRefreshPending, false);
            assert.equal(f.app._fillRefreshError, null);
            assert.equal(runDRC(f.app).violations.some(item => item.rule === 'fill'), false);
        } else {
            assert.equal(f.counts.sync, 1, `${mode}: current failed worker falls back synchronously`);
            assert.equal(f.counts.clear, 1);
            assert.equal(f.counts.drc, 1);
            scheduleFillRefresh(f.app); flush();
            assert.equal(f.counts.sync, 2, 'Failed transport is not retried on every refresh');
        }
    } finally { globalThis.Worker = FakeWorker; console.error = log; disposeFillRefresh(f.app); }
}

{
    const f = settled(), clear = f.app._clearFillGroups, log = console.error, errors = [];
    console.error = (...args) => errors.push(args);
    try {
        scheduleFillRefresh(f.app); flush();
        f.app._clearFillGroups = () => { clear(); throw new Error('SVG handoff failed'); };
        const rejected = workers.at(-1).finish(); await tick();
        assert.equal(errors.length, 1);
        assert.deepEqual(paths(f.app), f.artwork, 'Failed DOM handoff restores original nodes and their hole clips');
        f.model.copperFills.forEach((fill, index) => assert.equal(getComputedFill(fill), f.old[index]));
        assert.equal(f.counts.drc, 0);
        assert.equal(f.counts.rats, 0);
        assert.equal(f.app._fillRefreshPending, true);
        const clone = globalThis.structuredClone;
        let snapshots = 0;
        try {
            globalThis.structuredClone = value => { snapshots++; return clone(value); };
            resolveTrackContactGeometry(copperRegionShape(rejected.results[0][0]));
            assert.equal(snapshots, 1, 'Failed handoff does not install prepared contacts for unadopted regions');
        } finally { globalThis.structuredClone = clone; }
        f.app._clearFillGroups = clear;
        scheduleFillRefresh(f.app); flush();
        workers.at(-1).finish(); await tick();
        assert.equal(f.app._fillRefreshPending, false);
    } finally { console.error = log; disposeFillRefresh(f.app); }
}

{
    const f = settled();
    try {
        schedulePictureCopperRefresh(f.app);
        scheduleFillRefresh(f.app);
        assert.equal(frames.length, 0);
        await wait(120); flush();
        workers.at(-1).finish(); await tick();
        assert.equal(f.counts.clear, 1);
        assert.equal(f.counts.drc, 1);
        assert.equal(f.counts.rats, 1, 'Picture debounce hands connectivity responsibility to the worker');
    } finally { cancelPictureCopperRefresh(f.app); disposeFillRefresh(f.app); }
}

delete globalThis.Worker;
{
    const f = settled();
    try {
        scheduleFillRefresh(f.app); flush();
        assert.equal(f.counts.sync, 1, 'No-Worker hosts retain the synchronous scheduled fallback');
        assert.equal(f.counts.clear, 1);
    } finally { disposeFillRefresh(f.app); }
}
delete globalThis.requestAnimationFrame;
delete globalThis.localStorage;
console.log('PASS native fill-worker parity/responsiveness; latest-only scheduling, model/cache isolation, staged SVG, lifecycle, debt and failure fallback');
