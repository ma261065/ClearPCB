import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { Track } from '../../src/shapes/track.js';
import { Via } from '../../src/shapes/via.js';
import { Pad } from '../../src/shapes/pad.js';
import { getViaDrag } from '../../src/pcb/modules/terminal-drag.js';

globalThis.window = { addEventListener() {} };
const { startViaDrag, startPadDrag } = await import('../../src/pcb/modules/terminal-drag.js');
const { resolveTrackSnap } = await import('../../src/pcb/modules/track-snap.js');

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
    assert.deepEqual(getViaDrag(app).attached.map(item => [item.track.id, item.nodeId]),
        kind === 'via' ? [[top.id, 'n0'], [bottom.id, 'n0']] : [[top.id, 'n0']],
        'Near-coincident nodes still attach only on compatible copper layers');
    assert.deepEqual(model.tracks.map(track => track.captureState()), before, 'Pickup is read-only');
    assert.equal(calls.get(top), 1, 'Only the coincident node needs an incident-edge scan');
    assert.equal(calls.get(bottom), 1, 'Layer eligibility is checked for the near-coincident node');
    assert.equal(calls.get(distant), 0, 'Distant tracks do not need any incident-edge scans');
    for (const track of model.tracks) calls.set(track, 0);
    const snapStart = performance.now();
    const snap = resolveTrackSnap(app, { x: 2000.02, y: 0.01 }, {
        layer: kind === 'pad' ? 'top-copper' : 'both',
        excludeNode: (track, id) => !track.incidentEdges(id)
            .some(edge => getViaDrag(app).layers.includes(track.getEdgeLayer(edge.edgeId))),
    });
    console.log(`${kind} node snap: ${(performance.now() - snapStart).toFixed(2)} ms; incident scans: ${[...calls.values()].join(', ')}`);
    assert.equal(snap.snapType, 'track-node');
    assert.equal(snap.trackNode.track, top);
    assert.equal(snap.trackNode.nodeId, 'n2000');
    assert.equal(calls.get(top), 1, 'Only an in-range candidate needs layer eligibility testing');
    assert.equal(calls.get(bottom), 0);
    assert.equal(calls.get(distant), 0);
    assert.deepEqual(model.tracks.map(track => track.captureState()), before, 'Snapping is read-only');
}

{
    const near = new Track({ net: 'OTHER', points: [{ x: 0.01, y: 0 }, { x: 10, y: 0 }] });
    const preferred = new Track({ net: 'GND', points: [{ x: 0.05, y: 0 }, { x: 10, y: 10 }] });
    const boundary = new Track({ net: 'GND', points: [{ x: 0.1, y: 0 }, { x: 20, y: 20 }] });
    const app = { tracks: [near, preferred, boundary], viewport: { scale: 100 } };
    const options = { net: 'GND', trackTolerance: 0.1 };
    assert.equal(resolveTrackSnap(app, { x: 0, y: 0 }, options).trackNode.track, preferred);
    assert.equal(resolveTrackSnap(app, { x: 0, y: 0 }, {
        ...options, excludeNode: track => track === preferred,
    }).trackNode.track, boundary, 'Exclusion retains same-net preference and inclusive tolerance');
    assert.equal(resolveTrackSnap(app, { x: 0, y: 0 }, {
        ...options, excludeNode: track => track.net === 'GND',
    }).trackNode.track, near, 'Excluded preferred nodes fall back to the nearest other-net node');
    assert.notEqual(resolveTrackSnap(app, { x: 0, y: 0 }, {
        ...options, excludeNode: () => true,
    }).snapType, 'track-node');
}
console.log('PASS via/pad pickup and node snapping bound edge scans, preserving layer/net eligibility and read-only state');
