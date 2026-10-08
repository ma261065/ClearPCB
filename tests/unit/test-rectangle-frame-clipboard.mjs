import assert from 'node:assert/strict';
import { createShape } from '../../src/shapes/index.js';
import { copySelection, beginPastePreview, confirmPaste } from '../../src/schematic/modules/clipboard.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();
const element = (tagName = 'g') => fakeElement(tagName);

const selection = [
    { x: 10, y: -20, w: 12, h: 7, rot: 17.3 },
    { x: -5, y: 15, w: 6, h: 4, rot: 131, rev: true },
].map((frame, i) => createShape({
    type: 'polyline', id: `original-${i}`, ir: true, cl: true, ...frame,
    cn: ['a', 'b', 'c', 'd'],
    ed: { ab: ['a', 'b'], bc: ['b', 'c'], cd: ['c', 'd'], da: ['d', 'a'] },
    ncr: { a: 0.25 }, ew: { bc: 0.3 },
}));
const originals = selection.map(shape => shape.toJSON());
const origin = selection.reduce((sum, shape) => {
    const bounds = shape.getBounds();
    return { x: sum.x + (bounds.minX + bounds.maxX) / 4,
        y: sum.y + (bounds.minY + bounds.maxY) / 4 };
}, { x: 0, y: 0 });
const commands = [];
const app = {
    currentTool: 'select',
    selection: { getSelection: () => selection, selectMultiple() {} },
    viewport: {
        contentLayer: element(), svg: element(), currentMouseWorld: { x: 0, y: 0 },
        getSnappedPosition: ({ x, y }) => ({ x: Math.round(x), y: Math.round(y) }),
    },
    history: { execute: command => commands.push(command) },
    fileManager: { setDirty() {} },
    renderShapes() {},
};
copySelection(app);
for (const target of [{ x: 101.1, y: -53.1 }, { x: -37.2, y: 29.2 }]) {
    beginPastePreview(app);
    confirmPaste(app, target);
    const pasted = commands.at(-1).shapes;
    assert.equal(pasted.length, 2);
    pasted.forEach((shape, i) => {
        const saved = shape.toJSON(), original = originals[i];
        assert.notEqual(saved.id, original.id);
        assert.ok(Math.abs(saved.x - (Math.round(target.x) + original.x - origin.x)) < 0.0001);
        assert.ok(Math.abs(saved.y - (Math.round(target.y) + original.y - origin.y)) < 0.0001);
        for (const key of ['w', 'h', 'rot', 'rev', 'cn', 'ed', 'ncr', 'ew']) {
            assert.deepEqual(saved[key], original[key], `Paste preserves ${key}`);
        }
    });
    assert.equal(app.pastingClipboard, false);
}
assert.deepEqual(selection.map(shape => shape.toJSON()), originals, 'Repeated paste must not mutate the source or clipboard geometry');
assert.notEqual(commands[0].shapes[0].id, commands[1].shapes[0].id);
console.log('PASS rectangle frame copy/paste preserves selection offsets, winding, metadata and source geometry');
