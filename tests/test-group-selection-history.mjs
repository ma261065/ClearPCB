import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function element() {
    return {
        attributes: {}, children: [], style: {}, parentNode: null,
        setAttribute(name, value) { this.attributes[name] = String(value); },
        appendChild(child) { child.parentNode = this; this.children.push(child); },
        remove() {
            if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        },
        querySelectorAll(selector) {
            return this.children.flatMap(child => [
                ...(child.attributes.class === selector.slice(1) ? [child] : []),
                ...child.querySelectorAll(selector),
            ]);
        },
    };
}

globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: element };
const { CommandHistory } = await import('../src/core/CommandHistory.js');
const { beginGroupDrag, updateGroupDrag, endGroupDrag, refreshBoxSelectionHighlights } =
    await import('../src/pcb/modules/box-select.js');
const { registerPcbSelectionAdapter, setPcbSelection, getPcbSelection, clearPcbSelection } =
    await import('../src/pcb/modules/selection-registry.js');

registerPcbSelectionAdapter('text', (app, text, id) => ({
    id, kind: 'text', object: text, visible: true,
    getAnchors() { return [{ id: 'origin', x: text.x, y: text.y }]; },
    getBounds() { return { minX: text.x, minY: text.y, maxX: text.x, maxY: text.y }; },
    invalidate() {},
}));

const overlay = element();
const texts = [{ id: 'first', x: 1, y: 2 }, { id: 'second', x: 10, y: 20 }];
const app = {
    placements: new Map(), tracks: [], vias: [], boardShapes: [],
    texts: new Map(texts.map(text => [text.id, text])),
    viewport: { scale: 8, snapToGrid: false },
    _layerGroups: new Map([['selection-overlay', overlay]]),
    _getLayerGroup(id) { return this._layerGroups.get(id); },
    _markDirty() {}, _syncHistoryButtons() {}, _refreshText() {},
};
const source = readFileSync(new URL('../src/ui/PCBApp.js', import.meta.url), 'utf8');
const callback = source.match(/onChanged: \(\) => \{([\s\S]*?)\n            \},/);
assert.ok(callback, 'PCB history callback exists');
const onChanged = new Function('refreshBoxSelectionHighlights', callback[1]).bind(app, refreshBoxSelectionHighlights);
app.history = new CommandHistory({ onChanged });
setPcbSelection(app, texts.map(object => ({ kind: 'text', object })));

function coordinates() {
    return overlay.querySelectorAll('.pcb-selection-anchors').map(group => {
        const handle = group.children[0];
        return [Number(handle.attributes.x) + 0.5, Number(handle.attributes.y) + 0.5];
    });
}

refreshBoxSelectionHighlights(app);
assert.deepEqual(coordinates(), [[1, 2], [10, 20]]);
beginGroupDrag(app, { x: 0, y: 0 });
updateGroupDrag(app, { x: 5, y: 7 });
endGroupDrag(app);
assert.deepEqual(coordinates(), [[6, 9], [15, 27]], 'move replaces the original handles');
app.history.undo();
assert.deepEqual(coordinates(), [[1, 2], [10, 20]], 'undo removes destination handles');
assert.deepEqual(getPcbSelection(app, 'text'), texts, 'undo preserves selection');
app.history.redo();
assert.deepEqual(coordinates(), [[6, 9], [15, 27]], 'redo replaces restored handles');
clearPcbSelection(app);
refreshBoxSelectionHighlights(app);
assert.deepEqual(coordinates(), [], 'empty selection removes remaining handles');
console.log('PASS: group move, undo, redo, and deselection replace selection overlays');