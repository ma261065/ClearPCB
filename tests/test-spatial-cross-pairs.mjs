import assert from 'node:assert/strict';
import { spatialPairs, spatialCrossPairs } from '../src/core/spatial-pairs.js';

let seed = 7321;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const boxes = count => Array.from({ length: count }, (_, id) => {
    const minX = random() * 20 - 10, minY = random() * 20 - 10;
    return { id, minX, minY, maxX: minX + random() * 5, maxY: minY + random() * 5 };
});
for (let count = 0; count < 50; count++) {
    const first = boxes(count), second = boxes(50 - count);
    for (const margin of [0, 0.2, 5]) {
        const expected = first.flatMap(left => second.filter(right =>
            left.minX <= right.maxX + margin && right.minX <= left.maxX + margin
            && left.minY <= right.maxY + margin && right.minY <= left.maxY + margin
        ).map(right => `${left.id}:${right.id}`)).sort();
        let boundsCalls = 0;
        const actual = [...spatialCrossPairs(first, second, item => { boundsCalls++; return item; }, margin)]
            .map(([left, right]) => `${left.id}:${right.id}`).sort();
        assert.deepEqual(actual, expected);
        assert.equal(boundsCalls, first.length + second.length);
    }
}
console.log('PASS: spatial cross-pairs match 150 exhaustive fixtures with one bounds lookup per item');

// Preserve the pre-compaction sweep's pair order, including equal-X ties.
function* referencePairs(first, second, margin) {
    const cross = second !== null;
    const ordered = [first, ...(cross ? [second] : [])]
        .flatMap((items, side) => items.map(item => ({ item, side, bounds: item })))
        .sort((left, right) => left.bounds.minX - right.bounds.minX);
    const active = [[], []];
    for (const current of ordered) {
        const side = cross ? 1 - current.side : 0;
        active[side] = active[side].filter(entry => entry.bounds.maxX + margin >= current.bounds.minX);
        for (const entry of active[side]) {
            if (entry.bounds.maxY + margin < current.bounds.minY
                || current.bounds.maxY + margin < entry.bounds.minY) continue;
            yield cross && current.side === 0 ? [current.item, entry.item] : [entry.item, current.item];
        }
        active[current.side].push(current);
    }
}

const touching = Object.freeze([
    { id: 'point', minX: 0, maxX: 0, minY: 0, maxY: 0 },
    { id: 'vertical', minX: 0, maxX: 0, minY: -1, maxY: 1 },
    { id: 'wide', minX: 0, maxX: 10, minY: 0, maxY: 1 },
    { id: 'edge', minX: 10, maxX: 11, minY: 1, maxY: 2 },
    { id: 'tolerance', minX: 11 + 1e-7, maxX: 12, minY: 1, maxY: 2 },
].map(Object.freeze));
for (const first of [Object.freeze([]), touching,
    ...Array.from({ length: 30 }, (_, count) => Object.freeze(boxes(count).map(Object.freeze)))]) {
    for (const margin of [0, 1e-7, 0.2, 5]) {
        let boundsCalls = 0;
        const bounds = item => { boundsCalls++; return item; };
        const expected = [...referencePairs(first, null, margin)];
        const actual = [...spatialPairs(first, bounds, margin)];
        assert.deepEqual(actual, expected, 'single-set sweep retains exact pair order');
        assert.equal(boundsCalls, first.length);
        assert.equal(actual.length, first.reduce((count, left, index) => count
            + first.slice(index + 1).filter(right =>
                left.minX <= right.maxX + margin && right.minX <= left.maxX + margin
                && left.minY <= right.maxY + margin && right.minY <= left.maxY + margin).length, 0));
        for (const second of [Object.freeze([]), touching, first]) {
            boundsCalls = 0;
            assert.deepEqual([...spatialCrossPairs(first, second, bounds, margin)],
                [...referencePairs(first, second, margin)], 'cross-set sweep retains exact pair order');
            assert.equal(boundsCalls, first.length + second.length);
        }
    }
}
console.log('PASS: both spatial sweeps preserve pair order, ties, empty/same sets, bounds counts and inclusive margins');

const dense = Object.freeze(Array.from({ length: 4000 }, (_, id) => Object.freeze({
    id, minX: id % 40, maxX: id % 40 + 1, minY: Math.floor(id / 40), maxY: Math.floor(id / 40) + 0.2,
})));
let filters = 0, singleCount = 0, crossCount = 0;
const filter = Array.prototype.filter;
try {
    Array.prototype.filter = function (...args) { filters++; return filter.apply(this, args); };
    for (const pair of spatialPairs(dense, item => item)) singleCount++;
    for (const pair of spatialCrossPairs(dense, touching, item => item)) crossCount++;
} finally {
    Array.prototype.filter = filter;
}
assert.ok(singleCount > 0 && crossCount > 0);
assert.equal(filters, 0, 'expiry reuses active arrays instead of allocating one filtered array per item');
console.log('PASS: 4,000-box spatial sweeps allocate no per-item filtered active arrays');