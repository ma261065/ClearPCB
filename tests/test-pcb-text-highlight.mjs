import assert from 'node:assert/strict';

function element(tag) {
    const attributes = new Map();
    return {
        tag,
        children: [],
        parentNode: null,
        style: {},
        dataset: {},
        textContent: '',
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
            return child;
        },
        querySelectorAll() { return []; },
        removeChild(child) {
            this.children = this.children.filter(item => item !== child);
            child.parentNode = null;
        },
    };
}

globalThis.window = { addEventListener() {} };
globalThis.document = {
    documentElement: { getAttribute() { return 'dark'; } },
    createElementNS(_namespace, tag) { return element(tag); },
    getElementById() { return null; },
};

const [
    { default: PCBApp },
    { createPcbText },
    { pcbLayerHoverColor, pcbLayerSelectionColor },
    { setPcbSelection },
] = await Promise.all([
    import('../src/ui/PCBApp.js'),
    import('../src/pcb/modules/pcb-text.js'),
    import('../src/pcb/modules/layers.js'),
    import('../src/pcb/modules/selection-registry.js'),
]);

const text = createPcbText({ id: 'text-a', content: 'A', layer: 'top-copper' });
const layer = element('g');
const app = Object.create(PCBApp.prototype);
app.texts = new Map([[text.id, text]]);
app._textElements = new Map();
app._hoveredText = null;
app._getLayerGroup = () => layer;
app._refreshBoardShapeClearance = () => {};
app._setPcbStatus = () => {};

setPcbSelection(app, [{ kind: 'text', object: text }]);
app._renderText(text);
assert.equal(app._textElements.get(text.id).getAttribute('stroke'), pcbLayerSelectionColor(text.layer),
    'selected text uses the shared 50% highlight');

setPcbSelection(app, []);
app._hoveredText = text;
app._renderText(text);
assert.equal(app._textElements.get(text.id).getAttribute('stroke'), pcbLayerHoverColor(text.layer),
    'hovered text uses the shared 25% highlight');

console.log('PASS: PCB text uses shared selected and hover highlight strengths');
