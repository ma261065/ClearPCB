import assert from 'node:assert/strict';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';
import {
    appendComponentTextHighlight,
    hoverComponent,
    removeComponentHighlights,
} from '../../src/pcb/modules/component-selection.js';

installFakeDom();

function placement() {
    const bodyLayer = fakeElement('g');
    const silkLayer = fakeElement('g');
    const reference = fakeElement('g');
    reference.setAttribute('class', 'pcb-mirror-text');
    reference.setAttribute('data-fp-ref', '1');
    reference.setAttribute('stroke', '#f0e68c');
    const glyph = fakeElement('polyline');
    glyph.setAttribute('points', '0,0 1,1');
    reference.appendChild(glyph);
    silkLayer.appendChild(reference);
    return {
        bounds: { x: -2, y: -1, width: 4, height: 2 },
        elements: [bodyLayer, silkLayer],
        refVisible: true,
        reference,
    };
}

{
    const pl = placement();
    appendComponentTextHighlight(pl, 'pcb-selection-highlight');
    const copy = pl.elements[1].querySelector('.pcb-selection-highlight');
    assert.ok(copy, 'Component selection includes the rendered reference glyphs');
    assert.notEqual(copy, pl.reference);
    assert.equal(copy.getAttribute('stroke'), '#3399ff');
    assert.equal(copy.getAttribute('data-fp-ref'), null,
        'Highlight copies cannot be mistaken for the authored reference group');
    assert.equal(copy.children[0].getAttribute('points'), '0,0 1,1');
    assert.equal(pl.reference.getAttribute('stroke'), '#f0e68c',
        'Component highlighting does not alter independent reference-text state');
    removeComponentHighlights(pl, 'pcb-selection-highlight');
    assert.equal(pl.elements[1].querySelector('.pcb-selection-highlight'), null);
    assert.equal(pl.reference.parentNode, pl.elements[1]);
}

{
    const pl = placement();
    const app = { placements: new Map([['part', pl]]) };
    hoverComponent(app, 'part');
    assert.ok(pl.elements[0].querySelector('.pcb-hover-highlight'));
    const textHover = pl.elements[1].querySelector('.pcb-hover-highlight');
    assert.ok(textHover, 'Component hover includes reference text');
    assert.equal(textHover.getAttribute('opacity'), '0.65');
    hoverComponent(app, null);
    assert.equal(pl.elements[0].querySelector('.pcb-hover-highlight'), null);
    assert.equal(pl.elements[1].querySelector('.pcb-hover-highlight'), null);
}

{
    const pl = placement();
    pl.refVisible = false;
    appendComponentTextHighlight(pl, 'pcb-selection-highlight');
    assert.equal(pl.elements[1].querySelector('.pcb-selection-highlight'), null,
        'Hidden reference text stays absent from the component highlight');
}

console.log('PASS component highlights include reference text without changing authored glyphs');
