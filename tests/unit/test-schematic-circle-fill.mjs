import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { Circle } from '../../src/shapes/circle.js';
import { renderShape } from '../../src/schematic/render/shape-renderer.js';

installFakeDom();
const shape = new Circle({ x: 4, y: 6, radius: 10, lineWidth: 2, fill: true, fillAlpha: 0.4 });
const saved = shape.toJSON();
const hovered = { isSelected: () => false, isHovered: () => true };
const group = renderShape(shape, 10, { selection: hovered });
const [fill, stroke] = group.children;
assert.equal(group.tagName, 'g');
assert.equal(Number(fill.getAttribute('r')), 8);
assert.equal(Number(stroke.getAttribute('r')), 9);
assert.equal(Number(stroke.getAttribute('stroke-width')), 2);
assert.equal(fill.getAttribute('stroke'), 'none');
assert.equal(stroke.getAttribute('fill'), 'none');
assert.equal(fill.getAttribute('fill-opacity'), '0.4');
assert.equal(group.getAttribute('stroke-opacity'), '0.35');
assert.equal(Number(fill.getAttribute('r')),
    Number(stroke.getAttribute('r')) - Number(stroke.getAttribute('stroke-width')) / 2);
for (const child of group.children) {
    assert.equal(Number(child.getAttribute('cx')), 4);
    assert.equal(Number(child.getAttribute('cy')), 6);
}
renderShape(shape, 10);
assert.equal(group.getAttribute('stroke-opacity'), null);
assert.equal(group.children[0], fill, 'repaints reuse fill and stroke elements');
shape.fill = false;
renderShape(shape, 10);
assert.equal(fill.getAttribute('fill'), 'none');
assert.equal(fill.getAttribute('fill-opacity'), null);
shape.fill = true;
shape.lineWidth = 20;
renderShape(shape, 10);
assert.equal(Number(fill.getAttribute('r')), 0, 'a fully thick stroke has no negative fill radius');
shape.applyState(new Circle({ ...saved, radius: 10, lineWidth: 2, fill: true, fillAlpha: 0.4 }).captureState());
assert.deepEqual(shape.toJSON(), saved, 'rendering does not change authored circle geometry');
console.log('PASS schematic circle fill meets the inner stroke edge without hover overlap');
