import assert from 'node:assert/strict';
import { Pad } from '../../src/shapes/pad.js';
import { Track } from '../../src/shapes/track.js';
import { padBounds, padCopperPathD, padHitTest, padOutline, renderPad } from '../../src/pcb/modules/pad.js';
import { createPadSelectionAdapter } from '../../src/pcb/modules/pad-selection.js';
import { renderTrack, renderVia, viaCopperPathD } from '../../src/pcb/modules/track-render.js';
import { createViaSelectionAdapter } from '../../src/pcb/modules/track-select.js';
import { createBoardShapeSelectionAdapter } from '../../src/pcb/modules/board-shapes.js';
import { PCB_LAYERS, isViaLocked, isViaVisible } from '../../src/pcb/modules/layers.js';
import { snapToGridLines } from '../../src/core/grid-snap.js';
import { LOCK_SCREEN_GAP_PX, LOCK_SIZE, lockIconMetrics } from '../../src/core/ui-helpers.js';
import { compactProjectAliases, normalizeProjectAliases } from '../../src/core/project-field-aliases.js';
import { validateProject } from '../../src/core/project-format.js';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

const document = installFakeDom();
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');

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
const largeRoundPad = new Pad({ x: 0, y: 0, shape: 'round', size: 20 });
const roundLock = createPadSelectionAdapter({ viewport: { scale: 20 } },
    largeRoundPad, 'pad:round-lock').getLockPosition({ x: 0, y: 0 }, 20);
assert.ok(
    Math.abs(roundLock.x + LOCK_SIZE + largeRoundPad.size / 2) < 0.5,
    'round Pad lock sits beside its actual outline instead of its distant bounding-box corner',
);
const movingPad = new Pad({ x: 0, y: 0, shape: 'round' });
assert.deepEqual(
    snapToGridLines({ x: 0.5, y: 0.5 }, 1, 4),
    { x: 0.5, y: 0.5, snappedX: false, snappedY: false },
    'magnetic grid snapping retains a free-movement region when grid lines are close on screen',
);
assert.deepEqual(
    snapToGridLines({ x: 0.2, y: 0.8 }, 1, 4),
    { x: 0, y: 1, snappedX: true, snappedY: true },
    'magnetic grid snapping still attracts points near grid lines at low zoom',
);
const movingViewport = {
    scale: 20, gridVisible: true, snapToGrid: true, shiftHeld: false,
    getSnappedPosition(point) {
        let shouldSnap = this.snapToGrid;
        if (this.shiftHeld && this.gridVisible) shouldSnap = !shouldSnap;
        if (!shouldSnap || !this.gridVisible) return point;
        return snapToGridLines(point, 1, this.scale);
    },
    setCrosshair() {},
    hideCrosshair() {},
};
const movingApp = {
    pcbDocument: new PcbDocument(),
    viewport: movingViewport,
    getLayerGroup: () => null,
    history: { execute() {} },
};
movingApp.pcbDocument.pads.push(movingPad);
for (const key of ['tracks', 'vias', 'pads']) {
    Object.defineProperty(movingApp, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
}
const movingAdapter = createPadSelectionAdapter(movingApp, movingPad, 'pad:moving');
movingAdapter.beginMove({ x: 0, y: 0 });
movingAdapter.updateMove({ x: 1.3, y: 1.45 });
assert.deepEqual(
    movingAdapter.getPosition(),
    { x: 1, y: 1.45 },
    'pad drag is free between grid lines and magnetically snaps each nearby axis',
);
movingViewport.shiftHeld = true;
movingAdapter.updateMove({ x: 1.3, y: 1.3 });
assert.deepEqual(
    movingAdapter.getPosition(),
    { x: 1.3, y: 1.3 },
    'Shift overrides magnetic grid snapping while dragging a pad',
);
movingViewport.snapToGrid = false;
movingViewport.shiftHeld = true;
movingAdapter.updateMove({ x: 2.3, y: 2.45 });
assert.deepEqual(
    movingAdapter.getPosition(),
    { x: 2, y: 2.45 },
    'Shift temporarily enables magnetic snapping when normal snapping is off',
);
movingAdapter.endMove(false);
assert.deepEqual({ x: movingPad.x, y: movingPad.y }, { x: 0, y: 0 });
const rotatingPad = new Pad({ x: 0, y: 0, shape: 'rectangle', size: 2, ratio: 2 });
const rotationInput = fakeElement('input');
rotationInput.value = '';
document.getElementById = id => id === 'pcbPropPadRotation' ? rotationInput : null;
const rotationApp = {
    pcbDocument: new PcbDocument(),
    viewport: { scale: 1 }, getLayerGroup: () => null,
    history: { execute() {} },
};
rotationApp.pcbDocument.pads.push(rotatingPad);
const rotationAdapter = createPadSelectionAdapter(rotationApp, rotatingPad, 'pad:rotating');
assert.equal(rotationAdapter.getAnchors().length, 1);
rotationAdapter.beginAnchorDrag('rotate', { x: 0, y: -4 });
rotationAdapter.updateAnchorDrag({ x: 2, y: -2 });
assert.equal(rotatingPad.rotation, 0, 'rotation preview leaves authored geometry unchanged');
assert.equal(rotationAdapter.object.rotation, 315);
assert.equal(rotationInput.value, '315', 'rotation property follows the dragged handle');
assert.ok(padOutline(rotationAdapter.object)[1].y > 0, 'pad geometry follows the pointer rotation direction');
rotationAdapter.endAnchorDrag(false);

function svgElement(name) {
    const element = fakeElement(name);
    element.localName = name;
    return element;
}
document.createElementNS = (_namespace, name) => svgElement(name);
document.getElementById = () => null;
assert.doesNotThrow(() => renderTrack({ edges: new Map() }, () => null),
    'track rendering has no stale Via drill-colour dependency');
const renderGroups = new Map([
    ['top-copper', svgElement('g')],
    ['top-copper-track-labels', svgElement('g')],
    ['bottom-copper', svgElement('g')],
    ['top-copper-pad-drills', svgElement('g')],
    ['bottom-copper-pad-drills', svgElement('g')],
    ['hole', svgElement('g')],
]);
const renderedPad = new Pad({
    id: 'pad_render', x: 3, y: 4, shape: 'round', size: 2, drill: 1, layers: 'both',
});
renderPad(renderedPad, layer => renderGroups.get(layer));
for (const layer of ['top-copper', 'bottom-copper']) {
    const copperPath = renderGroups.get(layer).children[0];
    assert.equal(copperPath.localName, 'path');
    assert.equal(copperPath.getAttribute('fill-rule'), 'evenodd');
    assert.equal(copperPath.getAttribute('fill-opacity'), '1');
    assert.match(copperPath.getAttribute('d'), /A0\.5,0\.5 0 1 0/,
        'Pad copper contains a transparent circular drill cutout');
    const drill = renderGroups.get(`${layer}-pad-drills`).children[0];
    assert.equal(drill.getAttribute('fill'), 'var(--pcb-drill, #1a1a2e)',
        'Pad drill masks underlying normal and hover copper just like a Via');
    assert.equal(drill.getAttribute('r'), '0.5');
    assert.equal(drill.dataset.padId, renderedPad.id);
}
renderPad(renderedPad, layer => renderGroups.get(layer));
assert.equal(renderGroups.get('top-copper-pad-drills').children.length, 1,
    're-render replaces the old Pad drill mask');
assert.equal(renderGroups.get('hole').children.length, 0,
    'Pad drills are not covered by an opaque hole-layer disc');
assert.match(padCopperPathD(renderedPad), /^M.*Z M|^M.*ZM/,
    'Pad copper path includes an outer contour and bore contour');
const viaLayer = svgElement('g');
renderVia({ id: 'via_render', x: 3, y: 4, diameter: 1, drill: 0.5 },
    layer => layer === 'vias' ? viaLayer : null);
assert.equal(viaLayer.children[0].getAttribute('fill-opacity'), '1',
    'Via copper rings render fully opaque');
assert.equal(viaLayer.children[0].localName, 'path');
assert.equal(viaLayer.children[0].getAttribute('fill-rule'), 'evenodd');
assert.equal(viaLayer.children[1].localName, 'circle');
assert.equal(viaLayer.children[1].getAttribute('r'), '0.25');
assert.equal(viaLayer.children[1].getAttribute('fill'), 'var(--pcb-drill, #1a1a2e)',
    'Via drill masks tracks rendered beneath the bore');
assert.match(viaCopperPathD({ x: 3, y: 4, diameter: 1, drill: 0.5 }),
    /A0\.25,0\.25 0 1 0/, 'Via copper path contains a transparent drill cutout');
const labelledTrack = new Track({
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    layer: 'top-copper',
    width: 0.4,
    net: 'GND',
});
renderTrack(labelledTrack, layer => renderGroups.get(layer));
assert.equal(renderGroups.get('top-copper').children.some(element => element.localName === 'text'), false,
    'Track labels are not left beneath vias');
assert.equal(renderGroups.get('top-copper-track-labels').children.some(element => element.localName === 'text'), true,
    'Track labels render above vias');
const viaLock = createViaSelectionAdapter({ viewport: { scale: 20 } },
    { id: 'via_lock', x: 3, y: 4, diameter: 1 }, 'via:lock')
    .getLockPosition({ x: 3.5, y: 4 }, 20);
assert.ok(viaLock && Number.isFinite(viaLock.x) && Number.isFinite(viaLock.y),
    'Via adapter renders a finite pointer-relative lock position');
const copperCircle = {
    kind: 'circle', x: 0, y: 0, radius: 5, layer: 'top-copper',
    filled: true, copperMode: 'add',
};
const circlePointer = { x: 5, y: 0 };
const thinCircleLock = createBoardShapeSelectionAdapter({},
    { ...copperCircle, id: 'thin', lineWidth: 0.2 }, 'shape:thin')
    .getLockPosition(circlePointer, 20);
const fatCircleLock = createBoardShapeSelectionAdapter({},
    { ...copperCircle, id: 'fat', lineWidth: 3 }, 'shape:fat')
    .getLockPosition(circlePointer, 20);
assert.deepEqual(fatCircleLock, thinCircleLock,
    'equal-diameter copper circles place locks identically regardless of stored line width');
const fatArcLine = {
    id: 'fat-arc', kind: 'line', layer: 'top-copper', lineWidth: 0.2,
    segmentWidths: { 0: 4 },
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
};
const fatArcLock = createBoardShapeSelectionAdapter({}, fatArcLine, 'shape:fat-arc')
    .getLockPosition({ x: 5, y: 0 }, 20);
const fatArcBounds = lockIconMetrics(20).bounds;
const fatArcVisibleGap = -2 - (fatArcLock.y + fatArcBounds.maxY);
assert.ok(Math.abs(fatArcVisibleGap - LOCK_SCREEN_GAP_PX / 20) < 0.02,
    'fat line/arc lock clears the rendered per-segment width');
const holeLayerState = PCB_LAYERS.find(layer => layer.id === 'hole');
const viaLayerState = PCB_LAYERS.find(layer => layer.id === 'vias');
assert.ok(viaLayerState, 'PCB layer panel exposes a dedicated Vias layer');
const originalHoleState = { visible: holeLayerState.visible, locked: holeLayerState.locked };
const originalViaState = { visible: viaLayerState.visible, locked: viaLayerState.locked };
holeLayerState.visible = false;
holeLayerState.locked = true;
viaLayerState.visible = true;
viaLayerState.locked = false;
assert.equal(isViaVisible(), true, 'hiding Hole does not hide Vias');
assert.equal(isViaLocked(), false, 'locking Hole does not lock Vias');
viaLayerState.visible = false;
viaLayerState.locked = true;
assert.equal(isViaVisible(), false);
assert.equal(isViaLocked(), true);
Object.assign(holeLayerState, originalHoleState);
Object.assign(viaLayerState, originalViaState);

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
}), /drill between 0 \(no hole\) and size/);
assert.equal(validateProject({
    ...project, pcb: { ...project.pcb, pads: [{ ...longPad, drill: 0 }] },
}).pcb.pads[0].drill, 0, 'a pad without a hole is a valid project pad');

const { exportGerbers } = await import('../../src/pcb/modules/gerber.js');
const { boardCutoutEdgeRings, standalonePadEdgeMesh, standalonePadMesh } = await import('../../src/pcb/modules/board3d.js');
const { clipMeshToOutline } = await import('../../src/pcb/modules/board3d-mesh-ops.js');
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

// Test pads: a zero drill means no hole anywhere (model, render, drill file, 3D).
const testPad = new Pad({ x: 40, y: -20, shape: 'round', size: 1.5, drill: 0, layers: 'top-copper' });
assert.equal(testPad.drill, 0, 'a zero drill is kept, not replaced by the default');
assert.equal(Pad.fromJSON(testPad.toJSON()).drill, 0, 'a hole-less pad round-trips');
assert.equal(new Pad({ drill: -1 }).drill, 0.8, 'a negative drill still falls back to the default');
for (const group of renderGroups.values()) group.children.length = 0;
renderPad(testPad, layer => renderGroups.get(layer));
assert.equal(renderGroups.get('top-copper-pad-drills').children.length, 0, 'no drill mask is drawn');
assert.doesNotMatch(padCopperPathD(testPad), /Z\s*M/, 'pad copper has no bore contour');
const testFiles = exportGerbers({
    placements: new Map(), tracks: [], vias: [], pads: [testPad],
    boardWidth: 100, boardHeight: 80,
});
assert.ok(testFiles.get('board.gtl').includes('D03*'), 'the test pad is emitted on top copper');
for (const [name, content] of testFiles) {
    if (name.endsWith('.drl')) assert.doesNotMatch(content, /^T\d+C/m, `${name} has no tool for a hole-less pad`);
}
for (const layers of ['top-copper', 'bottom-copper', 'both']) {
    const mesh = standalonePadMesh(new Pad({ ...testPad.captureState(), layers }));
    const heights = [...new Set(mesh.verts.map(vertex => vertex.y))];
    assert.equal(heights.length, layers === 'both' ? 2 : 1, `${layers} hole-less pad is flat copper on its faces only`);
}
const drilledHeights = new Set(standalonePadMesh(new Pad({ ...testPad.captureState(), drill: 0.6 })).verts.map(vertex => vertex.y));
assert.ok(drilledHeights.size >= 2, 'a drilled pad still spans the board with a barrel');

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
const edgeJunctions = [...new Set(edgeMesh.verts.map(vertex => vertex.z))]
    .filter(z => z > -22 + 1e-9 && z < -18 - 1e-9)
    .sort((first, second) => first - second);
assert.ok(Math.abs(edgeJunctions[0] + 20.98) < 1e-9);
assert.ok(Math.abs(edgeJunctions[1] + 19.02) < 1e-9,
    'axis-aligned edge plating terminates exactly on the barrel polygon');
const diagonalAngle = Math.PI / 16;
const diagonalDirection = { x: Math.cos(diagonalAngle), z: Math.sin(diagonalAngle) };
const diagonalNormal = { x: -diagonalDirection.z, z: diagonalDirection.x };
const diagonalMesh = standalonePadEdgeMesh(
    new Pad({ x: 0, y: 0, shape: 'round', size: 4, drill: 2, layers: 'both' }),
    [
        { x: -10 * diagonalDirection.x, z: -10 * diagonalDirection.z },
        { x: 10 * diagonalDirection.x, z: 10 * diagonalDirection.z },
        { x: 10 * diagonalDirection.x + 10 * diagonalNormal.x,
            z: 10 * diagonalDirection.z + 10 * diagonalNormal.z },
        { x: -10 * diagonalDirection.x + 10 * diagonalNormal.x,
            z: -10 * diagonalDirection.z + 10 * diagonalNormal.z },
    ],
);
const diagonalJunctionDistances = [...new Set(diagonalMesh.verts
    .map(vertex => Math.hypot(vertex.x, vertex.z).toFixed(9)))]
    .map(Number)
    .filter(distance => distance < 1.5);
assert.deepEqual(diagonalJunctionDistances, [Number((0.98 * Math.cos(Math.PI / 16)).toFixed(9))],
    'oblique edge plating meets the barrel facets exactly without a gap or hanging overlap');
assert.ok(clipMeshToOutline(edgeMesh,
    [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: -80 }, { x: 0, z: -80 }]).faces.length > 0,
'castellation edge plating survives board-outline clipping');
const cutoutRings = boardCutoutEdgeRings([{
    x: 50, z: -40, r: 5, boardShape: true,
    ring: [
        { x: 45, z: -45 }, { x: 55, z: -45 },
        { x: 55, z: -35 }, { x: 45, z: -35 },
    ],
}]);
const cutoutEdgeMesh = standalonePadEdgeMesh(
    new Pad({ x: 45, y: -40, shape: 'round', size: 4, drill: 2, layers: 'both' }),
    cutoutRings[0],
);
assert.equal(cutoutEdgeMesh.faces.length, 4,
    'castellation plates both strips where a Pad meets an internal routed edge');
assert.ok(cutoutEdgeMesh.verts.every(vertex => Math.abs(vertex.x - 45) < 1e-9));

console.log('PASS standalone pad model, aliases, geometry, validation and fabrication');
