import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { Track } from '../src/shapes/track.js';
import { Via } from '../src/shapes/via.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { AddTrackCommand } from '../src/pcb/modules/track-commands.js';
import { getPcbSelection, setPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { setPropertyEditor } from '../src/pcb/modules/property-editors.js';
import { getTrackDraw } from '../src/pcb/modules/track-draw.js';
import { setPcbInteraction } from '../src/pcb/modules/pcb-interactions.js';

function svgElement() {
    return {
        attributes: new Map(), children: [], style: {}, dataset: {}, parentNode: null,
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        getAttribute(name) { return this.attributes.get(name) ?? null; },
        removeAttribute(name) { this.attributes.delete(name); },
        appendChild(child) { child.parentNode?.removeChild?.(child); child.parentNode = this; this.children.push(child); return child; },
        removeChild(child) { this.children = this.children.filter(item => item !== child); child.parentNode = null; return child; },
        remove() { this.parentNode?.removeChild?.(this); },
        querySelector() { return null; },
        querySelectorAll() { return []; },
    };
}
globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: () => svgElement(), getElementById: () => null, querySelector: () => null };
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const workers = [], intervals = new Map();
let nextId = 0;
globalThis.setInterval = callback => { intervals.set(++nextId, callback); return nextId; };
globalThis.clearInterval = id => intervals.delete(id);
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
class FakeWorker {
    constructor() { this.listeners = new Map(); this.jobs = []; workers.push(this); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name) { this.listeners.delete(name); }
    postMessage(message) { this.jobs.push(message); }
    terminate() { this.terminated = true; }
    emit(data) { this.listeners.get('message')?.({ data }); }
    finish(result) { this.emit({ type: 'done', result }); }
}
globalThis.Worker = FakeWorker;
const routed = {
    tracks: [{ net: 'ROUTED', layer: 'top', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }],
    vias: [{ x: 3, y: 4, net: 'ROUTED' }], failedConnections: [],
    totalConnectionCount: 1, failedConnectionCount: 0,
};
function fixture() {
    const app = Object.assign(Object.create(PCBApp.prototype), {
        pcbDocument: new PcbDocument(), placements: new Map([['part', { pads: new Map() }]]),
        netlist: [{ net: 'ORIGINAL', pins: [] }], _active: true, currentTool: 'select', status: { modeStatus: null },
        _layerGroups: new Map(),
        _shapeElements: new Map(),
        getLayerGroup(id) {
            if (!this._layerGroups.has(id)) {
                this._layerGroups.set(id, svgElement());
            }
            return this._layerGroups.get(id);
        },
        getRoutingParams: () => ({ trackWidth: 0.23456789, clearance: 0.1, viaDiameter: 0.6, viaDrill: 0.3 }),
        _getRouterMode: () => 'maze',
        _buildRouteInput: () => ({ connections: [{ net: 'ORIGINAL', pads: [] }] }),
        setStatus(message) { this.lastStatus = message; },
        refreshClearanceHalos() {},
        refreshFills: () => false, _ensureViewport() {}, updateCopperCuts() {},
        _clearFillGroups() {},
    });
    app.history = new CommandHistory({ onChanged: () => app._markDirty() });
    const track = new Track({ net: 'ORIGINAL', points: [{ x: Math.PI, y: 8 }, { x: 9, y: Math.E }] });
    const via = new Via({ x: Math.PI, y: 8, diameter: 0.6123456789, drill: 0.3 });
    app.pcbDocument.tracks.push(track);
    app.pcbDocument.vias.push(via);
    return { app, track, via };
}

for (const stopped of [false, true]) {
    const { app, track, via } = fixture();
    const before = app.pcbDocument.captureGeometry();
    let disposed = false;
    setPcbSelection(app, [{ kind: 'track', object: track }, { kind: 'via', object: via }]);
    setPropertyEditor(app, 'via', { active: false, dispose() { disposed = true; setPropertyEditor(app, 'via', null); } });
    const run = app.runAutoRoute(), worker = workers.at(-1);
    assert.equal(app.isSectionEditing(), true, 'Saving cannot capture temporary routing presentation');
    assert.deepEqual(app.pcbDocument.captureGeometry(), before, 'Routing never clears authored copper at startup');
    assert.equal(app.isSectionDirty(), false);
    if (stopped) {
        app._getAutorouter().stop();
        for (const poll of intervals.values()) poll();
        assert.equal(worker.jobs.at(-1).type, 'cancel', 'Stop requests a cooperative partial result');
    }
    worker.finish(routed);
    await run;
    assert.equal(worker.terminated, true);
    assert.equal(intervals.size, 0);
    assert.equal(app.isSectionEditing(), false);
    assert.equal(app.isSectionDirty(), true);
    assert.deepEqual(getPcbSelection(app), [], 'Removed copper is pruned from selection');
    assert.equal(disposed, true, 'Removed via Properties binding is retired');
    assert.equal(app.history.undoStack.length, 1);
    assert.equal(app.tracks[0].net, 'ROUTED');
    assert.equal(app.tracks[0].width, 0.23456789);
    const after = app.pcbDocument.captureGeometry();
    app.history.undo();
    assert.deepEqual(app.pcbDocument.captureGeometry(), before);
    assert.equal(app.tracks[0], track);
    assert.equal(app.vias[0], via);
    app.history.redo();
    assert.deepEqual(app.pcbDocument.captureGeometry(), after);
}

for (const operation of ['command', 'document', 'clear-document', 'deactivate', 'dispose', 'preview', 'drawing', 'rules', 'schematic']) {
    const { app, track } = fixture();
    const run = app.runAutoRoute(), worker = workers.at(-1);
    const manual = new Track({ net: 'MANUAL', points: [{ x: 20, y: 20 }, { x: 30, y: 20 }] });
    if (operation === 'command') app.history.execute(new AddTrackCommand(app, manual));
    if (operation === 'document') {
        app.pcbDocument = new PcbDocument();
        app.pcbDocument.tracks.push(manual);
    }
    if (operation === 'clear-document') app.loadFromData(null);
    if (operation === 'deactivate') app.deactivate();
    if (operation === 'dispose') app.dispose();
    if (operation === 'preview') setPropertyEditor(app, 'via', { active: true, cancel() {} });
    if (operation === 'drawing') setPcbInteraction(app, '_trackDraw', {});
    if (operation === 'rules') app.getRoutingParams = () => ({ trackWidth: 0.9, clearance: 0.1, viaDiameter: 0.6, viaDrill: 0.3 });
    if (operation === 'schematic') {
        app._active = false;
        app.onSchematicChanged();
    }
    const expected = app.pcbDocument.captureGeometry();
    worker.finish(routed);
    await run;
    assert.deepEqual(app.pcbDocument.captureGeometry(), expected, `${operation}: old results never overwrite newer state`);
    assert.equal(worker.terminated, true);
    assert.equal(app._getAutorouter().active, false);
    assert.equal(intervals.size, 0);
    if (operation === 'command') {
        assert.equal(app.history.undoStack.length, 1);
        app.history.undo();
        assert.deepEqual(app.tracks, [track], 'Manual edit still has normal undo after routing is cancelled');
    }
}

{
    const { app } = fixture();
    const first = app.runAutoRoute(), old = workers.at(-1);
    const lateMessage = old.listeners.get('message');
    const lateError = old.listeners.get('error');
    const second = app.runAutoRoute(), current = workers.at(-1);
    assert.notEqual(old, current);
    assert.equal(old.terminated, true);
    old.finish(routed);
    lateMessage({ data: { type: 'done', result: routed } });
    lateError({ error: new Error('Obsolete worker error') });
    await first;
    assert.notEqual(current.terminated, true, 'Old session cleanup cannot terminate its successor');
    current.finish(routed);
    await second;
    assert.equal(app.history.undoStack.length, 1);
}

{
    const { app, track } = fixture();
    let finishPresentation;
    app._getAutorouter().presentation.finishRipupPhases = () => new Promise(resolve => { finishPresentation = resolve; });
    const run = app.runAutoRoute();
    workers.at(-1).finish(routed);
    await Promise.resolve();
    const manual = new Track({ net: 'LATE', points: [{ x: 5, y: 6 }, { x: 7, y: 8 }] });
    app.history.execute(new AddTrackCommand(app, manual));
    finishPresentation();
    await run;
    assert.deepEqual(app.tracks, [track, manual], 'An edit during final progress presentation also invalidates adoption');
    assert.equal(app.history.undoStack.length, 1);
}

{
    const { app, track, via } = fixture();
    const run = app.runAutoRoute(), worker = workers.at(-1);
    app.clearRoutes();
    worker.finish(routed);
    await run;
    assert.equal(app.tracks.length, 0);
    assert.equal(app.vias.length, 0);
    assert.equal(app.history.undoStack.length, 1);
    app.history.undo();
    assert.deepEqual(app.tracks, [track]);
    assert.deepEqual(app.vias, [via]);
}

for (const mode of ['error', 'messageerror', 'post', 'constructor', 'capture', 'progress']) {
    const { app } = fixture(), before = app.pcbDocument.captureGeometry();
    const errors = [], originalError = console.error;
    console.error = (...args) => errors.push(args);
    try {
        if (mode === 'constructor') globalThis.Worker = class { constructor() { throw new Error('Constructor failed'); } };
        if (mode === 'post') globalThis.Worker = class extends FakeWorker { postMessage() { throw new Error('Post failed'); } };
        if (mode === 'capture') app._buildRouteInput = () => { throw new Error('Capture failed'); };
        const run = app.runAutoRoute();
        if (mode === 'error') workers.at(-1).emit({ type: 'error', error: 'Router failed' });
        if (mode === 'messageerror') workers.at(-1).listeners.get('messageerror')();
        if (mode === 'progress') {
            app._getAutorouter().presentation.showProgress = () => { throw new Error('Progress render failed'); };
            workers.at(-1).emit({ type: 'progress', done: 1, total: 3 });
        }
        await run;
        assert.deepEqual(app.pcbDocument.captureGeometry(), before);
        assert.equal(app.history.undoStack.length, 0);
        assert.equal(app.isSectionEditing(), false);
        assert.match(app.lastStatus, /Route error:/);
        assert.equal(errors.length, 1);
        assert.equal(intervals.size, 0);
    } finally { console.error = originalError; globalThis.Worker = FakeWorker; }
}
console.log('PASS autorouter ownership, dirty/readiness, partial-stop undo, lifecycle cancellation, supersession and failure preservation');
