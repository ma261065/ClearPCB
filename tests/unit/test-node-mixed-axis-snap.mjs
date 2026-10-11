import assert from 'node:assert/strict';
import { snapNodeToAxis, resolvePathPoint } from '../../src/shapes/path-snap.js';
import { axisAlignment, pathAlignmentSegments } from '../../src/shapes/axis-glow.js';
import { snapShapePoint } from '../../src/schematic/modules/shape-snap.js';
import { snapPathPoint } from '../../src/pcb/modules/path-edit.js';
import { computeMovingSegmentSnaps } from '../../src/schematic/modules/wire-drag-snap.js';

const close = (actual, expected) => {
    assert.ok(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1e-9,
        `${JSON.stringify(actual)} should match ${JSON.stringify(expected)}`);
};
let cases = 0;
for (const swap of [false, true]) for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const transform = ({ x, y }) => ({ x: 0.13 + sx * (swap ? y : x), y: -0.27 + sy * (swap ? x : y) });
    const neighbours = [transform({ x: 0, y: 0 }), transform({ x: 10, y: 10 })];
    const intersection = transform({ x: 20, y: 0 });
    for (const reverse of [false, true]) {
        const fixed = reverse ? [...neighbours].reverse() : neighbours;
        for (const dx of [-0.2, -0.1, 0.1, 0.2]) for (const dy of [-0.2, -0.1, 0.1, 0.2]) {
            const point = transform({ x: 20 + dx, y: dy });
            const grid = transform({ x: 20 + dx, y: 0.25 });
            close(snapNodeToAxis(point, fixed, 0.4, grid), intersection);
            close(resolvePathPoint(point, fixed, grid, 0.4), intersection);
            const schematic = { components: [], shapes: [],
                viewport: { scale: 20, gridSize: 1, gridVisible: true } };
            const pcb = { viewport: { scale: 20, gridSize: 1, snapToGrid: true } };
            close(snapShapePoint(schematic, point, fixed), intersection);
            close(snapPathPoint(pcb, point, fixed), intersection);
            const wire = computeMovingSegmentSnaps(0.4, fixed.map(neighbour => ({
                moving: point, fixed: neighbour,
            })), undefined, { diagonal: true });
            close({ x: point.x + wire.adjustX, y: point.y + wire.adjustY }, intersection);
            assert.deepEqual(wire.guides.map(guide => guide.axisKind).sort(), [swap ? 'v' : 'h', 'd'].sort());
            const guides = pathAlignmentSegments([fixed[0], intersection, fixed[1]], false, [1]);
            assert.equal(guides.length, 2, 'Both adjoining segments advertise exact alignment');
            assert.deepEqual(guides.map(guide => guide.axisKind).sort(), [swap ? 'v' : 'h', 'd'].sort());
            cases++;
        }
    }
}
const neighbours = [{ x: 0, y: 0 }, { x: 10, y: 10 }];
const outside = snapNodeToAxis({ x: 20.5, y: 0.1 }, neighbours, 0.4);
assert.equal(axisAlignment(neighbours[0], outside), 'h', 'Single-axis snap remains available outside the intersection band');
assert.equal(axisAlignment(neighbours[1], outside), null, 'A distant intersection must not attract the node');
close(snapNodeToAxis({ x: 5.1, y: 5.2 }, [{ x: 0, y: 0 }], 0.4), { x: 5.2, y: 5.2 });
close(snapNodeToAxis({ x: 10.1, y: 0.1 }, [{ x: 0, y: 0 }, { x: 10, y: 10 }], 0.4), { x: 10, y: 0 });
close(resolvePathPoint({ x: 20.1, y: 0.1 }, neighbours, { x: 20, y: 0 }, 0.4, { x: 21, y: 1 }), { x: 21, y: 1 });
const straight = resolvePathPoint({ x: 5, y: 5.1 }, neighbours, { x: 5, y: 5 }, 0.4);
assert.ok(Math.abs(straight.x - straight.y) < 1e-9, 'Collinear snapping retains priority');
const free = { x: 20.1, y: 0.2 };
close(snapShapePoint({ viewport: { shiftHeld: true } }, free, neighbours), free);
close(snapPathPoint({ viewport: { shiftHeld: true } }, free, neighbours), free);
console.log(`PASS ${cases} H/V-45 node snap cases across both editors, wires, reflections, neighbour order and grid competition`);
