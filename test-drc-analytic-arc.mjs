import assert from 'node:assert/strict';
import { closestPointOnSegment } from './src/core/geometry.js';

globalThis.window = { addEventListener() {} };
const { createCopperDistanceChecker, collectCopper, runDRC } = await import('./src/pcb/modules/drc.js');
const { arcPoint, arcSegmentDistance, arcArcDistance } = await import('./src/pcb/modules/arc-clearance.js');
const check = createCopperDistanceChecker();
const arc = (startAngle = 0, endAngle = Math.PI, options = {}) => ({ kind: 'arc', x: 0, y: 0,
    radius: 5, hw: 0.5, startAngle, endAngle, filled: false, ...options });
const track = (ax, ay, bx, by, hw = 0) => ({ kind: 'track', ax, ay, bx, by, hw });
const via = (x, y, r = 0) => ({ kind: 'via', x, y, r });
const rectangle = (left, top, right, bottom) => [
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
];
const near = (actual, expected, tolerance = 1e-9) =>
    assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const cases = [
    [arc(), via(0, 0), 4.5],
    [arc(), via(0, 7, 0.25), 1.25],
    [arc(), via(0, -5), Math.sqrt(50) - 0.5],
    [arc(0, -Math.PI), via(0, -7), 1.5],
    [arc(0, 1.5 * Math.PI), via(0, -5), 0],
    [arc(), track(-2, 6, 2, 6, 0.2), 0.3],
    [arc(), track(0, -10, 0, 10), 0],
    [arc(), track(-10, -1, 10, -1, 0.2), 0.3],
    [arc(), via(5.6, 0, 0.2), 0],
    [arc(), via(5, -1, 0.2), 0.3],
    [arc(), { kind: 'circle', x: 0, y: 0, innerRadius: 7, outerRadius: 8 }, 1.5],
    [arc(), { kind: 'circle', x: 0, y: 0, innerRadius: 0, outerRadius: 3 }, 1.5],
    [arc(), { kind: 'circle', x: 0, y: 0, innerRadius: 4, outerRadius: 6 }, 0],
    [arc(), arc(0, Math.PI, { radius: 7 }), 1],
    [arc(0, Math.PI / 2), arc(Math.PI, 1.5 * Math.PI), Math.sqrt(50) - 1],
    [arc(), arc(Math.PI, 2 * Math.PI, { x: 6 }), 3],
    [arc(), arc(0, Math.PI, { x: 6 }), 0],
    [arc(0, Math.PI, { filled: true }), via(0, 1), 0],
    [arc(0, Math.PI, { filled: true }), via(0, -2, 0.25), 1.25],
    [arc(0, -Math.PI, { filled: true }), via(0, 2), 1.5],
    [arc(0, 1.5 * Math.PI, { filled: true }), via(0, 0), 0],
    [arc(0, Math.PI, { filled: true }), { kind: 'circle', x: 0, y: 2, innerRadius: 0, outerRadius: 0.25 }, 0],
    [arc(), { kind: 'area', outer: rectangle(-10, -10, 10, 10), holes: [] }, 0],
    [arc(), { kind: 'area', outer: rectangle(-10, -10, 10, 10), holes: [rectangle(-6, -6, 6, 6)] }, 0.5],
    [arc(), { kind: 'pad', outline: rectangle(-1, 6, 1, 7) }, 0.5],
];
for (const [first, second, expected] of cases) {
    near(check(first, second).dist, expected);
    near(check(second, first).dist, expected);
}
const marker = arcSegmentDistance(arc(), { x: -2, y: 6 }, { x: 2, y: 6 }, 0.2);
near(marker.x, 0);
near(marker.y, 5.65);

let seed = 29091;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const randomArc = () => {
    const start = random() * 2 * Math.PI;
    return arc(start, start + (random() < 0.5 ? -1 : 1) * (0.01 + random() * 6.2),
        { x: random() * 12, y: random() * 12, radius: 0.1 + random() * 10, hw: random() });
};
const samples = (curve, count) => Array.from({ length: count + 1 }, (_, index) =>
    arcPoint(curve, curve.startAngle + (curve.endAngle - curve.startAngle) * index / count));
for (let index = 0; index < 60; index++) {
    const first = randomArc(), second = randomArc();
    const start = { x: random() * 20, y: random() * 20 }, end = { x: random() * 20, y: random() * 20 };
    const firstSamples = samples(first, 256), secondSamples = samples(second, 256);
    const sampledSegment = Math.max(0, Math.min(...firstSamples.map((point) => {
        const closest = closestPointOnSegment(point, start, end);
        return Math.hypot(point.x - closest.x, point.y - closest.y);
    })) - first.hw);
    const exactSegment = arcSegmentDistance(first, start, end).dist;
    const firstError = first.radius * Math.abs(first.endAngle - first.startAngle) / 512;
    assert.ok(exactSegment <= sampledSegment + 1e-9 && sampledSegment - exactSegment <= firstError + 1e-9);
    let sampledPair = Infinity;
    for (const firstPoint of firstSamples) {
        for (const secondPoint of secondSamples) {
            sampledPair = Math.min(sampledPair, Math.hypot(firstPoint.x - secondPoint.x, firstPoint.y - secondPoint.y));
        }
    }
    sampledPair = Math.max(0, sampledPair - first.hw - second.hw);
    const exactPair = arcArcDistance(first, second).dist;
    const secondError = second.radius * Math.abs(second.endAngle - second.startAngle) / 512;
    assert.ok(exactPair <= sampledPair + 1e-9 && sampledPair - exactPair <= firstError + secondError + 1e-9,
        `Arc pair ${index}: analytic ${exactPair}, sampled ${sampledPair}`);
    near(exactPair, arcArcDistance(second, first).dist);
}

const board = { placements: new Map(), tracks: [], vias: [], texts: new Map(), copperFills: [],
    boardShapes: [{ id: 'arc', kind: 'arc', layer: 'top-copper', net: 'GND',
        start: { x: 5, y: 0 }, bulge: { x: 0, y: 5 }, end: { x: -5, y: 0 }, lineWidth: 1, filled: false }] };
assert.equal(collectCopper(board).arcs.length, 1);
assert.equal(collectCopper(board).segments.length, 0);
board.vias = [{ id: 'via', x: 0, y: 6.5, diameter: 1, drill: 0.3, net: 'VCC' }];
assert.equal(runDRC(board, { clearance: 0.5 }).ok, true);
board.vias[0].y -= 0.01;
assert.ok(runDRC(board, { clearance: 0.5 }).violations.some((item) => item.id.includes('shape:arc')));
board.boardShapes[0].layer = 'bottom-copper';
board.vias = [];
board.boardShapes.push({ ...board.boardShapes[0], id: 'top-arc', layer: 'top-copper', net: 'VCC' });
assert.equal(runDRC(board, { clearance: 0.5 }).ok, true);
board.boardShapes = [{ ...board.boardShapes[0], bulge: { x: 0, y: 0 } }];
assert.equal(collectCopper(board).arcs.length, 0);
assert.equal(collectCopper(board).segments.length, 1, 'Collinear arc remains a straight segment');
console.log('PASS: exact arc distances, sweep direction, caps, filled regions, holes, sampled bounds, and DRC collection');

const { CopperFill } = await import('./src/shapes/copper-fill.js');
const { buildFillContext } = await import('./src/pcb/modules/fill-context.js');
const { loadClipper, computeFillPolygons } = await import('./src/pcb/modules/copper-fill-geom.js');
await loadClipper();
for (const radius of [5, 100]) {
    for (const sweep of [Math.PI, -Math.PI, 4.8]) {
        for (const filled of [false, true]) {
            const curve = arc(0.231, 0.231 + sweep, { radius });
            const shape = { id: 'pour-arc', kind: 'arc', layer: 'top-copper', net: 'VCC', filled, lineWidth: 1,
                start: arcPoint(curve, curve.startAngle), end: arcPoint(curve, curve.endAngle),
                bulge: arcPoint(curve, (curve.startAngle + curve.endAngle) / 2) };
            const pour = new CopperFill({ net: 'GND', outline: rectangle(-radius * 2, -radius * 2, radius * 2, radius * 2) });
            const target = { placements: new Map(), tracks: [], vias: [], texts: new Map(),
                boardShapes: [shape], copperFills: [pour], _getRoutingParams: () => ({ clearance: 0.5 }) };
            pour._computed = computeFillPolygons(pour, buildFillContext(target));
            assert.ok(pour._computed.length);
            const result = runDRC(target, { clearance: 0.5 });
            assert.equal(result.ok, true, `Arc pour radius ${radius}, sweep ${sweep}, filled ${filled}: ${JSON.stringify(result.violations)}`);
            for (const point of [shape.start, shape.end, shape.bulge]) point.x += 0.5;
            assert.equal(runDRC(target, { clearance: 0.5 }).ok, false, 'Moving an arc into an unchanged pour must still fail');
        }
    }
}
console.log('PASS: arc pours respect analytic clearance for large, reversed, major, and filled arcs');