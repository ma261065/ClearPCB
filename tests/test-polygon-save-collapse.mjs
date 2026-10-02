import assert from 'node:assert/strict';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { Polyline } from '../src/shapes/polyline.js';
import { createShape } from '../src/shapes/index.js';
import { collapseRoundedPolygon } from '../src/shapes/path-operations.js';
import { validBoardOutline } from '../src/shared/pcb/board-outline.js';
import { validateProject, defaultPcbStackup } from '../src/core/project-format.js';
import { FileManager, readProjectFile } from '../src/core/FileManager.js';
import { PcbDocument } from '../src/core/PcbDocument.js';

globalThis.window = { addEventListener() {} };
const { serializeBoardShapes, loadBoardShapes } = await import('../src/pcb/modules/board-shapes.js');
const { preparePcb } = await import('../src/pcb/modules/project-state.js');
const { prepareFabricationSnapshot } = await import('../src/pcb/modules/fabrication-snapshot.js');
const round4 = value => Math.round(value * 10000) / 10000;
const points = [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0.00001 }, { x: 10, y: 0.00002 },
    { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 0.00001, y: 0.00001 },
];
const square = [points[0], points[1], points[4], points[5]];
const boardShape = (overrides = {}) => ({
    id: 'polygon', kind: 'polygon', layer: 'top-copper', lineWidth: 0.2,
    copperMode: 'add', filled: true, plated: false, net: '', points: structuredClone(points), ...overrides,
});
const save = shape => serializeBoardShapes({ boardShapes: [shape] })[0];
const restore = record => {
    const pcbDocument = new PcbDocument();
    const app = { pcbDocument, boardShapes: pcbDocument.boardShapes, _shapeIdCounter: 1 };
    loadBoardShapes(app, [record], { strict: true, render: false });
    return app.boardShapes[0];
};
const distinctNeighbours = savedPoints => savedPoints.forEach((point, index) =>
    assert.notDeepEqual(point, savedPoints[(index + 1) % savedPoints.length]));

for (const reverse of [false, true]) {
    const ordered = reverse ? [...points].reverse() : points;
    for (let start = 0; start < ordered.length; start++) {
        const shifted = [...ordered.slice(start), ...ordered.slice(0, start)];
        const live = boardShape({ layer: 'board-outline', points: shifted });
        const before = structuredClone(live);
        const saved = save(live);
        assert.equal(saved.points.length, 4, 'Runs and wraparound duplicate corners collapse in either winding');
        assert.equal(validBoardOutline(saved), true);
        distinctNeighbours(saved.points);
        assert.deepEqual(live, before);
        assert.deepEqual(save(restore(saved)), saved, 'Repeated saves stabilize');
        const prepared = preparePcb({ stackup: defaultPcbStackup(), boardShapes: [saved] });
        assert.deepEqual(prepared.boardShapes[0].points, saved.points);
    }
}

const widths = { 0: 0.3, 1: 0.4, 2: 0.4, 3: 0.4, 4: 0.5, 5: 0.6, 6: 0.3 };
const shape = boardShape({ segmentWidths: widths, segmentBulges: { 3: 0.25 },
    nodeCornerRadii: { 0: 0, 5: 0.2, 6: 0 } });
const before = structuredClone(shape);
const saved = save(shape);
assert.deepEqual(saved.points, square);
assert.deepEqual(saved.segmentWidths, { 0: 0.3, 1: 0.4, 2: 0.5, 3: 0.6 });
assert.deepEqual(saved.segmentBulges, { 1: 0.25 }, 'The surviving outgoing arc must not be straightened');
assert.deepEqual(saved.nodeCornerRadii, { 0: 0, 3: 0.2 });
assert.deepEqual(shape, before);
assert.deepEqual(save(restore(saved)), saved);
const redundant = save(boardShape({ segmentWidths: { 1: 0.2 }, segmentBulges: { 1: 0 } }));
assert.equal('segmentWidths' in redundant, false);
assert.equal('segmentBulges' in redundant, false);
assert.deepEqual(save(restore(redundant)), redundant, 'Removed-only override maps cannot destabilize repeat saves');

const fill = new CopperFill({ id: 'fill', kind: 'polygon', layer: 'top-copper', outline: points,
    segmentBulges: { 3: 0.25 }, nodeCornerRadii: { 5: 0.2 } });
const fillBefore = fill.captureState();
const savedFill = fill.toJSON();
assert.deepEqual(savedFill.pts, square.map(({ x, y }) => [x, y]));
assert.deepEqual(savedFill.segmentBulges, { 1: 0.25 });
assert.deepEqual(savedFill.nodeCornerRadii, { 3: 0.2 });
assert.deepEqual(CopperFill.fromJSON(savedFill).toJSON(), savedFill);
assert.deepEqual(fill.captureState(), fillBefore);
const redundantFill = new CopperFill({ kind: 'polygon', outline: points, segmentBulges: { 1: 0 } }).toJSON();
assert.equal('segmentBulges' in redundantFill, false);
assert.deepEqual(CopperFill.fromJSON(redundantFill).toJSON(), redundantFill);

const graphOptions = {
    id: 'schematic-polygon', closed: true, isRect: false, lineWidth: 0.2,
    graphNodes: Object.fromEntries(points.map((point, i) => [`n${i}`, point])),
    graphEdges: Object.fromEntries(points.map((_, i) => [`e${i}`, i % 2
        ? [`n${(i + 1) % points.length}`, `n${i}`] : [`n${i}`, `n${(i + 1) % points.length}`]])),
    edgeWidths: Object.fromEntries(Object.entries(widths).map(([i, width]) => [`e${i}`, width])),
    edgeBulges: { e3: -0.25 }, nodeCornerRadii: { n5: 0.2 },
};
const schematic = new Polyline(graphOptions);
const schematicBefore = schematic.captureState();
const savedSchematic = schematic.toJSON();
assert.deepEqual(savedSchematic.nd, { n0: [0, 0], n1: [10, 0], n4: [10, 10], n5: [0, 10] });
assert.deepEqual(savedSchematic.ed, { e0: ['n0', 'n1'], e3: ['n4', 'n1'], e4: ['n4', 'n5'], e5: ['n0', 'n5'] });
assert.deepEqual(savedSchematic.bg, { e3: -0.25 }, 'Reversed edge direction and bulge sign stay unchanged');
assert.deepEqual(savedSchematic.ew, { e0: 0.3, e3: 0.4, e4: 0.5, e5: 0.6 });
assert.deepEqual(savedSchematic.ncr, { n5: 0.2 });
assert.deepEqual(createShape(savedSchematic).toJSON(), savedSchematic);
assert.deepEqual(schematic.captureState(), schematicBefore);

for (const [overrides, message] of [
    [{ segmentWidths: { 1: 0.7 } }, /conflicting width/],
    [{ nodeCornerRadii: { 1: 0.5 } }, /conflicting radii/],
    [{ segmentBulges: { 1: 0.25 } }, /curved edge/],
    [{ cornerRadius: 0.5 }, /rounded corner/],
    [{ points: [{ x: 0, y: 0 }, { x: 0.00001, y: 0 }, { x: 10, y: 0 }] }, /fewer than three/],
    [{ points: [{ x: 0, y: 0 }, { x: 0.00001, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }] }, /invalid closed outline/],
    [{ layer: 'board-outline', points: [{ x: 0, y: 0 }, { x: 0.00001, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }] },
        /invalid closed outline/],
]) {
    const invalid = boardShape(overrides), original = structuredClone(invalid);
    assert.throws(() => save(invalid), message);
    assert.deepEqual(invalid, original, 'Failed cleanup must leave live data untouched');
}
assert.throws(() => new CopperFill({ kind: 'polygon', outline: points, segmentBulges: { 1: 0.5 } }).toJSON(), /curved edge/);
assert.throws(() => new Polyline({ ...graphOptions, edgeWidths: { e1: 0.7 } }).toJSON(), /conflicting width/);
const openEdges = { ...graphOptions.graphEdges };
delete openEdges.e6;
assert.throws(() => new Polyline({ ...graphOptions, graphEdges: openEdges }).toJSON(), /simple closed graph/);

const noCollapse = boardShape({ points: [{ x: 0, y: 0 }, { x: 0.00006, y: 0 },
    { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] });
assert.equal(save(noCollapse).points.length, 5, 'Do not remove distinct rounded corners or simplify collinear edges');
const crossing = boardShape({ points: [{ x: 0, y: 0 }, { x: 0.00001, y: 0 },
    { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }] });
assert.equal(save(crossing).points.length, 4, 'Ordinary artwork polygons retain their supported even-odd crossings');
const nonPolygon = boardShape({ kind: 'line' });
assert.equal(save(nonPolygon).points.length, points.length, 'Open lines and electrical graphs are not polygon cleanup targets');
const raw = serializeBoardShapes({ boardShapes: [shape] }, { roundGeometry: false })[0];
assert.deepEqual(raw.points, points);
assert.deepEqual(raw.segmentWidths, widths);
const snapshot = await prepareFabricationSnapshot({
    placements: new Map(), tracks: [], vias: [], pads: [], texts: new Map(),
    copperFills: [fill], boardShapes: [shape, fill], _boardWidth: 20, _boardHeight: 20,
}, { computeFills: false });
assert.deepEqual(snapshot.boardShapes[0].points, points);
assert.deepEqual(snapshot.boardShapes[0].segmentBulges, shape.segmentBulges);
assert.deepEqual(snapshot.fills[0].outline, fill.getOutline());

const project = {
    type: 'clearpcb-project', version: '1.0', schematic: { shapes: [savedSchematic], components: [] },
    pcb: { stackup: defaultPcbStackup(),
        design: { trackWidth: 0.2, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3, units: 'mm', router: 'maze' },
        boardShapes: [save(boardShape({ id: 'board-outline', layer: 'board-outline' })), saved, savedFill] },
};
validateProject(project);
let written;
const result = await new FileManager().saveToHandle(project, {
    name: 'collapsed-polygons.cpcb',
    async createWritable() { return { async write(blob) { written = blob; }, async close() {} }; },
});
assert.equal(result.success, true, result.error);
const reopened = validateProject(await readProjectFile(written));
assert.deepEqual(createShape(reopened.schematic.shapes[0]).toJSON(), savedSchematic);
assert.equal(preparePcb(reopened.pcb).boardShapes[0].points.length, 4);

const roundedCopy = boardShape({ points: points.map(({ x, y }) => ({ x: round4(x), y: round4(y) })) });
assert.equal(collapseRoundedPolygon(roundedCopy), true);
assert.equal(collapseRoundedPolygon(roundedCopy), false, 'Cleanup is idempotent');
console.log('PASS rounded polygon vertex collapse, wraparound, metadata, validation, ZIP roundtrip and unchanged live/fabrication geometry');
