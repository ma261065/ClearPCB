import assert from 'node:assert/strict';
import { closestPointOnSegment, pointInPolygon } from '../../src/core/geometry.js';

globalThis.window = { addEventListener() {} };
const { collectCopper, createCopperDistanceChecker, runDRC } = await import('../../src/pcb/modules/drc.js');
const check = createCopperDistanceChecker();
const tolerance = 1e-8;
const rectangle = (left, top, right, bottom) => [
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
];
const track = (ax, ay, bx, by, hw) => ({ kind: 'track', ax, ay, bx, by, hw });
const pointDistance = (point, first, second) => {
    const closest = closestPointOnSegment(point, first, second);
    return Math.hypot(point.x - closest.x, point.y - closest.y);
};
const onRing = (point, ring) => ring.some((start, index) =>
    pointDistance(point, start, ring[(index + 1) % ring.length]) <= tolerance);
const onCopper = (feature, point) => {
    if (feature.kind === 'via') {
        const radius = Math.hypot(point.x - feature.x, point.y - feature.y);
        return radius >= (feature.drill || 0) / 2 - tolerance && radius <= feature.r + tolerance;
    }
    if (feature.kind === 'track') return pointDistance(point,
        { x: feature.ax, y: feature.ay }, { x: feature.bx, y: feature.by }) <= feature.hw + tolerance;
    const outer = feature.outer || feature.outline;
    return (pointInPolygon(point, outer) || onRing(point, outer))
        && !(feature.holes || []).some(hole => pointInPolygon(point, hole) && !onRing(point, hole));
};
const assertContact = (first, second, label) => {
    for (const [a, b] of [[first, second], [second, first]]) {
        const marker = check(a, b);
        assert.equal(marker.dist, 0, label);
        assert.ok(onCopper(first, marker), `${label}: marker on first object's copper`);
        assert.ok(onCopper(second, marker), `${label}: marker on second object's copper`);
    }
};

const via = { kind: 'via', x: 0, y: 0, r: 6.6, drill: 5.3 };
assertContact(via, { kind: 'area', outer: rectangle(-10, -8, -4.3, 8), holes: [] },
    'partial Via/polygon overlap');
assertContact(via, { kind: 'area', outer: rectangle(-10, -10, 10, 10), holes: [] },
    'polygon contains Via');
assertContact(via, { kind: 'via', x: 4, y: 0, r: 2, drill: 2 }, 'overlapping Via rings');
assertContact(via, track(0, 0, 10, 0, 0.1), 'Track reaches annulus from Via centre');
assertContact(track(0, 0, 10, 0, 3), track(2, 3.05, 8, 3.05, 0.1),
    'unequal-width parallel Track overlap');
assertContact(track(0, 0, 10, 0, 3), { kind: 'pad', outline: rectangle(2, 2.9, 8, 5) },
    'wide Track touches pad edge');
assertContact(track(0, 0, 0, 0, 3), track(0, 3.05, 0, 4, 0.1),
    'unequal-width end-cap overlap');

for (const feature of [
    track(-1, 0, 1, 0, 0.1),
    { kind: 'area', outer: rectangle(-1, -1, 1, 1), holes: [] },
    { kind: 'via', x: 0, y: 0, r: 1, drill: 0.5 },
]) {
    assert.ok(check(via, feature).dist > 1, 'copper entirely in the drill hole is not a contact');
    assert.equal(check(via, feature).dist, check(feature, via).dist);
}

const gap = check(via, track(7, -10, 7, 10, 0.2));
assert.ok(Math.abs(gap.dist - 0.2) < tolerance, 'positive clearance remains accurate');
assert.ok(Math.abs(gap.x - 6.7) < tolerance && Math.abs(gap.y) < tolerance,
    'positive-gap marker lies halfway between copper boundaries');

// Geometry from the reported board, including its rounded polygon corners.
const board = {
    placements: new Map(), texts: new Map(), tracks: [], copperFills: [],
    vias: [{ id: 'via_11', net: 'Net0001', x: 23.32, y: -47, diameter: 13.2, drill: 5.3 }],
    boardShapes: [{ id: 'pshape_92', net: 'Net0003', kind: 'polygon', layer: 'top-copper',
        copperMode: 'add', filled: true, lineWidth: 0.2,
        points: [{ x: 2.54, y: -41.91 }, { x: 21.59, y: -63.5 }, { x: 13.97, y: -16.51 }],
        nodeCornerRadii: { 1: 6.5, 2: 12.5 } }],
};
const copper = collectCopper(board);
for (const clipped of [false, true]) {
    if (clipped) {
        board.vias.push({ id: 'remote', net: '', x: 100, y: 100, diameter: 2, drill: 0.5 });
        board.boardShapes.push({ id: 'cut', kind: 'rect', layer: 'top-copper', filled: true,
            copperMode: 'remove-copper', lineWidth: 0.1, points: rectangle(99, 99, 100, 101) });
    }
    const result = runDRC(board, { clearance: 0.15 });
    const contacts = result.violations.filter(v => v.rule === (clipped ? 'short' : 'clearance'));
    assert.equal(contacts.length, 1, 'one reported Via/polygon contact');
    const marker = contacts[0];
    assert.ok(onCopper(copper.vias[0], marker), 'reported marker is outside the drill and inside the annulus');
    assert.ok([...copper.areas, ...copper.segments].some(shape => onCopper(shape, marker)),
        'reported marker is also on the rounded polygon copper');
}
console.log('PASS physical contact witnesses: Via bores, unequal strokes, gaps, and rounded-polygon report');
