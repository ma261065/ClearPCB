import assert from 'node:assert/strict';
import { Track } from '../src/shapes/track.js';

assert.equal(typeof window, 'undefined');
assert.equal(typeof document, 'undefined');
function makeTrack() {
    const track = new Track({ id: 'snapshot-track', net: 'SIG', width: 0.3456789, layer: 'top-copper',
        points: [{ x: Math.PI, y: -Math.E }, { x: 7.12345678, y: 4.98765432 }, { x: 10.12345678, y: -Math.E }],
        padConnections: { n0: { componentId: 'part', pinNumber: '1' } } });
    track.edges.get('e0').width = 0.23456789;
    track.edges.get('e0').layer = 'bottom-copper';
    track.edges.get('e0').bulge = 0.12345678;
    delete track.edges.get('e1').width;
    delete track.edges.get('e1').layer;
    track.cornerRadius = 0.45678901;
    track.nodeCornerRadii = { n1: 0.56789012 };
    return track;
}
const track = makeTrack();
const original = track.captureState();
track.elements = [{ uncloneable() {} }];
track.nodes.get('n0').view = { uncloneable() {} };
const snapshot = track.captureCopperGeometry();
assert.deepEqual(track.captureState(), original, 'Capturing physical data does not modify the authored graph');
assert.deepEqual(Object.keys(snapshot).sort(), ['id', 'net', 'width', 'layer', 'nodes', 'edges',
    'cornerRadius', 'nodeCornerRadii', 'padConnections'].sort());
assert.deepEqual(snapshot.nodes.get('n0'), { x: Math.PI, y: -Math.E }, 'Nodes exclude presentation state');
assert.equal(snapshot.edges.get('e0').width, 0.23456789);
assert.equal(snapshot.edges.get('e0').layer, 'bottom-copper');
assert.equal(snapshot.edges.get('e0').bulge, 0.12345678);
assert.equal(snapshot.edges.get('e1').width, 0.3456789, 'Inherited edge widths are resolved at capture time');
assert.equal(snapshot.edges.get('e1').layer, 'top-copper');
assert.equal(snapshot.cornerRadius, 0.45678901);
assert.equal(snapshot.nodeCornerRadii.n1, 0.56789012);
assert.deepEqual(structuredClone(snapshot), snapshot, 'Model snapshots contain only transferable data, not renderer methods');
assert.equal('elements' in snapshot, false);
assert.equal('getEdgeWidth' in snapshot, false);
track.nodes.get('n0').x = 100;
track.edges.get('e0').bulge = 0;
track.width = 9;
track.layer = 'bottom-copper';
track.nodeCornerRadii.n1 = 8;
track.padConnections.get('n0').pinNumber = 'changed';
assert.equal(snapshot.nodes.get('n0').x, Math.PI);
assert.equal(snapshot.edges.get('e0').bulge, 0.12345678);
assert.equal(snapshot.edges.get('e1').width, 0.3456789);
assert.equal(snapshot.edges.get('e1').layer, 'top-copper');
assert.equal(snapshot.nodeCornerRadii.n1, 0.56789012);
assert.equal(snapshot.padConnections.get('n0').pinNumber, '1');
snapshot.nodes.get('n0').y = 200;
snapshot.edges.get('e0').width = 5;
snapshot.nodeCornerRadii.n1 = 6;
snapshot.padConnections.get('n0').componentId = 'snapshot-only';
assert.equal(track.nodes.get('n0').y, -Math.E);
assert.equal(track.edges.get('e0').width, 0.23456789);
assert.equal(track.nodeCornerRadii.n1, 8);
assert.equal(track.padConnections.get('n0').componentId, 'part');
const frozen = makeTrack();
for (const point of frozen.nodes.values()) Object.freeze(point);
for (const edge of frozen.edges.values()) Object.freeze(edge);
for (const connection of frozen.padConnections.values()) Object.freeze(connection);
Object.freeze(frozen.nodeCornerRadii);
Object.freeze(frozen);
assert.deepEqual(frozen.captureCopperGeometry(), makeTrack().captureCopperGeometry(),
    'Snapshot capture also works on frozen model state');
assert.deepEqual(new Track().captureCopperGeometry().edges, new Map());

globalThis.window = { addEventListener() {} };
const { prepareFabricationSnapshot } = await import('../src/pcb/modules/fabrication-snapshot.js');
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
const source = makeTrack();
const capture = source.captureCopperGeometry.bind(source);
let captures = 0;
source.captureCopperGeometry = () => { captures++; return capture(); };
const app = {
    placements: new Map(), tracks: [source], vias: [], pads: [], texts: new Map(), boardShapes: [], copperFills: [],
    _boardWidth: 20, _boardHeight: 20, _boardRadius: 0, getRoutingParams: () => ({ clearance: 0.2 }),
};
const fabrication = await prepareFabricationSnapshot(app, { computeFills: false });
assert.equal(captures, 1, 'The export adapter delegates graph capture to the model once');
assert.equal(fabrication.tracks[0].getEdgeWidth('e0'), 0.23456789);
assert.equal(fabrication.tracks[0].getEdgeLayer('e1'), 'top-copper');
assert.deepEqual(exportGerbers(fabrication), exportGerbers({ ...fabrication, tracks: [source] }),
    'Detached model geometry produces identical Gerber output to the original track');
source.width = 10;
source.layer = 'bottom-copper';
assert.equal(fabrication.tracks[0].getEdgeWidth('e1'), 0.3456789);
assert.equal(fabrication.tracks[0].getEdgeLayer('e1'), 'top-copper');
fabrication.tracks[0].edges.get('e1').width = 0.87654321;
assert.equal(fabrication.tracks[0].getEdgeWidth('e1'), 0.87654321, 'Consumer queries resolve only the detached graph');
source.getEdgeWidth = () => { throw new Error('Invalid width'); };
assert.throws(() => source.captureCopperGeometry(), /Invalid width/);
await assert.rejects(prepareFabricationSnapshot(app), /Invalid width/, 'Model capture failures reach export callers');
console.log('PASS model-owned copper graph snapshots, full precision, isolation, headless capture and unchanged Gerber output');
