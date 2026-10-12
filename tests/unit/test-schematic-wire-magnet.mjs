import assert from 'node:assert/strict';
import { gridSnapTolerance, snapToGridLines } from '../../src/core/grid-snap.js';
import { Wire } from '../../src/shapes/wire.js';
import { computeStickyWireSnaps, computeAnchorCollinearSnap, applyOffGridNeighborSnap } from '../../src/schematic/modules/wire-drag-snap.js';

for (const [gridSize, scale] of [[1, 100], [1, 4], [2, 20]]) {
    const tolerance = gridSnapTolerance(gridSize, scale);
    for (const distance of [tolerance * 0.9, tolerance * 1.1, gridSize * 0.5]) {
        const wire = new Wire({ points: [{ x: 0, y: 0 }, { x: 10, y: distance }] });
        const ids = [...wire.nodes.keys()];
        wire.pinConnections.set(ids[1], { componentId: 'part', pinNumber: '1' });
        const app = { shapes: [wire], viewport: { gridSize, scale, getEffectiveGridSize: () => gridSize } };
        const sticky = computeStickyWireSnaps(app, new Set(['part']), 0, 0);
        const grid = snapToGridLines({ x: 10, y: distance }, gridSize, scale);
        assert.equal(sticky.adjustY !== 0, grid.snappedY,
            `sticky wire pull matches the grid at ${distance} mm, scale ${scale}`);
        const anchor = computeAnchorCollinearSnap(app, wire, ids[1], { x: 10, y: distance });
        assert.equal(anchor.anchorPos.y === 0, grid.snappedY);
        const snapped = { x: 10, y: distance };
        applyOffGridNeighborSnap(snapped, snapped, [{ x: 0, y: 0 }], gridSize, tolerance);
        assert.equal(snapped.y === 0, grid.snappedY);
    }
}
console.log('PASS schematic wire and sticky-component axis magnets match displayed-grid pull distance');
