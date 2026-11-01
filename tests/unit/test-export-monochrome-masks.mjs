import assert from 'node:assert/strict';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';
import { forceMonochromeSvg } from '../../src/shared/ui/export.js';

installFakeDom();

const root = fakeElement('svg');
const mask = fakeElement('mask');
const reveal = fakeElement('polygon');
reveal.setAttribute('fill', '#ffffff');
reveal.setAttribute('fill-opacity', '0.75');
const cutout = fakeElement('path');
cutout.setAttribute('fill', '#000000');
cutout.setAttribute('stroke', '#ffffff');
cutout.setAttribute('opacity', '0.5');
mask.appendChild(reveal);
mask.appendChild(cutout);
root.appendChild(mask);

const visibleFill = fakeElement('polygon');
visibleFill.setAttribute('fill', '#777777');
visibleFill.setAttribute('stroke', '#123456');
visibleFill.setAttribute('opacity', '0.5');
root.appendChild(visibleFill);

root.querySelectorAll = selector => {
    assert.equal(selector, '*');
    return [mask, reveal, cutout, visibleFill];
};

forceMonochromeSvg(root);

assert.equal(visibleFill.getAttribute('fill'), '#000000');
assert.equal(visibleFill.getAttribute('stroke'), '#000000');
assert.equal(visibleFill.getAttribute('opacity'), '1');
assert.equal(reveal.getAttribute('fill'), '#ffffff',
    'Monochrome conversion preserves the white reveal area of a luminance mask');
assert.equal(reveal.getAttribute('fill-opacity'), '0.75');
assert.equal(cutout.getAttribute('fill'), '#000000');
assert.equal(cutout.getAttribute('stroke'), '#ffffff');
assert.equal(cutout.getAttribute('opacity'), '0.5',
    'Monochrome conversion preserves mask opacity data');

console.log('PASS monochrome SVG conversion preserves luminance masks');
