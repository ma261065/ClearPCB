import assert from 'node:assert/strict';
import {
    applyTextConnectionGuide,
    createInlineTextOverlay,
    setInlineTextInputActive,
} from '../src/ui/modules/inline-text-overlay.js';

function element(tagName) {
    return {
        tagName,
        attributes: {},
        children: [],
        parentNode: null,
        style: {},
        setAttribute(name, value) { this.attributes[name] = String(value); },
        removeAttribute(name) { delete this.attributes[name]; },
        appendChild(child) {
            child.parentNode = this;
            this.children = this.children.filter(item => item !== child);
            this.children.push(child);
        },
        remove() {
            if (this.parentNode) {
                this.parentNode.children = this.parentNode.children.filter(item => item !== this);
                this.parentNode = null;
            }
        },
    };
}

globalThis.document = {
    createElementNS(namespace, tagName) {
        return element(tagName);
    },
};

const container = element('g');
const overlay = createInlineTextOverlay(group => container.appendChild(group));

assert.equal(container.children[0], overlay.group);
assert.deepEqual(overlay.group.children, [overlay.box, overlay.caret]);
assert.equal(overlay.box.attributes.stroke, 'var(--accent-color, #00ccff)');
assert.equal(overlay.box.attributes['stroke-width'], '2');
assert.equal(overlay.box.attributes['stroke-opacity'], '0.5');
assert.equal(overlay.box.attributes['vector-effect'], 'non-scaling-stroke');
assert.equal(overlay.caret.attributes.stroke, 'var(--accent-color, #00ccff)');
assert.equal(overlay.caret.attributes['stroke-width'], '2');
assert.equal(overlay.caret.attributes['stroke-linecap'], 'butt');

assert.equal(overlay.updateGeometry({
    x: 2,
    y: 3,
    width: 10,
    height: 5,
    caretX: 7,
    caretTop: 3.5,
    caretBottom: 7.5,
    transform: 'translate(4 5)',
}), true);
assert.equal(overlay.group.attributes.transform, 'translate(4 5)');
assert.deepEqual(overlay.box.attributes, {
    fill: 'none',
    stroke: 'var(--accent-color, #00ccff)',
    'stroke-width': '2',
    'stroke-opacity': '0.5',
    'vector-effect': 'non-scaling-stroke',
    x: '2',
    y: '3',
    width: '10',
    height: '5',
});
assert.equal(overlay.caret.attributes.x1, '7');
assert.equal(overlay.caret.attributes.x2, '7');
assert.equal(overlay.caret.attributes.y1, '3.5');
assert.equal(overlay.caret.attributes.y2, '7.5');

overlay.keepCaretVisible();
assert.equal(overlay.caret.style.opacity, '1');
assert.ok(overlay.forceVisibleUntil > performance.now());

overlay.destroy();
assert.equal(container.children.length, 0);
assert.equal(overlay.blinkTimer, null);

const guide = element('line');
applyTextConnectionGuide(guide, {
    start: { x: 1, y: 2 },
    end: { x: 10, y: 20 },
});
assert.equal(guide.attributes.x1, '10');
assert.equal(guide.attributes.y1, '20');
assert.equal(guide.attributes.x2, '1');
assert.equal(guide.attributes.y2, '2');
assert.equal(guide.attributes['stroke-dasharray'], '3 3');

let focused = false;
const input = {
    isConnected: true,
    readOnly: false,
    focus() { focused = true; },
    blur() { focused = false; },
};
document.activeElement = input;
setInlineTextInputActive(input, false);
assert.equal(input.readOnly, true);
assert.equal(focused, false);
setInlineTextInputActive(input, true);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(input.readOnly, false);
assert.equal(focused, true);

console.log('PASS: editors share text visuals and suspend inactive hidden input independently');
