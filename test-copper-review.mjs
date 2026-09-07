import assert from 'node:assert/strict';
import { resolveCopperPads } from './src/pcb/modules/copper-model.js';
import { buildCopperClusters, unionCoincidentClusters } from './src/pcb/modules/copper-connectivity.js';
import { spatialPairs } from './src/core/spatial-pairs.js';
import { pointInPolygon } from './src/core/geometry.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: () => ({ setAttribute() {}, appendChild() {} }) };
const { buildFillContext } = await import('./src/pcb/modules/fill-context.js');
const { computeFillPolygons, loadClipper } = await import('./src/pcb/modules/copper-fill-geom.js');
const { CopperFill } = await import('./src/shapes/copper-fill.js');
const { collectCopper, runDRC } = await import('./src/pcb/modules/drc.js');
const { CompoundCommand } = await import('./src/pcb/modules/track-commands.js');
const { deferDerivedUpdate } = await import('./src/core/DerivedUpdates.js');
const { cancelGroupDrag } = await import('./src/pcb/modules/box-select.js');
const { Track } = await import('./src/shapes/track.js');

const rectangle = (left, top, right, bottom) => [
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
];
const board = () => ({ tracks: [], vias: [], texts: new Map(), boardShapes: [], copperFills: [],
    placements: new Map(), netlist: [], _getRoutingParams: () => ({ clearance: 0.2 }) });
const app = board();
app.placements.set('U1', { x: 5, y: 0, rotation: 0, padOffsets: [
    { number: '1', padId: '1', dx: 0, dy: 0, width: 1, height: 1, layer: 'top' },
    { number: '1', padId: '1#2', dx: 3, dy: 0, width: 1, height: 1, layer: 'bottom' },
] });
app.netlist = [{ net: 'GND', pins: [{ componentId: 'U1', pinNumber: '1' }] }];
assert.deepEqual(resolveCopperPads(app).map((pad) => [pad.padId, pad.net, pad.layer]),
    [['1', 'GND', 'top'], ['1#2', 'GND', 'bottom']]);
assert.deepEqual(buildCopperClusters(app).map((cluster) => cluster.layer), ['top-copper', 'bottom-copper']);
app.placements.get('U1').side = 'bottom';
assert.equal(resolveCopperPads(app)[1].x, 2);

const clusters = ['top-copper', 'bottom-copper', 'all'].map((layer) => ({ layer, net: 'GND', points: [{ x: 0, y: 0 }] }));
let unions = [];
unionCoincidentClusters(clusters.slice(0, 2), (...pair) => unions.push(pair), true);
assert.equal(unions.length, 0);
unionCoincidentClusters(clusters, (...pair) => unions.push(pair), true);
assert.equal(unions.length, 2);
unions = [];
unionCoincidentClusters([clusters[0], { ...clusters[0], net: 'VCC' }], (...pair) => unions.push(pair), true);
assert.equal(unions.length, 0);

const fillApp = board();
const first = new CopperFill({ net: 'GND', outline: rectangle(0, 0, 10, 10) });
const second = new CopperFill({ net: 'VCC', outline: rectangle(5, 0, 15, 10) });
fillApp.copperFills = [first, second];
const context = buildFillContext(fillApp);
assert.deepEqual(context.fills, [first, second]);
const clipper = await loadClipper();
const clearanceCases = [
    ...[0.6, 2].map((diameter) => ({
        name: `via-${diameter}`,
        populate(target) {
            const via = { id: 'clearance-via', net: 'VCC', x: 0.12345, y: -0.23456, diameter, drill: 0.3 };
            target.vias.push(via);
            return () => { via.x += 0.05; };
        },
    })),
    ...[0, 37, 90].map((angle) => ({
        name: `track-${angle}`,
        populate(target) {
            const radians = angle * Math.PI / 180;
            const track = new Track({ net: 'VCC', layer: 'top-copper', width: 0.4,
                points: [{ x: 0.12345, y: 0.23456 },
                    { x: 0.12345 + 3 * Math.cos(radians), y: 0.23456 + 3 * Math.sin(radians) }] });
            target.tracks.push(track);
            return () => { for (const node of track.nodes.values()) node.x += 0.05; };
        },
    })),
    ...['rect', 'circle', 'ellipse', 'oval'].flatMap((shape) => [0, 37, 90].map((rotation) => ({
        name: `${shape}-pad-${rotation}`,
        populate(target) {
            const placement = { x: 0.12345, y: -0.23456, rotation, mirror: true,
                padOffsets: [{ number: '1', padId: '1', dx: 0, dy: 0,
                    width: shape === 'circle' ? 1 : 2, height: 1, shape, layer: 'top' }] };
            target.placements.set('P1', placement);
            target.netlist = [{ net: 'VCC', pins: [{ componentId: 'P1', pinNumber: '1' }] }];
            return () => { placement.x += 0.05; };
        },
    }))),
];
for (const fixture of clearanceCases) {
    for (const clearance of [0.1, 0.2, 0.5, 1.67]) {
        const target = board();
        target._getRoutingParams = () => ({ clearance });
        const moveObstacle = fixture.populate(target);
        const pour = new CopperFill({ net: 'GND', outline: rectangle(-10, -10, 10, 10) });
        target.copperFills = [pour];
        pour._computed = computeFillPolygons(pour, buildFillContext(target), clipper);
        assert.ok(pour._computed.length, `${fixture.name}: pour must not be empty`);
        const result = runDRC(target, { clearance });
        assert.equal(result.ok, true, `${fixture.name}, clearance ${clearance}: ${JSON.stringify(result.violations)}`);
        moveObstacle();
        assert.equal(runDRC(target, { clearance }).violations.some((violation) => violation.rule === 'clearance'), true,
            `${fixture.name}: encroaching on an existing pour must still fail clearance`);
    }
}
const contains = (polygons, point) => polygons.some((polygon) => pointInPolygon(point, polygon.outer)
    && !polygon.holes.some((hole) => pointInPolygon(point, hole)));
for (const clearance of [0.1, 0.5, 1.67]) {
    for (const layer of ['top-copper', 'bottom-copper']) {
        const target = board();
        target._getRoutingParams = () => ({ clearance });
        const circle = { id: 'pshape_4', kind: 'circle', layer, filled: false, copperMode: 'add',
            net: '', x: 44.45, y: -55.88, radius: 16.51, lineWidth: 5.1 };
        target.boardShapes = [circle];
        const pour = new CopperFill({ net: 'GND', layer, outline: rectangle(10, -90, 80, -20) });
        target.copperFills = [pour];
        pour._computed = computeFillPolygons(pour, buildFillContext(target), clipper);
        assert.equal(contains(pour._computed, { x: circle.x, y: circle.y }), true,
            'A hollow circle must retain copper poured inside its ring');
        assert.equal(contains(pour._computed, { x: 12, y: -55.88 }), true,
            'A hollow circle must retain copper poured outside its ring');
        const result = runDRC(target, { clearance });
        assert.equal(result.ok, true, `Hollow circle ${layer}, clearance ${clearance}: ${JSON.stringify(result.violations)}`);
        circle.x += 0.1;
        assert.equal(runDRC(target, { clearance }).violations.some((violation) => violation.rule === 'clearance'), true,
            'Moving the circle into an unchanged pour must still fail clearance');
    }
}
assert.equal(contains(computeFillPolygons(first, context, clipper), { x: 7, y: 5 }), false);
assert.equal(contains(computeFillPolygons(second, context, clipper), { x: 7, y: 5 }), false);
assert.equal(contains(computeFillPolygons(first, context, clipper), { x: 2, y: 5 }), true);

fillApp.texts.set('label', { id: 'label', content: 'I', x: 2, y: 5, size: 2, strokeWidth: 0.2, layer: 'top-copper' });
second.net = 'GND';
second.outline = first.outline;
const reusable = buildFillContext(fillApp);
assert.equal([...reusable.texts].length, 1);
assert.equal([...reusable.texts].length, 1);
assert.deepEqual(computeFillPolygons(first, reusable, clipper), computeFillPolygons(second, reusable, clipper));
assert.notDeepEqual(computeFillPolygons(first, reusable, clipper),
    computeFillPolygons(first, { ...reusable, texts: [] }, clipper));

const drcApp = board();
drcApp.boardShapes.push({ id: 'plane', kind: 'rect', filled: true, copperMode: 'add', layer: 'top-copper',
    net: 'GND', lineWidth: 0.2, points: rectangle(-5, -5, 5, 5) });
drcApp.vias.push({ id: 'v1', net: 'VCC', x: 0, y: 0, diameter: 0.6, drill: 0.3 });
assert.equal(runDRC(drcApp).ok, false);
drcApp.boardShapes = [];
drcApp.copperFills = [{ id: 'f1', layer: 'top-copper', net: 'GND', _computed: [
    { outer: rectangle(-5, -5, 5, 5), holes: [rectangle(-2, -2, 2, 2)] },
] }];
assert.equal(runDRC(drcApp).ok, true);
drcApp.copperFills[0]._computed[0].holes = [];
assert.equal(runDRC(drcApp).ok, false);
drcApp.copperFills[0]._computed = null;
assert.equal(runDRC(drcApp).violations.some((violation) => violation.id === 'drc:fill-pending|f1'), true);
drcApp.copperFills = [];
drcApp.texts = fillApp.texts;
const textSegment = collectCopper(drcApp).segments[0];
assert.ok(textSegment);
drcApp.vias[0].x = (textSegment.ax + textSegment.bx) / 2;
drcApp.vias[0].y = (textSegment.ay + textSegment.by) / 2;
assert.equal(runDRC(drcApp).ok, false);

const bounds = (item) => ({ minX: item.x, maxX: item.x + 1, minY: item.y, maxY: item.y + 1 });
const sparse = Array.from({ length: 2000 }, (_, index) => ({ x: index * 10, y: 0 }));
assert.equal([...spatialPairs(sparse, bounds, 0.2)].length, 0);
assert.equal([...spatialPairs([{ x: 0, y: 0 }, { x: 1.1, y: 0 }], bounds, 0.2)].length, 1);

const owner = {};
let refreshes = 0;
let edits = 0;
const refresh = () => { if (!deferDerivedUpdate(owner, 'ratsnest', refresh)) refreshes++; };
const command = () => ({ app: owner, execute() { edits++; refresh(); }, undo() { edits--; refresh(); } });
const batch = new CompoundCommand([command(), new CompoundCommand([command(), command()])]);
batch.execute();
assert.equal(edits, 3);
assert.equal(refreshes, 1);
batch.undo();
assert.equal(edits, 0);
assert.equal(refreshes, 2);
assert.throws(() => new CompoundCommand([command(), { app: owner, execute() { throw new Error('failed'); } }]).execute(), /failed/);
assert.equal(edits, 0);
assert.equal(refreshes, 3);
const dragApp = board();
dragApp._getLayerGroup = () => null;
dragApp._layerGroups = new Map();
dragApp.placements.set('U1', { x: 10, y: 20, pads: new Map(), padOffsets: [] });
const draggedTrack = new Track({ net: 'GND', points: [{ x: 0, y: 0 }, { x: 3, y: 0 }] });
const originalTrack = draggedTrack.captureState();
for (const node of draggedTrack.nodes.values()) node.x += 10;
dragApp.tracks.push(draggedTrack);
const draggedVia = { x: 12, y: 23, diameter: 0.6, drill: 0.3 };
dragApp.vias.push(draggedVia);
let fillRefreshes = 0;
dragApp._refreshFills = () => { fillRefreshes++; };
dragApp._groupDrag = { previousDeferDragOverlays: false,
    comps: [{ id: 'U1', x: 0, y: 0 }], vias: [{ via: draggedVia, x: 2, y: 3 }],
    tracks: [{ track: draggedTrack, before: originalTrack }], shapes: [], texts: [], fills: [] };
cancelGroupDrag(dragApp);
assert.equal(dragApp._groupDrag, null);
assert.equal(dragApp._deferDragOverlays, false);
assert.equal(dragApp.placements.get('U1').x, 0);
assert.deepEqual([draggedVia.x, draggedVia.y], [2, 3]);
assert.deepEqual(draggedTrack.captureState(), originalTrack);
assert.equal(fillRefreshes, 1);
console.log('PASS: copper layers, pad identities, pours, DRC, spatial pairs, and derived-update batching');