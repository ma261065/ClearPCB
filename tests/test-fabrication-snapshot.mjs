import assert from 'node:assert/strict';
import { getComputedFill } from '../src/pcb/modules/computed-fill-cache.js';
import { Worker as NodeWorker } from 'node:worker_threads';
import { inflateRawSync } from 'node:zlib';
import { unzipSync, strFromU8 } from '../assets/vendor/fflate.module.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { Track } from '../src/shapes/track.js';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { createPcbText, serializePcbText, TEXT_LAYERS } from '../src/core/pcb-text.js';
globalThis.window = { addEventListener() {} };
const { exportGerbers, buildZip } = await import('../src/pcb/modules/gerber.js');
const { prepareFabricationSnapshot, prepareSnapshotFills, hasFabricationContent } = await import('../src/pcb/modules/fabrication-snapshot.js');
const { setDragOverlaysDeferred, setFillRefreshScheduled, setFillRefreshSuspended } = await import('../src/pcb/modules/refresh-state.js');
const { generateGerberArchive } = await import('../src/pcb/modules/gerber-export.js');
const outline = [{ x: 1, y: -1 }, { x: 19, y: -1 }, { x: 19, y: -19 }, { x: 1, y: -19 }];
const fill = new CopperFill({ net: 'GND', outline });
const app = { placements: new Map(), tracks: [], vias: [], texts: new Map(), netlist: [],
    boardShapes: [fill], copperFills: [fill], _boardWidth: 20, _boardHeight: 20, _boardRadius: 0,
    getRoutingParams: () => ({ clearance: 0.2 }) };
setFillRefreshScheduled(app, true);
assert.equal(hasFabricationContent(app), true);
const pending = prepareFabricationSnapshot(app);
fill.outline[0].x = 5;
const snapshot = await pending;
assert.equal(snapshot.fills[0].outline[0].x, 1, 'Snapshot captured before asynchronous loading');
assert.ok(snapshot.fills[0]._computed.length > 0, 'Uncomputed pours are prepared for export');
assert.equal(getComputedFill(fill), null, 'Export does not mutate the preview cache');
assert.equal('_computed' in fill, false, 'Live authored fills do not own export or preview results');
assert.equal(snapshot.boardShapes.length, 0);
const deferred = await prepareFabricationSnapshot(app, { computeFills: false });
assert.equal(deferred.fills[0]._computed, null, 'Worker snapshots defer expensive pour calculations');
const fillProgress = [];
await prepareSnapshotFills(deferred, (done, total) => fillProgress.push([done, total]));
assert.ok(deferred.fills[0]._computed.length > 0);
assert.deepEqual(fillProgress, [[0, 1], [1, 1]]);
const suspensionSetters = { _deferDragOverlays: setDragOverlaysDeferred, _suspendFillRefresh: setFillRefreshSuspended };
for (const state of ['_deferDragOverlays', '_suspendFillRefresh', '_rotationHandleDrag', '_shapeDrag',
    '_vertexDrag', '_viaDrag', '_textEdit', '_boardOutlineResize']) {
    const target = suspensionSetters[state] ? { ...app } : { ...app, [state]: {} };
    suspensionSetters[state]?.(target, true);
    await assert.rejects(prepareFabricationSnapshot(target),
        /Finish the current edit before exporting/, `${state} must not leak preview state into manufacturing output`);
}
assert.equal(hasFabricationContent({ placements: new Map(), tracks: [], vias: [], texts: new Map(),
    boardShapes: [{ kind: 'image', layer: 'top-silk' }] }), true);
const track = new Track({ points: [{ x: 2, y: -2 }, { x: 18, y: -2 }], width: 0.6 });
const connectedNode = [...track.nodes.keys()][0];
track.padConnections.set(connectedNode, { componentId: 'pad', pinNumber: '1' });
app.tracks.push(track);
app.placements.set('pad', { x: 5, y: -5, padOffsets: [{ dx: 0, dy: 0, width: 2, height: 1, layer: 'top' }],
    element: { uncloneable() {} }, model3d: { uncloneable() {} } });
app.vias.push({ id: 'via', x: 10, y: -10, diameter: 1, drill: 0.3, net: '' });
app.boardShapes.push({ id: 'image', kind: 'image', layer: 'top-copper', filled: true,
    points: [{ x: 6, y: -6 }, { x: 7, y: -6 }, { x: 7, y: -7 }, { x: 6, y: -7 }],
    artwork: { width: 1, height: 1, rectangles: [{ x: 0, y: 0, width: 1, height: 1 }] } });
const pendingGeometry = prepareFabricationSnapshot(app);
track.padConnections.get(connectedNode).componentId = 'changed-after-capture';
track.width = 2;
app.placements.get('pad').padOffsets[0].width = 5;
app.vias[0].diameter = 3;
app.boardShapes[1].points[0].x = 15;
const geometry = await pendingGeometry;
assert.deepEqual(geometry.tracks[0].padConnections.get(connectedNode), { componentId: 'pad', pinNumber: '1' },
    'Connection records are detached before asynchronous fill preparation');
geometry.tracks[0].padConnections.get(connectedNode).pinNumber = '2';
assert.equal(track.padConnections.get(connectedNode).pinNumber, '1', 'Snapshot edits cannot change live connections');
assert.equal(geometry.tracks[0].getEdgeWidth([...track.edges.keys()][0]), 0.6);
assert.equal(geometry.placements.get('pad').padOffsets[0].width, 2);
assert.equal(geometry.vias[0].diameter, 1);
assert.equal(geometry.boardShapes[0].points[0].x, 6);
assert.equal(geometry.placements.get('pad').element, undefined);
assert.ok(exportGerbers(geometry).get('board.gtl').includes('G36*'));
const zipFiles = new Map([...exportGerbers(geometry),
    ['repeated.gbr', 'X1000000Y2000000D01*\n'.repeat(10000)], ['empty.txt', '']]);
const zipBlob = buildZip(zipFiles);
assert.equal(zipBlob.type, 'application/zip');
const zipBytes = new Uint8Array(await zipBlob.arrayBuffer());
const zipView = new DataView(zipBytes.buffer);
const extracted = unzipSync(zipBytes);
assert.deepEqual(Object.keys(extracted), [...zipFiles.keys()]);
let zipOffset = 0;
for (const [name, content] of zipFiles) {
    assert.equal(strFromU8(extracted[name]), content, 'ZIP extraction preserves file contents');
    assert.equal(zipView.getUint32(zipOffset, true), 0x04034b50);
    assert.equal(zipView.getUint16(zipOffset + 8, true), 8, 'ZIP entries use DEFLATE');
    const compressedSize = zipView.getUint32(zipOffset + 18, true);
    assert.equal(zipView.getUint32(zipOffset + 22, true), Buffer.byteLength(content));
    const dataOffset = zipOffset + 30 + zipView.getUint16(zipOffset + 26, true)
        + zipView.getUint16(zipOffset + 28, true);
    assert.equal(inflateRawSync(zipBytes.subarray(dataOffset, dataOffset + compressedSize)).toString('utf8'), content,
        'Independent zlib decoder accepts the raw DEFLATE payload');
    zipOffset = dataOffset + compressedSize;
}
assert.equal(zipView.getUint32(zipOffset, true), 0x02014b50, 'Central directory follows compressed payloads');
assert.ok(zipBytes.length < [...zipFiles.values()].reduce((total, content) => total + Buffer.byteLength(content), 0) / 2,
    'Repetitive Gerber text compresses substantially');
assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await buildZip(new Map()).arrayBuffer()))), []);
const priorGetEdgeWidth = track.getEdgeWidth;
track.getEdgeWidth = () => { throw new Error('Invalid track'); };
await assert.rejects(prepareFabricationSnapshot(app), /Invalid track/);
track.getEdgeWidth = priorGetEdgeWidth;

const priorWorker = globalThis.Worker;
for (const layer of TEXT_LAYERS) for (const border of [false, true]) {
    const text = createPcbText({ id: 'snapshot-label', content: 'R1', x: Math.PI, y: -Math.E,
        size: 1.23456789, rotation: 37.12345678, strokeWidth: 0.12345678, layer, border });
    const authored = serializePcbText(text);
    const textApp = { placements: new Map(), tracks: [], vias: [], pads: [], texts: new Map([[text.id, text]]),
        boardShapes: [], copperFills: [], _boardWidth: 20, _boardHeight: 20, _boardRadius: 0,
        getRoutingParams: () => ({ clearance: 0.2 }) };
    const clean = await prepareFabricationSnapshot(textApp, { computeFills: false });
    const expectedGerbers = exportGerbers(clean);
    text.element = { uncloneable() {} };
    text.selected = true;
    text.viewState = { cachedBounds: { minX: 999 } };
    const pendingText = prepareFabricationSnapshot(textApp, { computeFills: false });
    text.content = 'changed-after-capture';
    text.x = 100;
    text.rotation = 90;
    const captured = await pendingText;
    assert.deepEqual(captured.texts, [authored], 'Fabrication uses the full-precision authored text snapshot');
    assert.deepEqual(structuredClone(captured.texts), [authored], 'No editor state enters the worker payload');
    assert.deepEqual(exportGerbers(captured), expectedGerbers,
        'Authored-only text capture preserves Gerber output on every text layer and border mode');
    captured.texts[0].content = 'snapshot-only';
    captured.texts[0].x = 200;
    assert.equal(text.content, 'changed-after-capture');
    assert.equal(text.x, 100);
    assert.equal(typeof text.element.uncloneable, 'function', 'Capture leaves view-owned metadata alone');
    assert.equal(text.viewState.cachedBounds.minX, 999);
    Object.defineProperty(text, 'content', { get() { throw new Error('Invalid authored text'); } });
    await assert.rejects(prepareFabricationSnapshot(textApp), /Invalid authored text/,
        'Authored-field errors must still reach the export caller');
}
const workerProgress = [];
let workerFailure = false;
let workerTerminated = false;
globalThis.Worker = class {
    constructor(url, options) {
        assert.ok(url.pathname.endsWith('/gerber-worker.js'));
        assert.equal(options.type, 'module');
    }
    postMessage(data) {
        const detached = structuredClone(data);
        assert.equal(detached.tracks[0].getEdgeWidth, undefined, 'Worker payload contains no methods');
        assert.equal(detached.fills[0]._computed, null);
        this.onmessage({ data: { type: 'progress', label: 'board.gtl', value: 25 } });
        this.onmessage({ data: workerFailure ? { type: 'error', message: 'Generation failed' }
            : { type: 'complete', blob: new Blob(['zip']), fileCount: 10 } });
    }
    terminate() { workerTerminated = true; }
};
try {
    for (const state of ['_textEdit', '_boardOutlineResize']) {
        await assert.rejects(generateGerberArchive({ ...app, [state]: {} }, () => {}),
            /Finish the current edit before exporting/, 'Worker exports enforce the same edit guard');
    }
    const archive = await generateGerberArchive(app, (...progress) => workerProgress.push(progress));
    assert.equal(archive.fileCount, 10);
    assert.ok(archive.blob instanceof Blob);
    assert.ok(workerProgress.some(([label, value]) => label === 'board.gtl' && value === 25));
    assert.equal(workerTerminated, true, 'Completed worker is released');
    workerFailure = true;
    workerTerminated = false;
    await assert.rejects(generateGerberArchive(app, () => {}), /Generation failed/);
    assert.equal(workerTerminated, true, 'Failed worker is released');
} finally {
    globalThis.Worker = priorWorker;
}

const workerInput = { ...geometry,
    tracks: geometry.tracks.map(({ getEdgeWidth, getEdgeLayer, ...data }) => data) };
const actualWorker = new NodeWorker(`
    const { parentPort, workerData } = require('node:worker_threads');
    globalThis.postMessage = message => parentPort.postMessage(message);
    import(workerData.url).then(() => globalThis.onmessage({ data: workerData.snapshot }));
`, { eval: true, workerData: {
    url: new URL('../src/pcb/modules/gerber-worker.js', import.meta.url).href, snapshot: workerInput,
} });
const actualProgress = [];
try {
    const generated = await new Promise((resolve, reject) => {
        actualWorker.on('error', reject);
        actualWorker.on('exit', code => reject(new Error(`Worker exited without an archive (${code})`)));
        actualWorker.on('message', message => {
            if (message.type === 'progress') actualProgress.push(message);
            else if (message.type === 'error') reject(new Error(message.message));
            else if (message.type === 'complete') resolve(message);
        });
    });
    assert.ok(generated.blob instanceof Blob);
    assert.ok(generated.blob.size > 0);
    assert.equal(generated.fileCount, exportGerbers(geometry).size);
    assert.ok(actualProgress.some(message => message.label === 'board.gtl'));
    assert.equal(actualProgress.at(-1).label, 'Packaging ZIP');
} finally {
    await actualWorker.terminate();
}

const { default: PCBApp } = await import('../src/ui/PCBApp.js');
for (const name of ['app', 'bootstrap']) Object.defineProperty(window, name, {
    get() { assert.fail('Export naming must not consult global project owners'); },
});
const ownedProject = { fileManager: { fileName: 'owned.rev2.cpcb' } };
assert.equal(PCBApp.prototype._exportBaseName.call({ project: ownedProject }), 'owned.rev2');
assert.equal(PCBApp.prototype._exportBaseName.call({}), 'untitled');
const { projectBaseName } = await import('../src/pcb/modules/pcb-export.js');
for (const [fileName, expected] of [['owned.rev2.cpcb', 'owned.rev2'], ['board', 'board']]) {
    assert.equal(projectBaseName({ project: { fileManager: { fileName } } }), expected);
}
assert.equal(projectBaseName({}), 'pcb', 'PDF keeps its existing unnamed-project fallback');
assert.equal(projectBaseName({ project: { fileManager: { fileName: '.cpcb' } } }), 'pcb');
assert.equal(PCBApp.prototype._exportBaseName.call({
    project: { fileManager: { fileName: '.cpcb' } },
}), 'untitled');

const csvNames = [];
const csvApp = {
    project: ownedProject, _exportBaseName: PCBApp.prototype._exportBaseName,
    placements: new Map([['U1', { reference: 'U1', value: 'Part', footprint: 'Package' }]]),
    async _saveBlob(blob, name) { assert.ok(blob instanceof Blob); csvNames.push(name); return true; },
    setStatus() {},
};
PCBApp.prototype.exportBOM.call(csvApp);
PCBApp.prototype.exportPickAndPlace.call(csvApp);
await Promise.resolve();
assert.deepEqual(csvNames, ['owned.rev2-bom.csv', 'owned.rev2-pick-and-place.csv']);

// The real export methods, observed through browser APIs the test supplies: the save
// picker on `window`, the Gerber progress element, and the worker that builds the ZIP.
const events = [];
let finishWrite;
const writing = new Promise(resolve => { finishWrite = resolve; });
const progressLabels = [];
const progressHost = {
    hidden: true, title: '',
    label: { textContent: '' },
    bar: { current: null, get value() { return this.current; },
        set value(next) { this.current = next; recordProgress(); }, removeAttribute() { this.current = null; recordProgress(); } },
    querySelector(selector) { return selector === 'progress' ? this.bar : this.label; },
};
globalThis.document = { getElementById: id => id === 'pcbGerberProgress' ? progressHost : null };
const recordProgress = () => progressLabels.push(progressHost.hidden ? null : [progressHost.label.textContent, progressHost.bar.value]);
const workerSnapshots = [];
globalThis.Worker = class {
    postMessage(snapshot) {
        events.push('prepare');
        workerSnapshots.push(snapshot);
        setTimeout(() => this.onmessage({ data: { type: 'complete', blob: new Blob(['zip']), fileCount: 1 } }), 0);
    }
    terminate() {}
};
window.showSaveFilePicker = options => {
    events.push('picker');
    assert.equal(options.suggestedName, 'owned.rev2-gerber.zip');
    return Promise.resolve({
        async createWritable() {
            events.push('createWritable');
            return {
                async write(blob) {
                    assert.ok(blob instanceof Blob);
                    events.push('write');
                    await writing;
                },
                async close() { events.push('close'); },
            };
        },
    });
};
const exportPcbDocument = new PcbDocument();
exportPcbDocument.tracks.push(new Track({ net: 'N', layer: 'top-copper', width: 0.25,
    points: [{ x: 2, y: -2 }, { x: 8, y: -2 }] }));
const exportApp = Object.assign(Object.create(PCBApp.prototype), {
    pcbDocument: exportPcbDocument, placements: new Map(), project: ownedProject,
    setStatus(message) { events.push(message); },
});
const saving = exportApp.exportGerber();
assert.deepEqual(events, ['picker'], 'Picker opens synchronously before fabrication preparation');
assert.equal(exportApp._exportGerberPending, true);
await exportApp.exportGerber();
assert.equal(events.filter(event => event === 'picker').length, 1, 'Duplicate export is blocked');
finishWrite();
await saving;
assert.deepEqual(events, ['picker', 'prepare', 'createWritable', 'write', 'close', 'Gerbers exported (1 files)']);
assert.equal(exportApp._exportGerberPending, false);
assert.equal(workerSnapshots.length, 1, 'One fabrication snapshot is sent to the worker');
assert.equal(workerSnapshots[0].tracks.length, 1, 'The snapshot carries the board copper');
assert.equal(typeof workerSnapshots[0].tracks[0].getEdgeWidth, 'undefined', 'Snapshot tracks are plain data');
assert.deepEqual(progressLabels.filter(Boolean).map(([label]) => label),
    ['Gerber: Capturing board', 'Gerber: Starting export', 'Gerber: Saving ZIP'],
    'Progress shows capture, export and saving');
assert.equal(progressHost.bar.value, null);
assert.equal(progressHost.hidden, true, 'Progress clears after saving');

events.length = 0;
progressLabels.length = 0;
window.showSaveFilePicker = async () => {
    events.push('cancel');
    throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
};
await exportApp.exportGerber();
assert.deepEqual(events, ['cancel'], 'Cancelling does not prepare or save fabrication data');
assert.equal(exportApp._exportGerberPending, false);
assert.equal(workerSnapshots.length, 1, 'Cancelling sends nothing to the worker');
assert.equal(progressHost.hidden, true, 'Cancellation leaves no progress indicator');
assert.ok(progressLabels.every(entry => entry === null), 'Cancellation never shows progress');

window.showSaveFilePicker = async () => {
    throw new Error('Picker failed');
};
await assert.rejects(exportApp._saveBlob(async () => new Blob(), 'board.zip'), /Picker failed/);
delete window.showSaveFilePicker;

const downloadEvents = [];
const downloadWindow = { document: {
    body: { appendChild() { downloadEvents.push('append'); } },
    createElement() {
        return { click() { downloadEvents.push('download'); }, remove() { downloadEvents.push('remove'); } };
    },
} };
assert.equal(await exportApp._saveBlob(async () => {
    downloadEvents.push('prepare');
    return new Blob(['zip']);
}, 'board.zip', { win: downloadWindow }), true);
assert.deepEqual(downloadEvents, ['prepare', 'append', 'download', 'remove']);
assert.equal(await exportApp._saveBlob(new Blob(['existing caller']), 'board.zip', { win: downloadWindow }), true);
console.log('PASS fresh detached fabrication snapshot, asynchronous isolation and artwork-only export');
