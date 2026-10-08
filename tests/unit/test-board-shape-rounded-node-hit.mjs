/** A selected path's nodes stay hittable when a large corner radius pulls the drawn outline away from them. */
import assert from 'node:assert/strict';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

const menus = [];
const document = installFakeDom();
document.body.appendChild = child => { menus.push(child); return child; };
const element = (tagName) => fakeElement(tagName);

const { hitTestBoardShape, selectBoardShape, showBoardShapeContextMenu, createBoardShapeSelectionAdapter } = await import('../../src/pcb/modules/board-shapes.js');
const { boardShapeHitTest } = await import('../../src/shared/pcb/board-shape-geometry.js');

const overlay = element('g');
const shape = {
    id: 'pshape_1', kind: 'polygon', layer: 'top-copper', lineWidth: 0.2, filled: false,
    nodeCornerRadii: { 1: 9.5 },
    points: [{ x: 135.36, y: -57.15 }, { x: 152.4, y: -27.94 }, { x: 163.83, y: -37.36 }, { x: 157.48, y: -59.69 }],
};
const app = {
    boardShapes: [shape], placements: new Map(), pads: [], tracks: [], _shapeElements: new Map(),
    viewport: { scale: 10, setCrosshair() {} },
    getLayerGroup() { return overlay; },
    history: { execute() {} },
};
const node = shape.points[1];

assert.equal(boardShapeHitTest(shape, node, 0.6), false, 'fixture: the rounded outline is far from the node');
assert.ok(createBoardShapeSelectionAdapter(app, shape, 'shape:pshape_1').getBounds().maxY < node.y - 0.6,
    'fixture: the node lies outside the visual bounds');
assert.equal(hitTestBoardShape(app, node), null, 'an unselected shape is not hit at a node outside its outline');

selectBoardShape(app, shape);
assert.equal(hitTestBoardShape(app, node), shape, 'a selected shape is hit at its node');
assert.equal(hitTestBoardShape(app, { x: node.x, y: node.y + 3 }), null, 'hit bounds do not grow beyond the nodes');

showBoardShapeContextMenu(app, hitTestBoardShape(app, node), 0, 0, node);
assert.equal(menus.length, 1, 'right-click on the node opens a menu');
const labels = menus[0].children.map(item => item.textContent);
assert.deepEqual(labels, ['Split', 'Delete node']);

const visual = createBoardShapeSelectionAdapter(app, shape, 'shape:pshape_1').getBounds();
assert.ok(visual.maxY < node.y - 0.6, 'visual bounds (box select, group bounds) are unchanged');

console.log('PASS selected rounded-corner nodes remain hittable for right-click menus');
