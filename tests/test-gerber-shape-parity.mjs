import assert from 'node:assert/strict';
import { pointInPolygon } from '../src/core/geometry.js';
import { pictureShape } from '../src/pcb/modules/picture-raster.js';

globalThis.window = { addEventListener() {} };
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
const { resolveBoardShapeGeometry, boardShapeFilledRemovalOutlines } = await import('../src/pcb/modules/board-shapes.js');
const { pcbTextSegments } = await import('../src/pcb/modules/pcb-text.js');
const exportShapes = boardShapes => exportGerbers({ placements: new Map(),
    boardX: 0, boardY: 0, boardWidth: 100, boardHeight: 80, boardShapes });
for (const layer of ['top-silk', 'bottom-silk']) {
    const file = layer === 'top-silk' ? 'board.gto' : 'board.gbo';
    const circle = { kind: 'circle', layer, x: 30, y: -30, radius: 10, lineWidth: 2, filled: false };
    const ring = exportShapes([circle]).get(file);
    assert.match(ring, /%ADD\d+C,2\.0000\*%/);
    assert.match(ring, /G75\*\nX21000000Y30000000D02\*\nG03\*\nX21000000Y30000000I9000000J0D01\*\nG01\*/);
    const disc = exportShapes([{ ...circle, filled: true }]).get(file);
    assert.match(disc, /%ADD\d+C,20\.0000\*%/);
    assert.match(disc, /X30000000Y30000000D03\*/);
}
console.log('PASS Gerber silk circles preserve outer radius, thickness and fill on both sides');
function regionsIn(file) {
    return [...file.matchAll(/G36\*\n([\s\S]*?)G37\*/g)].map(match => {
        assert.equal((match[1].match(/D02\*/g) || []).length, 1, 'Each region has one unambiguous contour');
        const points = [...match[1].matchAll(/X(-?\d+)Y(-?\d+)D0[12]\*/g)]
            .map(point => ({ x: Number(point[1]) / 1e6, y: -Number(point[2]) / 1e6 }));
        assert.deepEqual(points[0], points.at(-1), 'Regions explicitly close');
        return points;
    });
}
const portrait = pictureShape({ width: 10, height: 10, contours: [
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 }],
    [{ x: 4, y: 4 }, { x: 6, y: 4 }, { x: 6, y: 6 }, { x: 4, y: 6 }],
] }, { widthMm: 20, layer: 'top-silk', center: { x: 30, y: -30 } });
portrait.points = portrait.points.map(point => ({ x: 30 + (point.x - 30) * 0.8 - (point.y + 30) * 0.6,
    y: -30 + (point.x - 30) * 0.6 + (point.y + 30) * 0.8 }));
const hollow = { kind: 'rect', points: [{ x: 10, y: -10 }, { x: 40, y: -10 },
    { x: 40, y: -40 }, { x: 10, y: -40 }], cornerRadius: 5, lineWidth: 2, filled: false };
const triangle = { kind: 'polygon', points: [{ x: 12, y: -12 }, { x: 44, y: -16 }, { x: 25, y: -44 }],
    lineWidth: 1, segmentWidths: { 0: 3, 1: 1.5, 2: 0.5 }, filled: false };
for (const original of [portrait, hollow, triangle]) {
    for (const [layer, file] of [['top-silk', 'board.gto'], ['top-copper', 'board.gtl']]) {
        const shape = { ...original, layer, copperMode: 'add' };
        const expected = resolveBoardShapeGeometry(shape).physicalContours;
        const actual = regionsIn(exportShapes([shape]).get(file));
        assert.ok(actual.length > 0);
        for (let column = 0; column < 90; column++) for (let row = 0; row < 90; row++) {
            const point = { x: 5.137 + column * 0.51, y: -5.193 - row * 0.51 };
            assert.equal(actual.some(contour => pointInPolygon(point, contour)),
                expected.filter(contour => pointInPolygon(point, contour)).length % 2 === 1,
                `${original.kind} ${layer} coverage at ${JSON.stringify(point)}`);
        }
    }
}
console.log('PASS Gerber portrait holes/islands, hollow rounded rectangles and variable-width triangles match shared 2D geometry');
for (const layer of ['top-copper', 'top-silk']) {
    const text = { content: 'H', x: 0, y: -10, size: 10, rotation: 0, strokeWidth: 2, layer };
    const right = Math.max(...pcbTextSegments(text).flat().map(point => point.x));
    text.x = 100.5 - right;
    const gerbers = exportGerbers({ placements: new Map(), boardWidth: 100, boardHeight: 80, texts: [text] });
    const file = gerbers.get(layer === 'top-silk' ? 'board.gto' : 'board.gtl');
    assert.match(file, /X100500000Y\d+D02\*\nX100500000Y\d+D01\*/, 'The right stem overlaps the board by half a millimetre');
}
const curvedSlot = { kind: 'line', layer: 'hole', lineWidth: 2,
    points: [{ x: 20, y: -20 }, { x: 25, y: -27 }, { x: 30, y: -30 }, { x: 35, y: -27 }, { x: 40, y: -20 }] };
const outline = exportShapes([curvedSlot]).get('board.gko');
const moves = [...outline.matchAll(/X(-?\d+)Y(-?\d+)D02\*\n([\s\S]*?)(?=X-?\d+Y-?\d+D02\*|M02\*)/g)];
assert.equal(moves.length, 2, 'One board boundary and one physical curved-slot boundary');
const cutout = [{ x: Number(moves[1][1]) / 1e6, y: -Number(moves[1][2]) / 1e6 },
    ...[...moves[1][3].matchAll(/X(-?\d+)Y(-?\d+)D01\*/g)]
        .map(point => ({ x: Number(point[1]) / 1e6, y: -Number(point[2]) / 1e6 }))];
assert.deepEqual(cutout[0], cutout.at(-1));
assert.ok(pointInPolygon({ x: 30, y: -30 }, cutout), 'The arc centreline is removed');
assert.equal(pointInPolygon({ x: 30, y: -25 }, cutout), false, 'A curved slot must not become a filled arc segment');
assert.ok(pointInPolygon({ x: 19.5, y: -20 }, cutout), 'Round end-cap extends by the stroke radius');
console.log('PASS board-edge text strokes and curved cutout thickness/caps');
const arcHole = { kind: 'arc', layer: 'hole', lineWidth: 2,
    start: { x: 20, y: -20 }, end: { x: 40, y: -20 }, bulge: { x: 30, y: -30 } };
const arcOutline = exportShapes([arcHole]).get('board.gko');
for (const contour of boardShapeFilledRemovalOutlines(arcHole)) {
    for (const point of contour) {
        assert.ok(arcOutline.includes(`X${Math.round(point.x * 1e6)}Y${Math.round(-point.y * 1e6)}D0`),
            'Filled arc cutouts export the same stroke-expanded boundary as 2D');
    }
}
const varyingLine = { kind: 'line', layer: 'top-silk', lineWidth: 1, segmentWidths: { 0: 2, 1: 3 },
    points: [{ x: 10, y: -10 }, { x: 20, y: -10 }, { x: 30, y: -20 }] };
const varyingSilk = exportShapes([varyingLine]).get('board.gto');
assert.match(varyingSilk, /%ADD\d+C,2\.0000\*%/);
assert.match(varyingSilk, /%ADD\d+C,3\.0000\*%/);
const varyingDrill = exportShapes([{ ...varyingLine, layer: 'hole' }]).get('board-NPTH.drl');
assert.match(varyingDrill, /T\d+C2\.000/);
assert.match(varyingDrill, /T\d+C3\.000/);
console.log('PASS open silk and drill-slot exports preserve per-segment widths');
const filledArc = { kind: 'arc', layer: 'top-copper', filled: true, lineWidth: 0.5,
    start: { x: 20, y: -20 }, end: { x: 40, y: -20 }, bulge: { x: 30, y: -30 } };
for (const [layer, file] of [['top-copper', 'board.gtl'], ['top-silk', 'board.gto'], ['top-mask', 'board.gts']]) {
    regionsIn(exportShapes([{ ...filledArc, layer }]).get(file));
}
const pour = { layer: 'top-copper', _computed: [{ outer: triangle.points,
    holes: [[{ x: 23, y: -20 }, { x: 27, y: -20 }, { x: 25, y: -25 }]] }] };
regionsIn(exportGerbers({ placements: new Map(), boardWidth: 100, boardHeight: 80, fills: [pour] }).get('board.gtl'));
console.log('PASS filled arc and pour regions explicitly close on all exported layers');
const edgeCircles = [
    { kind: 'circle', layer: 'top-copper', filled: true, copperMode: 'add', lineWidth: 1.1,
        x: 128.27, y: -91.44, radius: 18.733632750360957 },
    { kind: 'circle', layer: 'top-copper', filled: true, copperMode: 'add', lineWidth: 0.2,
        x: 101, y: -30, radius: 10 },
    { kind: 'circle', layer: 'top-copper', filled: true, copperMode: 'add', lineWidth: 0.2,
        x: 92, y: -30, radius: 5 },
];
const edgeCopper = exportShapes(edgeCircles).get('board.gtl');
assert.match(edgeCopper, /X101000000Y30000000D03\*/, 'A circle centred outside the board still contributes its overlapping copper');
assert.match(edgeCopper, /X92000000Y30000000D03\*/, 'Both overlapping circles survive export');
const island = [{ x: 7, y: -31 }, { x: 13, y: -38 }, { x: 10, y: -32 }];
const surrounding = [{ x: 0.5, y: -0.5 }, { x: 99.5, y: -0.5 }, { x: 99.5, y: -79.5 }, { x: 0.5, y: -79.5 }];
const clearance = [{ x: 3, y: -24 }, { x: 17, y: -24 }, { x: 17, y: -43 }, { x: 3, y: -43 }];
for (const reverse of [false, true]) {
    const polygons = [{ outer: island, holes: [] }, { outer: surrounding, holes: [clearance] }];
    if (reverse) polygons.reverse();
    const file = exportGerbers({ placements: new Map(), boardWidth: 100, boardHeight: 80,
        fills: [{ layer: 'top-copper', _computed: polygons }] }).get('board.gtl');
    assert.ok(!file.includes('%LPC*%'), 'A pour hole must not erase islands emitted by another pour polygon');
    const regions = regionsIn(file);
    assert.ok(regions.some(region => pointInPolygon({ x: 10, y: -33.5 }, region)), 'Triangle interior island survives either polygon order');
    assert.ok(!regions.some(region => pointInPolygon({ x: 5, y: -30 }, region)), 'The surrounding clearance remains empty');
}
console.log('PASS pour islands survive surrounding holes regardless of export order, and off-board circle centres retain artwork');