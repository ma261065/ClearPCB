import assert from 'node:assert/strict';
import { Wire } from '../../src/shapes/wire.js';
import { installFakeDom, fakeElement } from './helpers/fake-dom.mjs';
import { anchorDragState } from '../../src/schematic/modules/draw-states.js';
import { setSchematicDrag } from '../../src/schematic/modules/drag.js';
import { getAxisGlowState } from '../../src/shapes/axis-glow.js';

installFakeDom();
function fixture(targetKind) {
    const dragged = new Wire({ points: [{ x: 0, y: -10 }, { x: 0, y: 0 }] });
    const target = targetKind ? new Wire({ points: [{ x: -10, y: 10 }, { x: 10, y: 10 }] }) : null;
    const [fixedId, anchorId] = [...dragged.nodes.keys()];
    const app = { shapes: target ? [dragged, target] : [dragged], components: [],
        viewport: { svg: fakeElement('svg'), contentLayer: fakeElement('g'), scale: 20, gridSize: 1,
            layers: new Map(), shiftHeld: false, isPanning: false,
            getSnappedPosition: point => ({ ...point }), getEffectiveGridSize: () => 1 },
        selection: { keepSelected() {} }, renderShapes() {}, updateCrosshair() {}, fileManager: { setDirty() {} },
    };
    setSchematicDrag(app, { shape: dragged, anchorId, excludePin: null, tjLinks: [] });
    return { app, dragged, target, fixedId, anchorId };
}
const guide = app => getAxisGlowState(app).resolved || [];
for (const offset of [0.2, 0.05, 0]) {
    const { app, dragged, anchorId } = fixture('segment');
    anchorDragState.mousemove(app, {}, { worldPos: { x: offset, y: 10 },
        snapped: { x: offset, y: 10 } });
    assert.ok(Math.abs(dragged.nodes.get(anchorId).x) < 1e-9);
    assert.deepEqual(dragged.nodes.get(anchorId), { x: 0, y: 10 }, 'Hard target and vertical axis agree');
    assert.equal(guide(app).length, 1, 'Vertical indicator remains visible while snapped to horizontal segment');
    assert.equal(guide(app)[0].segment.axisKind, 'v');
    assert.deepEqual(new Set([guide(app)[0].segment.a.y, guide(app)[0].segment.b.y]), new Set([-10, 10]));
    assert.equal(guide(app)[0].segment.a.x, 0);
    assert.equal(guide(app)[0].segment.b.x, 0);
}
for (const point of [{ x: 0, y: 10 }, { x: 0.05, y: 10 }]) {
    const { app, dragged, target, anchorId } = fixture('endpoint');
    const targetNode = target.addNode(0, 10);
    anchorDragState.mousemove(app, {}, { worldPos: point, snapped: point });
    assert.equal(target.nodes.has(targetNode), true);
    assert.deepEqual(dragged.nodes.get(anchorId), { x: 0, y: 10 });
    assert.equal(guide(app).length, 1);
    assert.equal(guide(app)[0].segment.axisKind, 'v');
}
{
    const { app } = fixture('segment');
    anchorDragState.mousemove(app, {}, { worldPos: { x: 2, y: 10 }, snapped: { x: 2, y: 10 } });
    assert.deepEqual(guide(app), [], 'Incompatible hard target does not invent a vertical guide');
}
{
    const { app } = fixture(null);
    anchorDragState.mousemove(app, {}, { worldPos: { x: 0.05, y: 8 }, snapped: { x: 0.05, y: 8 } });
    assert.equal(guide(app).length, 1, 'Ordinary axis-only drag keeps the existing indicator');
}
console.log('PASS wire anchor keeps compatible axis guides while hard-snapped to nodes and segments');
