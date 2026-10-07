import assert from 'node:assert/strict';
import { AutorouterSession } from '../../src/pcb/modules/autorouter-session.js';

class Element {
    constructor(tag = 'g') {
        this.tagName = tag;
        this.children = [];
        this.dataset = {};
        this.style = {};
        this.attributes = {};
        this.listeners = new Map();
        this._text = '';
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    appendChild(element) { element.parent = this; this.children.push(element); }
    remove() {
        if (this.parent) this.parent.children = this.parent.children.filter(element => element !== this);
        this.parent = null;
    }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    querySelectorAll(selector) {
        const name = selector.match(/^[.#]([^[]+)/)?.[1];
        const data = selector.match(/\[data-(net|connid)="([^"]*)"\]/);
        return this.children.flatMap(element => [
            ...((selector.startsWith('#') ? element.attributes.id === name
                : (element.attributes.class || '').split(' ').includes(name))
                && (!data || element.dataset[data[1]] === data[2]) ? [element] : []),
            ...element.querySelectorAll(selector),
        ]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    set textContent(value) { this._text = value; this.children = []; }
    get textContent() { return this._text; }
    set innerHTML(_value) {
        this.children = [];
        for (const name of ['route-progress-bar-fill', 'route-progress-label', 'route-progress-elapsed']) {
            const element = new Element('span');
            element.setAttribute('class', name);
            this.appendChild(element);
        }
        const button = new Element('button');
        button.setAttribute('id', 'pcbRouteCancelBtn');
        this.appendChild(button);
    }
}

function fixture() {
    const intervals = new Map(), timeouts = new Map(), frames = new Map(), workers = [];
    let nextId = 0, now = 0;
    const schedule = queue => callback => { queue.set(++nextId, callback); return nextId; };
    const svg = new Element('svg'), host = new Element('status');
    const layers = new Map(['top-copper', 'bottom-copper', 'vias', 'ratlines'].map(name => {
        const layer = new Element();
        svg.appendChild(layer);
        return [name, layer];
    }));
    const ratline = new Element('line'), label = new Element('text');
    ratline.setAttribute('class', 'ratsnest-line');
    ratline.dataset.net = 'N';
    label.textContent = 'N';
    layers.get('ratlines').appendChild(ratline);
    layers.get('ratlines').appendChild(label);
    const copper = new Element('polyline');
    copper.setAttribute('class', 'pcb-routed-track');
    layers.get('top-copper').appendChild(copper);
    const board = {
        active: true, editing: false, model: {}, placements: new Map([['P', {}]]),
        netlist: [{ net: 'N' }], undo: [], redo: [],
        rules: { trackWidth: 0.23456789, clearance: 0.1, viaDiameter: 0.6, viaDrill: 0.3 },
    };
    const adopted = [], errors = [], statuses = [];
    let reconciles = 0;
    const runtime = {
        createWorker() {
            const worker = {
                listeners: new Map(), jobs: [], terminated: false,
                addEventListener(type, callback) { this.listeners.set(type, callback); },
                removeEventListener(type) { this.listeners.delete(type); },
                terminate() { this.terminated = true; },
                postMessage(message) { this.jobs.push(message); },
                emit(data) { this.listeners.get('message')?.({ data }); },
            };
            workers.push(worker);
            return worker;
        },
        now: () => now,
        setInterval: schedule(intervals), clearInterval: id => intervals.delete(id),
        setTimeout: schedule(timeouts), clearTimeout: id => timeouts.delete(id),
        requestAnimationFrame: schedule(frames), cancelAnimationFrame: id => frames.delete(id),
        createSvgElement: tag => new Element(tag),
    };
    const capabilities = {
        readBoard: () => board,
        takeRouteInput: () => ({ connections: [{ net: 'N', pads: [] }] }),
        getRouterMode: () => 'maze',
        adoptResult: result => { adopted.push(result); board.undo.push(result); },
        reconcileRatsnest: () => {
            reconciles++;
            ratline.style.display = label.style.display = '';
        },
        setStatus: message => statuses.push(message),
        reportError: error => errors.push(error),
        presentation: {
            getProgressHost: () => host, getSvg: () => svg,
            getLayerGroup: name => layers.get(name),
            getRoutingParams: () => board.rules,
            refreshClearanceHalos() {},
        },
    };
    const owner = new AutorouterSession(capabilities, runtime);
    const checkReleased = () => {
        assert.equal(owner.active, false);
        assert.equal(intervals.size, 0);
        assert.equal(timeouts.size, 0);
        assert.equal(frames.size, 0);
        assert.equal(svg.querySelectorAll('.pcb-route-anim').length, 0);
        assert.equal(copper.parent, layers.get('top-copper'), 'Authored artwork is never removed');
    };
    return {
        owner, capabilities, runtime, board, workers, host, svg, layers, ratline, label, copper,
        intervals, timeouts, frames, adopted, errors, statuses, checkReleased,
        reconciles: () => reconciles, advance: value => { now += value; },
    };
}

const tracks = [{
    net: 'N', connId: 'N:1', layer: 'top', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
    vias: [{ x: 3, y: 4 }],
}];
const result = { tracks, vias: tracks[0].vias, failedConnections: [], totalConnectionCount: 1, failedConnectionCount: 0 };
let cases = 0;

for (const blocked of ['inactive', 'editing', 'empty', 'disposed']) {
    const f = fixture();
    if (blocked === 'inactive') f.board.active = false;
    if (blocked === 'editing') f.board.editing = true;
    if (blocked === 'empty') f.board.netlist = [];
    if (blocked === 'disposed') f.owner.dispose();
    await f.owner.run();
    assert.equal(f.workers.length, 0);
    if (blocked === 'editing') assert.match(f.statuses.at(-1), /Finish the current edit/);
    if (blocked === 'empty') assert.equal(f.statuses.at(-1), 'Nothing to route');
    f.checkReleased();
    cases++;
}

for (const stopped of [false, true]) {
    const f = fixture(), run = f.owner.run(), worker = f.workers.at(-1);
    assert.equal(f.owner.active, true);
    assert.equal(f.adopted.length, 0);
    assert.equal(worker.jobs[0].routeInput.trackWidth, f.board.rules.trackWidth);
    worker.emit({ type: 'netRouted', netTracks: tracks });
    assert.equal(f.svg.querySelectorAll('.pcb-route-anim').length, 2);
    assert.equal(f.svg.querySelector('.pcb-routed-via').attributes['fill-rule'], 'evenodd');
    worker.emit({ type: 'progress', done: 1, total: 1, net: 'N', meta: { phase: 'initial' } });
    assert.equal(f.ratline.style.display, 'none');
    assert.equal(f.label.style.display, 'none');
    if (stopped) {
        const button = f.host.querySelector('#pcbRouteCancelBtn');
        button.listeners.get('mousedown')({ stopPropagation() {} });
        assert.equal(button.disabled, true);
        assert.equal(worker.jobs.at(-1).type, 'cancel');
        assert.equal(f.owner.active, true, 'Stop is not invalidation');
    }
    f.advance(65000);
    worker.emit({ type: 'done', result });
    await run;
    assert.deepEqual(f.adopted, [result]);
    assert.match(f.statuses.at(-1), /1 min 05 sec/);
    assert.equal(worker.terminated, true);
    f.checkReleased();
    cases++;
}

for (const mutation of ['model', 'placements', 'netlist', 'undo', 'redo', 'rules', 'editing', 'active']) {
    const f = fixture(), run = f.owner.run(), worker = f.workers.at(-1);
    if (mutation === 'model') f.board.model = {};
    if (mutation === 'placements') f.board.placements = new Map(f.board.placements);
    if (mutation === 'netlist') f.board.netlist = [...f.board.netlist];
    if (mutation === 'undo') f.board.undo.push({});
    if (mutation === 'redo') f.board.redo.push({});
    if (mutation === 'rules') f.board.rules = { ...f.board.rules, clearance: 0.8 };
    if (mutation === 'editing') f.board.editing = true;
    if (mutation === 'active') f.board.active = false;
    for (const callback of [...f.intervals.values()]) callback();
    worker.emit({ type: 'done', result });
    await run;
    assert.equal(f.adopted.length, 0, `${mutation} invalidates the snapshot`);
    assert.equal(f.reconciles(), 1);
    assert.equal(worker.terminated, true);
    f.checkReleased();
    cases++;
}

{
    const f = fixture(), first = f.owner.run(), old = f.workers.at(-1);
    old.emit({ type: 'netFailed', conn: { net: 'N', pads: tracks[0].points } });
    old.emit({ type: 'netPendingChanged', netName: 'N', pendingConnections: 0 });
    const oldFrames = [...f.frames.values()];
    const oldIntervals = [...f.intervals.values()];
    const oldMessage = old.listeners.get('message'), oldError = old.listeners.get('error');
    const oldStop = f.host.querySelector('#pcbRouteCancelBtn').listeners.get('mousedown');
    const second = f.owner.run(), current = f.workers.at(-1);
    current.emit({ type: 'netPendingChanged', netName: 'N', pendingConnections: 1 });
    const frameCount = f.frames.size, intervalCount = f.intervals.size;
    for (const callback of oldFrames) callback();
    for (const callback of oldIntervals) callback();
    oldMessage({ data: { type: 'done', result } });
    oldError({ error: new Error('Late error') });
    oldStop({ stopPropagation() {} });
    await first;
    assert.equal(current.terminated, false);
    assert.equal(current.jobs.length, 1, 'Old Stop never stops the successor');
    assert.equal(f.frames.size, frameCount, 'Old RAF cannot flush successor visibility');
    assert.equal(f.intervals.size, intervalCount);
    assert.equal(f.ratline.style.display, '');
    assert.equal(f.errors.length, 0);
    current.emit({ type: 'done', result });
    await second;
    assert.deepEqual(f.adopted, [result]);
    f.checkReleased();
    cases++;
}

for (const action of ['cancel', 'dispose', 'stop', 'history']) {
    const f = fixture(), run = f.owner.run(), worker = f.workers.at(-1);
    worker.emit({ type: 'progress', done: 1, total: 1, net: 'Rip-up pass 1',
        meta: { phase: 'ripup', ripupPass: 1, ripupMaxPasses: 4 } });
    worker.emit({ type: 'done', result });
    await Promise.resolve();
    assert.equal(f.timeouts.size, 1, 'Final phase presentation is owned and cancellable');
    if (action === 'cancel') f.owner.cancel();
    if (action === 'dispose') f.owner.dispose();
    if (action === 'stop') f.owner.stop();
    if (action === 'history') {
        f.board.undo.push({});
        const [id, callback] = [...f.timeouts][0];
        f.timeouts.delete(id);
        callback();
    }
    await run;
    assert.equal(f.adopted.length, action === 'stop' ? 1 : 0);
    f.checkReleased();
    cases++;
}

{
    const f = fixture(), run = f.owner.run(), worker = f.workers.at(-1);
    worker.emit({ type: 'progress', done: 1, total: 1, net: 'Rip-up pass 1',
        meta: { phase: 'ripup', ripupPass: 1, ripupMaxPasses: 4 } });
    worker.emit({ type: 'done', result });
    await Promise.resolve();
    for (let pass = 2; pass <= 4; pass++) {
        assert.match(f.host.querySelector('.route-progress-label').textContent, new RegExp(`Rip-up ${pass} of 4`));
        const [id, callback] = [...f.timeouts][0];
        f.timeouts.delete(id);
        callback();
        await Promise.resolve();
    }
    await run;
    assert.deepEqual(f.adopted, [result]);
    f.checkReleased();
    cases++;
}

{
    const f = fixture(), first = f.owner.run(), old = f.workers.at(-1);
    old.emit({ type: 'progress', done: 1, total: 1, net: 'Rip-up pass 1',
        meta: { phase: 'ripup', ripupPass: 1, ripupMaxPasses: 4 } });
    old.emit({ type: 'done', result });
    await Promise.resolve();
    const latePhase = [...f.timeouts.values()][0];
    const second = f.owner.run(), worker = f.workers.at(-1);
    latePhase();
    await first;
    assert.equal(f.owner.active, true);
    assert.equal(f.adopted.length, 0);
    assert.equal(f.timeouts.size, 0, 'Supersession cancels the old presentation delay');
    worker.emit({ type: 'done', result });
    await second;
    assert.deepEqual(f.adopted, [result]);
    f.checkReleased();
    cases++;
}

for (const failure of ['construct', 'post', 'worker', 'messageerror', 'progress', 'input', 'stop']) {
    const f = fixture();
    if (failure === 'construct') f.owner.runtime.createWorker = () => { throw new Error('Constructor failed'); };
    if (failure === 'input') f.capabilities.takeRouteInput = () => { throw new Error('Input failed'); };
    if (failure === 'post') {
        const factory = f.owner.runtime.createWorker;
        f.owner.runtime.createWorker = () => {
            const worker = factory();
            worker.postMessage = () => { throw new Error('Post failed'); };
            return worker;
        };
    }
    const run = f.owner.run(), worker = f.workers.at(-1);
    if (failure === 'worker') worker.emit({ type: 'error', error: 'Worker failed' });
    if (failure === 'messageerror') worker.listeners.get('messageerror')();
    if (failure === 'progress') {
        f.host.querySelector = () => { throw new Error('Render failed'); };
        worker.emit({ type: 'progress', done: 0, total: 1 });
    }
    if (failure === 'stop') {
        worker.postMessage = () => { throw new Error('Stop failed'); };
        f.owner.stop();
    }
    await run;
    assert.equal(f.errors.length, 1);
    assert.match(f.statuses.at(-1), /Route error:/);
    assert.equal(f.adopted.length, 0);
    if (worker) assert.equal(worker.terminated, true);
    f.checkReleased();
    cases++;
}

{
    const f = fixture(), run = f.owner.run(), worker = f.workers.at(-1);
    worker.emit({ type: 'trying', from: tracks[0].points[0], to: tracks[0].points[1] });
    assert.equal(f.svg.querySelectorAll('.pcb-trying-line').length, 1);
    worker.emit({ type: 'netRouted', netTracks: tracks });
    assert.equal(f.svg.querySelectorAll('.pcb-trying-line').length, 0);
    worker.emit({ type: 'connRipped', connId: 'N:1' });
    assert.equal(f.svg.querySelectorAll('.pcb-route-anim').length, 0);
    worker.emit({ type: 'netFailed', conn: { net: 'N', pads: tracks[0].points } });
    assert.equal(f.frames.size, 1);
    worker.emit({ type: 'netFailed', conn: { net: 'N', pads: tracks[0].points } });
    assert.equal(f.frames.size, 1, 'Replacing failure artwork cancels its fade');
    f.owner.dispose();
    await run;
    f.checkReleased();
    cases++;
}

console.log(`PASS ${cases} independent autorouter owner contracts (explicit board, worker, DOM and scheduler capabilities)`);
