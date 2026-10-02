import assert from 'node:assert/strict';
import { getComputedFill, setComputedFill } from '../src/pcb/modules/computed-fill-cache.js';
import { resolveCopperPads } from '../src/pcb/modules/copper-model.js';
import { buildCopperClusters, unionCoincidentClusters } from '../src/pcb/modules/copper-connectivity.js';
import { spatialPairs } from '../src/core/spatial-pairs.js';
import { pointInPolygon } from '../src/core/geometry.js';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { Component } from '../src/components/Component.js';
import { Via } from '../src/shapes/via.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: () => ({ setAttribute() {}, appendChild() {} }) };
const { buildFillContext } = await import('../src/pcb/modules/fill-context.js');
const { computeFillPolygons, loadClipper } = await import('../src/pcb/modules/copper-fill-geom.js');
const { CopperFill } = await import('../src/shapes/copper-fill.js');
const { collectCopper, runDRC } = await import('../src/pcb/modules/drc.js');
const { CompoundCommand, getPlacementPreviewTracks } = await import('../src/pcb/modules/track-commands.js');
const { deferDerivedUpdate } = await import('../src/core/DerivedUpdates.js');
const { beginGroupDrag, updateGroupDrag, cancelGroupDrag, getGroupPreview } = await import('../src/pcb/modules/box-select.js');
const { setPcbSelection } = await import('../src/pcb/modules/selection-registry.js');
const { Track } = await import('../src/shapes/track.js');

const rectangle = (left, top, right, bottom) => [
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
];
const board = () => ({ tracks: [], vias: [], texts: new Map(), boardShapes: [], copperFills: [],
    placements: new Map(), netlist: [], getRoutingParams: () => ({ clearance: 0.2 }) });
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
        target.getRoutingParams = () => ({ clearance });
        const moveObstacle = fixture.populate(target);
        const pour = new CopperFill({ net: 'GND', outline: rectangle(-10, -10, 10, 10) });
        target.copperFills = [pour];
        setComputedFill(pour, computeFillPolygons(pour, buildFillContext(target), clipper));
        assert.ok(getComputedFill(pour).length, `${fixture.name}: pour must not be empty`);
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
        target.getRoutingParams = () => ({ clearance });
        const circle = { id: 'pshape_4', kind: 'circle', layer, filled: false, copperMode: 'add',
            net: '', x: 44.45, y: -55.88, radius: 16.51, lineWidth: 5.1 };
        target.boardShapes = [circle];
        const pour = new CopperFill({ net: 'GND', layer, outline: rectangle(10, -90, 80, -20) });
        target.copperFills = [pour];
        setComputedFill(pour, computeFillPolygons(pour, buildFillContext(target), clipper));
        assert.equal(contains(getComputedFill(pour), { x: circle.x, y: circle.y }), true,
            'A hollow circle must retain copper poured inside its ring');
        assert.equal(contains(getComputedFill(pour), { x: 12, y: -55.88 }), true,
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
drcApp.copperFills = [{ id: 'f1', layer: 'top-copper', net: 'GND' }];
setComputedFill(drcApp.copperFills[0], [
    { outer: rectangle(-5, -5, 5, 5), holes: [rectangle(-2, -2, 2, 2)] },
]);
assert.equal(runDRC(drcApp).ok, true);
getComputedFill(drcApp.copperFills[0])[0].holes = [];
assert.equal(runDRC(drcApp).ok, false);
setComputedFill(drcApp.copperFills[0], null);
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
const project = new ProjectDocument(), model = project.pcbDocument;
project.schematicDocument.components.push(new Component({
    name: 'CopperGroup', _source: 'KiCad', symbol: { pins: [{ number: '1' }] },
    footprintShapes: ['PAD~RECT~2~1~1~1~1~both~1~0~0.5'],
}, { id: 'U1' }));
model.placementState.record('U1', { x: 0, y: 0, rotation: 0 });
const dragApp = {
    ...board(), project, pcbDocument: model, placements: project.resolvePcbLayout().placements,
    get tracks() { return getGroupPreview(this)?.tracks || getPlacementPreviewTracks(this) || model.tracks; },
    get vias() { return getGroupPreview(this)?.vias || model.vias; },
};
dragApp.getLayerGroup = () => null;
dragApp._layerGroups = new Map();
const draggedTrack = new Track({ net: 'GND', points: [{ x: 0, y: 0 }, { x: 3, y: 0 }] });
const originalTrack = draggedTrack.captureState();
model.tracks.push(draggedTrack);
const draggedVia = new Via({ x: 2, y: 3, diameter: 0.6, drill: 0.3 });
model.vias.push(draggedVia);
const before = model.serialize();
let fillRefreshes = 0;
dragApp.refreshFills = () => { fillRefreshes++; };
setPcbSelection(dragApp, [
    { kind: 'component', object: 'U1' }, { kind: 'track', object: draggedTrack }, { kind: 'via', object: draggedVia },
]);
beginGroupDrag(dragApp, { x: 0, y: 0 });
updateGroupDrag(dragApp, { x: 10, y: 20 }, { snap: false });
assert.deepEqual([dragApp.vias[0].x, dragApp.vias[0].y], [12, 23]);
assert.equal(dragApp.tracks[0].nodes.values().next().value.x, 10);
assert.deepEqual(model.serialize(), before, 'Group preview does not author copper or component placements');
assert.deepEqual(draggedTrack.captureState(), originalTrack);
cancelGroupDrag(dragApp);
assert.equal(dragApp._groupDrag, null);
assert.equal(dragApp._deferDragOverlays, false);
assert.equal(dragApp.placements.get('U1').x, 0);
assert.deepEqual([draggedVia.x, draggedVia.y], [2, 3]);
assert.deepEqual(draggedTrack.captureState(), originalTrack);
assert.deepEqual(model.serialize(), before);
assert.equal(fillRefreshes, 0, 'Discarding an isolated preview retains settled fills without repouring');
console.log('PASS: copper layers, pad identities, pours, DRC, spatial pairs, and derived-update batching');