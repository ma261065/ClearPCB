import assert from 'node:assert/strict';
import { expandCopperContactRoots } from '../../src/pcb/modules/track-draw.js';
const key = (a, b) => [a, b].sort((x, y) => x - y).join(':');
const contact = (id, root = id, layer = 'top-copper') => ({
    root, layer, resolved: { id, bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 } },
});

function compare(contacts, seeds, links, newTracks = null) {
    const expected = new Set(seeds), edges = [];
    let exhaustiveCalls = 0, calls = 0;
    for (let i = 0; i < contacts.length; i++) for (let j = i + 1; j < contacts.length; j++) {
        const a = contacts[i], b = contacts[j];
        if (a.root === b.root || (a.layer !== b.layer && a.layer !== 'all' && b.layer !== 'all')) continue;
        const fill = [a, b].find(c => c.shape?.type === 'fill')?.shape;
        const track = a.track || b.track;
        if (fill?.net && newTracks?.has(track) && fill.net !== track.net) continue;
        exhaustiveCalls++;
        if (links.has(key(a.resolved.id, b.resolved.id))) edges.push([a.root, b.root]);
    }
    let changed;
    do {
        changed = false;
        for (const [a, b] of edges) {
            if (expected.has(a) === expected.has(b)) continue;
            expected.add(a); expected.add(b);
            changed = true;
        }
    } while (changed);
    const actual = new Set(seeds);
    expandCopperContactRoots(contacts, actual, newTracks, (a, b) => {
        calls++;
        return links.has(key(a.id, b.id));
    });
    assert.deepEqual([...actual].sort((a, b) => a - b), [...expected].sort((a, b) => a - b),
        'Seed-reachable contacts match exhaustive physical connectivity');
    assert.ok(calls <= exhaustiveCalls);
    return { calls, exhaustiveCalls, actual };
}

const dense = Array.from({ length: 80 }, (_, id) => contact(id));
const links = new Set([key(0, 1), key(1, 2)]);
for (let i = 3; i < dense.length; i++) for (let j = i + 1; j < dense.length; j++) links.add(key(i, j));
const bounded = compare(dense, [0], links);
assert.ok(bounded.calls < bounded.exhaustiveCalls * 0.1,
    'Unrelated dense artwork must eliminate at least 90% of exact contact checks');
assert.equal(compare(dense, [], links).calls, 0, 'No seed means no exact contact checks');
compare(dense, [0, 3], links);
compare(dense.toReversed(), [2], links);
compare([contact(0, 0), contact(1, 0), contact(2, 1), contact(3, 2)],
    [0], new Set([key(1, 2), key(2, 3)]));
compare([contact(0, 0, 'top-copper'), contact(1, 1, 'bottom-copper'), contact(2, 2, 'all')],
    [0], new Set([key(0, 1), key(0, 2), key(1, 2)]));

const track = { net: 'A' };
const route = { ...contact(0), track };
const fill = { ...contact(1), shape: { type: 'fill', net: 'B' } };
assert.equal(compare([route, fill], [0], new Set([key(0, 1)]), new Set([track])).actual.size, 1,
    'New routes still reserve clearance in foreign-net cached pours');
assert.equal(compare([route, fill], [0], new Set([key(0, 1)])).actual.size, 2,
    'Existing physical contacts remain reachable regardless of Net names');

let seed = 0xabc123;
const random = max => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
};
for (let trial = 0; trial < 300; trial++) {
    const contacts = Array.from({ length: 24 }, (_, id) =>
        contact(id, random(16), ['top-copper', 'bottom-copper', 'all'][random(3)]));
    const pairs = new Set();
    for (let i = 0; i < contacts.length; i++) for (let j = i + 1; j < contacts.length; j++) {
        if (random(5) === 0) pairs.add(key(i, j));
    }
    compare(contacts, Array.from({ length: random(4) }, () => random(20)), pairs);
}
console.log(`PASS reachable/exhaustive contact parity in 300 mixed-layer/group cases; dense checks ${bounded.exhaustiveCalls} -> ${bounded.calls}`);
