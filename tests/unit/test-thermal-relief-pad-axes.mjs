import assert from 'node:assert/strict';
import { computeFillPolygons, loadClipper } from '../../src/pcb/modules/copper-fill-geom.js';
import { resolveCopperPads } from '../../src/pcb/modules/copper-model.js';
import { Pad } from '../../src/shapes/pad.js';

// A same-net pad's thermal relief: four spokes along the pad's own axes reach the pour
// across the clearance ring, whatever the pad's aspect ratio and rotation, and the ring
// between the spokes stays clear.
const C = await loadClipper();
const inside = (point, polygon) => {
    let result = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const a = polygon[i], b = polygon[j];
        if ((a.y > point.y) !== (b.y > point.y)
            && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
    }
    return result;
};
const copperAt = (pours, point) => pours.some(pour =>
    inside(point, pour.outer) && !pour.holes.some(hole => inside(point, hole)));

const clearance = 0.3;
const square = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }];
for (const shape of ['stadium', 'rectangle', 'oval', 'round', 'square']) {
    for (const rotation of [0, 30, 90, 135]) {
        const pad = new Pad({ shape, size: 1.5, ratio: 2.5, rotation, drill: 0.6, net: 'GND', layers: 'both' });
        const context = { params: { clearance }, board: null, pads: resolveCopperPads({ pads: [pad] }),
            tracks: [], vias: [], boardShapes: [], texts: [], holes: [] };
        const pours = computeFillPolygons({ layer: 'top-copper', net: 'GND', outline: square }, context, C);
        // Points in the pad's own frame, turned as its outline is (padFlashOutline).
        const angle = -rotation * Math.PI / 180;
        const at = (u, v) => ({ x: u * Math.cos(angle) - v * Math.sin(angle), y: u * Math.sin(angle) + v * Math.cos(angle) });
        const halfLength = pad.width / 2 + clearance / 2, halfWidth = pad.height / 2 + clearance / 2;
        const label = `${shape} at ${rotation}°`;
        for (const [u, v, side] of [[halfLength, 0, 'end'], [-halfLength, 0, 'end'],
            [0, halfWidth, 'side'], [0, -halfWidth, 'side']]) {
            assert.ok(copperAt(pours, at(u, v)), `${label}: a spoke crosses the clearance at each ${side}`);
        }
        const corner = at(pad.width / 2 + clearance / 2, pad.height / 2 + clearance / 2);
        if (shape === 'rectangle' || shape === 'square') {
            assert.equal(copperAt(pours, corner), false, `${label}: the ring between spokes stays clear`);
        }
        const beside = at(pad.width / 2 - Math.min(pad.width, pad.height) / 4, halfWidth);
        if (shape === 'stadium' || shape === 'rectangle') {
            // Straight long sides: just inside the end, the clearance ring beside the spoke is void.
            assert.equal(copperAt(pours, beside), false, `${label}: the long side is clear beside its spoke`);
        }
    }
}

console.log('PASS thermal reliefs follow the pad\'s axes for every shape, aspect ratio and rotation');

// A spoke that cannot reach pour copper is voided, not left dangling from the pad: here
// the GND pad sits between other-net pads at a pitch tighter than two clearances, and the
// pour stops just past its right end.
{
    const pad = (y, net) => new Pad({ shape: 'stadium', size: 0.6, ratio: 2.8, x: 0, y, drill: 0.3, net, layers: 'both' });
    const gnd = pad(0, 'GND');
    const pads = [pad(-1, 'A'), gnd, pad(1, 'B')];
    const hw = gnd.width / 2;
    const outline = [{ x: -10, y: -10 }, { x: hw + 0.1, y: -10 }, { x: hw + 0.1, y: 10 }, { x: -10, y: 10 }];
    const context = { params: { clearance }, board: null, pads: resolveCopperPads({ pads }),
        tracks: [], vias: [], boardShapes: [], texts: [], holes: [] };
    const pours = computeFillPolygons({ layer: 'top-copper', net: 'GND', outline }, context, C);
    assert.ok(copperAt(pours, { x: -hw - clearance / 2, y: 0 }), 'the spoke towards the open pour is kept');
    assert.ok(copperAt(pours, { x: -hw - clearance * 1.5, y: 0 }), 'the kept spoke joins the pour');
    assert.equal(copperAt(pours, { x: hw + 0.05, y: 0 }), false, 'no stub towards the pour edge');
    for (const y of [0.35, -0.35]) {
        assert.equal(copperAt(pours, { x: 0, y }), false, `no stub into the neighbour's clearance at y=${y}`);
    }
    console.log('PASS thermal spokes that cannot reach the pour are not drawn');
}
