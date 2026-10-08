import assert from 'node:assert/strict';
import {
    CongestionGrid,
    fixAngles,
    padPointBlocked,
    padSegmentBlocked,
    PathfinderGrid,
    pointToSegmentDist,
    sanitizeAngles,
    simplifyPath,
    SpatialHash,
} from '../../src/pcb/modules/autorouter-common.js';

assert.equal(pointToSegmentDist(1, 1, 0, 0, 2, 0), 1,
    'perpendicular point-to-segment distance is measured to the segment interior');
assert.equal(pointToSegmentDist(3, 4, 0, 0, 0, 0), 5,
    'zero-length segments fall back to point distance');

const rectPad = { cx: 0, cy: 0, hw: 1, hh: 1, shape: 'rect' };
assert.equal(padPointBlocked(1.3, 1.3, rectPad, 0.5), true,
    'rect pad clearance uses rounded-corner Minkowski distance');
assert.equal(padPointBlocked(1.4, 1.4, rectPad, 0.5), false,
    'rect pad clearance does not over-block the square corner');

const circlePad = { cx: 0, cy: 0, hw: 1, hh: 1, shape: 'ellipse' };
assert.equal(padSegmentBlocked(-2, 1.4, 2, 1.4, circlePad, 0.5), true,
    'circle pad clearance blocks segments within radius plus clearance');
assert.equal(padSegmentBlocked(-2, 1.6, 2, 1.6, circlePad, 0.5), false,
    'circle pad clearance permits segments beyond radius plus clearance');

const obstacles = new SpatialHash(2);
obstacles.insertPad(5, 5, 2, 2, 'pad_1', 'top', { shape: 'rect' });
assert.equal(obstacles.isBlocked(5, 5, 0.1, new Set(), 'top'), true,
    'a pad blocks its own copper area on its layer');
assert.equal(obstacles.isBlocked(5, 5, 0.1, new Set(['pad_1']), 'top'), false,
    'skipIds exempt the source/destination pad group');
assert.equal(obstacles.isBlocked(5, 5, 0.1, new Set(), 'bottom'), false,
    'single-layer pads do not block the other routing layer');
assert.equal(obstacles.isSegmentBlocked(3, 5, 7, 5, 0.1, new Set(), 'top'), true,
    'the obstacle grid catches segments through a pad');

const congestion = new CongestionGrid(1);
congestion.recordDemandLine(0, 0, 2, 0, 'A');
congestion.recordDemandLine(0, 0, 2, 0, 'B');
assert.equal(congestion.getCongestion(1, 0), 2,
    'congestion grid counts distinct nets using the same cell');

const pathfinderCosts = new PathfinderGrid(1);
pathfinderCosts.addUsage(1, 1, 'top', 'A');
assert.equal(pathfinderCosts.cellCost(1, 1, 'top', 4), 0,
    'one net in a cell is not overused');
pathfinderCosts.addUsage(1, 1, 'top', 'B');
assert.equal(pathfinderCosts.cellCost(1, 1, 'top', 4), 4,
    'present pathfinder cost rises when a second net contests the cell');
pathfinderCosts.accumulateHistory(2);
pathfinderCosts.clearDemand();
assert.equal(pathfinderCosts.cellCost(1, 1, 'top', 4), 2,
    'history cost remains after present demand is cleared');

const clearObstacles = {
    isOnPad: () => false,
    isSegmentBlocked: () => false,
};
const stair = [
    { x: 0, y: 0, layer: 'top' },
    { x: 1, y: 0, layer: 'top' },
    { x: 2, y: 0, layer: 'top' },
    { x: 2, y: 1, layer: 'top' },
];
assert.deepEqual(simplifyPath(stair, clearObstacles, new Set(), 0.3), [
    { x: 0, y: 0, layer: 'top' },
    { x: 2, y: 0, layer: 'top' },
    { x: 2, y: 1, layer: 'top' },
], 'simplifyPath removes redundant collinear waypoints but keeps the corner');
assert.deepEqual(fixAngles(stair), [
    { x: 0, y: 0, layer: 'top' },
    { x: 2, y: 0, layer: 'top' },
    { x: 2, y: 1, layer: 'top' },
], 'fixAngles also merges consecutive collinear steps');
assert.deepEqual(sanitizeAngles([
    { x: 0, y: 0, layer: 'top' },
    { x: 3, y: 1, layer: 'top' },
]), [
    { x: 0, y: 0, layer: 'top' },
    { x: 1, y: 1, layer: 'top' },
    { x: 3, y: 1, layer: 'top' },
], 'sanitizeAngles decomposes non-H/V/45-degree segments into legal angles');

console.log('PASS autorouter geometry: clearance, obstacle grids, congestion costs and path cleanup');
