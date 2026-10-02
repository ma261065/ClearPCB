import assert from 'node:assert/strict';
import * as placementGeometry from '../src/core/pcb-placement-geometry.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { resolvePlacementDrills } from '../src/shared/pcb/board-geometry.js';

assert.equal(typeof window, 'undefined');
assert.equal(typeof document, 'undefined');
const { captureResolvedPlacement, applyPlacementSide, updatePlacementPadPositions } = placementGeometry;
assert.equal(typeof captureResolvedPlacement, 'function', 'The neutral model module owns resolved placement capture');

function fixture(side = 'top', mirror = false, refVisible = true) {
    const placement = {
        x: 15.12345678, y: -15.98765432, rotation: 37.12345678, mirror, side: 'top',
        padOffsets: [
            { number: '1', padId: '1', dx: -3.12345678, dy: 0, width: 2.34567891, height: 1.23456789,
                shape: 'rect', layer: 'top', drill: 0, mask: true, paste: false },
            { number: '1', padId: '1#2', dx: 3.12345678, dy: 0, width: 2.34567891, height: 1.23456789,
                shape: 'oval', layer: 'both', drill: 0.45678901, slotLength: 1.12345678,
                slotAngle: 0.32109876, mask: false, paste: false },
        ],
        pasteOffsets: [{ dx: -3.12345678, dy: 0, width: 1.23456789, height: 0.98765432,
            shape: 'rect', side: 'top' }],
        silks: [
            { type: 'line', layer: 'top-silk', x1: -4, y1: -2, x2: 4, y2: -2, width: 0.12345678 },
            { type: 'circle', layer: 'hole', cx: 0, cy: 3, r: 0.45678901 },
        ],
        pads: new Map(), name: 'Connector', reference: 'J1',
        outline: { x: -4, y: -2, w: 8, h: 6 },
        refVisible, refDx: 0.23456789, refDy: -3.12345678, refRot: 12.34567891,
        refSize: 1.23456789, refStrokeWidth: 0.12345678,
    };
    applyPlacementSide(placement, side);
    updatePlacementPadPositions(placement);
    return placement;
}

for (const side of ['top', 'bottom']) for (const mirror of [false, true]) {
    const placement = fixture(side, mirror);
    const expected = structuredClone(placement);
    for (const field of ['elements', 'bounds', 'model3dObj', 'model3dPlacement', 'locked', 'selected']) {
        Object.defineProperty(placement, field, {
            enumerable: true, get() { throw new Error(`Presentation metadata read: ${field}`); },
        });
    }
    const captured = captureResolvedPlacement(placement);
    assert.deepEqual(captured, expected, 'The snapshot preserves the existing resolved-data shape and full precision');
    assert.deepEqual(structuredClone(captured), expected, 'Snapshots contain transferable data only');
    assert.equal(captured.rotation, 37.12345678, 'Capture neither normalizes nor rounds the resolved pose');
    assert.deepEqual([...captured.pads.keys()], ['1', '1#2'], 'Duplicate physical pad identifiers are retained');
    const sourceBefore = structuredClone(expected);
    captured.padOffsets[0].dx = 100;
    captured.pasteOffsets[0].width = 100;
    captured.silks[0].x1 = 100;
    captured.pads.get('1').x = 100;
    captured.outline.w = 100;
    captured.reference = 'SNAPSHOT';
    assert.deepEqual(captureResolvedPlacement(placement), sourceBefore, 'Snapshot edits cannot mutate source data');
    const detached = captureResolvedPlacement(placement);
    placement.x = 200;
    placement.padOffsets[0].dx = 200;
    placement.pasteOffsets[0].width = 200;
    placement.silks[0].x1 = 200;
    placement.pads.get('1').x = 200;
    placement.outline.w = 200;
    placement.reference = 'SOURCE';
    assert.deepEqual(detached, expected, 'Source edits cannot mutate an earlier capture');
}

{
    const placement = fixture();
    const freeze = value => {
        if (!value || typeof value !== 'object') return;
        for (const child of value instanceof Map ? value.values() : Object.values(value)) freeze(child);
        Object.freeze(value);
    };
    freeze(placement);
    assert.deepEqual(captureResolvedPlacement(placement), fixture(), 'Capture does not mutate frozen physical state');
    const sparse = captureResolvedPlacement({ x: Math.PI, y: -Math.E });
    assert.equal(sparse.x, Math.PI);
    assert.equal(sparse.rotation, undefined, 'Missing resolved fields retain their prior consumer defaults');
    const broken = fixture();
    Object.defineProperty(broken, 'padOffsets', { get() { throw new Error('Invalid physical pads'); } });
    assert.throws(() => captureResolvedPlacement(broken), /Invalid physical pads/);
}

globalThis.window = { addEventListener() {} };
const { prepareFabricationSnapshot, prepareSnapshotFills } = await import('../src/pcb/modules/fabrication-snapshot.js');
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
for (const side of ['top', 'bottom']) for (const mirror of [false, true]) for (const refVisible of [false, true]) {
    const placement = fixture(side, mirror, refVisible);
    const expectedPlacement = structuredClone(placement);
    const fill = new CopperFill({ net: 'GND', layer: `${side}-copper`,
        outline: [{ x: 1, y: -1 }, { x: 29, y: -1 }, { x: 29, y: -29 }, { x: 1, y: -29 }] });
    const app = {
        placements: new Map([['part', placement]]), tracks: [], vias: [], pads: [], texts: new Map(),
        boardShapes: [fill], copperFills: [fill],
        netlist: [{ net: 'GND', pins: [{ componentId: 'part', pinNumber: '1' }] }],
        _boardWidth: 30, _boardHeight: 30, _boardRadius: 0, getRoutingParams: () => ({ clearance: 0.2 }),
    };
    const expected = await prepareFabricationSnapshot(app, { computeFills: false });
    expected.placements = new Map([['part', expectedPlacement]]);
    placement.elements = [{ uncloneable() {} }];
    placement.model3dObj = { uncloneable() {} };
    let padReads = 0;
    const padOffsets = placement.padOffsets;
    Object.defineProperty(placement, 'padOffsets', { get() { padReads++; return padOffsets; } });
    const pending = prepareFabricationSnapshot(app);
    placement.x = 200;
    placement.rotation = 90;
    padOffsets[0].dx = 200;
    placement.pasteOffsets[0].width = 200;
    placement.silks[0].x1 = 200;
    placement.pads.clear();
    placement.reference = 'CHANGED';
    app.netlist[0].net = 'CHANGED';
    app.placements.clear();
    const captured = await pending;
    assert.equal(padReads, 1, 'Physical fields are captured once before asynchronous work');
    assert.deepEqual(captured.placements.get('part'), expectedPlacement);
    await prepareSnapshotFills(expected);
    assert.deepEqual(captured, expected, 'Capture preserves the resolved placement/netlist pair and computed pours');
    const drills = resolvePlacementDrills(captured.placements);
    assert.ok(drills.some(drill => drill.plated && drill.slot), 'The fixture exercises plated slots');
    assert.ok(drills.some(drill => !drill.plated), 'The fixture exercises footprint mounting holes');
    assert.deepEqual(exportGerbers(captured), exportGerbers(expected),
        'Mirrors, both board sides, pad masks/paste, slots, artwork and reference visibility preserve output');
    app.placements.set('part', { get padOffsets() { throw new Error('Invalid physical pads'); } });
    await assert.rejects(prepareFabricationSnapshot(app), /Invalid physical pads/);
}
console.log('PASS neutral resolved placement capture, headless precision/isolation and unchanged manufacturing output');
