import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { routeAll } from '../src/pcb/modules/autorouter-maze.js';
import { routeAllPathfinder } from '../src/pcb/modules/autorouter-pathfinder.js';
import { tracksFromAutorouterResult } from '../src/pcb/modules/autorouter-adapter.js';
import { exportDSN, importDSN, importSES } from '../src/pcb/modules/dsn.js';
import { AutorouterPresentation } from '../src/pcb/modules/autorouter-presentation.js';

// Direct calls use the non-yielding DOM path; real workers exercise MessageChannel scheduling.
globalThis.document = { visibilityState: 'hidden' };

const input = {
    trackWidth: 0.23456789, clearance: 0.1, viaDiameter: 0.4, gridStep: 0.5,
    bounds: { minX: 0, minY: 0, maxX: 12, maxY: 12 },
    connections: [{ net: 'N1', pads: [
        { x: 2, y: 2, width: 1, height: 1, layer: 'top' },
        { x: 10, y: 10, width: 1, height: 1, layer: 'bottom' },
    ] }],
};

async function runWorker(routerMode, routeInput) {
    const url = new URL('../src/pcb/modules/autorouter-worker.js', import.meta.url).href;
    const worker = new Worker(`
        const { parentPort } = require('node:worker_threads');
        let receive;
        globalThis.self = {
            addEventListener(name, callback) { receive = callback; },
            postMessage(data) { parentPort.postMessage(data); },
        };
        const ready = import(${JSON.stringify(url)});
        parentPort.on('message', async data => { await ready; await receive({ data }); });
    `, { eval: true });
    const messages = [];
    try {
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Routing worker timed out')), 30000);
            worker.on('error', error => { clearTimeout(timer); reject(error); });
            worker.on('message', message => {
                messages.push(message);
                if (message.type === 'done' || message.type === 'error') {
                    clearTimeout(timer);
                    resolve({ message, messages });
                }
            });
            worker.postMessage({ type: 'start', routerMode, routeInput });
        });
    } finally {
        await worker.terminate();
    }
}

for (const [mode, router] of [['maze', routeAll], ['pathfinder', routeAllPathfinder]]) {
    const before = structuredClone(input);
    const directProgress = [];
    const direct = await router(structuredClone(input), {
        onNetRouted: tracks => directProgress.push(structuredClone(tracks)),
    });
    assert.ok(direct.tracks.length > 0);
    assert.equal(Object.hasOwn(direct, 'traces'), false);
    assert.equal(direct.failedConnectionCount, 0);
    const { message, messages } = await runWorker(mode, input);
    assert.equal(message.type, 'done');
    assert.deepEqual(message.result, direct, 'Worker and direct calculation expose identical full results');
    const progress = messages.filter(message => message.type === 'netRouted');
    assert.ok(progress.length > 0);
    assert.deepEqual(progress.map(message => message.netTracks), directProgress);
    assert.ok(progress.every(message => !Object.hasOwn(message, 'netTraces')));
    const model = tracksFromAutorouterResult(message.result, {
        trackWidth: input.trackWidth, viaDiameter: input.viaDiameter, viaDrill: 0.2,
    });
    assert.equal(model.tracks.length, direct.tracks.length);
    assert.ok(model.tracks.every(track => track.width === input.trackWidth));
    assert.ok(model.tracks.some(track => track.layer === 'bottom-copper'));
    assert.deepEqual(input, before);
    const invalid = { ...input, trackWidth: undefined, traceWidth: 0.2 };
    const failed = await runWorker(mode, invalid);
    assert.equal(failed.message.type, 'error');
    assert.match(failed.message.error, /trackWidth/);
}

const placements = new Map([
    ['part1', { x: 2, y: 3, reference: 'U1', padOffsets: [{ number: '1', dx: 0, dy: 0, width: 1, height: 1 }] }],
    ['part2', { x: 8, y: 9, reference: 'U2', padOffsets: [{ number: '1', dx: 0, dy: 0, width: 1, height: 1 }] }],
]);
const dsn = exportDSN({
    placements, netlist: [{ net: 'N1', pins: [{ componentId: 'part1', pinNumber: '1' },
        { componentId: 'part2', pinNumber: '1' }] }],
    trackWidth: 0.234, clearance: 0.1, viaDiameter: 0.4, bounds: input.bounds,
});
assert.match(dsn, /\(width 234\)/);
assert.match(dsn, /\(path signal /, 'External DSN grammar must not be renamed');
const imported = importDSN(dsn).routeInput;
assert.equal(imported.trackWidth, 0.234);
assert.equal(Object.hasOwn(imported, 'traceWidth'), false);
assert.equal(imported.connections.length, 1);
const ses = importSES(`(session fixture (routes (resolution mm 1000)
    (network_out (net N1 (wire (path top 200 2000 3000 8000 3000))))))`);
assert.deepEqual(ses.tracks, [{ net: 'N1', layer: 'top', points: [{ x: 2, y: -3 }, { x: 8, y: -3 }] }]);
assert.equal(Object.hasOwn(ses, 'traces'), false);
assert.equal(tracksFromAutorouterResult(ses, { trackWidth: 0.234 }).tracks[0].width, 0.234);

globalThis.window = { addEventListener() {} };
const nodes = [];
globalThis.document = { createElementNS(_ns, tag) {
    const node = { tag, dataset: {}, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; },
        remove() { nodes.splice(nodes.indexOf(this), 1); } };
    return node;
} };
const presentation = new AutorouterPresentation({
    getProgressHost: () => null,
    getRoutingParams: () => ({ trackWidth: 0.234, viaDiameter: 0.4, viaDrill: 0.2 }),
    getLayerGroup: () => ({ appendChild(node) { nodes.push(node); } }),
    refreshClearanceHalos() {},
    getSvg: () => ({ querySelectorAll(selector) {
        assert.equal(selector, '.pcb-route-anim');
        return nodes.filter(node => node.attributes.class.split(' ').includes('pcb-route-anim'));
    } }),
}, () => {});
presentation.renderNetTracks(ses.tracks);
assert.equal(nodes[0].attributes.class, 'pcb-routed-track pcb-route-anim');
assert.equal(nodes[0].attributes['stroke-width'], '0.234');
assert.equal(nodes[0].attributes.points, '2,-3 8,-3');
presentation.clearIncrementalTracks();
assert.equal(nodes.length, 0);
console.log('PASS track contracts across both routers, real workers, model adapter, DSN/SES and incremental rendering');
