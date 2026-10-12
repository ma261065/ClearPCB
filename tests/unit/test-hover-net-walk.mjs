import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';

globalThis.window = { addEventListener() {} };
installFakeDom();
const { collectHoveredNet } = await import('../../src/pcb/modules/copper-halos.js');

// The scanning walk collectHoveredNet replaced, kept verbatim as the reference: the
// indexed walk must find the same copper in the same order.
const posKey = (x, y) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
function referenceWalk(app, seed) {
    const tracks = new Set(), vias = new Set(), pads = new Set(), standalonePads = new Set(), shapes = new Set();
    const viaByPos = new Map();
    for (const via of app.vias || []) viaByPos.set(posKey(via.x, via.y), via);
    const netFor = (componentId, pinNumber) => {
        for (const entry of app.netlist || []) for (const pin of entry.pins || []) {
            if (String(pin.componentId) === String(componentId) && String(pin.pinNumber) === String(pinNumber)) return entry.net || '';
        }
        return '';
    };
    const netName = seed.type === 'track' ? seed.track.net || '' : seed.type === 'via' ? seed.via.net || ''
        : seed.type === 'standalone-pad' ? seed.pad.net || '' : seed.type === 'shape' ? seed.shape.net || ''
            : netFor(seed.componentId, seed.pinNumber);
    if (netName) {
        for (const track of app.tracks) if (track.net === netName) tracks.add(track);
        for (const via of app.vias) if (via.net === netName) vias.add(via);
        for (const pad of app.pads) if (pad.net === netName) standalonePads.add(pad);
        for (const shape of app.boardShapes) {
            if (shape.type === 'fill') continue;
            if (shape.net === netName && (shape.layer === 'top-copper' || shape.layer === 'bottom-copper')) shapes.add(shape);
        }
        const netEntry = app.netlist.find(entry => entry.net === netName);
        for (const pin of netEntry?.pins || []) pads.add(`${pin.componentId}|${pin.pinNumber}`);
    }
    const queue = [];
    if (seed.type === 'pad') { const key = `${seed.componentId}|${seed.pinNumber}`; pads.add(key); queue.push({ kind: 'pad', key }); }
    else if (seed.type === 'track') { tracks.add(seed.track); queue.push({ kind: 'track', track: seed.track }); }
    else if (seed.type === 'via') { vias.add(seed.via); queue.push({ kind: 'via', via: seed.via }); }
    else if (seed.type === 'shape') shapes.add(seed.shape);
    else standalonePads.add(seed.pad);
    for (const track of tracks) queue.push({ kind: 'track', track });
    for (const via of vias) queue.push({ kind: 'via', via });
    for (const key of pads) queue.push({ kind: 'pad', key });
    while (queue.length) {
        const item = queue.shift();
        if (item.kind === 'pad') {
            const [componentId, pinNumber] = item.key.split('|');
            for (const track of app.tracks) {
                if (tracks.has(track)) continue;
                for (const connection of track.padConnections.values()) {
                    if (String(connection.componentId) === componentId && String(connection.pinNumber) === pinNumber) {
                        tracks.add(track); queue.push({ kind: 'track', track }); break;
                    }
                }
            }
        } else if (item.kind === 'track') {
            for (const connection of item.track.padConnections.values()) {
                const key = `${connection.componentId}|${connection.pinNumber}`;
                if (!pads.has(key)) { pads.add(key); queue.push({ kind: 'pad', key }); }
            }
            for (const node of item.track.nodes.values()) {
                const key = posKey(node.x, node.y);
                const via = viaByPos.get(key);
                if (via && !vias.has(via)) { vias.add(via); queue.push({ kind: 'via', via }); }
                for (const other of app.tracks) {
                    if (other === item.track || tracks.has(other)) continue;
                    if ([...other.nodes.values()].some(n => posKey(n.x, n.y) === key)) { tracks.add(other); queue.push({ kind: 'track', track: other }); }
                }
            }
        } else {
            const key = posKey(item.via.x, item.via.y);
            for (const track of app.tracks) {
                if (tracks.has(track)) continue;
                if ([...track.nodes.values()].some(n => posKey(n.x, n.y) === key)) { tracks.add(track); queue.push({ kind: 'track', track }); }
            }
        }
    }
    return { tracks, vias, pads, standalonePads, shapes };
}

let seed = 7;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = list => list[Math.floor(random() * list.length)];
const grid = () => ({ x: Math.floor(random() * 12) * 1.27, y: Math.floor(random() * 12) * -1.27 });

function board() {
    const nets = ['', '', 'GND', 'VCC', 'SIG'];
    const pins = Array.from({ length: 10 }, (_, index) => ({ componentId: `U${index % 4}`, pinNumber: String(index % 3 + 1) }));
    const tracks = Array.from({ length: 70 }, (_, index) => {
        const nodes = new Map(Array.from({ length: 2 + Math.floor(random() * 3) }, (_, n) => [`n${n}`, grid()]));
        const padConnections = new Map(random() < 0.3 ? [['n0', pick(pins)]] : []);
        return { id: `t${index}`, net: pick(nets), nodes, padConnections };
    });
    const vias = Array.from({ length: 15 }, (_, index) => ({ id: `v${index}`, ...grid(), net: pick(nets) }));
    const pads = Array.from({ length: 6 }, (_, index) => ({ id: `p${index}`, net: pick(nets) }));
    const boardShapes = [
        { id: 's0', net: 'GND', layer: 'top-copper', copperMode: 'add' },
        { id: 's1', net: 'VCC', layer: 'top-silk', copperMode: 'add' },
        { id: 'f0', type: 'fill', net: 'GND', layer: 'top-copper' },
    ];
    const netlist = [{ net: 'GND', pins: pins.slice(0, 3) }, { net: 'SIG', pins: pins.slice(5, 7) }];
    return { tracks, vias, pads, boardShapes, netlist };
}

const ids = set => [...set].map(item => (typeof item === 'string' ? item : item.id));
let compared = 0;
for (let round = 0; round < 40; round++) {
    const app = board();
    const seeds = [
        ...app.tracks.slice(0, 12).map(track => ({ type: 'track', track })),
        ...app.vias.slice(0, 5).map(via => ({ type: 'via', via })),
        ...app.pads.slice(0, 3).map(pad => ({ type: 'standalone-pad', pad })),
        { type: 'shape', shape: app.boardShapes[0] },
        { type: 'pad', componentId: 'U1', pinNumber: '2' }, { type: 'pad', componentId: 'U0', pinNumber: '1' },
    ];
    for (const start of seeds) {
        const expected = referenceWalk(app, start), actual = collectHoveredNet(app, start);
        for (const field of ['tracks', 'vias', 'pads', 'standalonePads', 'shapes']) {
            assert.deepEqual(ids(actual[field]), ids(expected[field]), `round ${round}, ${start.type} seed: ${field} match in order`);
        }
        compared++;
    }
}
assert.ok(compared > 800);
console.log(`PASS the indexed hover walk finds the same copper in the same order as the scan (${compared} seeds)`);
