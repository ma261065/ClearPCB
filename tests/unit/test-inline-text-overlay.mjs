import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import {
    applyTextConnectionGuide,
    createInlineTextOverlay,
    setInlineTextInputActive,
} from '../../src/shared/ui/inline-text-overlay.js';
import { getSchematicTextEdit, setTextCaretFromScreen, handleTextEditKey } from '../../src/schematic/modules/text-edit.js';
import { setSchematicInteraction } from '../../src/schematic/modules/schematic-interactions.js';
import { ensureView } from '../../src/schematic/render/shape-view-state.js';

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

const document = installFakeDom();
document.createElementNS = (_namespace, tagName) => element(tagName);

const container = element('g');
const overlay = createInlineTextOverlay(group => container.appendChild(group));

assert.equal(container.children[0], overlay.group);
assert.deepEqual(overlay.group.children, [overlay.box, overlay.selection, overlay.caret]);
assert.equal(overlay.box.attributes.stroke, 'var(--accent-color, #00ccff)');
assert.equal(overlay.box.attributes['stroke-width'], '2');
assert.equal(overlay.box.attributes['stroke-opacity'], '0.5');
assert.equal(overlay.box.attributes['vector-effect'], 'non-scaling-stroke');
assert.equal(overlay.caret.attributes.stroke, 'var(--accent-color, #00ccff)');
assert.equal(overlay.caret.attributes['stroke-width'], '2');

const emphasizedContainer = element('g');
const emphasized = createInlineTextOverlay(
    group => emphasizedContainer.appendChild(group),
    { emphasized: true },
);
assert.equal(emphasized.box.attributes.fill, 'var(--accent-color, #00ccff)');
assert.equal(emphasized.box.attributes['fill-opacity'], '0.12');
assert.equal(emphasized.box.attributes['stroke-width'], '3');
assert.equal(emphasized.box.attributes['stroke-opacity'], '1');
assert.equal(emphasized.box.attributes['stroke-dasharray'], '7 4');
emphasized.destroy();
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
assert.equal(overlay.selection.style.display, 'none');
overlay.updateGeometry({ x: 2, y: 3, width: 10, height: 5, caretX: 5,
    selectionStartX: 10, selectionEndX: 5 });
assert.equal(overlay.selection.style.display, '');
assert.equal(overlay.selection.attributes.x, '5');
assert.equal(overlay.selection.attributes.width, '5', 'backward selections draw a positive-width highlight');
overlay.updateGeometry({ x: 2, y: 3, width: 10, height: 5, caretX: 5 });
assert.equal(overlay.selection.style.display, 'none', 'collapsed selections hide the highlight');

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

const textElement = {
    tagName: 'text',
    getScreenCTM() { return { inverse() { return {}; } }; },
    getCharNumAtPosition() { return 1; },
    getStartPositionOfChar() { return { x: 10 }; },
    getEndPositionOfChar() { return { x: 20 }; },
};
const caretShape = { type: 'text', text: 'ABC' };
ensureView(caretShape).element = { children: [element('rect'), textElement] };
const caretApp = {
    viewport: {
        svg: {
            getBoundingClientRect() { return { left: 0, top: 0 }; },
            createSVGPoint() {
                return {
                    x: 0,
                    y: 0,
                    matrixTransform() { return this; },
                };
            },
        },
    },
};
setSchematicInteraction(caretApp, 'textEdit', {
    shape: caretShape,
    caretIndex: 3,
    selectionAnchor: 0,
    overlayGroup: null,
});
setTextCaretFromScreen(caretApp, { x: 16, y: 0 });
assert.equal(getSchematicTextEdit(caretApp).caretIndex, 2);
assert.equal(getSchematicTextEdit(caretApp).selectionAnchor, null, 'clicking resets keyboard selection');

caretApp.fileManager = { setDirty() {} };
caretApp.renderShapes = () => {};
const state = getSchematicTextEdit(caretApp);
function key(value, modifiers = {}) {
    let prevented = false;
    assert.equal(handleTextEditKey(caretApp, { key: value, ...modifiers,
        preventDefault() { prevented = true; }, stopPropagation() {}, stopImmediatePropagation() {} }), true);
    assert.ok(prevented, 'inline keys must not reach canvas or browser shortcuts');
}
for (const modifier of ['ctrlKey', 'metaKey']) {
    caretShape.text = 'hello world';
    state.caretIndex = 11;
    state.selectionAnchor = null;
    key('a', { [modifier]: true });
    assert.equal(state.selectionAnchor, 0);
    assert.equal(state.caretIndex, 11);
    key('ArrowLeft');
    assert.equal(state.caretIndex, 0);
    assert.equal(state.selectionAnchor, null);
    key('ArrowRight', { shiftKey: true });
    key('ArrowRight', { shiftKey: true });
    assert.equal(state.selectionAnchor, 0);
    assert.equal(state.caretIndex, 2);
    key('ArrowLeft', { shiftKey: true });
    key('Delete');
    assert.equal(caretShape.text, 'ello world');
    assert.equal(state.caretIndex, 0);
    assert.equal(state.selectionAnchor, null);
    key('End');
    key('ArrowLeft', { shiftKey: true, [modifier]: true });
    assert.equal(state.caretIndex, 5);
    key('X');
    assert.equal(caretShape.text, 'ello X');
    key('Home');
    key('End', { shiftKey: true });
    key('Backspace');
    assert.equal(caretShape.text, '');
    key('a', { [modifier]: true });
    key('ArrowLeft', { shiftKey: true });
    assert.equal(state.caretIndex, 0);
    key('Z');
    assert.equal(caretShape.text, 'Z', 'typing into an empty selection inserts normally');
}

console.log('PASS: editors share text visuals and suspend inactive hidden input independently');
