import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
const { resolveBoardShapeGeometry } = await import('../src/shared/pcb/board-shape-geometry.js');
const { getBoardShapeAnchors } = await import('../src/pcb/modules/board-shapes.js');

for (const reversed of [false, true]) {
    for (const filled of [false, true]) {
        let previousTip = null;
        for (let step = -20; step <= 20; step++) {
            const angle = 2 * Math.asin(0.1) + step * 0.0001;
            const points = [{ x: 0, y: 0 }, { x: 100, y: -100 * Math.tan(angle / 2) },
                { x: 100, y: 100 * Math.tan(angle / 2) }];
            if (reversed) points.reverse();
            const shape = { kind: 'polygon', layer: 'top-copper', points, lineWidth: 2, filled };
            const contours = resolveBoardShapeGeometry(shape).physicalContours;
            const tip = Math.min(...contours.flat().map(point => point.x));
            assert.ok(Math.abs(tip + shape.lineWidth / 2) < 0.003,
                'Round joins extend one half-width beyond an acute corner, without miter spikes');
            if (previousTip !== null) assert.ok(Math.abs(tip - previousTip) < 0.01, 'Tiny angle changes must not pop the corner');
            previousTip = tip;
            assert.deepEqual(getBoardShapeAnchors(shape).filter(anchor => !anchor.midpoint).map(({ x, y }) => ({ x, y })), points);
        }
    }
}
console.log('PASS continuous round joins across the former miter threshold with fixed centreline handles');