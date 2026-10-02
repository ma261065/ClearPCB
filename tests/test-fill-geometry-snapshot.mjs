import assert from 'node:assert/strict';
import { CopperFill } from '../src/shapes/copper-fill.js';

assert.equal(typeof window, 'undefined');
assert.equal(typeof document, 'undefined');
const outline = [
    { x: Math.PI, y: -Math.E }, { x: 13.12345678, y: -Math.E },
    { x: 13.12345678, y: -11.98765432 }, { x: Math.PI, y: -11.98765432 },
];
const cases = [
    { kind: 'polygon', outline },
    { kind: 'rect', outline, cornerRadius: 0.45678901, nodeCornerRadii: { 1: 0.56789012 } },
    { kind: 'circle', x: 8.12345678, y: -7.23456789, radius: 2.34567891 },
    { kind: 'polygon', outline, segmentBulges: { 0: 0.25123456 } },
];
for (const layer of ['top-copper', 'bottom-copper']) for (const options of cases) {
    const fill = new CopperFill({ ...options, id: 'geometry-fill', layer, net: 'GND', locked: true, visible: false });
    const authored = fill.captureState(), resolved = structuredClone(fill.getOutline());
    fill.element = { uncloneable() {} };
    const snapshot = fill.captureCopperGeometry();
    assert.deepEqual(fill.captureState(), authored, 'Geometry capture leaves authored control geometry unchanged');
    assert.deepEqual(snapshot, { id: fill.id, type: 'fill', layer, net: 'GND', outline: resolved });
    assert.deepEqual(structuredClone(snapshot), snapshot, 'Resolved model snapshots contain transferable data only');
    assert.equal('_computed' in snapshot, false, 'The model does not own computed pour results');
    if (options.cornerRadius || options.segmentBulges || options.kind === 'circle') {
        assert.ok(snapshot.outline.length > 4, 'Capture uses the existing curved boundary, not its control polygon');
    } else {
        assert.equal(snapshot.outline[0].x, Math.PI, 'Capture does not round coordinates for file storage');
    }
    fill.move(10, 20);
    fill.net = 'CHANGED';
    assert.deepEqual(snapshot.outline, resolved, 'Later model edits cannot change a captured boundary');
    assert.equal(snapshot.net, 'GND');
    const moved = structuredClone(fill.getOutline());
    snapshot.outline[0].x = 999;
    snapshot.outline.push({ x: 1000, y: 1000 });
    assert.deepEqual(fill.getOutline(), moved, 'Snapshot edits cannot change model geometry or its cached boundary');
    const frozen = new CopperFill({ ...options, id: 'frozen', layer, net: 'GND' });
    for (const point of frozen.outline) Object.freeze(point);
    Object.freeze(frozen.outline);
    Object.freeze(frozen.nodeCornerRadii);
    Object.freeze(frozen.segmentBulges);
    Object.freeze(frozen);
    assert.deepEqual(frozen.captureCopperGeometry().outline, resolved, 'Capture works without mutating frozen models');
}
assert.deepEqual(new CopperFill().captureCopperGeometry().outline, []);
const broken = new CopperFill({ outline });
broken.getOutline = () => { throw new Error('Invalid fill geometry'); };
assert.throws(() => broken.captureCopperGeometry(), /Invalid fill geometry/);

globalThis.window = { addEventListener() {} };
const { prepareFabricationSnapshot, prepareSnapshotFills } = await import('../src/pcb/modules/fabrication-snapshot.js');
const { getComputedFill, setComputedFill } = await import('../src/pcb/modules/computed-fill-cache.js');
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
for (const layer of ['top-copper', 'bottom-copper']) for (const options of cases) {
    const fill = new CopperFill({ ...options, id: 'export-fill', layer, net: 'GND' });
    const resolved = structuredClone(fill.getOutline());
    const preview = [{ outer: [{ x: 100, y: 100 }, { x: 101, y: 100 }, { x: 100, y: 101 }], holes: [] }];
    setComputedFill(fill, preview);
    const capture = fill.captureCopperGeometry.bind(fill);
    let captures = 0;
    fill.captureCopperGeometry = () => { captures++; return capture(); };
    const app = {
        placements: new Map(), tracks: [], vias: [], pads: [], texts: new Map(), netlist: [],
        boardShapes: [fill], copperFills: [fill], _boardWidth: 30, _boardHeight: 30, _boardRadius: 0,
        getRoutingParams: () => ({ clearance: 0.2 }),
    };
    const pending = prepareFabricationSnapshot(app, { computeFills: false });
    fill.move(1, 2);
    const snapshot = await pending;
    assert.equal(captures, 1, 'Fabrication delegates boundary capture to the model once');
    assert.deepEqual(snapshot.fills, [{ id: fill.id, type: 'fill', layer, net: 'GND', outline: resolved, _computed: null }]);
    const priorShape = { ...snapshot, fills: [{ id: fill.id, type: 'fill', layer, net: 'GND',
        outline: structuredClone(resolved), _computed: null }] };
    await prepareSnapshotFills(snapshot);
    await prepareSnapshotFills(priorShape);
    assert.ok(snapshot.fills[0]._computed.length > 0);
    assert.deepEqual(snapshot.fills[0]._computed, priorShape.fills[0]._computed,
        'Pour computation is identical to the prior resolved-boundary representation');
    assert.deepEqual(exportGerbers(snapshot), exportGerbers(priorShape), 'Gerber output remains identical');
    assert.equal(getComputedFill(fill), preview, 'Export does not overwrite the live preview cache');
    assert.equal('_computed' in fill, false);
    fill.getOutline = broken.getOutline;
    await assert.rejects(prepareFabricationSnapshot(app), /Invalid fill geometry/,
        'Capture errors reach export callers without using stale preview geometry');
}
console.log('PASS model-owned fill geometry snapshots, curved boundaries, isolation, precision and unchanged pours/Gerbers');
