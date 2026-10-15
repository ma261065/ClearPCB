import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { updateCopperCuts, clearCopperCuts, copperCutState } from '../../src/pcb/modules/copper-cuts.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
const model = new PcbDocument();
const hole = { id: 'hole', kind: 'circle', layer: 'hole', x: 10, y: -10, radius: 2, filled: true };
model.boardShapes.push(hole);
const svg = fakeElement('svg');
const defs = fakeElement('defs');
Object.defineProperty(defs, 'localName', { get: () => defs.tagName });
defs.setAttribute('data-pcb-defs', '');
svg.appendChild(defs);
const groups = new Map(['top-copper', 'bottom-copper', 'top-fill', 'bottom-fill']
    .map(layer => [layer, fakeElement('g')]));
let bounds = { minX: 0, minY: -80, maxX: 100, maxY: 0 };
const app = {
    pcbDocument: model, boardShapes: model.boardShapes, existingLayerGroups: () => groups,
    viewport: { svg, scale: 10, getVisibleBounds: () => bounds },
};
const paths = () => ['top', 'bottom'].map(side => defs.querySelector(`#pcb-copper-cut-${side}`).firstChild);
updateCopperCuts(app);
const initial = paths();
const geometry = copperCutState(app).geometry.top;
for (let i = 1; i <= 30; i++) {
    bounds = { minX: i, minY: -80 + i / 2, maxX: 100 + i, maxY: i / 2 };
    updateCopperCuts(app, { geometryChanged: false });
    assert.deepEqual(paths(), initial, 'Ordinary pan reuses both copper clip paths without DOM writes');
    assert.equal(copperCutState(app).geometry.top, geometry, 'Panning never rebuilds hole geometry');
}
const cutout = initial[0].getAttribute('d').slice(initial[0].getAttribute('d').indexOf(' Z') + 2);
bounds = { minX: 90, minY: -80, maxX: 190, maxY: 0 };
updateCopperCuts(app, { geometryChanged: false });
assert.notEqual(paths()[0], initial[0], 'Approaching the overscan boundary recentres the clip');
assert.ok(paths()[0].getAttribute('d').endsWith(cutout), 'Recentring does not recalculate or move holes');
const recentered = paths();
updateCopperCuts(app, { geometryChanged: false });
assert.deepEqual(paths(), recentered, 'The recentred paths are cached');
app.viewport.scale = 100000;
bounds = { minX: 100, minY: -40, maxX: 110, maxY: -32 };
updateCopperCuts(app, { geometryChanged: false });
assert.notEqual(paths()[0], recentered[0], 'Zoom bounds the clip to the new screen-sized area');
assert.equal(copperCutState(app).bounds.maxX - copperCutState(app).bounds.minX, 30);
for (let i = 0; i < 20; i++) {
    bounds = { minX: 100 + i * 50, minY: -40, maxX: 110 + i * 50, maxY: -32 };
    updateCopperCuts(app, { geometryChanged: false });
    const clip = copperCutState(app).bounds;
    assert.ok(clip.minX < bounds.minX && clip.maxX > bounds.maxX, 'Even long pan jumps retain visible copper');
    assert.equal(clip.maxX - clip.minX, 30, 'Long pans do not grow the raster bounds');
}
bounds = { minX: 1050, minY: -40, maxX: 1052, maxY: -38 };
updateCopperCuts(app, { geometryChanged: false });
assert.equal(copperCutState(app).bounds.maxX - copperCutState(app).bounds.minX, 6,
    'A smaller viewport shrinks the clip even without a scale change');
const beforeEdit = paths();
hole.x += 2;
updateCopperCuts(app);
assert.notEqual(paths()[0], beforeEdit[0], 'Editing a hole immediately updates its geometry');
const edited = paths();
updateCopperCuts(app, { geometryChanged: false });
assert.deepEqual(paths(), edited);
defs.querySelector('#pcb-copper-cut-top').remove();
updateCopperCuts(app, { geometryChanged: false });
assert.notEqual(paths()[0], edited[0], 'Missing clip nodes are recreated despite identical cached geometry');
clearCopperCuts(app);
updateCopperCuts(app, { geometryChanged: false });
assert.ok(paths().every(path => path && path !== edited[0]), 'Clearing and recreating clips cannot skip the DOM rebuild');
assert.equal(groups.get('top-copper').getAttribute('clip-path'), 'url(#pcb-copper-cut-top)');
console.log('PASS copper clip reuse across pan, overscan refresh, zoom, hole edits and reset');
