import assert from 'node:assert/strict';
import { closestPointOnSegment, pointInPolygon } from '../src/core/geometry.js';
import { Track } from '../src/shapes/track.js';
import { pictureShape } from '../src/pcb/modules/picture-raster.js';

globalThis.window = { addEventListener() {} };
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
const { resolveBoardShapeGeometry, boardShapeFilledRemovalOutlines } = await import('../src/pcb/modules/board-shapes.js');
const { pcbTextSegments } = await import('../src/pcb/modules/pcb-text.js');
const exportShapes = boardShapes => exportGerbers({ placements: new Map(),
    boardX: 0, boardY: 0, boardWidth: 100, boardHeight: 80, boardShapes });

function circularStrokesIn(file) {
    const apertures = new Map([...file.matchAll(/%ADD(\d+)C,([\d.]+)\*%/g)]
        .map(match => [Number(match[1]), Number(match[2])]));
    const strokes = [];
    let aperture = null;
    let position = null;
    for (const command of file.split(/\r?\n/)) {
        const selection = command.match(/^D(\d+)\*$/);
        if (selection) aperture = Number(selection[1]);
        const draw = command.match(/^X(-?\d+)Y(-?\d+)D0([12])\*$/);
        if (!draw) continue;
        const next = { x: Number(draw[1]) / 1e6, y: -Number(draw[2]) / 1e6 };
        if (draw[3] === '1') {
            assert.ok(position && apertures.has(aperture), 'Every curve segment uses a circular aperture');
            strokes.push({ start: position, end: next, width: apertures.get(aperture) });
        }
        position = next;
    }
    return strokes;
}

for (const [layer, file] of [['top-copper', 'board.gtl'], ['bottom-copper', 'board.gbl'],
    ['top-silk', 'board.gto'], ['bottom-silk', 'board.gbo'], ['top-mask', 'board.gts']]) {
    for (const kind of layer.endsWith('copper') ? ['track', 'line', 'variable-line'] : ['line', 'variable-line']) {
        const points = [{ x: 10, y: -10 }, { x: 30, y: -10 }, { x: 30, y: -30 }];
        const shape = { kind: 'line', layer, points, cornerRadius: 8, lineWidth: 0.4, filled: false };
        if (kind === 'variable-line') Object.assign(shape, { lineWidth: 0.2, segmentWidths: { 0: 0.4, 1: 0.4 } });
        const track = new Track({ points, layer, cornerRadius: 8, width: 0.4 });
        const gerber = exportGerbers({ placements: new Map(), boardWidth: 100, boardHeight: 80,
            tracks: kind === 'track' ? [track] : [], boardShapes: kind === 'track' ? [] : [shape] }).get(file);
        const strokes = circularStrokesIn(gerber);
        const label = `${kind} ${layer}`;
        assert.ok(strokes.length > 16, `${label}: adaptive corner samples reach Gerber`);
        assert.ok(strokes.every(stroke => stroke.width === 0.4), `${label}: stroke width is preserved`);
        for (let index = 1; index < strokes.length; index++) {
            assert.deepEqual(strokes[index].start, strokes[index - 1].end, `${label}: successive draws meet exactly`);
        }
        const covers = point => strokes.some(stroke => {
            const closest = closestPointOnSegment(point, stroke.start, stroke.end);
            return Math.hypot(point.x - closest.x, point.y - closest.y) <= stroke.width / 2;
        });
        for (let sample = 1; sample < 100; sample++) {
            const fraction = sample / 100;
            const point = { x: 30 - 8 * (1 - fraction) ** 2, y: -10 - 8 * fraction ** 2 };
            const length = Math.hypot(fraction, 1 - fraction);
            const normal = { x: fraction / length, y: (1 - fraction) / length };
            for (const side of [-1, 1]) {
                assert.ok(covers({ x: point.x + side * normal.x * 0.195, y: point.y + side * normal.y * 0.195 }),
                    `${label}: no notches along either curve boundary at ${fraction}`);
                assert.equal(covers({ x: point.x + side * normal.x * 0.205, y: point.y + side * normal.y * 0.205 }), false,
                    `${label}: round joins do not create protrusions at ${fraction}`);
            }
        }
        assert.equal(covers({ x: 30, y: -10 }), false, `${label}: removed sharp corner stays empty`);
    }
}

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
for (const original of [portrait, hollow, triangle, { ...triangle, cornerRadius: 3 },
    { ...hollow, kind: 'polygon', nodeCornerRadii: { 1: 2 } }]) {
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
    const clipped = regionsIn(file);
    assert.ok(clipped.some(contour => contour.some(point => point.x === 100)), 'Overlapping text reaches the board edge');
    assert.ok(clipped.flat().every(point => point.x <= 100), 'Text stroke width is clipped at the edge');
    assert.doesNotMatch(file, /X100500000Y\d+D0[12]\*/, 'Off-board centreline is replaced with clipped regions');
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
assert.ok(regionsIn(edgeCopper).some(contour => pointInPolygon({ x: 99, y: -30 }, contour)),
    'A circle centred outside the board still contributes its overlapping copper');
assert.ok(regionsIn(edgeCopper).flat().every(point => point.x <= 100 && point.y >= -80), 'Circle regions stop at the board boundary');
assert.doesNotMatch(edgeCopper, /X101000000Y30000000D03\*/, 'The off-board circle is not emitted as an unbounded flash');
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

const concaveOutline = { kind: 'polygon', layer: 'board-outline', lineWidth: 0.2, filled: false,
    points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: -20 }, { x: 14, y: -20 },
        { x: 14, y: -8 }, { x: 6, y: -8 }, { x: 6, y: -20 }, { x: 0, y: -20 }] };
const exportNotched = options => exportGerbers({ placements: new Map(), boardWidth: 20, boardHeight: 20,
    ...options, boardShapes: [concaveOutline, ...(options.boardShapes || [])] });
for (const [layer, filename] of [['top-copper', 'board.gtl'], ['bottom-copper', 'board.gbl'],
    ['top-silk', 'board.gto'], ['bottom-silk', 'board.gbo'], ['top-mask', 'board.gts'], ['bottom-mask', 'board.gbs']]) {
    const crossing = { kind: 'line', layer, lineWidth: 2, filled: false,
        points: [{ x: 2, y: -12 }, { x: 18, y: -12 }] };
    const original = JSON.stringify([concaveOutline, crossing]);
    const file = exportNotched({ boardShapes: [crossing] }).get(filename);
    const regions = regionsIn(file);
    assert.ok(regions.some(contour => pointInPolygon({ x: 4, y: -12.8 }, contour)), `${layer}: left stroke width retained`);
    assert.ok(regions.some(contour => pointInPolygon({ x: 16, y: -12.8 }, contour)), `${layer}: right stroke width retained`);
    assert.ok(regions.every(contour => contour.every(point => point.x <= 6 || point.x >= 14)), `${layer}: no vertices in notch`);
    assert.ok(!regions.some(contour => pointInPolygon({ x: 10, y: -12 }, contour)), `${layer}: no bridge across notch`);
    assert.equal(JSON.stringify([concaveOutline, crossing]), original, 'Export leaves source geometry unchanged');
    const circle = { kind: 'circle', layer, x: 7, y: -12, radius: 2, lineWidth: 0.4, filled: true };
    const circleRegions = regionsIn(exportNotched({ boardShapes: [circle] }).get(filename));
    assert.ok(circleRegions.some(contour => pointInPolygon({ x: 5.5, y: -12 }, contour)), `${layer}: partial circle survives`);
    assert.ok(circleRegions.flat().every(point => point.x <= 6), `${layer}: circle clipped at notch`);
    if (!layer.endsWith('mask')) {
        const ring = { ...circle, x: 5, filled: false };
        const ringRegions = regionsIn(exportNotched({ boardShapes: [ring] }).get(filename));
        assert.ok(ringRegions.some(contour => pointInPolygon({ x: 3.2, y: -12 }, contour)), `${layer}: ring thickness survives`);
        assert.ok(!ringRegions.some(contour => pointInPolygon({ x: 5, y: -12 }, contour)), `${layer}: clipped ring remains hollow`);
        assert.ok(ringRegions.flat().every(point => point.x <= 6), `${layer}: ring stops at notch`);
    }
    const outside = exportNotched({ boardShapes: [{ ...circle, x: 30 }] }).get(filename);
    assert.doesNotMatch(outside, /X-?\d+Y-?\d+D0[123]\*/, `${layer}: wholly external circle omitted`);
}
for (const side of ['top', 'bottom']) {
    const placements = new Map([['edge', { x: 6, y: -12, side, padOffsets: [
        { dx: 0, dy: 0, width: 2, height: 2, shape: 'rect', layer: side },
    ] }]]);
    const files = exportNotched({ placements });
    for (const filename of side === 'top' ? ['board.gtl', 'board.gts', 'board.gtp'] : ['board.gbl', 'board.gbs', 'board.gbp']) {
        const regions = regionsIn(files.get(filename));
        assert.ok(regions.some(contour => pointInPolygon({ x: 5.5, y: -12 }, contour)), `${filename}: partial pad retained`);
        assert.ok(regions.flat().every(point => point.x <= 6), `${filename}: pad footprint clipped`);
        assert.doesNotMatch(files.get(filename), /D03\*/, `${filename}: crossing pad is not a full flash`);
    }
}
const clippedVias = exportNotched({ vias: [{ x: 6, y: -12, diameter: 2, drill: 0.5 },
    { x: 10, y: -12, diameter: 1, drill: 0.5 }] });
assert.ok(regionsIn(clippedVias.get('board.gtl')).flat().every(point => point.x <= 6));
assert.match(clippedVias.get('board-PTH.drl'), /X6\.000Y12\.000/);
assert.doesNotMatch(clippedVias.get('board-PTH.drl'), /X10\.000Y12\.000/, 'Drills centred in the notch are omitted');
const oversizedPicture = pictureShape({ width: 10, height: 10, contours: [
    [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    [{ x: 3, y: 3 }, { x: 7, y: 3 }, { x: 7, y: 7 }, { x: 3, y: 7 }],
] }, { widthMm: 30, layer: 'top-silk', center: { x: 10, y: -10 } });
const pictureRegions = regionsIn(exportNotched({ boardShapes: [oversizedPicture] }).get('board.gto'));
assert.ok(pictureRegions.some(contour => pointInPolygon({ x: 2, y: -12 }, contour)), 'Clipped picture retains on-board ink');
assert.ok(!pictureRegions.some(contour => pointInPolygon({ x: 10, y: -5 }, contour)), 'Clipped picture retains its hole');
assert.ok(!pictureRegions.some(contour => pointInPolygon({ x: 10, y: -18 }, contour)), 'Picture cannot fill the board notch');
for (const filename of ['board.gtl', 'board.gto']) {
    const layer = filename === 'board.gtl' ? 'top-copper' : 'top-silk';
    const rounded = exportGerbers({ placements: new Map(), boardWidth: 20, boardHeight: 20, boardRadius: 5,
        boardShapes: [{ kind: 'circle', layer, x: 1, y: -1, radius: 3, filled: true, lineWidth: 0.2 }] });
    const regions = regionsIn(rounded.get(filename));
    assert.ok(regions.some(contour => pointInPolygon({ x: 3, y: -3 }, contour)), 'Artwork survives inside rounded corner');
    assert.ok(!regions.some(contour => pointInPolygon({ x: 0.5, y: -0.5 }, contour)), 'Legacy rounded board clips the corner');
}
const profile = exportNotched({ boardShapes: [
    { kind: 'circle', layer: 'hole', x: 30, y: -10, radius: 2 },
    { kind: 'circle', layer: 'hole', x: 0, y: -10, radius: 2 },
] }).get('board.gko');
const profilePoints = [...profile.matchAll(/X(-?\d+)Y(-?\d+)D0[12]\*/g)]
    .map(match => ({ x: Number(match[1]) / 1e6, y: -Number(match[2]) / 1e6 }));
assert.ok(profilePoints.length > 8, 'Crossing cutout is incorporated in the perimeter');
assert.ok(profilePoints.every(point => point.x >= 0 && point.x <= 20 && point.y >= -20 && point.y <= 0),
    'Cutouts never emit off-board profile coordinates');
const circularBoard = exportGerbers({ placements: new Map(), boardWidth: 20, boardHeight: 20, boardShapes: [
    { kind: 'circle', layer: 'board-outline', x: 10, y: -10, radius: 10 },
    { kind: 'circle', layer: 'top-copper', x: 18, y: -10, radius: 4, filled: true },
] }).get('board.gtl');
const circularRegions = regionsIn(circularBoard);
assert.ok(circularRegions.some(contour => pointInPolygon({ x: 19, y: -10 }, contour)), 'Circular board retains overlapping artwork');
assert.ok(circularRegions.flat().every(point => Math.hypot(point.x - 10, point.y + 10) <= 10.000002),
    'Artwork follows the circular boundary');
console.log('PASS actual board-boundary clipping for strokes, circles, pads, vias, pictures, rounded corners and cutouts');
const circularNotch = { kind: 'circle', layer: 'hole', filled: true,
    x: 35.56, y: -66.04, radius: 18.491479, lineWidth: 0.2 };
const notchFiles = exportShapes([circularNotch]);
assert.equal(notchFiles.has('board-NPTH.drl'), false,
    'An edge-crossing circle is routed by the profile, not duplicated as a full drill');
const notchStrokes = circularStrokesIn(notchFiles.get('board.gko'));
assert.ok(notchStrokes.some(stroke => Math.abs(stroke.start.x - 35.56) < 1e-6
    && Math.abs(stroke.start.y + 47.548521) < 1e-6), 'The circular notch remains in the board profile');
assert.ok(notchStrokes.every(stroke => stroke.start.y >= -80 && stroke.end.y >= -80),
    'The routed notch stops at the board edge');
const internalHole = { ...circularNotch, x: 70, y: -30, radius: 2 };
const mixedHoles = exportShapes([circularNotch, internalHole]).get('board-NPTH.drl');
assert.match(mixedHoles, /T1C4\.000/);
assert.match(mixedHoles, /X70\.000Y30\.000/);
assert.doesNotMatch(mixedHoles, /C36\.983|X35\.560Y66\.040/,
    'Interior circular drills are preserved without reintroducing the edge-crossing drill');
console.log('PASS circular edge cutouts use the routed profile without duplicate NPTH drills');