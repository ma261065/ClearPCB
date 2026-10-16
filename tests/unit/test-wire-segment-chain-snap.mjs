import assert from 'node:assert/strict';
import { Wire } from '../../src/shapes/wire.js';
import { buildCollinearChain, computeSegmentDragSnap } from '../../src/schematic/modules/wire-drag-snap.js';

for (const swap of [false, true]) for (const sign of [-1, 1]) for (const reverse of [false, true]) {
    const transform = ({ x, y }) => swap ? { x: y, y: sign * x } : { x: sign * x, y };
    const nodes = {
        n46: { x: 3.26, y: 0 }, n65: { x: 3.26, y: -3.81 }, n71: { x: 3.26, y: -6.35 },
        n14: { x: 0, y: 0 }, n48: { x: 0, y: -6.35 }, n74: { x: 8.87, y: -3.81 },
    };
    const edges = {
        e82: ['n46', 'n65'], e63: ['n71', 'n65'],
        e46: ['n46', 'n14'], e84: ['n48', 'n71'], e77: ['n74', 'n65'],
    };
    const wire = new Wire({
        graphNodes: Object.fromEntries(Object.entries(nodes).map(([id, point]) => [id, transform(point)])),
        graphEdges: Object.fromEntries(Object.entries(edges).map(([id, pair]) => [id, reverse ? [...pair].reverse() : pair])),
    });
    const state = wire.captureState();
    assert.equal(buildCollinearChain(wire, 'e82', state).size, 3);
    const app = { components: [], shapes: [wire], viewport: {
        scale: 20, gridSize: 1.27, getSnappedPosition: point => ({ ...point }),
    } };
    const axis = swap ? 'vertical' : 'horizontal';
    const from = state.nodes[state.edges.e82.from];
    for (const x of [2.52, 2.54, 0.1]) {
        const delta = transform({ x: x - 3.26, y: 0 });
        const target = { x: from.x + delta.x, y: from.y + delta.y };
        const result = computeSegmentDragSnap(app, wire, 'e82', state, target, axis);
        const expected = x === 0.1 ? transform({ x: 0, y: reverse ? -3.81 : 0 }) : target;
        assert.ok(Math.hypot(result.snappedTarget.x - expected.x, result.snappedTarget.y - expected.y) < 1e-9,
            'An extended chain does not snap toward a diagonal to the wrong node');
        assert.ok(result.guides.every(guide => guide.axisKind !== 'd'),
            'Horizontal branches do not advertise a phantom diagonal');
        if (x === 0.1) assert.ok(result.guides.some(guide => guide.collinear),
            'Real collinearity still produces its guide');
    }
}
console.log('PASS segment chain snapping uses every boundary node position across orientation and edge direction');
