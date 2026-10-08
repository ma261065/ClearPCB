import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();

const [
    { default: PCBApp },
    { createPcbText },
    { pcbLayerHoverColor, pcbLayerSelectionColor },
    { setPcbSelection },
    { getTextElement, renderText, setTextHover },
] = await Promise.all([
    import('../../src/ui/PCBApp.js'),
    import('../../src/pcb/modules/pcb-text.js'),
    import('../../src/pcb/modules/layers.js'),
    import('../../src/pcb/modules/selection-registry.js'),
    import('../../src/pcb/modules/pcb-text-render.js'),
]);

const text = createPcbText({ id: 'text-a', content: 'A', layer: 'top-copper' });
const layer = fakeElement('g');
const app = Object.create(PCBApp.prototype);
app.pcbDocument = new PcbDocument();
app.texts = new Map([[text.id, text]]);
app.getLayerGroup = () => layer;
app._refreshBoardShapeClearance = () => {};
app.setPcbStatus = () => {};

setPcbSelection(app, [{ kind: 'text', object: text }]);
renderText(app, text);
assert.equal(getTextElement(app, text.id).getAttribute('stroke'), pcbLayerSelectionColor(text.layer),
    'selected text uses the shared 50% highlight');

setPcbSelection(app, []);
setTextHover(app, text);
assert.equal(getTextElement(app, text.id).getAttribute('stroke'), pcbLayerHoverColor(text.layer),
    'hovered text uses the shared 25% highlight');

console.log('PASS: PCB text uses shared selected and hover highlight strengths');
