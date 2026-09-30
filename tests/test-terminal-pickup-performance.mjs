import assert from 'node:assert/strict';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { Track } from '../src/shapes/track.js';
import { Via } from '../src/shapes/via.js';
import { Pad } from '../src/shapes/pad.js';

globalThis.window = { addEventListener() {} };
const { startViaDrag, startPadDrag } = await import('../src/pcb/modules/track-drag.js');

for (const kind of ['via', 'pad']) {
    const model = new PcbDocument();
    const top = new Track({ points: Array.from({ length: 4000 }, (_, i) => ({ x: i, y: 0 })), layer: 'top-copper' });
    const bottom = new Track({ points: [{ x: 0.00005, y: -0.00005 }, { x: -10, y: 0 }], layer: 'bottom-copper' });
    const distant = new Track({ points: Array.from({ length: 4000 }, (_, i) => ({ x: i, y: 10 })), layer: 'top-copper' });
    model.tracks.push(top, bottom, distant);
    const terminal = kind === 'via' ? new Via({ x: 0, y: 0 }) : new Pad({ x: 0, y: 0, layers: 'top-copper' });
    model[kind === 'via' ? 'vias' : 'pads'].push(terminal);
    const before = model.tracks.map(track => track.captureState());
    const calls = new Map();
    for (const track of model.tracks) {
        const incident = track.incidentEdges;
        calls.set(track, 0);
        track.incidentEdges = function (id) {
            calls.set(this, calls.get(this) + 1);
            return incident.call(this, id);
        };
    }
    const app = { pcbDocument: model, tracks: model.tracks,
        viewport: { scale: 100, setCrosshair() {} } };
    const start = performance.now();
    const accepted = (kind === 'via' ? startViaDrag : startPadDrag)(app, terminal, { x: 0.1, y: 0.1 });
    console.log(`${kind} pickup: ${(performance.now() - start).toFixed(2)} ms; incident scans: ${[...calls.values()].join(', ')}`);
    assert.equal(accepted, true);
    assert.deepEqual(app._viaDrag.attached.map(item => [item.track.id, item.nodeId]),
        kind === 'via' ? [[top.id, 'n0'], [bottom.id, 'n0']] : [[top.id, 'n0']],
        'Near-coincident nodes still attach only on compatible copper layers');
    assert.deepEqual(model.tracks.map(track => track.captureState()), before, 'Pickup is read-only');
    assert.equal(calls.get(top), 1, 'Only the coincident node needs an incident-edge scan');
    assert.equal(calls.get(bottom), 1, 'Layer eligibility is checked for the near-coincident node');
    assert.equal(calls.get(distant), 0, 'Distant tracks do not need any incident-edge scans');
}
console.log('PASS via/pad pickup uses node positions before edge scans, preserving layer eligibility and read-only state');
