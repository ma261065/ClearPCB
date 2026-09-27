import assert from 'node:assert/strict';
import { Text, Net, createShape } from '../src/shapes/index.js';
import {
    createPcbText,
    pcbTextEditBox,
    pcbTextBounds,
    pcbTextHitTest,
    pcbTextPolylines,
    serializePcbText,
} from '../src/pcb/modules/pcb-text.js';
import {
    getTextEditBoxGeometry,
    measureTextAdvance,
} from '../src/core/text-edit-geometry.js';

class SvgElement {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.attributes = new Map();
        this.style = {};
        this.textContent = '';
    }
    appendChild(child) { this.children.push(child); return child; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    getBBox() {
        if (this.tagName !== 'text') throw new Error('Only text is measurable in this fixture');
        const size = Number(this.getAttribute('font-size')) || 2;
        return {
            x: Number(this.getAttribute('x')) || 0,
            y: (Number(this.getAttribute('y')) || 0) - size,
            width: this.textContent.length * size * 0.6,
            height: size,
        };
    }
}

globalThis.window = { addEventListener() {} };
globalThis.document = {
    createElementNS(namespace, tagName) { return new SvgElement(tagName); },
    createElement(tagName) {
        if (tagName !== 'canvas') return {};
        return {
            getContext() {
                return {
                    font: '',
                    textBaseline: '',
                    measureText(value) {
                        return {
                            width: value.length * 600,
                            actualBoundingBoxAscent: 800,
                            actualBoundingBoxDescent: 200,
                        };
                    },
                };
            },
        };
    },
};

{
    const text = new Text({ id: 'label', x: 10, y: 20, text: 'TEST', fontSize: 2, border: true });
    const element = text._createElement();
    text._updateElement(element, '#123456', '#123456', 10);
    const [border, glyphs] = element.children;
    assert.equal(border.tagName, 'rect');
    assert.equal(border.getAttribute('display'), null);
    assert.equal(border.getAttribute('stroke'), '#123456');
    assert.equal(border.getAttribute('fill'), 'none');
    const editBox = getTextEditBoxGeometry(text, glyphs);
    assert.equal(border.getAttribute('x'), String(editBox.x + editBox.originX));
    assert.equal(border.getAttribute('y'), String(editBox.y + editBox.originY));
    assert.equal(border.getAttribute('width'), String(editBox.width));
    assert.equal(border.getAttribute('height'), String(editBox.height));
    assert.equal(glyphs.textContent, 'TEST');
    const initialHeight = editBox.height;
    text.text = 'gy  ';
    text._updateElement(element, '#123456', '#123456', 10);
    const spacedBox = getTextEditBoxGeometry(text, glyphs);
    assert.equal(spacedBox.height, initialHeight);
    assert.ok(measureTextAdvance(text, 'A   ') > measureTextAdvance(text, 'A'));
    text.text = '';
    text._updateElement(element, '#123456', '#123456', 10);
    const emptyBox = getTextEditBoxGeometry(text, glyphs);
    assert.equal(emptyBox.x, editBox.x);
    assert.equal(emptyBox.y, editBox.y);
    assert.equal(emptyBox.height, editBox.height);
    assert.equal(text.toJSON().bd, true);
    assert.equal(createShape(text.toJSON()).border, true);
    assert.ok(text.getPropertyDescriptors().some(item => item.key === 'border'));

    text.fieldKey = 'reference';
    assert.ok(!text.getPropertyDescriptors().some(item => item.key === 'border'));
    text.fieldKey = 'label';
    assert.ok(text.getPropertyDescriptors().some(item => item.key === 'border'));
}

{
    const net = new Net({ id: 'net-label', net: 'GND', border: true });
    let invalidated = false;
    net.labelText = {
        text: '', fontSize: 0, rotation: 0, textAnchor: '', x: 0, y: 0, border: false,
        invalidate() { invalidated = true; },
    };
    net.syncLabelText();
    assert.equal(net.labelText.border, true);
    assert.equal(invalidated, true);
    assert.equal(net.toJSON().bd, true);
    assert.equal(createShape(net.toJSON()).border, true);
    assert.ok(net.getPropertyDescriptors().some(item => item.key === 'border'));
}

{
    const plain = createPcbText({
        id: 'pcb-text', content: 'A', x: 5, y: 6, size: 2,
        rotation: 0, layer: 'top-silk', strokeWidth: 0.2,
    });
    const bordered = createPcbText({ ...plain, border: true });
    assert.equal(plain.border, false);
    assert.equal(bordered.border, true);
    assert.equal(serializePcbText(bordered).border, true);

    const plainPolylines = pcbTextPolylines(plain);
    const borderedPolylines = pcbTextPolylines(bordered);
    assert.equal(borderedPolylines.length, plainPolylines.length + 1);
    assert.deepEqual(borderedPolylines[0][0], borderedPolylines[0].at(-1));
    const editBox = pcbTextEditBox(bordered);
    assert.deepEqual(borderedPolylines[0], [
        { x: bordered.x + editBox.x, y: bordered.y + editBox.y },
        { x: bordered.x + editBox.x + editBox.width, y: bordered.y + editBox.y },
        { x: bordered.x + editBox.x + editBox.width, y: bordered.y + editBox.y + editBox.height },
        { x: bordered.x + editBox.x, y: bordered.y + editBox.y + editBox.height },
        { x: bordered.x + editBox.x, y: bordered.y + editBox.y },
    ]);

    const plainBounds = pcbTextBounds(plain);
    const borderedBounds = pcbTextBounds(bordered);
    assert.ok(borderedBounds.minX < plainBounds.minX);
    assert.ok(borderedBounds.minY < plainBounds.minY);
    assert.ok(borderedBounds.maxX > plainBounds.maxX);
    assert.ok(borderedBounds.maxY > plainBounds.maxY);

    const bottom = { ...bordered, layer: 'bottom-silk' };
    const topBorder = borderedPolylines[0];
    const bottomBorder = pcbTextPolylines(bottom)[0];
    assert.equal(topBorder.length, bottomBorder.length);
    for (let index = 0; index < topBorder.length; index++) {
        assert.ok(Math.abs((topBorder[index].x - bordered.x) + (bottomBorder[index].x - bottom.x)) < 1e-9);
        assert.ok(Math.abs(topBorder[index].y - bottomBorder[index].y) < 1e-9);
    }

    const descender = createPcbText({
        content: 'gy', x: 10, y: 10, size: 2,
        rotation: 0, layer: 'top-silk', strokeWidth: 0.2,
    });
    const descenderBounds = pcbTextBounds(descender);
    assert.ok(descenderBounds.maxY > descender.y + descender.size * 0.7);
    assert.equal(pcbTextHitTest(descender, descender.x + 1, descender.y + descender.size * 0.7), true);
    assert.equal(pcbTextHitTest(descender, descender.x + 1, descender.y + descender.size * 1.2), false);
}

console.log('PASS: schematic text, net labels, and PCB text support bordered geometry');
