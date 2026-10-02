import assert from 'node:assert/strict';
import { getComputedFill, setComputedFill } from '../src/pcb/modules/computed-fill-cache.js';
import { distanceToSegment, pointInPolygon } from '../src/core/geometry.js';
import { padFlashOutline } from '../src/shared/pcb/board-geometry.js';
import { padCopperOutline } from '../src/pcb/modules/copper-model.js';
import { buildFillContext } from '../src/pcb/modules/fill-context.js';
import { computeFillPolygons, loadClipper } from '../src/pcb/modules/copper-fill-geom.js';
import { CopperFill } from '../src/shapes/copper-fill.js';
import { Pad } from '../src/shapes/pad.js';

globalThis.window = { addEventListener() {} };
const { collectCopper, createCopperDistanceChecker, runDRC } = await import('../src/pcb/modules/drc.js');
await loadClipper();
const rectangle = (left, top, right, bottom) => [
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
];
const board = clearance => ({
    placements: new Map(), netlist: [], tracks: [], vias: [], pads: [], boardShapes: [], texts: new Map(),
    copperFills: [new CopperFill({ net: 'GND', layer: 'top-copper', outline: rectangle(-30, -30, 30, 30) })],
    getRoutingParams: () => ({ clearance }),
});
const pour = app => {
    const fill = app.copperFills[0];
    setComputedFill(fill, computeFillPolygons(fill, buildFillContext(app)));
    assert.ok(getComputedFill(fill).length, 'the fixture must contain actual poured copper');
};
const checkGeneratedGap = (app, clearance, label) => {
    pour(app);
    const { pads, areas } = collectCopper(app);
    const distance = createCopperDistanceChecker();
    for (const pad of pads) for (const area of areas) {
        const gap = distance(pad, area).dist;
        assert.ok(gap >= clearance, `${label}: generated gap ${gap} must meet ${clearance}`);
    }
    assert.equal(runDRC(app, { clearance }).ok, true, `${label}: generated clearance must pass DRC`);
};

// U3's slotted 1 x 2 mm pads, at their saved non-grid-rounded coordinates.
const u3 = board(0.15);
const offsets = [
    [2.400046, -4.799965], [-2.400046, -3.799967], [2.400046, -1.200023],
    [-2.400046, 3.200019], [2.100072, 4.799965],
];
u3.placements.set('U3', { x: 7, y: -8, rotation: 0, reference: 'U3',
    padOffsets: offsets.map(([dx, dy], index) => ({
        dx, dy, padId: String(index + 1), number: String(index + 1), layer: 'both', shape: 'oval',
        width: 0.999998, height: 1.999996, drill: 0.5999988, slotLength: 1.5999968,
    })),
});
u3.netlist = offsets.map((_, index) => ({ net: `U3.${index + 1}`,
    pins: [{ componentId: 'U3', pinNumber: String(index + 1) }] }));
checkGeneratedGap(u3, 0.15, 'U3 saved geometry');

const near = (point, contour) => contour.some((start, index) =>
    distanceToSegment(point, start, contour[(index + 1) % contour.length]) < 1e-9);
for (const [width, height] of [[1, 2], [2, 1], [0.6, 6], [6, 0.6], [1, 1]]) {
    const radius = Math.min(width, height) / 2;
    const dx = width / 2 - radius, dy = height / 2 - radius;
    const conservative = padCopperOutline({ x: 0, y: 0, width, height, shape: 'oval' });
    const physical = padFlashOutline({ x: 0, y: 0, w: width, h: height, shape: 'oval' });
    for (const x of [-1, 1]) for (const y of [-1, 1]) {
        const tangent = dx ? { x: x * dx, y: y * radius } : { x: x * radius, y: y * dy };
        assert.ok(near(tangent, physical), 'physical capsule includes each exact arc/straight tangency');
    }
    for (let index = 0; index < 720; index++) {
        const angle = index * Math.PI / 360;
        const point = { x: Math.sign(Math.cos(angle)) * dx + radius * Math.cos(angle),
            y: Math.sign(Math.sin(angle)) * dy + radius * Math.sin(angle) };
        assert.ok(pointInPolygon(point, conservative) || near(point, conservative),
            `conservative ${width} x ${height} capsule must enclose its entire analytic boundary`);
    }
}

for (const standalone of [false, true]) for (const [width, height] of [[1, 2], [2, 1], [0.6, 6]]) {
    for (const rotation of [0, 37, 90]) for (const clearance of [0.1, 0.15, 0.2, 1.67]) {
        const app = board(clearance);
        let moved;
        if (standalone) {
            moved = new Pad({ x: 0.12345, y: -0.23456, width, height, shape: 'stadium',
                rotation, drill: 0.3, layers: 'both', net: 'SIGNAL' });
            app.pads.push(moved);
        } else {
            moved = { x: 0.12345, y: -0.23456, rotation, mirror: true, reference: 'U3',
                padOffsets: [{ dx: 0, dy: 0, padId: '1', number: '1', layer: 'both',
                    width, height, shape: 'oval', drill: 0.3, slotLength: 0.8 }] };
            app.placements.set('U3', moved);
            app.netlist = [{ net: 'SIGNAL', pins: [{ componentId: 'U3', pinNumber: '1' }] }];
        }
        const label = `${standalone ? 'standalone' : 'footprint'} ${width} x ${height}, ${rotation} deg, ${clearance} mm`;
        checkGeneratedGap(app, clearance, label);
        moved.x += 0.02;
        assert.ok(runDRC(app, { clearance }).violations.some(v => v.rule === 'clearance'),
            `${label}: a real 0.02 mm intrusion into the existing pour remains an error`);
    }
}
console.log('PASS U3 pad/pour clearance, conservative capsule outlines, rotations, mirrored pads and genuine intrusions');
