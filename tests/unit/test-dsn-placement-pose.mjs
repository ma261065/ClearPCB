import assert from 'node:assert/strict';
import { exportDSN, importDSN } from '../../src/pcb/modules/dsn.js';
import { placementPose } from '../../src/shared/pcb/board-geometry.js';
import { applyPlacementSide } from '../../src/core/pcb-placement-geometry.js';

// An asymmetric footprint: a wide SMD pad and a tall through-hole pad off-centre.
const footprint = () => [
    { number: '1', padId: '1', dx: -2, dy: 1, width: 1.6, height: 0.6, layer: 'top', shape: 'rect' },
    { number: '2', padId: '2', dx: 3, dy: -0.5, width: 1, height: 2, layer: 'both', shape: 'stadium' },
];

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-3,
    `${message}: ${actual} != ${expected}`);

for (const rotation of [0, 90, 180, 270]) for (const side of ['top', 'bottom']) for (const mirror of [false, true]) {
    const placement = { x: 10, y: 20, rotation, side: 'top', mirror, reference: 'U1', padOffsets: footprint() };
    applyPlacementSide(placement, side);
    const other = { x: 30, y: 20, reference: 'U2', padOffsets: footprint() };
    const dsn = exportDSN({
        placements: new Map([['u1', placement], ['u2', other]]),
        netlist: [{ net: 'N', pins: [{ componentId: 'u1', pinNumber: '1' }, { componentId: 'u2', pinNumber: '1' }] }],
        trackWidth: 0.25, clearance: 0.2, viaDiameter: 0.6,
    });
    const label = `rotation ${rotation}, ${side}${mirror ? ', mirrored' : ''}`;
    const dsnRotation = (360 - rotation) % 360;
    assert.match(dsn, new RegExp(`\\(place U1 10000 -20000 ${side === 'bottom' ? 'back' : 'front'} ${dsnRotation}\\)`),
        `${label}: the DSN carries the rotation (counter-clockwise, Y-up) and side`);
    const pads = importDSN(dsn).routeInput.allObstaclePads.slice(0, 2);
    const pose = placementPose(placement);
    const swap = rotation % 180 !== 0;
    placement.padOffsets.forEach((offset, index) => {
        const expected = pose.xf(offset.dx, offset.dy);
        near(pads[index].x, expected.x, `${label}: pad ${offset.number} x`);
        near(pads[index].y, expected.y, `${label}: pad ${offset.number} y`);
        near(pads[index].width, swap ? offset.height : offset.width, `${label}: pad ${offset.number} width`);
        near(pads[index].height, swap ? offset.width : offset.height, `${label}: pad ${offset.number} height`);
        assert.equal(pads[index].layer, offset.layer, `${label}: pad ${offset.number} copper side`);
    });
}

const dsn = exportDSN({
    placements: new Map([['u1', { x: 0, y: 0, reference: 'U1', padOffsets: footprint() }]]),
    netlist: [], trackWidth: 0.25, clearance: 0.2, viaDiameter: 0.6,
});
assert.match(dsn, /\(padstack stadium_1000x2000_both\n\s+\(shape \(path F\.Cu 1000 0 -500 0 500\)\)\n\s+\(shape \(path B\.Cu 1000 0 -500 0 500\)\)/,
    'Through-hole pads have copper on both layers and keep their stadium shape');
assert.match(dsn, /\(padstack rect_1600x600_top\n\s+\(shape \(rect F\.Cu -800 -300 800 300\)\)\n\s+\(attach off\)/,
    'SMD pads stay on their own copper layer');

console.log('PASS DSN export carries component rotation, side and mirror so Freerouting places pads where ClearPCB does');
