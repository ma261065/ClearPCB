import assert from 'node:assert/strict';
import { computeFillPolygons, loadClipper } from '../../src/pcb/modules/copper-fill-geom.js';
import { resolveCopperPads } from '../../src/pcb/modules/copper-model.js';
import { Pad } from '../../src/shapes/pad.js';

// Free SMD pads store copper-layer names ('top-copper'/'bottom-copper'), while
// footprint pads use part-relative 'top'/'bottom'. resolveCopperPads gives both the
// same board layer ids, so a pour on that layer gives a same-net pad thermal relief
// and an other-net pad clearance, and ignores pads on the other layer.
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
const outline = [{ x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 }];
for (const layer of ['top-copper', 'bottom-copper']) {
    const otherLayer = layer === 'top-copper' ? 'bottom-copper' : 'top-copper';
    const gnd = new Pad({ id: 'gnd', x: -3, y: 0, shape: 'rectangle', size: 1, ratio: 1.5,
        rotation: 270, drill: 0, net: 'GND', layers: layer });
    const signal = new Pad({ id: 'signal', x: 3, y: 0, shape: 'rectangle', size: 1, ratio: 1.5,
        rotation: 270, drill: 0, net: 'SIG', layers: layer });
    const context = { params: { clearance }, board: null, pads: resolveCopperPads({ pads: [gnd, signal] }),
        tracks: [], vias: [], boardShapes: [], texts: [], holes: [] };
    assert.deepEqual(context.pads.map(pad => pad.layer), [layer, layer], `${layer}: resolved free pad layers`);
    const pours = computeFillPolygons({ layer, net: 'GND', outline }, context, C);
    // Rotated 270°, the pad is 1 mm wide and 1.5 mm tall in board coordinates.
    const ring = 0.5 + clearance / 2;
    const end = 0.75 + clearance / 2;

    assert.ok(copperAt(pours, { x: gnd.x + ring, y: 0 }), `${layer}: GND pad side spoke`);
    assert.ok(copperAt(pours, { x: gnd.x, y: end }), `${layer}: GND pad end spoke`);
    assert.equal(copperAt(pours, { x: gnd.x + ring, y: end }), false, `${layer}: GND pad relief gap`);
    assert.equal(copperAt(pours, { x: signal.x + ring, y: 0 }), false, `${layer}: other-net pad clearance`);
    assert.equal(copperAt(pours, { x: signal.x, y: end }), false, `${layer}: other-net pad has no spoke`);

    const otherPours = computeFillPolygons({ layer: otherLayer, net: 'GND', outline }, context, C);
    assert.ok(copperAt(otherPours, gnd), `${otherLayer}: GND SMD pad on ${layer} is ignored`);
    assert.ok(copperAt(otherPours, signal), `${otherLayer}: signal SMD pad on ${layer} is ignored`);
}

console.log('PASS free SMD pads get pour thermal relief or clearance on their copper layer');
