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

const keyboardStart = source.indexOf('    handleKeyDown(e) {');
const keyboardEnd = source.indexOf('    _commitTrack(', keyboardStart);
assert.ok(keyboardStart >= 0 && keyboardEnd > keyboardStart);
const keyboardDependencies = {
    getPcbSelection,
    cancelShapeDraw(target) { target._shapeDraw = null; },
    cancelTrackDraw(target) { target._trackDraw = null; },
    cancelFillDraw(target) { target._fillDraw = null; },
    finishSelectionInteraction() { return false; },
    clearSelectionInteractionUi() {},
    clearBoxSelection: clearPcbSelection,
    hasBoxSelection(target) { return getPcbSelection(target).length > 0; },
    getSelectedTrack() { return null; }, getSelectedVia() { return null; },
};
const handleKeyDown = new Function(...Object.keys(keyboardDependencies),
    `return ({ ${source.slice(keyboardStart, keyboardEnd)} }).handleKeyDown;`)(...Object.values(keyboardDependencies));
for (const tool of ['line', 'rect', 'polygon', 'circle', 'arc', 'track', 'fill']) {
    for (const selected of [false, true]) {
        setPcbSelection(app, selected ? [{ kind: 'text', object: texts[0] }] : []);
        app._active = true;
        app.currentTool = tool;
        const drawingKey = tool === 'track' ? '_trackDraw' : tool === 'fill' ? '_fillDraw' : '_shapeDraw';
        app[drawingKey] = { kind: tool };
        assert.equal(handleKeyDown.call(app, { key: 'Escape' }), true);
        assert.equal(app[drawingKey], null, `${tool}: first Escape discards drawing`);
        assert.equal(app.currentTool, tool, `${tool}: first Escape retains tool`);
        assert.equal(getPcbSelection(app).length, selected ? 1 : 0);
        assert.equal(handleKeyDown.call(app, { key: 'Escape' }), true);
        assert.equal(app.currentTool, 'select', `${tool}: second Escape returns to Select`);
        assert.deepEqual(getPcbSelection(app), [], `${tool}: second Escape clears old selection`);
    }
}
console.log('PASS: drawing cancellation takes two Escapes with or without an existing selection');

const statusStart = source.indexOf('    _setPcbStatus() {');
const statusEnd = source.indexOf('\n    /** Enable/disable PCB home-tab', statusStart);
assert.ok(statusStart >= 0 && statusEnd > statusStart);
const setStatus = new Function('getPcbSelection',
    `return ({ ${source.slice(statusStart, statusEnd)} })._setPcbStatus;`)(getPcbSelection);
app.status = { modeStatus: { textContent: '' } };
app.activeLayer = 'hole';
for (const [tool, settings, expected] of [
    ['text', { _textDefaults: { layer: 'top-silk' } }, 'Text | Top Silk'],
    ['text', { _textDefaults: { layer: 'bottom-silk' } }, 'Text | Bottom Silk'],
    ['fill', { _fillToolLayer: 'bottom-copper' }, 'Fill | Bottom Copper'],
    ['fill', { _fillDraw: { layer: 'top-copper' } }, 'Fill | Top Copper'],
    ['track', { _trackToolLayer: 'top-copper' }, 'Track | Top Copper'],
    ['track', { _trackDraw: { currentLayer: 'bottom-copper' } }, 'Track | Bottom Copper'],
    ['circle', {}, 'Circle | Hole'],
    ['select', {}, 'Select | Hole'],
]) {
    Object.assign(app, settings, { currentTool: tool });
    setStatus.call(app);
    assert.equal(app.status.modeStatus.textContent, expected);
}
console.log('PASS: status displays tool-specific and in-progress drawing layers after Hole');