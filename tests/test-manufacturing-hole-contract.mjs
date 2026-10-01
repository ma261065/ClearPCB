import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { Component } from '../src/components/Component.js';
import { createPcbFootprint } from '../src/core/pcb-footprint.js';
import { captureResolvedPlacement, applyPlacementSide } from '../src/core/pcb-placement-geometry.js';
import { FlipPlacementCommand } from '../src/core/pcb-placement-commands.js';
import { prepareFabricationSnapshot } from '../src/pcb/modules/fabrication-snapshot.js';
import { generatePickAndPlace } from '../src/pcb/modules/assembly.js';
import { resolvePlacementDrills, resolvePadFlashes, placementPose } from '../src/pcb/modules/board-geometry.js';
import { resolveCopperPads } from '../src/pcb/modules/copper-model.js';
import { buildFillContext } from '../src/pcb/modules/fill-context.js';
import { computeFillPolygons, loadClipper } from '../src/pcb/modules/copper-fill-geom.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { pointInPolygon } from '../src/core/geometry.js';
import { PANEL_DEFAULTS, buildPanelLayout } from '../src/pcb/modules/panelization.js';
import { rectangleBoardOutline } from '../src/pcb/modules/board-outline.js';

globalThis.window = { addEventListener() {} };
const { KiCadFetcher } = await import('../src/components/KiCadFetcher.js');
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
const source = `(footprint "Audit"
    (pad "1" thru_hole circle (at -5 -8) (size 2 2) (drill 0.8) (layers "*.Cu" "*.Mask"))
    (pad "2" thru_hole circle (at 5 8) (size 2 2) (drill 0.8) (layers "*.Cu" "*.Mask"))
    (pad "3" thru_hole oval (at -2 -4 37) (size 2 4) (drill oval 1 3) (layers "*.Cu" "*.Mask"))
    (pad "" np_thru_hole circle (at 1 0) (size 1.2 1.2) (drill 1.2) (layers "*.Cu" "*.Mask"))
    (pad "" np_thru_hole oval (at 0 4 37) (size 1 3) (drill oval 1 3) (layers "*.Cu" "*.Mask"))
)`;
const parsed = new KiCadFetcher()._parseFootprintPreview(source);
const definition = { name: 'Audit', _source: 'KiCad', footprint: 'Audit',
    symbol: { pins: [{ number: '1' }, { number: '2' }, { number: '3' }] },
    footprintShapes: parsed.shapes };
const project = new ProjectDocument();
project.schematicDocument.components.push(new Component(definition, { id: 'part', reference: 'J1' }));
const footprint = project.getPcbFootprint('part');
assert.deepEqual(footprint.padOffsets.map(pad => pad.number), ['1', '2', '3'],
    'Mechanical holes never invent numbered copper pads or electrical terminals');
assert.equal(footprint.geometry.silks.filter(shape => shape.layer === 'hole').length, 2);
assert.equal(footprint.padOffsets[2].slotLength, 3);
assert.ok(Math.abs(footprint.padOffsets[2].slotAngle - (Math.PI / 2 + 37 * Math.PI / 180)) < 1e-12);
const restored = new ProjectDocument();
await restored.load(project.serialize());
assert.equal(restored.getPcbFootprint('part').geometry.silks.filter(shape => shape.layer === 'hole').length, 2);
assert.equal(restored.getPcbFootprint('part').padOffsets[2].slotLength, 3);
assert.ok(Math.abs(restored.getPcbFootprint('part').padOffsets[2].slotAngle
    - footprint.padOffsets[2].slotAngle) < 0.000051, 'Save/load retains slot angle at existing shape-string precision');

const board = placements => ({ placements, tracks: [], vias: [], pads: [], texts: new Map(),
    boardShapes: [], copperFills: [], _boardWidth: 40, _boardHeight: 40, _boardRadius: 0,
    _getRoutingParams: () => ({ clearance: 0.2 }) });
const drillCommand = drill => `X${drill.x.toFixed(3)}Y${(-drill.y).toFixed(3)}`
    + (drill.slot ? `G85X${drill.slot.x2.toFixed(3)}Y${(-drill.slot.y2).toFixed(3)}` : '');
for (const side of ['top', 'bottom']) for (const mirror of [false, true]) for (const rotation of [0, 37, 90]) {
    const placement = { x: 20, y: -20, rotation, mirror, side, refVisible: false,
        reference: 'J1', padOffsets: structuredClone(footprint.padOffsets), silks: structuredClone(footprint.geometry.silks) };
    applyPlacementSide(placement, side);
    const app = board(new Map([['part', placement]]));
    const snapshot = await prepareFabricationSnapshot(app, { computeFills: false });
    assert.deepEqual(structuredClone(snapshot.placements), snapshot.placements, 'Worker-transferable hole geometry');
    assert.deepEqual(snapshot.placements.get('part'), captureResolvedPlacement(placement));
    const drills = resolvePlacementDrills(snapshot.placements);
    assert.equal(drills.filter(drill => drill.plated).length, 3);
    assert.equal(drills.filter(drill => !drill.plated).length, 2);
    assert.equal(drills.filter(drill => drill.slot).length, 2);
    const npth = drills.find(drill => !drill.plated && !drill.slot);
    assert.deepEqual({ x: npth.x, y: npth.y }, placementPose(placement).xf(1, 0));
    const files = exportGerbers(snapshot);
    for (const drill of drills) {
        assert.ok(files.get(drill.plated ? 'board-PTH.drl' : 'board-NPTH.drl').includes(drillCommand(drill)));
    }
    assert.match(files.get('board-NPTH.drl'), /TYPE=NON_PLATED/);
    assert.equal(resolvePadFlashes(snapshot.placements).length, 3);
    const copper = resolveCopperPads(app);
    assert.equal(copper.length, 3);
    const platedSlot = drills.find(drill => drill.plated && drill.slot);
    assert.deepEqual(copper[2].slot, { x1: platedSlot.x, y1: platedSlot.y,
        x2: platedSlot.slot.x2, y2: platedSlot.slot.y2 }, 'Electrical and fabrication slot axes use radians');
    placement.silks[0].r = 99;
    assert.equal(resolvePlacementDrills(snapshot.placements).find(drill => !drill.plated && !drill.slot).dia, 1.2,
        'Snapshot owns detached mechanical geometry');
}
const legacy = createPcbFootprint({ footprint: 'Old', pins: [], source: 'KiCad',
    footprintShapes: ['PAD~OVAL~0~0~2~4~1~both~1~0~1.2'] });
assert.deepEqual(resolvePlacementDrills(new Map([['old', { padOffsets: legacy.padOffsets }]])),
    [{ x: 0, y: 0, dia: 1.2, plated: true, slot: null }], 'Old diameter-only records retain their old meaning');

// The whole mechanical slot, not only its first cap, must clear a copper pour.
const holeApp = board(new Map([['hole', { x: 20, y: -20, silks: [
    { type: 'line', layer: 'hole', x1: -3, y1: 0, x2: 3, y2: 0, strokeWidth: 1 },
] }]]));
const fill = new CopperFill({ net: 'GND', layer: 'top-copper',
    outline: [{ x: 1, y: -1 }, { x: 39, y: -1 }, { x: 39, y: -39 }, { x: 1, y: -39 }] });
holeApp.copperFills = [fill];
await loadClipper();
const poured = computeFillPolygons(fill, buildFillContext(holeApp));
assert.ok(poured.length, 'The pour must be computed, not an unloaded empty result');
const hasCopper = point => poured.some(region => pointInPolygon(point, region.outer)
    && !region.holes.some(hole => pointInPolygon(point, hole)));
for (const x of [17, 20, 23]) assert.equal(hasCopper({ x, y: -19.4 }), false, 'Clearance spans the whole slot');
assert.equal(hasCopper({ x: 20, y: -18.5 }), true);

const contours = file => {
    const result = [];
    for (const match of file.matchAll(/X(-?\d+)Y(-?\d+)D0([12])\*/g)) {
        if (match[3] === '2') result.push([]);
        result.at(-1).push({ x: Number(match[1]) / 1e6, y: -Number(match[2]) / 1e6 });
    }
    return result;
};
for (const plated of [false, true]) for (const slot of [false, true]) {
    for (const side of ['top', 'bottom']) for (const rotation of [0, 37, 180, 217]) {
        const placement = { x: 0.5, y: -10, side, rotation, refVisible: false,
            padOffsets: plated ? [{ dx: 0, dy: 0, width: 4, height: 2, shape: 'oval', layer: 'both',
                drill: slot ? 1 : 2, slotLength: slot ? 3 : 0, slotAngle: 0 }] : [],
            silks: plated ? [] : slot
                ? [{ type: 'line', layer: 'hole', x1: -1, y1: 0, x2: 1, y2: 0, strokeWidth: 1 }]
                : [{ type: 'circle', layer: 'hole', cx: 0, cy: 0, r: 1 }] };
        for (const panelization of [null, { ...PANEL_DEFAULTS, rows: 2, columns: 2 }]) {
            const options = { placements: new Map([['edge', placement]]), boardWidth: 20, boardHeight: 20,
                boardShapes: [rectangleBoardOutline(20, 20)], panelization };
            const files = exportGerbers(options), bare = exportGerbers({ ...options, placements: new Map() });
            assert.equal(files.get('board-PTH.drl'), bare.get('board-PTH.drl'), 'Crossing holes are not full plated drills');
            assert.equal(files.get('board-NPTH.drl'), bare.get('board-NPTH.drl'), 'Panel tooling holes remain untouched');
            assert.notEqual(files.get('board.gko'), bare.get('board.gko'), 'Crossing footprint bore remains as a routed opening');
            assert.match(files.get('fabrication-notes.txt'), /routed-edge plating/);
            assert.ok(files.get('fabrication-notes.txt').includes(`\n${plated ? 'PLATED' : 'NON-PLATED'}: diameter `),
                'Routed-hole instructions retain each source hole plating requirement');
            const outline = contours(files.get('board.gko'));
            const solid = point => outline.filter(contour => pointInPolygon(point, contour)).length % 2 === 1;
            const instances = panelization ? buildPanelLayout(options, panelization).instances : [{ dx: 0, dy: 0 }];
            for (const instance of instances) {
                assert.equal(solid({ x: 0.5 + instance.dx, y: -10 + instance.dy }), false, 'Each source bore removes substrate');
                assert.equal(solid({ x: 3 + instance.dx, y: -10 + instance.dy }), true, 'Nearby substrate is preserved');
            }
        }
    }
}
const whollyInside = exportGerbers({ placements: new Map([['slot', { x: 10, y: -10,
    silks: [{ type: 'line', layer: 'hole', x1: -1, y1: 0, x2: 1, y2: 0, strokeWidth: 1 }] }]]),
    boardWidth: 20, boardHeight: 20 });
assert.match(whollyInside.get('board-NPTH.drl'), /X9\.000Y10\.000G85X11\.000Y10\.000/);
assert.equal(whollyInside.has('fabrication-notes.txt'), false);

project.pcbDocument.placementState.record('part', { x: 20, y: -20, side: 'bottom', rotation: 0, mirror: false });
const csvPlacement = () => new Map([['part', {
    ...project.pcbDocument.placementState.overrides.get('part'), reference: 'J1', footprint: 'Audit',
} ]]);
const originalCsv = generatePickAndPlace(csvPlacement());
assert.match(originalCsv, /20\.0000,20\.0000,0\.00,Bottom/);
const command = new FlipPlacementCommand(project, 'part', 'H');
command.execute();
assert.throws(() => generatePickAndPlace(csvPlacement()), /J1 is mirrored.*Remove its mirror.*Top\/Bottom/);
command.undo();
assert.equal(generatePickAndPlace(csvPlacement()), originalCsv);
assert.throws(() => generatePickAndPlace(new Map([['top', { reference: 'U2', side: 'top', mirror: true }]])),
    /U2 is mirrored/);
console.log('PASS imported round/slotted NPTH, PTH slot axes, save/load, detached fabrication, full-slot pour clearance, edge routing/panels and mirrored assembly preflight');
