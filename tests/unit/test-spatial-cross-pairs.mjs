import assert from 'node:assert/strict';
import { spatialPairs, spatialCrossPairs, prepareSpatialOrder, filterSpatialOrder, spatialCrossPairsPrepared } from '../../src/core/spatial-pairs.js';

let seed = 7321;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const boxes = count => Array.from({ length: count }, (_, id) => {
    const minX = random() * 20 - 10, minY = random() * 20 - 10;
    return { id, minX, minY, maxX: minX + random() * 5, maxY: minY + random() * 5 };
});
const extent = items => items.reduce((box, item) => ({
    minX: Math.min(box.minX, item.minX), minY: Math.min(box.minY, item.minY),
    maxX: Math.max(box.maxX, item.maxX), maxY: Math.max(box.maxY, item.maxY),
}), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
for (let count = 0; count < 50; count++) {
    const first = boxes(count), second = boxes(50 - count);
    for (const margin of [0, 0.2, 5]) {
        const expected = first.flatMap(left => second.filter(right =>
            left.minX <= right.maxX + margin && right.minX <= left.maxX + margin
            && left.minY <= right.maxY + margin && right.minY <= left.maxY + margin
        ).map(right => `${left.id}:${right.id}`)).sort();
        let boundsCalls = 0;
        const bounds = item => { boundsCalls++; return item; };
        const actual = [...spatialCrossPairs(first, second, bounds, margin)]
            .map(([left, right]) => `${left.id}:${right.id}`).sort();
        assert.deepEqual(actual, expected);
        assert.equal(boundsCalls, first.length + second.length);
        boundsCalls = 0;
        const firstOrder = prepareSpatialOrder(first, bounds), secondOrder = prepareSpatialOrder(second, bounds);
        assert.equal(boundsCalls, first.length + second.length);
        assert.deepEqual([...spatialCrossPairsPrepared(firstOrder, secondOrder, margin)],
            [...referencePairs(first, second, margin)], 'prepared merge retains exact orientation and stable tie order');
        assert.equal(boundsCalls, first.length + second.length, 'Prepared traversal performs no bounds callbacks');
        const firstCandidates = filterSpatialOrder(firstOrder, extent(second), margin);
        const secondCandidates = filterSpatialOrder(secondOrder, extent(first), margin);
        assert.deepEqual([...spatialCrossPairsPrepared(firstCandidates, secondCandidates, margin)],
            [...referencePairs(first, second, margin)], 'Conservative filtering preserves every pair and exact stable order');
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
for (const margin of [0, 1e-7, 0.2]) {
    const first = touching.slice(0, 3), second = touching.slice(3);
    const left = filterSpatialOrder(prepareSpatialOrder(first, item => item), extent(second), margin);
    const right = filterSpatialOrder(prepareSpatialOrder(second, item => item), extent(first), margin);
    assert.deepEqual([...spatialCrossPairsPrepared(left, right, margin)], [...referencePairs(first, second, margin)],
        'Filtered orders preserve equal-X ties and inclusive edge/tolerance contacts');
}
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
            boundsCalls = 0;
            const firstOrder = prepareSpatialOrder(first, bounds), secondOrder = prepareSpatialOrder(second, bounds);
            assert.equal(boundsCalls, first.length + second.length);
            assert.deepEqual([...spatialCrossPairsPrepared(firstOrder, secondOrder, margin)],
                [...referencePairs(first, second, margin)], 'prepared merge retains exact orientation and stable tie order');
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

{
    const first = prepareSpatialOrder(dense, item => item), second = prepareSpatialOrder(touching, item => item);
    const methods = ['map', 'flatMap', 'filter', 'sort'];
    const original = new Map(methods.map(name => [name, Array.prototype[name]]));
    let allocations = 0, pairs = 0;
    try {
        for (const name of methods) Array.prototype[name] = function (...args) {
            allocations++;
            return original.get(name).apply(this, args);
        };
        for (let pass = 0; pass < 10; pass++) {
            for (const pair of spatialCrossPairsPrepared(first, second)) pairs++;
        }
    } finally {
        for (const [name, method] of original) Array.prototype[name] = method;
    }
    assert.equal(pairs, crossCount * 10);
    assert.equal(allocations, 0, 'Prepared queries do not rebox, sort, map, flatten or filter their inputs');
    const before = first.slice(), otherBefore = second.slice();
    const paused = spatialCrossPairsPrepared(first, second);
    paused.next();
    assert.deepEqual([...spatialCrossPairsPrepared(first, second)],
        [...spatialCrossPairs(dense, touching, item => item)], 'Interleaved queries have independent sweep state');
    paused.return();
    assert.deepEqual(first, before);
    assert.deepEqual(second, otherBefore);
}
{
    const first = [{ minX: 0, maxX: 1, minY: 0, maxY: 1 }];
    const second = [{ minX: 3, maxX: 4, minY: 0, maxY: 1 }];
    assert.equal([...spatialCrossPairs(first, second, item => item)].length, 0);
    const pending = spatialCrossPairs(first, second, item => item);
    second[0].minX = 0.5;
    assert.equal([...pending].length, 1, 'Generic input capture remains lazy until iteration begins');
    assert.equal([...spatialCrossPairs(first, second, item => item)].length, 1,
        'Generic sweeps still resolve mutated bounds on every call');
    const ordered = prepareSpatialOrder(second, item => item);
    second[0] = { minX: 5, maxX: 6, minY: 0, maxY: 1 };
    assert.equal([...spatialCrossPairsPrepared(prepareSpatialOrder(first, item => item), ordered)].length, 1);
    assert.equal([...spatialCrossPairsPrepared(prepareSpatialOrder(first, item => item),
        prepareSpatialOrder(second, item => item))].length, 0, 'Explicit replacement preparation does not reuse an old ordering');
}
console.log('PASS: prepared sweeps preserve stable order and generic mutation behavior without repeated input allocations/sorts');

{
    const query = { minX: 20, maxX: 20.5, minY: 50, maxY: 50.2 };
    const ordered = prepareSpatialOrder(dense, item => item);
    const queryOrder = prepareSpatialOrder([query], item => item);
    let boundsVisits = 0;
    for (const entry of ordered) {
        const bounds = entry.bounds;
        Object.defineProperty(entry, 'bounds', { get() { boundsVisits++; return bounds; } });
    }
    const candidates = filterSpatialOrder(ordered, query);
    assert.equal(boundsVisits, 2101, 'Filter stops after the first minX beyond the query');
    assert.equal(candidates.length, 2);
    assert.ok(candidates.every(entry => ordered.includes(entry)), 'Candidates reuse the prepared records without boxing');
    const measure = source => {
        const push = Array.prototype.push;
        let visits = 0, peakActive = 0;
        try {
            Array.prototype.push = function (...args) {
                if (args[0]?.item && args[0].bounds) {
                    visits++;
                    peakActive = Math.max(peakActive, this.length + args.length);
                }
                return push.apply(this, args);
            };
            return { pairs: [...spatialCrossPairsPrepared(source, queryOrder)], get visits() { return visits; },
                get peakActive() { return peakActive; } };
        } finally { Array.prototype.push = push; }
    };
    const full = measure(ordered), pruned = measure(candidates);
    assert.deepEqual(pruned.pairs, full.pairs);
    assert.equal(full.visits, 4001);
    assert.equal(pruned.visits, 3);
    assert.equal(full.peakActive, 2100);
    assert.equal(pruned.peakActive, 2);
    const pending = spatialCrossPairsPrepared(candidates, queryOrder);
    const firstPair = pending.next().value;
    const otherQuery = filterSpatialOrder(ordered, { ...query, minY: 10, maxY: 10.2 });
    assert.equal(otherQuery.length, 2);
    assert.deepEqual([firstPair, ...pending], full.pairs, 'Interleaved candidate queries cannot overwrite prior results');
    assert.equal(filterSpatialOrder(ordered, { minX: -2, maxX: -1, minY: 0, maxY: 0 }).length, 0);
}
console.log('PASS: bounded filtering preserves pair order with 2101 bounds visits, 2 reused candidates and 3 instead of 4001 sweep visits');