import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { runPcbNudgeAction } from '../../src/pcb/modules/editor-actions.js';
import { createPropertyPreview } from '../../src/shapes/property-preview.js';
import { setPropertyEditor } from '../../src/pcb/modules/property-editors.js';
import { areDragOverlaysDeferred } from '../../src/pcb/modules/refresh-state.js';
import { getGroupDrag } from '../../src/pcb/modules/box-select.js';
import { setPcbInteraction } from '../../src/pcb/modules/pcb-interactions.js';
import { getFillDraw } from '../../src/pcb/modules/copper-fill-draw.js';
import { getShapeDraw } from '../../src/pcb/modules/board-shape-draw.js';
import { getTrackDraw, setTrackToolLayer } from '../../src/pcb/modules/track-draw.js';
import { setTextToolDefaults } from '../../src/pcb/modules/text-properties.js';
import { setFillToolDefaults } from '../../src/pcb/modules/copper-fill-draw.js';
import { isEditorActive, setEditorActive } from '../../src/pcb/modules/pcb-editor-api.js';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';

function element() {
    return {
        attributes: {}, children: [], style: {}, parentNode: null, addEventListener() {},
        classList: { add() {}, remove() {} },
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

const document = installFakeDom();
globalThis.window.setTimeout = callback => { callback(); };
globalThis.requestAnimationFrame = callback => callback();
document.createElementNS = element;
document.createElement = element;
document.getElementById = () => null;
document.querySelector = () => null;
document.querySelectorAll = () => [];
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');
const { CommandHistory } = await import('../../src/core/CommandHistory.js');
const { armBoxSelect, beginGroupDrag, finishBoxSelect, updateGroupDrag, endGroupDrag, refreshBoxSelectionHighlights } =
    await import('../../src/pcb/modules/box-select.js');
const { getTextPosePreviewTexts } = await import('../../src/pcb/modules/text-commands.js');
const { registerPcbSelectionAdapter, setPcbSelection, getPcbSelection, getPcbSelectionEntries, clearPcbSelection } =
    await import('../../src/pcb/modules/selection-registry.js');

registerPcbSelectionAdapter('text', (app, text, id) => ({
    id, kind: 'text', object: text, visible: true,
    getAnchors() { return [{ id: 'origin', x: text.x, y: text.y }]; },
    getBounds() { return { minX: text.x, minY: text.y, maxX: text.x, maxY: text.y }; },
    invalidate() {},
}));

const overlay = element();
const texts = [{ id: 'first', x: 1, y: 2 }, { id: 'second', x: 10, y: 20 }];
const pcbDocument = new PcbDocument();
for (const text of texts) pcbDocument.texts.set(text.id, text);
const app = { ...pcbEditorStubs(),
    placements: new Map(), tracks: [], vias: [], boardShapes: [],
    pcbDocument, get texts() { return getTextPosePreviewTexts(this) || pcbDocument.texts; },
    viewport: { scale: 8, snapToGrid: false, contentLayer: element(),
        getVisibleBounds: () => ({ minX: -100, minY: -100, maxX: 100, maxY: 100 }),
        hideCrosshair() {} },
    _layerGroups: new Map([['selection-overlay', overlay]]),
    getLayerGroup(id) { return this._layerGroups.get(id); },
    markDirty() {}, syncPcbHistoryButtons() {}, refreshText() {},
};
app.history = new CommandHistory({ onChanged: () => PCBApp.prototype._onHistoryChanged.call(app) });
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

// The real keyboard handler, run against this test's editor.
const handleKeyDown = PCBApp.prototype.handleKeyDown;
setEditorActive(app, true);
app.currentTool = 'select';
app.viewport.snapToGrid = true;
app.viewport.gridSize = 0.25;
setPcbSelection(app, texts.map(object => ({ kind: 'text', object })));
let propertyRefreshes = 0;
app.showMultiSelectionProperties = selected => {
    assert.equal(getGroupDrag(app), null, 'Properties refresh follows gesture completion');
    assert.deepEqual(selected.map(entry => entry.object), texts);
    propertyRefreshes++;
};
for (const invoke of [key => handleKeyDown.call(app, { key }), key => runPcbNudgeAction(app, key)]) {
for (const [key, dx, dy] of [
    ['ArrowUp', 0, -0.0625], ['ArrowDown', 0, 0.0625],
    ['ArrowLeft', -0.0625, 0], ['ArrowRight', 0.0625, 0],
]) {
    const before = texts.map(text => [text.x, text.y]);
    const after = before.map(([x, y]) => [x + dx, y + dy]);
    propertyRefreshes = 0;
    assert.equal(invoke(key), true);
    assert.equal(propertyRefreshes, 1, 'Refresh Properties once after the movement command');
    assert.deepEqual(texts.map(text => [text.x, text.y]), after, `${key}: one quarter-grid step`);
    assert.deepEqual(coordinates(), after, `${key}: selection handles follow`);
    app.history.undo();
    assert.deepEqual(texts.map(text => [text.x, text.y]), before, `${key}: one undo restores the group`);
    app.history.redo();
    assert.deepEqual(texts.map(text => [text.x, text.y]), after, `${key}: redo moves the group`);
    assert.deepEqual(getPcbSelection(app, 'text'), texts);
    assert.equal(getGroupDrag(app), null);
    assert.equal(areDragOverlaysDeferred(app), false);
}
}
app.viewport.snapToGrid = false;
const beforeUnsnapped = texts.map(text => [text.x, text.y]);
assert.equal(handleKeyDown.call(app, { key: 'ArrowRight' }), true);
assert.deepEqual(texts.map(text => [text.x, text.y]), beforeUnsnapped.map(([x, y]) => [x + 1, y]),
    'With snapping off, arrows move by 1 mm');
app.history.undo();
{
    const before = texts.map(text => [text.x, text.y]);
    texts[0].size = 1.2;
    const binding = createPropertyPreview({
        capture: () => texts[0].size,
        restore: size => { texts[0].size = size; },
        redraw() {},
        commit(original, next) {
            app.history.execute({
                execute() { texts[0].size = next; },
                undo() { texts[0].size = original; },
            });
        },
    });
    setPropertyEditor(app, 'text', binding);
    binding.update(() => { texts[0].size = 2.4; });
    assert.equal(handleKeyDown.call(app, { key: 'ArrowRight' }), true);
    assert.equal(binding.active, false, 'Nudging preserves the existing property-commit handoff');
    assert.equal(texts[0].size, 2.4);
    assert.deepEqual(texts.map(text => [text.x, text.y]), before.map(([x, y]) => [x + 1, y]));
    app.history.undo();
    assert.deepEqual(texts.map(text => [text.x, text.y]), before, 'First Undo restores the group position');
    assert.equal(texts[0].size, 2.4, 'Property edit precedes movement in history');
    app.history.undo();
    assert.equal(texts[0].size, 1.2, 'Second Undo restores the property value');
    app.history.redo();
    app.history.redo();
    assert.equal(texts[0].size, 2.4);
    assert.deepEqual(texts.map(text => [text.x, text.y]), before.map(([x, y]) => [x + 1, y]));
    app.history.undo();
    app.history.undo();
    setPropertyEditor(app, 'text', null);
}
{
    const failure = new Error('Fixture property commit failed');
    const beforeUndo = [...app.history.undoStack], beforeRedo = [...app.history.redoStack];
    setPropertyEditor(app, 'pad', { active: true, commit() { throw failure; } });
    assert.throws(() => handleKeyDown.call(app, { key: 'ArrowLeft' }), error => error === failure);
    assert.deepEqual(texts.map(text => [text.x, text.y]), beforeUnsnapped);
    assert.equal(getGroupDrag(app), null, 'A failed handoff must not start movement');
    assert.deepEqual(app.history.undoStack, beforeUndo);
    assert.deepEqual(app.history.redoStack, beforeRedo);
    setPropertyEditor(app, 'pad', null);
}
for (const event of [
    { key: 'ArrowUp', target: { tagName: 'INPUT' } },
    { key: 'ArrowUp', target: { tagName: 'TEXTAREA' } },
    { key: 'ArrowUp', target: { tagName: 'SELECT' } },
    { key: 'ArrowUp', target: { isContentEditable: true } },
    { key: 'ArrowUp', ctrlKey: true }, { key: 'ArrowUp', metaKey: true },
    { key: 'ArrowUp', altKey: true },
]) {
    assert.equal(handleKeyDown.call(app, event), false);
    assert.deepEqual(texts.map(text => [text.x, text.y]), beforeUnsnapped);
}
for (const state of ['_pcbSelectionInteraction', '_groupDrag', '_vertexDrag', '_viaDrag', '_shapeDrag',
    '_boardOutlineResize', '_rotationHandleDrag', '_pasteDrop', '_textEdit', '_drag',
    '_textDrag', '_refDrag', '_boxSelectArm']) {
    if (state === '_boxSelectArm') armBoxSelect(app, { x: 0, y: 0 }, { x: 0, y: 0 });
    else setPcbInteraction(app, state, {});
    assert.equal(handleKeyDown.call(app, { key: 'ArrowLeft' }), false, `${state}: arrows leave active gestures alone`);
    assert.equal(runPcbNudgeAction(app, 'ArrowLeft'), false, `${state}: direct action uses the same guard`);
    assert.deepEqual(texts.map(text => [text.x, text.y]), beforeUnsnapped);
    if (state === '_boxSelectArm') finishBoxSelect(app);
    else setPcbInteraction(app, state, null);
}
const selectedEntry = getPcbSelectionEntries(app)[0];
selectedEntry.visible = false;
assert.equal(handleKeyDown.call(app, { key: 'ArrowLeft' }), false, 'Hidden or layer-locked entries cannot move');
selectedEntry.visible = true;
// A locked member stays put while the rest of the selection moves.
const lockedText = selectedEntry.object;
const lockedAt = [lockedText.x, lockedText.y];
const movingText = texts.find(text => text !== lockedText);
const movingAt = [movingText.x, movingText.y];
selectedEntry.locked = true;
lockedText.locked = true;
assert.equal(handleKeyDown.call(app, { key: 'ArrowRight' }), true, 'Unlocked members still move');
assert.deepEqual([lockedText.x, lockedText.y], lockedAt, 'The locked member stays put');
assert.notDeepEqual([movingText.x, movingText.y], movingAt);
app.history.undo();
assert.deepEqual([movingText.x, movingText.y], movingAt);
selectedEntry.locked = false;
delete lockedText.locked;
selectedEntry.locked = true;
for (const entry of getPcbSelectionEntries(app)) entry.locked = true;
assert.equal(handleKeyDown.call(app, { key: 'ArrowRight' }), false, 'An all-locked selection does not move');
for (const entry of getPcbSelectionEntries(app)) entry.locked = false;
app.viewport.isPanning = true;
assert.equal(handleKeyDown.call(app, { key: 'ArrowRight' }), false, 'Panning retains ownership of navigation');
app.viewport.isPanning = false;
app.currentTool = 'track';
assert.equal(handleKeyDown.call(app, { key: 'ArrowRight' }), false, 'Drawing tools do not nudge selection');
app.currentTool = 'select';
setEditorActive(app, false);
assert.equal(handleKeyDown.call(app, { key: 'ArrowRight' }), false, 'Inactive editors do not nudge');
assert.equal(runPcbNudgeAction(app, 'ArrowRight'), false);
setEditorActive(app, true);
for (const key of ['_trackDraw', '_fillDraw', '_shapeDraw']) {
    setPcbInteraction(app, key, {});
    assert.equal(runPcbNudgeAction(app, 'ArrowRight'), false, 'Direct actions also respect unfinished drawing');
    setPcbInteraction(app, key, null);
}
assert.deepEqual(texts.map(text => [text.x, text.y]), beforeUnsnapped);
app.placements.set('ref', {});
setPcbSelection(app, [{ kind: 'text', object: texts[0] }, { kind: 'reftext', object: 'ref' }]);
assert.equal(getPcbSelectionEntries(app).length, 2);
assert.equal(runPcbNudgeAction(app, 'ArrowRight'), false, 'Reference labels retain their separate movement policy');
clearPcbSelection(app);
app.placements.delete('ref');
assert.equal(handleKeyDown.call(app, { key: 'ArrowLeft' }), false, 'Empty selection is not moved');
console.log('PASS: PCB arrow-key group movement, grid steps, undo/redo, and input guards');

const warnings = [];
app.viewport.worldToScreen = point => ({ x: point.x, y: point.y });
app.viewport.svg = { style: {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
const appendChild = document.body.appendChild;
document.body.appendChild = (popup) => {
    // The popup is anchored at its component's centre: identify the component from where it lands.
    const left = parseFloat(popup.style.left), top = parseFloat(popup.style.top);
    const componentId = [...app.placements].find(([, pl]) => pl.x === left && pl.y === top)?.[0] ?? null;
    warnings.push({ componentId, message: popup.textContent });
    return appendChild.call(document.body, popup);
};
app.placements.set('component-1', { x: 7, y: 11 });
app.placements.set('component-2', { x: 23, y: 5 });
for (const key of ['Delete', 'Backspace']) {
    for (const kind of ['component', 'reftext']) {
        for (const mixed of [false, true]) {
            pcbDocument.texts.set(texts[0].id, texts[0]);
            const selection = [{ kind, object: 'component-1' }];
            if (mixed) selection.push({ kind: 'text', object: texts[0] });
            setPcbSelection(app, selection);
            warnings.length = 0;
            assert.equal(handleKeyDown.call(app, { key }), true);
            assert.deepEqual(getPcbSelection(app), [], 'Deletion cleared selection before the warning');
            assert.deepEqual(warnings, [{ componentId: 'component-1', message: 'Delete components from the schematic editor' }],
                `${key}: ${kind} warning survives selection clearing (mixed=${mixed})`);
            assert.equal(pcbDocument.texts.has(texts[0].id), !mixed, 'Only selected text is deleted');
        }
    }
}
warnings.length = 0;
pcbDocument.texts.set(texts[0].id, texts[0]);
setPcbSelection(app, [{ kind: 'text', object: texts[0] }]);
assert.equal(handleKeyDown.call(app, { key: 'Delete' }), true);
assert.deepEqual(warnings, [], 'Ordinary deletion does not show a component warning');
assert.equal(handleKeyDown.call(app, { key: 'Delete' }), false, 'Empty selection remains unhandled');
pcbDocument.texts.set(texts[0].id, texts[0]);
app.placements.delete('component-1');
app.placements.delete('component-2');
console.log('PASS: component deletion warnings survive selection clearing');

for (const tool of ['line', 'rect', 'polygon', 'circle', 'arc', 'track', 'fill']) {
    for (const selected of [false, true]) {
        setPcbSelection(app, selected ? [{ kind: 'text', object: texts[0] }] : []);
        setEditorActive(app, true);
        app.currentTool = tool;
        const drawingKey = tool === 'track' ? '_trackDraw' : tool === 'fill' ? '_fillDraw' : '_shapeDraw';
        setPcbInteraction(app, drawingKey, { kind: tool });
        assert.equal(handleKeyDown.call(app, { key: 'Escape' }), true);
        assert.equal(getTrackDraw(app) || getFillDraw(app) || getShapeDraw(app), null, `${tool}: first Escape discards drawing`);
        assert.equal(app.currentTool, tool, `${tool}: first Escape retains tool`);
        assert.equal(getPcbSelection(app).length, selected ? 1 : 0);
        assert.equal(handleKeyDown.call(app, { key: 'Escape' }), true);
        assert.equal(app.currentTool, 'select', `${tool}: second Escape returns to Select`);
        assert.deepEqual(getPcbSelection(app), [], `${tool}: second Escape clears old selection`);
    }
}
console.log('PASS: drawing cancellation takes two Escapes with or without an existing selection');

const setStatus = PCBApp.prototype.setPcbStatus;
app.status = { modeStatus: { textContent: '' } };
app.activeLayer = 'hole';
for (const [tool, setup, expected] of [
    ['text', app => setTextToolDefaults(app, { size: 1.0, rotation: 0, layer: 'top-silk', strokeWidth: 0.15, border: false }), 'Text | Top Silk'],
    ['text', app => setTextToolDefaults(app, { size: 1.0, rotation: 0, layer: 'bottom-silk', strokeWidth: 0.15, border: false }), 'Text | Bottom Silk'],
    ['fill', app => { setFillToolDefaults(app, { layer: 'bottom-copper' }); }, 'Fill | Bottom Copper'],
    ['fill', app => setPcbInteraction(app, '_fillDraw', { layer: 'top-copper' }), 'Fill | Top Copper'],
    ['track', app => setTrackToolLayer(app, 'top-copper'), 'Track | Top Copper'],
    ['track', app => setPcbInteraction(app, '_trackDraw', { currentLayer: 'bottom-copper' }), 'Track | Bottom Copper'],
    ['circle', () => {}, 'Circle | Hole'],
    ['select', () => {}, 'Select | Hole'],
]) {
    Object.assign(app, { currentTool: tool });
    setPcbInteraction(app, '_fillDraw', null);
    setPcbInteraction(app, '_trackDraw', null);
    setup(app);
    setStatus.call(app);
    assert.equal(app.status.modeStatus.textContent, expected);
}
console.log('PASS: status displays tool-specific and in-progress drawing layers after Hole');