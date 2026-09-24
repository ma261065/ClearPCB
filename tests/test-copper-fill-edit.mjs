import assert from 'node:assert/strict';
import { CopperFill } from '../src/shapes/copper-fill.js';

globalThis.window = { addEventListener() {} };
globalThis.document = {};
const { shapeOutline, getBoardShapeAnchors, loadBoardShapes, serializeBoardShapes } = await import('../src/pcb/modules/board-shapes.js');
const { beginFillEdit, updateFillEdit, endFillEdit, deleteFillNode, deleteFocusedFillPart,
    commitFillEdit, startFillEditAt } = await import('../src/pcb/modules/copper-fill-edit.js');
const { createCopperFillSelectionAdapter } = await import('../src/pcb/modules/copper-fill-selection.js');
const { computeFillPolygons, loadClipper } = await import('../src/pcb/modules/copper-fill-geom.js');
const { prepareFabricationSnapshot } = await import('../src/pcb/modules/fabrication-snapshot.js');
const { PCB_LAYERS, PCB_COPPER_FILLS } = await import('../src/pcb/modules/layers.js');
const outline = [{ x: 2, y: -2 }, { x: 18, y: -2 }, { x: 18, y: -18 }, { x: 2, y: -18 }];

for (const options of [
    { outline },
    { outline, kind: 'rect', cornerRadius: 2 },
    { outline, cornerRadius: 2, nodeCornerRadii: { 0: 1 }, segmentBulges: { 1: 0.2 } },
    { kind: 'circle', x: 10, y: -10, radius: 6 },
]) {
    const fill = new CopperFill({ ...options, net: 'GND' });
    assert.deepEqual(fill.getOutline(), shapeOutline({ ...options, kind: fill.kind, points: fill.outline }));
    const loaded = CopperFill.fromJSON(fill.toJSON());
    assert.deepEqual(loaded.captureState(), fill.captureState(), 'Geometry survives compact save/load');
    const clone = fill.clone();
    assert.notEqual(clone.id, fill.id);
    assert.deepEqual(clone.getOutline(), fill.getOutline());
    clone.move(3, 5);
    const translated = fill.getOutline().map(point => ({ x: point.x + 3, y: point.y + 5 }));
    clone.getOutline().forEach((point, index) => assert.ok(Math.hypot(point.x - translated[index].x, point.y - translated[index].y) < 1e-9));
    const app = { boardShapes: [fill] };
    const saved = serializeBoardShapes(app);
    const restored = { boardShapes: [] };
    loadBoardShapes(restored, saved, { render: false, strict: true });
    assert.deepEqual(restored.boardShapes[0].getOutline(), fill.getOutline());
}
const rounded = new CopperFill({ outline, kind: 'rect', cornerRadius: 3 });
assert.equal(rounded.containsPoint(2.1, -2.1), false);
assert.equal(rounded.containsPoint(10, -10), true);
assert.ok(rounded.distanceToEdge(2, -2) > 1);
const circle = new CopperFill({ kind: 'circle', x: 10, y: -10, radius: 5 });
assert.deepEqual(circle.getBounds(), { minX: 5, minY: -15, maxX: 15, maxY: -5 });
assert.ok(circle.distanceToEdge(15, -10) < 1e-9);
assert.deepEqual(getBoardShapeAnchors(circle).map(anchor => anchor.id), ['center', 'radius']);

const commands = [];
let crosshair = null;
const app = { viewport: { scale: 10, shiftHeld: true,
    setCrosshair(point) { crosshair = { ...point }; }, hideCrosshair() { crosshair = null; } }, placements: new Map(),
    tracks: [], vias: [], texts: new Map(), boardShapes: [],
    _getLayerGroup() { return null; }, _refreshFillProperties() {},
    history: { execute(command) { commands.push(command); command.execute(); } } };
const fill = new CopperFill({ outline, cornerRadius: 1, nodeCornerRadii: { 2: 2 }, segmentBulges: { 2: 0.25 } });
app.boardShapes.push(fill);
const before = fill.captureState();
assert.equal(beginFillEdit(app, fill, { x: 10, y: -2 }, 'mid:0'), true);
assert.deepEqual(crosshair, { x: 10, y: -2 }, 'Midpoint pickup shows the crosshair');
assert.equal(fill.outline.length, 5);
assert.equal(fill.segmentBulges[3], 0.25);
assert.equal(fill.nodeCornerRadii[3], 2);
updateFillEdit(app, { x: 10, y: -1 });
assert.deepEqual(crosshair, fill.outline[1], 'Crosshair follows the inserted vertex');
endFillEdit(app, false);
assert.equal(crosshair, null, 'Cancel hides the crosshair');
assert.deepEqual(fill.captureState(), before, 'Cancel restores vertices and metadata');
assert.equal(commands.length, 0);
assert.equal(app._deferDragOverlays, false);

beginFillEdit(app, fill, { x: 10, y: -2 }, 'mid:0');
updateFillEdit(app, { x: 10, y: -1 });
endFillEdit(app, true);
assert.equal(crosshair, null, 'Commit hides the crosshair');
assert.equal(commands.length, 1);
assert.equal(fill.outline.length, 5);
commands.at(-1).undo();
assert.deepEqual(fill.captureState(), before);
commands.at(-1).execute();
assert.equal(fill.outline.length, 5);
assert.equal(deleteFillNode(app, fill, 1), true);
assert.equal(fill.segmentBulges[2], 0.25);
assert.equal(fill.nodeCornerRadii[2], 2);
assert.equal(fill.outline.length, 4);
assert.equal(deleteFillNode(app, fill, 1), true);
assert.equal(fill.outline.length, 3);
assert.equal(deleteFillNode(app, fill, 1), false, 'Closed boundary cannot drop below three vertices');
app._fillEdit = { fillId: fill.id, node: 1 };
assert.equal(deleteFocusedFillPart(app, fill), true, 'Blocked node deletion must not delete the entire fill');

const plain = new CopperFill({ outline });
assert.equal(commitFillEdit(app, plain, () => { plain.segmentBulges[0] = 0.2; }), true);
assert.ok(plain.getOutline().length > plain.outline.length);
commands.at(-1).undo();
assert.deepEqual(plain.segmentBulges, {});
const state = plain.captureState();
assert.equal(commitFillEdit(app, plain, () => {
    plain.outline = [outline[0], outline[2], outline[1], outline[3]];
}), false, 'Reject self-intersection');
assert.deepEqual(plain.captureState(), state);
assert.equal(startFillEditAt(app, plain, { x: 100, y: 100 }), false, 'Unrelated clicks must not begin a fill drag');

app.boardShapes = [circle];
beginFillEdit(app, circle, { x: 15, y: -10 }, 'radius');
updateFillEdit(app, { x: 16, y: -10 });
endFillEdit(app, true);
assert.equal(circle.radius, 6);
commands.at(-1).undo();
assert.equal(circle.radius, 5);
beginFillEdit(app, circle, { x: 10, y: -10 });
updateFillEdit(app, { x: 12, y: -7 });
endFillEdit(app, true);
assert.equal(circle.x, 12);
assert.equal(circle.y, -7);
commands.at(-1).undo();
assert.equal(circle.x, 10);
assert.equal(circle.y, -10);

for (const [region, anchor, point] of [
    [new CopperFill({ outline }), 0, { x: 3, y: -3 }],
    [new CopperFill({ outline, segmentBulges: { 0: 0.25 } }), 'bulge:0', { x: 8, y: -5 }],
    [circle, 'center', { x: 12, y: -12 }],
    [circle, 'radius', { x: 13, y: -6 }],
]) {
    const handlePoint = () => {
        const handle = getBoardShapeAnchors(region).find(item => item.id === anchor);
        return { x: handle.x, y: handle.y };
    };
    beginFillEdit(app, region, handlePoint(), anchor);
    assert.deepEqual(crosshair, handlePoint(), `${anchor} pickup shows the actual handle position`);
    updateFillEdit(app, point);
    assert.deepEqual(crosshair, handlePoint(), `${anchor} crosshair follows resolved geometry, not the raw pointer`);
    endFillEdit(app, false);
    assert.equal(crosshair, null);
}

const copperLayer = PCB_LAYERS.find(layer => layer.id === 'top-copper');
const fillLayer = PCB_COPPER_FILLS.find(layer => layer.id === 'top-copper');
const previousVisible = copperLayer.visible;
copperLayer.visible = false;
const adapter = createCopperFillSelectionAdapter(app, circle, 'fill:test');
assert.equal(adapter.visible, true, 'Hidden copper does not hide the independently visible pour');
assert.equal(adapter.hitTest({ x: 10, y: -10 }, 0.1), false, 'Interior clicks do not select fills');
assert.equal(adapter.hitTest({ x: 15, y: -10 }, 0.1), true);
fillLayer.locked = true;
assert.equal(beginFillEdit(app, circle, { x: 15, y: -10 }, 'radius'), false);
fillLayer.locked = false;
copperLayer.visible = previousVisible;

const clipper = await loadClipper();
const context = { tracks: [], vias: [], pads: [], texts: [], fills: [], boardShapes: [], holes: [], params: { clearance: 0.1 } };
for (const region of [rounded, circle, new CopperFill({ outline, segmentBulges: { 0: 0.25 } })]) {
    assert.deepEqual(computeFillPolygons(region, context, clipper),
        computeFillPolygons({ layer: region.layer, net: region.net, outline: region.getOutline() }, context, clipper),
        'Pour uses sampled curves rather than the control polygon');
    const snapshot = await prepareFabricationSnapshot({ ...app, boardShapes: [region], copperFills: [region],
        netlist: [], _boardWidth: 20, _boardHeight: 20, _getRoutingParams: () => ({ clearance: 0.1 }) });
    assert.deepEqual(snapshot.fills[0].outline, region.getOutline());
    assert.ok(snapshot.fills[0]._computed.length > 0);
}
console.log('PASS copper fill curved geometry, save/load, editing, undo/cancel, selection and fabrication');