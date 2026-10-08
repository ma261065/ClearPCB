import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';

globalThis.window = { addEventListener() {} };
installFakeDom();
const { pcbEditorFixture } = await import('./pcb-editor-fixture.mjs');
const { setEditorActive } = await import('../../src/pcb/modules/pcb-editor-api.js');
const { reconcileRatsnest } = await import('../../src/pcb/modules/ratsnest.js');
const { storedDrcRatlines } = await import('../../src/pcb/modules/drc-state.js');
const { getComputedFill, setComputedFill } = await import('../../src/pcb/modules/computed-fill-cache.js');
const { startBoardShapeDrag, handleBoardShapeDrag, endBoardShapeDrag } = await import('../../src/pcb/modules/board-shapes.js');
const { fillEditProfile } = await import('../../src/pcb/modules/copper-fill-edit.js');
const { CopperFill } = await import('../../src/shapes/copper-fill.js');
const { Via } = await import('../../src/shapes/via.js');

// Ratlines see a pour's computed copper, which stays put until the drop recomputes it,
// so a pour drag does not rebuild them on each move (they already match a full rebuild),
// and the drop brings them up to date.

function board() {
    const groups = new Map();
    const app = pcbEditorFixture({
        getLayerGroup(id) {
            if (!groups.has(id)) {
                const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                // Fill display stages each batch in a shallow copy of its layer group.
                group.cloneNode = () => document.createElementNS('http://www.w3.org/2000/svg', 'g');
                groups.set(id, group);
            }
            return groups.get(id);
        },
        existingLayerGroups: () => groups,
        _layerGroups: groups,
        viewport: { scale: 10, svg: document.createElementNS('http://www.w3.org/2000/svg', 'svg'), gridVisible: false,
            snapToGrid: false, shiftHeld: false, setCrosshair() {}, hideCrosshair() {},
            getSnappedPosition: point => ({ x: point.x, y: point.y }) },
    });
    app.designSettings = app.pcbDocument.designSettings;
    setEditorActive(app, true);
    const doc = app.pcbDocument;
    doc.vias.push(new Via({ x: 10, y: -10, diameter: 0.6, drill: 0.3, net: 'GND' }),
        new Via({ x: 30, y: -10, diameter: 0.6, drill: 0.3, net: 'GND' }),
        new Via({ x: 10, y: -30, diameter: 0.6, drill: 0.3, net: 'VCC' }),
        new Via({ x: 30, y: -30, diameter: 0.6, drill: 0.3, net: 'VCC' }));
    const pour = new CopperFill({ outline: [{ x: 5, y: -5 }, { x: 35, y: -5 }, { x: 35, y: -15 }, { x: 5, y: -15 }],
        net: 'GND', layer: 'top-copper' });
    doc.boardShapes.push({ id: 'board-outline', kind: 'rect', layer: 'board-outline', lineWidth: 0.2,
        points: [{ x: 0, y: -40 }, { x: 40, y: -40 }, { x: 40, y: 40 }, { x: 0, y: 40 }] }, pour);
    // The pour's copper as last computed: it joins the two GND vias.
    setComputedFill(pour, [{ outer: pour.outline.map(point => ({ ...point })), holes: [] }]);
    reconcileRatsnest(app);
    return { app, pour };
}

const ratlines = app => storedDrcRatlines(app).map(line => `${line.net}:${[[line.x1, line.y1], [line.x2, line.y2]]
    .map(point => point.map(value => value.toFixed(6)).join(',')).sort().join('|')}`).sort();

const live = board(), reference = board();
assert.deepEqual(ratlines(live.app).filter(line => line.startsWith('GND')), [], 'at rest the pour joins the GND vias');
let rebuilds = 0;
const rebuild = live.app.updateRatsnest.bind(live.app);
live.app.updateRatsnest = options => { rebuilds++; return rebuild(options); };
for (const { app, pour } of [live, reference]) {
    assert.ok(startBoardShapeDrag(app, pour, { x: 20, y: -5 }, null, { editProfile: fillEditProfile(), whole: true }));
}
for (let step = 1; step <= 8; step++) {
    const point = { x: 20 + step * 2, y: -5 - step };
    handleBoardShapeDrag(live.app, point);
    handleBoardShapeDrag(reference.app, point);
    reconcileRatsnest(reference.app);
    assert.deepEqual(ratlines(live.app), ratlines(reference.app), `move ${step}: the same ratlines as a full rebuild`);
}
assert.equal(rebuilds, 0, 'moving a pour does not rebuild ratlines');
// Dropped clear of both GND vias, the recomputed pour no longer joins them.
handleBoardShapeDrag(live.app, { x: 20, y: 30 });
endBoardShapeDrag(live.app, true);
const recomputed = () => getComputedFill(live.pour)?.some(region => region.outer.every(point => point.y > 15));
for (let wait = 0; wait < 200 && !recomputed(); wait++) await new Promise(resolve => setTimeout(resolve, 10));
assert.ok(recomputed(), 'the drop recomputes the pour at its new place');
assert.deepEqual(ratlines(live.app).filter(line => line.startsWith('GND')).length, 1,
    'the drop shows the GND ratline the moved pour no longer covers');
assert.deepEqual(ratlines(live.app).filter(line => line.startsWith('VCC')),
    ratlines(reference.app).filter(line => line.startsWith('VCC')), 'other nets are unchanged');
console.log('PASS a pour drag leaves ratlines to the drop, and they match a full rebuild on every move');
