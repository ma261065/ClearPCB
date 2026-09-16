import assert from 'node:assert/strict';
import { spatialCrossPairs } from '../src/core/spatial-pairs.js';

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