import assert from 'node:assert/strict';
import { closestPointOnSegment, pointInPolygon } from '../src/core/geometry.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: () => ({ setAttribute() {}, appendChild() {} }) };
const { createCopperDistanceChecker, collectCopper, runDRC } = await import('../src/pcb/modules/drc.js');
const { Track } = await import('../src/shapes/track.js');
const { resolveTrackSegments } = await import('../src/pcb/modules/board-geometry.js');

for (const kind of ['track', 'line', 'polygon', 'rect']) {
    for (const filled of kind === 'polygon' || kind === 'rect' ? [false, true] : [false]) {
        const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
        if (kind === 'polygon' || kind === 'rect') points.push({ x: 0, y: 10 });
        const shape = kind === 'track'
            ? new Track({ points, width: 0.2, cornerRadius: 4, layer: 'top-copper', net: 'GND' })
            : { id: 'rounded', kind, points, lineWidth: 0.2, cornerRadius: 4, filled, layer: 'top-copper', net: 'GND' };
        const probe = { id: 'probe', x: 10, y: 0, diameter: 0.4, net: 'VCC' };
        const board = { placements: new Map(), tracks: kind === 'track' ? [shape] : [],
            boardShapes: kind === 'track' ? [] : [shape], vias: [probe], texts: new Map(), copperFills: [] };
        const label = `${kind}, filled=${filled}`;
        assert.equal(runDRC(board, { clearance: 0.2 }).ok, true, `${label}: removed sharp corner has no copper`);
        const midpoint = kind === 'rect'
            ? { x: 6 + 4 / Math.SQRT2, y: 4 - 4 / Math.SQRT2 }
            : { x: 9, y: 1 };
        for (const gap of [0.19, 0.21]) {
            probe.x = midpoint.x + (0.3 + gap) / Math.SQRT2;
            probe.y = midpoint.y - (0.3 + gap) / Math.SQRT2;
            const result = runDRC(board, { clearance: 0.2 });
            assert.equal(result.ok, gap > 0.2, `${label}: clearance gap ${gap}`);
            if (gap < 0.2) {
                assert.equal(result.violations.filter(item => item.rule === 'clearance').length, 1,
                    `${label}: sampled segments produce one entity-pair violation`);
            }
        }
        Object.assign(probe, midpoint);
        assert.equal(runDRC(board, { clearance: 0.2 }).ok, false, `${label}: contact with the curve fails`);
        probe.net = 'GND';
        assert.equal(runDRC(board, { clearance: 0.2 }).ok, true, `${label}: same-net contact is allowed`);
        probe.net = 'VCC';
        board.vias = [];
        board.boardShapes.push({ id: 'opposite', kind: 'circle', ...midpoint, radius: 0.2,
            lineWidth: 0.1, filled: true, layer: 'bottom-copper', net: 'VCC' });
        assert.equal(runDRC(board, { clearance: 0.2 }).ok, true, `${label}: opposite layers do not collide`);
        board.boardShapes.pop();
        board.vias = [probe];
        probe.x = 10;
        probe.y = 0;
        if (kind === 'track') {
            assert.equal(collectCopper(board).segments.length, resolveTrackSegments(shape).length,
                'DRC collects every adaptively sampled track segment');
            shape.setNodeCornerRadius('n1', 0);
        } else shape.nodeCornerRadii = { 1: 0 };
        assert.equal(runDRC(board, { clearance: 0.2 }).ok, false, `${label}: sharp-node override updates DRC`);
        shape.nodeCornerRadii = {};
        assert.equal(runDRC(board, { clearance: 0.2 }).ok, true, `${label}: restoring rounding clears the violation`);
    }
}

const rectangle = (left, top, right, bottom) => [
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
];
const edges = (feature) => {
    if (feature.kind === 'track') return [[{ x: feature.ax, y: feature.ay }, { x: feature.bx, y: feature.by }]];
    if (feature.kind === 'via') return [[{ x: feature.x, y: feature.y }, { x: feature.x, y: feature.y }]];
    const rings = feature.kind === 'area' ? [feature.outer, ...feature.holes] : [feature.outline];
    return rings.flatMap((ring) => ring.map((point, index) => [point, ring[(index + 1) % ring.length]]));
};
const contains = (feature, point) => feature.kind === 'area'
    ? pointInPolygon(point, feature.outer) && !feature.holes.some((hole) => pointInPolygon(point, hole))
    : feature.kind === 'pad' && pointInPolygon(point, feature.outline);
const radius = (feature) => feature.kind === 'via' ? feature.r : feature.kind === 'track' ? feature.hw : 0;

function segmentDistance(start, end, otherStart, otherEnd) {
    const denominator = (end.x - start.x) * (otherEnd.y - otherStart.y)
        - (end.y - start.y) * (otherEnd.x - otherStart.x);
    if (Math.abs(denominator) >= 1e-12) {
        const along = ((otherStart.x - start.x) * (otherEnd.y - otherStart.y)
            - (otherStart.y - start.y) * (otherEnd.x - otherStart.x)) / denominator;
        const otherAlong = ((otherStart.x - start.x) * (end.y - start.y)
            - (otherStart.y - start.y) * (end.x - start.x)) / denominator;
        if (along >= 0 && along <= 1 && otherAlong >= 0 && otherAlong <= 1) {
            return { dist: 0, x: start.x + along * (end.x - start.x), y: start.y + along * (end.y - start.y) };
        }
    }
    let nearest = { dist: Infinity, x: 0, y: 0 };
    for (const [point, first, second] of [[start, otherStart, otherEnd], [end, otherStart, otherEnd],
        [otherStart, start, end], [otherEnd, start, end]]) {
        const closest = closestPointOnSegment(point, first, second);
        const dist = Math.hypot(point.x - closest.x, point.y - closest.y);
        if (dist < nearest.dist) nearest = { dist, x: (point.x + closest.x) / 2, y: (point.y + closest.y) / 2 };
    }
    return nearest;
}

function exhaustiveDistance(first, second) {
    const firstEdges = edges(first), secondEdges = edges(second);
    for (const [point] of firstEdges) if (contains(second, point)) return { dist: 0, ...point };
    for (const [point] of secondEdges) if (contains(first, point)) return { dist: 0, ...point };
    let nearest = { dist: Infinity, x: 0, y: 0 };
    for (const [start, end] of firstEdges) {
        for (const [otherStart, otherEnd] of secondEdges) {
            const candidate = segmentDistance(start, end, otherStart, otherEnd);
            if (candidate.dist < nearest.dist) nearest = candidate;
        }
    }
    nearest.dist = Math.max(0, nearest.dist - radius(first) - radius(second));
    return nearest;
}

const pour = { kind: 'area', outer: rectangle(-10, -10, 10, 10), holes: [rectangle(-3, -3, 3, 3)] };
const fixtures = [pour,
    { kind: 'pad', outline: rectangle(-0.5, -0.5, 0.5, 0.5) },
    { kind: 'pad', outline: rectangle(2.8, -0.5, 3.8, 0.5) },
    { kind: 'via', x: 0, y: 0, r: 0.5 },
    { kind: 'via', x: 2.4, y: 0, r: 0.5 },
    { kind: 'via', x: 11, y: 0, r: 0.8 },
    { kind: 'track', ax: -12, ay: 0, bx: 12, by: 0, hw: 0.2 },
    { kind: 'track', ax: -2, ay: 0, bx: 2, by: 0, hw: 1.2 },
    { kind: 'track', ax: 12, ay: -5, bx: 12, by: 5, hw: 2.1 },
    { kind: 'track', ax: 3, ay: 0, bx: 3, by: 0, hw: 0.1 },
    { kind: 'area', outer: rectangle(15, -1, 17, 1), holes: [] },
];
let seed = 91273;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
for (let index = 0; index < 24; index++) {
    const x = random() * 30 - 15, y = random() * 30 - 15;
    fixtures.push(index % 2
        ? { kind: 'track', ax: x, ay: y, bx: x + random() * 6 - 3, by: y + random() * 6 - 3, hw: random() * 2 }
        : { kind: 'pad', outline: Array.from({ length: 48 }, (_, vertex) => ({
            x: x + 1.2 * Math.cos(vertex * Math.PI / 24), y: y + 0.8 * Math.sin(vertex * Math.PI / 24),
        })) });
}
for (const clearance of [0.1, 0.2, 1.67]) {
    const check = createCopperDistanceChecker(clearance);
    for (let first = 0; first < fixtures.length; first++) {
        for (let second = 0; second < fixtures.length; second++) {
            if (first === second) continue;
            const expected = exhaustiveDistance(fixtures[first], fixtures[second]);
            const actual = check(fixtures[first], fixtures[second]);
            const label = `${first}/${second} clearance=${clearance}`;
            assert.equal(actual.dist < clearance - 1e-4, expected.dist < clearance - 1e-4, label);
            if (expected.dist < clearance - 1e-4) {
                assert.ok(Math.abs(actual.dist - expected.dist) < 1e-10, label);
                assert.ok(Math.abs(actual.x - expected.x) < 1e-10, label);
                assert.ok(Math.abs(actual.y - expected.y) < 1e-10, label);
            }
        }
    }
}

let edgeBuilds = 0;
const outline = rectangle(-1, -1, 1, 1);
outline.map = function (...args) { edgeBuilds++; return Array.prototype.map.apply(this, args); };
const pad = { kind: 'pad', outline };
const check = createCopperDistanceChecker(0.2);
for (let index = 0; index < 100; index++) check(pad, { kind: 'via', x: 10 + index, y: 0, r: 0.5 });
assert.equal(edgeBuilds, 1);
createCopperDistanceChecker(0.2)(pad, { kind: 'via', x: 10, y: 0, r: 0.5 });
assert.equal(edgeBuilds, 2);

const app = { placements: new Map(), tracks: [], texts: new Map(), boardShapes: [],
    vias: [{ id: 'via_1', x: 0, y: 0, diameter: 1, drill: 0.3, net: 'VCC' }],
    copperFills: [{ id: 'fill_1', layer: 'top-copper', net: 'GND',
        _computed: [{ outer: pour.outer, holes: pour.holes }] }] };
assert.equal(runDRC(app, { clearance: 0.2 }).ok, true);
app.vias[0].x = 2.4;
assert.ok(runDRC(app, { clearance: 0.2 }).violations.some((violation) => violation.rule === 'clearance'));
app.vias[0].x = 0;
assert.equal(runDRC(app, { clearance: 0.2 }).ok, true);
console.log('DRC boundary-cache and exhaustive-distance comparisons passed.');