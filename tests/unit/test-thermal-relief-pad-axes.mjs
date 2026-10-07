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
