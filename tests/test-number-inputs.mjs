import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatNumberInput, installNumberInputFormatting } from '../src/core/number-inputs.js';

const field = (value, rotation = false) => ({
    nodeType: 1, namespaceURI: 'http://www.w3.org/1999/xhtml', value, dataset: rotation ? { numberFormat: 'rotation' } : {},
    get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); },
    matches(selector) { return selector === 'input[type="number"]'; },
    querySelectorAll() { return []; },
});
for (const [value, expected] of [['2', '2.00'], ['2.1', '2.10'], ['-3.5', '-3.50'], ['0', '0.00'], ['2.345', '2.35'], ['', ''], ['-', '-']]) {
    const input = field(value);
    formatNumberInput(input);
    assert.equal(input.value, expected);
}
const rotation = field('15', true);
formatNumberInput(rotation);
assert.equal(rotation.value, '15');

let mutations;
let disconnected = false;
globalThis.MutationObserver = class {
    constructor(callback) { mutations = callback; }
    observe() {}
    disconnect() { disconnected = true; }
};
const listeners = new Map();
const width = field('30');
const root = {
    documentElement: {},
    querySelectorAll() { return [width, rotation]; },
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name) { listeners.delete(name); },
};
const dispose = installNumberInputFormatting(root);
assert.equal(width.value, '30.00');
const height = field('12.5');
mutations([{ type: 'childList', addedNodes: [height] }]);
assert.equal(height.value, '12.50');
let svgScans = 0;
const svg = {
    nodeType: 1, namespaceURI: 'http://www.w3.org/2000/svg',
    matches() { svgScans++; return false; },
    querySelectorAll() { svgScans++; return []; },
};
mutations(Array.from({ length: 10000 }, () => ({ type: 'childList', target: svg, addedNodes: [svg] })));
mutations([{ type: 'childList', addedNodes: [svg] }, { type: 'attributes', target: svg }]);
assert.equal(svgScans, 0, 'Board redraws never scan SVG artwork for numeric controls');
width.value = '30.1';
listeners.get('input')({ type: 'input', target: width });
width.value = '30.2';
await Promise.resolve();
assert.equal(width.value, '30.20', 'Formatting runs after the control handler');
assert.equal(rotation.value, '15');
width.value = '1.';
listeners.get('input')({ type: 'input', inputType: 'insertText', target: width });
await Promise.resolve();
assert.equal(width.value, '1.', 'Typing a decimal point remains possible');
listeners.get('change')({ type: 'change', target: width });
await Promise.resolve();
assert.equal(width.value, '1.00');
width.value = '7';
mutations([{ type: 'attributes', target: width }]);
assert.equal(width.value, '7.00');
dispose();
assert.equal(disconnected, true);
assert.equal(listeners.size, 0);
for (const [path, ids] of [
    ['../src/pcb/modules/board-shapes.js', ['pcbPropImageRot']],
    ['../src/ui/PCBApp.js', ['pcbPropTextToolRot', 'pcbPropTextRot', 'pcbPropRefRot']],
]) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    for (const id of ids) {
        const tag = source.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
        assert.ok(tag?.includes('data-number-format="rotation"'), `${id} opts out of decimal formatting`);
    }
}
console.log('PASS shared number formatting, dynamic dialogs, live steps, manual entry and rotation exclusion');