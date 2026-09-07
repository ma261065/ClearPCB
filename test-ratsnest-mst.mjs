import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
const { _clusterMST } = await import('./src/pcb/modules/track-draw.js');

function closestPair(first, second) {
    let best = Infinity;
    let result = { x1: first[0].x, y1: first[0].y, x2: second[0].x, y2: second[0].y, d2: Infinity };
    for (const start of first) {
        for (const end of second) {
            const dx = start.x - end.x, dy = start.y - end.y;
            const distance = dx * dx + dy * dy;
            if (distance < best) {
                best = distance;
                result = { x1: start.x, y1: start.y, x2: end.x, y2: end.y, d2: distance };
            }
        }
    }
    return result;
}

function originalMST(nodes) {
    const count = nodes.length;
    const edges = [];
    if (count < 2) return edges;
    const inTree = new Uint8Array(count);
    const best = new Float64Array(count).fill(Infinity);
    const bestFrom = new Int32Array(count).fill(-1);
    inTree[0] = 1;
    const relax = (source) => {
        for (let target = 0; target < count; target++) {
            if (inTree[target]) continue;
            const distance = closestPair(nodes[source], nodes[target]).d2;
            if (distance < best[target]) { best[target] = distance; bestFrom[target] = source; }
        }
    };
    relax(0);
    for (let iteration = 1; iteration < count; iteration++) {
        let selected = -1, distance = Infinity;
        for (let target = 0; target < count; target++) {
            if (!inTree[target] && best[target] < distance) {
                distance = best[target];
                selected = target;
            }
        }
        if (selected === -1) break;
        inTree[selected] = 1;
        const pair = closestPair(nodes[bestFrom[selected]], nodes[selected]);
        edges.push({ x1: pair.x1, y1: pair.y1, x2: pair.x2, y2: pair.y2 });
        relax(selected);
    }
    return edges;
}

const fixtures = [
    [],
    [[{ x: 0, y: 0 }]],
    [[{ x: 0, y: 0 }], [{ x: 1, y: 0 }], [{ x: 0, y: 1 }], [{ x: 1, y: 1 }]],
    [[{ x: 0, y: 0 }, { x: 0, y: 0 }], [{ x: 0, y: 0 }], [{ x: -2, y: 0 }]],
    [[{ x: -10, y: 0 }, { x: 10, y: 0 }], [{ x: 12, y: 0 }], [{ x: 11, y: 0 }]],
];
let seed = 62813;
const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
};
for (let sample = 0; sample < 120; sample++) {
    fixtures.push(Array.from({ length: 2 + Math.floor(random() * 19) }, () =>
        Array.from({ length: 1 + Math.floor(random() * 18) }, () => ({
            x: Math.floor(random() * 40) - 20,
            y: Math.floor(random() * 40) - 20,
        }))));
}
for (const nodes of fixtures) {
    assert.deepEqual(_clusterMST(nodes), originalMST(nodes));
    assert.equal(_clusterMST(nodes).length, Math.max(0, nodes.length - 1));
}

let reads = 0;
const countedNodes = Array.from({ length: 2 }, (_, cluster) =>
    Array.from({ length: 100 }, (_, point) => ({
        get x() { reads++; return cluster * 150 + point; },
        get y() { reads++; return point % 7; },
    })));
const expected = originalMST(countedNodes);
const originalReads = reads;
reads = 0;
assert.deepEqual(_clusterMST(countedNodes), expected);
assert.equal(reads * 2, originalReads, 'A two-cluster MST must search its point pairs only once');

console.log(`PASS: ${fixtures.length} exact MST comparisons; two-cluster coordinate reads ${originalReads} -> ${reads}`);