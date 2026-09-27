import assert from 'node:assert/strict';
import { Pad } from '../src/shapes/pad.js';
import { padBounds, padHitTest, padOutline } from '../src/pcb/modules/pad.js';
import { createPadSelectionAdapter } from '../src/pcb/modules/pad-selection.js';
import { compactProjectAliases, normalizeProjectAliases } from '../src/core/project-field-aliases.js';
import { validateProject } from '../src/core/project-format.js';

const pad = new Pad({
    id: 'pad_7', x: 10, y: 20, shape: 'stadium', size: 2, drill: 1,
    ratio: 3, rotation: 90, layers: 'both', net: 'GND',
});
assert.equal(pad.width, 6);
assert.equal(pad.height, 2);
assert.equal(padOutline(pad).length > 8, true);
assert.equal(padHitTest(pad, { x: 10, y: 22.5 }), true);
assert.equal(padHitTest(pad, { x: 13, y: 20 }), false);
const bounds = padBounds(pad);
assert.ok(bounds.maxY - bounds.minY > bounds.maxX - bounds.minX);
assert.deepEqual(pad.toJSON(), {
    type: 'pad', id: 'pad_7', x: 10, y: 20, sh: 'stadium', s: 2,
    dr: 1, ls: 'both', ra: 3, rot: 90, n: 'GND',
});

const roundAdapter = createPadSelectionAdapter({ viewport: { scale: 1 } },
    new Pad({ shape: 'round' }), 'pad:round');
assert.deepEqual(roundAdapter.getAnchors(), [], 'round pads do not expose a rotation handle');
const rotatingPad = new Pad({ x: 0, y: 0, shape: 'rectangle', size: 2, ratio: 2 });
const rotationInput = { value: '' };
globalThis.document = { getElementById: id => id === 'pcbPropPadRotation' ? rotationInput : null };
const rotationApp = {
    viewport: { scale: 1 }, _getLayerGroup: () => null,
    history: { execute() {} },
};
const rotationAdapter = createPadSelectionAdapter(rotationApp, rotatingPad, 'pad:rotating');
assert.equal(rotationAdapter.getAnchors().length, 1);
rotationAdapter.beginAnchorDrag('rotate', { x: 0, y: -4 });
rotationAdapter.updateAnchorDrag({ x: 2, y: -2 });
assert.equal(rotatingPad.rotation, 315);
assert.equal(rotationInput.value, '315', 'rotation property follows the dragged handle');
assert.ok(padOutline(rotatingPad)[1].y > 0, 'pad geometry follows the pointer rotation direction');
rotationAdapter.endAnchorDrag(false);

const longPad = {
    type: 'pad', id: 'pad_1', x: 2, y: 3, shape: 'rectangle', size: 1.5,
    drill: 0.7, ratio: 2.5, rotation: 30, layers: 'top-copper', net: 'SIG',
    locked: false, visible: true,
};
const compact = compactProjectAliases({ pcb: { pads: [longPad] } });
assert.deepEqual(compact.pcb.pads[0], {
    type: 'pad', id: 'pad_1', x: 2, y: 3, sh: 'rectangle', s: 1.5,
    dr: 0.7, ra: 2.5, rot: 30, ls: 'top-copper', n: 'SIG', lk: false, v: true,
});
assert.deepEqual(normalizeProjectAliases(compact).pcb.pads[0], longPad);

const project = {
    type: 'clearpcb-project', version: '1.0',
    schematic: { settings: {}, shapes: [], components: [], defs: {} },
    pcb: {
        stackup: { copperLayers: ['top-copper', 'bottom-copper'] },
        design: {
            trackWidth: 0.2, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3,
            units: 'mm', router: 'maze',
        },
        tracks: [], vias: [], pads: [longPad], boardShapes: [], texts: [], placements: {},
    },
};
assert.equal(validateProject(project).pcb.pads[0].shape, 'rectangle');
assert.throws(() => validateProject({
    ...project, pcb: { ...project.pcb, pads: [{ ...longPad, drill: 2 }] },
}), /drill no larger than size/);

globalThis.window = { addEventListener() {} };
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
const { standalonePadEdgeMesh } = await import('../src/pcb/modules/board3d.js');
const { clipMeshToOutline } = await import('../src/pcb/modules/board3d-mesh-ops.js');
const exportPad = new Pad({ ...pad.captureState(), id: 'pad_export', y: -20, rotation: 37 });
const files = exportGerbers({
    placements: new Map(), tracks: [], vias: [], pads: [exportPad.captureState()],
    boardWidth: 100, boardHeight: 80,
});
assert.ok(files.get('board.gtl').includes('G36*'), 'rotated stadium is emitted on top copper');
assert.ok(files.get('board.gbl').includes('G36*'), 'both-side pad is emitted on bottom copper');
assert.ok(files.get('board.gts').includes('G36*'), 'pad has a top mask opening');
assert.ok(files.get('board-PTH.drl').includes('T1C1.000'), 'pad drill is emitted as plated');

const topOnly = new Pad({ x: 30, y: -20, shape: 'square', size: 2, drill: 0.8, layers: 'top-copper' });
const topFiles = exportGerbers({
    placements: new Map(), tracks: [], vias: [], pads: [topOnly],
    boardWidth: 100, boardHeight: 80,
});
assert.ok(topFiles.get('board.gtl').includes('D03*'), 'top-only pad is emitted on top copper');
assert.ok(!topFiles.get('board.gbl').includes('D03*'), 'top-only pad is absent from bottom copper');
assert.ok(!topFiles.get('board.gbs').includes('D03*'), 'top-only pad has no bottom mask opening');

const edge = new Pad({ x: 100, y: -20, shape: 'round', size: 2, drill: 0.8, layers: 'top-copper' });
const edgeFiles = exportGerbers({
    placements: new Map(), tracks: [], vias: [], pads: [edge],
    boardWidth: 100, boardHeight: 80,
});
assert.ok(edgeFiles.get('board.gtl').includes('G36*'), 'castellated copper is clipped to the board edge');
assert.ok(edgeFiles.get('board-PTH.drl').includes('T1C0.800'), 'castellated drill remains plated');
const edgeMesh = standalonePadEdgeMesh(
    new Pad({ x: 0, y: -20, shape: 'round', size: 4, drill: 2, layers: 'both' }),
    [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: -80 }, { x: 0, z: -80 }],
);
assert.equal(edgeMesh.faces.length, 4, 'castellation plates both board-edge strips around the bore');
assert.ok(Math.abs(Math.min(...edgeMesh.verts.map(vertex => vertex.z)) + 22) < 1e-9);
assert.ok(Math.abs(Math.max(...edgeMesh.verts.map(vertex => vertex.z)) + 18) < 1e-9);
assert.ok(clipMeshToOutline(edgeMesh,
    [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: -80 }, { x: 0, z: -80 }]).faces.length > 0,
'castellation edge plating survives board-outline clipping');

console.log('PASS standalone pad model, aliases, geometry, validation and fabrication');
