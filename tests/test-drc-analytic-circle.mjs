import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
const { createCopperDistanceChecker, collectCopper, runDRC } = await import('../src/pcb/modules/drc.js');
const { circleCircleDistance, circleSegmentDistance } = await import('../src/pcb/modules/circle-clearance.js');
const check = createCopperDistanceChecker();
const circle = (x = 0, y = 0, innerRadius = 4, outerRadius = 5) =>
    ({ kind: 'circle', x, y, innerRadius, outerRadius });
const track = (ax, ay, bx, by, hw = 0) => ({ kind: 'track', ax, ay, bx, by, hw });
const rectangle = (left, top, right, bottom) => [
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
];
const area = (outer, holes = []) => ({ kind: 'area', outer, holes });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const cases = [
    [circle(), track(6, -2, 6, 2), 1],
    [circle(), track(6, -2, 6, 2, 0.25), 0.75],
    [circle(), track(-1, 0, 1, 0), 3],
    [circle(), track(-1, 0, 1, 0, 0.5), 2.5],
    [circle(), track(-10, 0, 10, 0), 0],
    [circle(), track(5, -10, 5, 10), 0],
    [circle(), track(0, 0, 0, 0), 4],
    [circle(0, 0, 0, 5), track(0, 0, 0, 0), 0],
    [circle(), { kind: 'via', x: 0, y: 0, r: 1 }, 3],
    [circle(), { kind: 'via', x: 6, y: 0, r: 0.5 }, 0.5],
    [circle(), circle(12, 0), 2],
    [circle(), circle(0, 0, 0, 2), 2],
    [circle(), circle(1, 0, 0, 2), 1],
    [circle(), circle(3, 0, 0, 2), 0],
    [circle(), circle(0, 0, 4.5, 6), 0],
    [circle(), area(rectangle(-1, -1, 1, 1)), 4 - Math.SQRT2],
    [circle(), area(rectangle(-10, -10, 10, 10)), 0],
    [circle(), area(rectangle(-10, -10, 10, 10), [rectangle(-6, -6, 6, 6)]), 1],
    [circle(), area(rectangle(-10, -10, 10, 10), [rectangle(-3, -3, 3, 3)]), 0],
    [circle(), { kind: 'pad', outline: rectangle(6, -1, 7, 1) }, 1],
];
for (const [first, second, expected] of cases) {
    near(check(first, second).dist, expected);
    near(check(second, first).dist, expected);
    assert.ok(Number.isFinite(check(first, second).x) && Number.isFinite(check(first, second).y));
}

for (const angle of [0, 0.013, Math.PI / 48, 0.7, 2.9]) {
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    const rotate = (point) => ({ x: point.x * cosine - point.y * sine + 17.3,
        y: point.x * sine + point.y * cosine - 23.1 });
    const center = rotate({ x: 0, y: 0 });
    const radial = { ...circle(), ...center };
    const start = rotate({ x: 5.5, y: -2 }), end = rotate({ x: 5.5, y: 2 });
    const result = circleSegmentDistance(radial, start, end, 0.2);
    near(result.dist, 0.3);
    const marker = rotate({ x: 5.15, y: 0 });
    near(result.x, marker.x);
    near(result.y, marker.y);
}

let seed = 8827;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
for (let index = 0; index < 500; index++) {
    const first = circle(random() * 20, random() * 20, random() * 3, 3 + random() * 5);
    const second = circle(random() * 20, random() * 20, random() * 3, 3 + random() * 5);
    const result = circleCircleDistance(first, second);
    near(result.dist, circleCircleDistance(second, first).dist);
    if (result.dist === 0) {
        for (const ring of [first, second]) {
            const distance = Math.hypot(result.x - ring.x, result.y - ring.y);
            assert.ok(distance >= ring.innerRadius - 1e-9 && distance <= ring.outerRadius + 1e-9,
                'Overlap marker must lie in both copper rings');
        }
    }
}

const board = { placements: new Map(), tracks: [], vias: [], texts: new Map(), copperFills: [],
    boardShapes: [{ id: 'ring', kind: 'circle', layer: 'top-copper', net: 'GND',
        x: 0, y: 0, radius: 4.5, lineWidth: 1, filled: false, copperMode: 'add' }] };
const copper = collectCopper(board);
assert.equal(copper.circles.length, 1);
assert.equal(copper.segments.length, 0, 'DRC must not also include a chord-based circle stroke');
assert.equal(copper.areas.length, 0);
near(copper.circles[0].innerRadius, 4);
near(copper.circles[0].outerRadius, 5);
board.vias = [{ id: 'via', x: 6, y: 0, diameter: 1, drill: 0.3, net: 'VCC' }];
assert.equal(runDRC(board, { clearance: 0.5 }).ok, true);
board.vias[0].x -= 0.01;
assert.ok(runDRC(board, { clearance: 0.5 }).violations.some((item) => item.id.includes('shape:ring')));
board.vias[0].net = 'GND';
assert.equal(runDRC(board, { clearance: 0.5 }).ok, true);
board.boardShapes[0].filled = true;
assert.equal(collectCopper(board).circles[0].innerRadius, 0);
board.boardShapes[0].copperMode = 'remove-copper';
assert.equal(collectCopper(board).circles.length, 0);
console.log('PASS: analytic circle distances, hollow interiors, pour holes, rotation, overlap witnesses, and DRC collection');