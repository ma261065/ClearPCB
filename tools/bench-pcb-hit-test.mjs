#!/usr/bin/env node
// Measures PCB selection queries on a large synthetic board: syncing the selection
// registry with the model, and a full pointer hit query (sync + hit test), which
// hover and every click run.
//
// Usage: node tools/bench-pcb-hit-test.mjs [scale]   (scale multiplies the entity counts)
// Compare medians before and after selection or geometry changes on the same machine.

import { PcbDocument } from '../src/core/PcbDocument.js';

const noop = () => {};
const element = () => ({
    style: {}, dataset: {}, children: [], classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop, appendChild: child => child,
    insertBefore: child => child, remove: noop, addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [],
});
globalThis.window = { addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1 };
globalThis.document = {
    body: element(), documentElement: { getAttribute: () => 'dark' }, createElement: element, createElementNS: element,
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: noop,
};
globalThis.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };

await import('../src/ui/PCBApp.js');
const { syncPcbSelection, hitTestPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const { Track } = await import('../src/shapes/track.js');
const { Via } = await import('../src/shapes/via.js');
const { Pad } = await import('../src/shapes/pad.js');
const { CopperFill } = await import('../src/shapes/copper-fill.js');

const scale = Number(process.argv[2]) || 1;
const pcbDocument = new PcbDocument();
const grid = Math.ceil(Math.sqrt(200 * scale));
for (let index = 0; index < 600 * scale; index++) {
    const x = (index % grid) * 6, y = Math.floor(index / grid) * 6;
    pcbDocument.tracks.push(new Track({ net: `N${index % 50}`, layer: 'top-copper', width: 0.25,
        cornerRadius: index % 3 === 0 ? 1 : 0, edgeBulges: index % 7 === 0 ? { e1: 0.4 } : undefined,
        points: [{ x, y }, { x: x + 3, y }, { x: x + 3, y: y + 3 }, { x: x + 5, y: y + 4 }] }));
}
for (let index = 0; index < 200 * scale; index++) {
    const x = (index % grid) * 6 + 1, y = Math.floor(index / grid) * 6 + 5;
    pcbDocument.vias.push(new Via({ x, y, diameter: 0.6, drill: 0.3 }));
    pcbDocument.pads.push(new Pad({ x: x + 2, y, shape: index % 2 ? 'stadium' : 'round', size: 1.2, rotation: index % 90 }));
}
for (let index = 0; index < 100 * scale; index++) {
    const x = (index % grid) * 12, y = Math.floor(index / grid) * 12 + 2;
    const points = [{ x, y }, { x: x + 4, y }, { x: x + 4, y: y + 3 }, { x, y: y + 3 }];
    pcbDocument.boardShapes.push(index % 2
        ? { id: `shape${index}`, kind: 'polygon', layer: 'top-silk', lineWidth: 0.2, filled: false, points, nodeCornerRadii: { 1: 1.5 } }
        : { id: `shape${index}`, kind: 'line', layer: 'top-copper', lineWidth: 0.3, points: points.slice(0, 3), segmentBulges: { 0: 0.3 } });
}
for (let index = 0; index < 10 * scale; index++) {
    const x = index * 40;
    pcbDocument.boardShapes.push(new CopperFill({ layer: 'bottom-copper', kind: 'polygon', cornerRadius: 2,
        outline: [{ x, y: 0 }, { x: x + 30, y: 0 }, { x: x + 30, y: 30 }, { x, y: 30 }] }));
}
const app = { pcbDocument, placements: new Map(), texts: pcbDocument.texts, tracks: pcbDocument.tracks,
    vias: pcbDocument.vias, pads: pcbDocument.pads, boardShapes: pcbDocument.boardShapes,
    viewport: { scale: 10 }, getLayerGroup: () => null, _shapeElements: new Map() };

const span = grid * 6;
const points = Array.from({ length: 256 }, (_, index) => ({ x: (index * 37.3) % span, y: (index * 53.7) % span }));
function measure(label, iterations, run) {
    for (let index = 0; index < iterations; index++) run(index);
    const runs = [];
    for (let round = 0; round < 7; round++) {
        const start = process.hrtime.bigint();
        for (let index = 0; index < iterations; index++) run(index);
        runs.push(Number(process.hrtime.bigint() - start) / iterations / 1000);
    }
    runs.sort((a, b) => a - b);
    return { scenario: label, 'median µs/query': runs[3].toFixed(1), 'min µs/query': runs[0].toFixed(1) };
}
const entities = pcbDocument.tracks.length + pcbDocument.vias.length + pcbDocument.pads.length + pcbDocument.boardShapes.length;
console.log(`${entities} selectable entities`);
console.table([
    measure('selection sync only', 200, () => syncPcbSelection(app)),
    measure('pointer hit query (sync + hit test)', 200, index => hitTestPcbSelection(app, points[index & 255])),
]);
