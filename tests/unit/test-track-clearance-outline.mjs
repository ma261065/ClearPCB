import assert from 'node:assert/strict';
import { Track } from '../../src/shapes/track.js';
import { renderTrack, buildTrackLayerRuns } from '../../src/pcb/modules/track-render.js';
import { showClearances, clearanceOverlayState } from '../../src/pcb/modules/clearance-overlay.js';
import { trackClearanceOutlines } from '../../src/pcb/modules/copper-fill-geom.js';
import { installFakeDom, fakeElement } from './helpers/fake-dom.mjs';

installFakeDom();
const groups = new Map();
const getLayerGroup = id => {
    if (!groups.has(id)) {
        const group = fakeElement('g');
        const query = group.querySelectorAll.bind(group);
        group.querySelectorAll = selector => selector.split(',').flatMap(part => query(part.trim()));
        groups.set(id, group);
    }
    return groups.get(id);
};
const radius = 0.4;
const distance = (point, start, end) => {
    const dx = end.x - start.x, dy = end.y - start.y;
    const length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length)) : 0;
    return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
};
const outlinePoints = element => element.getAttribute('points').split(' ').map(pair => {
    const [x, y] = pair.split(',').map(Number);
    return { x, y };
});

const track = new Track({ id: 'pad-connected', net: 'GND', width: 0.4, points: [
    { x: 40, y: -20 }, { x: 40, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: -5 },
] });
track.padConnections.set('n0', { componentId: 'U1', pinNumber: 'thermal' });
const app = { getLayerGroup, getRoutingParams: () => ({ clearance: 0.2, trackWidth: 0.4 }),
    placements: new Map(), tracks: [track], vias: [], boardShapes: [], texts: new Map() };
renderTrack(track, getLayerGroup);
showClearances(app, true);
function assertBoundary(outlines, points, radius) {
    const segments = points.slice(1).map((end, index) => [points[index], end]);
    assert.ok(outlines.length);
    for (const outline of outlines) {
        for (let index = 0; index < outline.length; index++) {
            const start = outline[index], end = outline[(index + 1) % outline.length];
            for (const t of [0, 0.25, 0.5, 0.75]) {
                const point = { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
                const gap = Math.min(...segments.map(([a, b]) => distance(point, a, b)));
                assert.ok(Math.abs(gap - radius) < 0.005,
                    `Clearance follows copper at (${point.x}, ${point.y}); ${gap} mm from centreline, expected ${radius}`);
            }
        }
    }
}
const paths = buildTrackLayerRuns(track);
assertBoundary(clearanceOverlayState(app).trackElements.get(track.id).map(outlinePoints), paths[0].points, radius);
const before = track.captureState();
const full = clearanceOverlayState(app).trackElements.get(track.id).map(outlinePoints);
showClearances(app, true, track);
assert.deepEqual(clearanceOverlayState(app).trackElements.get(track.id).map(outlinePoints), full,
    'Full and live refresh use identical track boundaries');
assert.deepEqual(track.captureState(), before, 'Outline generation never edits authored or connected geometry');
track.padConnections.clear();
showClearances(app, true, track);
assert.deepEqual(clearanceOverlayState(app).trackElements.get(track.id).map(outlinePoints), full,
    'Pad attachment alone cannot distort the halo');
const cases = [
    [[0, 0], [20, 0]],
    [[0, 0], [0, 0], [20, 0]],
    [[0, 0], [20, 0], [20, 10]],
    [[0, 0], [20, 0], [0, 0]],
    [[0, 0], [20, 0], [0.001, 0.001], [0, -10]],
    [[0, 0], [10, 10], [0, 10], [10, 0]],
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
];
for (const coordinates of cases) {
    for (const reverse of [false, true]) {
        for (const angle of [0, Math.PI / 3, Math.PI]) {
            const points = coordinates.map(([x, y]) => ({
                x: 30 + x * Math.cos(angle) - y * Math.sin(angle),
                y: -40 + x * Math.sin(angle) + y * Math.cos(angle),
            }));
            if (reverse) points.reverse();
            const outlines = trackClearanceOutlines(points, 0.4, 0.2);
            assertBoundary(outlines, points, radius);
            if (coordinates === cases.at(-1)) assert.equal(outlines.length, 2, 'Closed-loop clearance retains its inner boundary');
        }
    }
}
track.setEdgeAttr('e0', 'width', 0.8);
track.setEdgeAttr('e0', 'layer', 'bottom-copper');
renderTrack(track, getLayerGroup);
showClearances(app, true);
const mixed = clearanceOverlayState(app).trackElements.get(track.id);
assert.equal(mixed.length, buildTrackLayerRuns(track).length, 'Per-edge layer and width changes retain their own halos');
getLayerGroup('bottom-copper').style.display = 'none';
showClearances(app, true);
assert.equal(clearanceOverlayState(app).trackElements.get(track.id).length, mixed.length - 1, 'Hidden-layer tracks have no halo');
showClearances(app, false);
assert.equal(clearanceOverlayState(app).trackElements.size, 0);
console.log('PASS track clearance reversals, intersections, loops, live parity, attachments, widths and layer visibility');
