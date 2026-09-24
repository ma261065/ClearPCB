import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Worker as NodeWorker } from 'node:worker_threads';
import { inflateRawSync } from 'node:zlib';
import { unzipSync, strFromU8 } from '../assets/vendor/fflate.module.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { Track } from '../src/shapes/track.js';
globalThis.window = { addEventListener() {} };
const { exportGerbers, buildZip } = await import('../src/pcb/modules/gerber.js');
const { prepareFabricationSnapshot, prepareSnapshotFills, hasFabricationContent } = await import('../src/pcb/modules/fabrication-snapshot.js');
const { generateGerberArchive } = await import('../src/pcb/modules/gerber-export.js');
const outline = [{ x: 1, y: -1 }, { x: 19, y: -1 }, { x: 19, y: -19 }, { x: 1, y: -19 }];
const fill = new CopperFill({ net: 'GND', outline });
const app = { placements: new Map(), tracks: [], vias: [], texts: new Map(), netlist: [],
    boardShapes: [fill], copperFills: [fill], _boardWidth: 20, _boardHeight: 20, _boardRadius: 0,
    _getRoutingParams: () => ({ clearance: 0.2 }), _fillRefreshScheduled: true };
assert.equal(hasFabricationContent(app), true);
const pending = prepareFabricationSnapshot(app);
fill.outline[0].x = 5;
const snapshot = await pending;
assert.equal(snapshot.fills[0].outline[0].x, 1, 'Snapshot captured before asynchronous loading');
assert.ok(snapshot.fills[0]._computed.length > 0, 'Uncomputed pours are prepared for export');
assert.equal(fill._computed, null, 'Export does not mutate the preview cache');
assert.equal(snapshot.boardShapes.length, 0);
const deferred = await prepareFabricationSnapshot(app, { computeFills: false });
assert.equal(deferred.fills[0]._computed, null, 'Worker snapshots defer expensive pour calculations');
const fillProgress = [];
await prepareSnapshotFills(deferred, (done, total) => fillProgress.push([done, total]));
assert.ok(deferred.fills[0]._computed.length > 0);
assert.deepEqual(fillProgress, [[0, 1], [1, 1]]);
await assert.rejects(prepareFabricationSnapshot({ ...app, _deferDragOverlays: true }), /Finish/);
assert.equal(hasFabricationContent({ placements: new Map(), tracks: [], vias: [], texts: new Map(),
    boardShapes: [{ kind: 'image', layer: 'top-silk' }] }), true);
const track = new Track({ points: [{ x: 2, y: -2 }, { x: 18, y: -2 }], width: 0.6 });
app.tracks.push(track);
app.placements.set('pad', { x: 5, y: -5, padOffsets: [{ dx: 0, dy: 0, width: 2, height: 1, layer: 'top' }],
    element: { uncloneable() {} }, model3d: { uncloneable() {} } });
app.vias.push({ id: 'via', x: 10, y: -10, diameter: 1, drill: 0.3, net: '' });
app.boardShapes.push({ id: 'image', kind: 'image', layer: 'top-copper', filled: true,
    points: [{ x: 6, y: -6 }, { x: 7, y: -6 }, { x: 7, y: -7 }, { x: 6, y: -7 }],
    artwork: { width: 1, height: 1, rectangles: [{ x: 0, y: 0, width: 1, height: 1 }] } });
const pendingGeometry = prepareFabricationSnapshot(app);
track.width = 2;
app.placements.get('pad').padOffsets[0].width = 5;
app.vias[0].diameter = 3;
app.boardShapes[1].points[0].x = 15;
const geometry = await pendingGeometry;
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

const pcbSource = fs.readFileSync(new URL('../src/ui/PCBApp.js', import.meta.url), 'utf8');
const methodSource = name => {
    const start = pcbSource.indexOf(`    async ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const end = pcbSource.indexOf('\n    }', start);
    return pcbSource.slice(start, end + 6).trim();
};
const events = [];
let finishWrite;
const writing = new Promise(resolve => { finishWrite = resolve; });
const saveWindow = {
    showSaveFilePicker(options) {
        events.push('picker');
        assert.equal(options.suggestedName, 'untitled-gerber.zip');
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
    },
};
const saveBlob = new Function('window', 'document',
    `return ({ ${methodSource('_saveBlob')} })._saveBlob;`)(saveWindow, {});
const progressEvents = [];
const exportGerber = new Function('window', 'hasFabricationContent', 'generateGerberArchive',
    'showGerberProgress', `return ({ ${methodSource('exportGerber')} }).exportGerber;`)(
    saveWindow, () => true,
    async () => { events.push('prepare'); return { blob: new Blob(['zip']), fileCount: 1 }; },
    (...progress) => progressEvents.push(progress),
);
const exportApp = { _saveBlob: saveBlob, _setStatus(message) { events.push(message); } };
const saving = exportGerber.call(exportApp);
assert.deepEqual(events, ['picker'], 'Picker opens synchronously before fabrication preparation');
assert.equal(exportApp._exportGerberPending, true);
await exportGerber.call(exportApp);
assert.equal(events.filter(event => event === 'picker').length, 1, 'Duplicate export is blocked');
finishWrite();
await saving;
assert.deepEqual(events, ['picker', 'prepare', 'createWritable', 'write', 'close', 'Gerbers exported (1 files)']);
assert.equal(exportApp._exportGerberPending, false);
assert.deepEqual(progressEvents, [['Saving ZIP', 100], [null]], 'Progress remains through saving, then clears');

events.length = 0;
progressEvents.length = 0;
saveWindow.showSaveFilePicker = async () => {
    events.push('cancel');
    throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
};
await exportGerber.call(exportApp);
assert.deepEqual(events, ['cancel'], 'Cancelling does not prepare or save fabrication data');
assert.equal(exportApp._exportGerberPending, false);
assert.deepEqual(progressEvents, [[null]], 'Cancellation leaves no progress indicator');

saveWindow.showSaveFilePicker = async () => {
    throw new Error('Picker failed');
};
await assert.rejects(saveBlob.call(exportApp, async () => new Blob(), 'board.zip'), /Picker failed/);

const downloadEvents = [];
const downloadDocument = {
    body: { appendChild() { downloadEvents.push('append'); } },
    createElement() {
        return { click() { downloadEvents.push('download'); }, remove() { downloadEvents.push('remove'); } };
    },
};
const fallbackSave = new Function('window', 'document',
    `return ({ ${methodSource('_saveBlob')} })._saveBlob;`)({}, downloadDocument);
assert.equal(await fallbackSave(async () => {
    downloadEvents.push('prepare');
    return new Blob(['zip']);
}, 'board.zip'), true);
assert.deepEqual(downloadEvents, ['prepare', 'append', 'download', 'remove']);
assert.equal(await fallbackSave(new Blob(['existing caller']), 'board.zip'), true);
console.log('PASS fresh detached fabrication snapshot, asynchronous isolation and artwork-only export');