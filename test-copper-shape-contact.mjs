import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: () => ({ setAttribute() {}, dataset: {} }) };
const { reconcileRatsnest } = await import('./src/pcb/modules/track-draw.js');
const { copperShapesTouch } = await import('./src/pcb/modules/track-contact-geometry.js');
const circle = (options = {}) => ({ id: 'circle', kind: 'circle', x: 0, y: 0, radius: 2,
    filled: false, lineWidth: 0.2, layer: 'top-copper', net: 'GND', ...options });
const polygon = (left, top, right, bottom, options = {}) => ({
    id: 'polygon', kind: 'polygon', filled: false, lineWidth: 0.2, layer: 'top-copper', net: 'GND',
    points: [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }],
    ...options,
});
function ratlines(shapes) {
    const lines = [];
    const app = { boardShapes: shapes, copperFills: [], tracks: [], vias: [], placements: new Map(), netlist: [],
        _getLayerGroup: () => ({ children: [], appendChild(line) { lines.push(line); } }) };
    reconcileRatsnest(app);
    return lines.length;
}
const cases = [
    [circle(), polygon(-3, -0.1, 3, 0.1), true],
    [circle({ filled: true }), polygon(-3, -0.1, 3, 0.1), true],
    [circle(), polygon(2.15, -0.1, 3, 0.1), true],
    [circle(), polygon(2.25, -0.1, 3, 0.1), false],
    [circle(), polygon(-0.5, -0.5, 0.5, 0.5), false],
    [circle({ filled: true }), polygon(-0.5, -0.5, 0.5, 0.5), true],
    [circle(), polygon(-3, -3, 3, 3), false],
    [circle(), polygon(-3, -3, 3, 3, { filled: true }), true],
    [circle(), circle({ id: 'second', x: 3 }), true],
    [circle(), circle({ id: 'second', radius: 0.5 }), false],
    [polygon(-3, -0.1, 3, 0.1), polygon(-0.1, -3, 0.1, 3), true],
];
for (const [first, second, touches] of cases) {
    assert.equal(copperShapesTouch(first, second), touches);
    assert.equal(copperShapesTouch(second, first), touches);
    assert.equal(ratlines([first, second]), touches ? 0 : 1);
}
assert.equal(ratlines([circle(), polygon(-3, -0.1, 3, 0.1, { layer: 'bottom-copper' })]), 1);
assert.equal(ratlines([circle(), polygon(-3, -0.1, 3, 0.1, { net: 'VCC' }),
    circle({ id: 'remote', x: 10 })]), 1);
const moving = polygon(2.25, -0.1, 3, 0.1);
assert.equal(ratlines([circle(), moving]), 1);
for (const point of moving.points) point.x -= 1;
assert.equal(ratlines([circle(), moving]), 0);
for (const point of moving.points) point.x += 1;
assert.equal(ratlines([circle(), moving]), 1);
console.log('PASS: copper shape overlap, hollow interiors, layer/net isolation, and move/restore ratsnest');