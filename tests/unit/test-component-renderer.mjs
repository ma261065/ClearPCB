import assert from 'node:assert/strict';
import { Component } from '../../src/components/Component.js';
import {
    buildComponentSymbol,
    componentPinElement,
    discardComponent,
    rebuildComponentSymbol,
    renderComponent,
} from '../../src/schematic/render/component-renderer.js';
import { componentViewOf } from '../../src/schematic/render/shape-view-state.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();

let created = 0;
const createElementNS = document.createElementNS;
document.createElementNS = (namespace, tagName) => {
    created++;
    return createElementNS(namespace, tagName);
};

function component(id = 'U1') {
    return new Component({
        name: 'RendererTest',
        symbol: {
            width: 4,
            height: 2,
            origin: { x: 0, y: 0 },
            graphics: [
                { type: 'rect', x: -1, y: -1, width: 2, height: 2 },
                { type: 'line', x1: -1, y1: 0, x2: 1, y2: 0 },
            ],
            pins: [
                { number: '1', name: 'IN', x: -2, y: 0, length: 2, orientation: 'right', _key: 'pin-1' },
                { number: '2', name: 'OUT', x: 2, y: 0, length: 2, orientation: 'left', _key: 'pin-2' },
            ],
        },
    }, { id, x: 5, y: 6, locked: true });
}

function tags(element) {
    return [element.tagName, ...element.children.flatMap(tags)];
}

{
    const comp = component('state');
    assert.equal(componentViewOf(comp), undefined);
    const element = buildComponentSymbol(comp);
    assert.equal(componentViewOf(comp).element, element);
    assert.equal(componentPinElement(comp, 'pin-1')?.tagName, 'g');

    const parent = fakeElement('svg');
    parent.appendChild(element);
    discardComponent(comp);
    assert.equal(componentViewOf(comp), undefined);
    assert.equal(element.parentNode, null);
}

{
    const comp = component('pose');
    const parent = fakeElement('svg');
    const before = parent.appendChild(buildComponentSymbol(comp));
    const beforeTags = tags(before);

    created = 0;
    comp.rotate(90);
    comp.flipHorizontal();
    assert.equal(created, 0, 'model pose changes do not create SVG');
    assert.equal(componentViewOf(comp).element, before, 'model pose changes do not replace SVG');

    const after = rebuildComponentSymbol(comp);
    assert.notEqual(after, before);
    assert.equal(after.parentNode, parent);
    assert.deepEqual(tags(after), beforeTags, 'rebuild preserves symbol DOM structure');
    assert.match(after.getAttribute('transform'), /^translate\(.+\) rotate\(/);
}

{
    const comp = component('selected');
    const element = buildComponentSymbol(comp);
    const selectedView = { isSelected: item => item === comp, isHovered: () => false };
    renderComponent(comp, 10, { selection: selectedView });

    assert.equal(element.firstChild.getAttribute('class'), 'component-highlight');
    assert.equal(componentPinElement(comp, 'pin-1').querySelector('circle').getAttribute('display'), '');
    assert.equal(componentViewOf(comp).lockIconEl?.getAttribute('class'), 'component-lock-icon');
    assert.equal(comp._dirty, false);

    const emptyView = { isSelected: () => false, isHovered: () => false };
    renderComponent(comp, 10, { selection: emptyView });
    assert.notEqual(element.firstChild.getAttribute('class'), 'component-highlight');
    assert.equal(componentPinElement(comp, 'pin-1').querySelector('circle').getAttribute('display'), 'none');
    assert.equal(componentViewOf(comp).lockIconEl, null);
}

console.log('PASS component renderer owns view state, rebuilds symbols, and renders selection visuals');
