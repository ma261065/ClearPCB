import assert from 'node:assert/strict';
import { SelectionManager } from '../src/core/SelectionManager.js';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { getPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { isBoardOutlineSelected, setBoardOutlineSelected } from '../src/pcb/modules/board-outline-resize.js';

globalThis.window = { addEventListener() {} };

const rows = ['a', 'b', 'c'].map(id => ({
    dataset: { drcId: id },
    focused: false,
    scrolled: false,
    focus(options) {
        this.focused = options?.preventScroll === true;
    },
    scrollIntoView(options) {
        this.scrolled = options?.block === 'nearest';
    },
}));
const list = {
    querySelectorAll(selector) {
        return selector === '.drc-item' ? rows : [];
    },
};
globalThis.document = {
    getElementById(id) {
        return id === 'pcbDrcList' ? list : null;
    },
};

const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { getDrcPresentation, initDrc } = await import('../src/pcb/modules/drc-state.js');
const app = Object.create(PCBApp.prototype);
app.pcbDocument = new PcbDocument();
const drc = getDrcPresentation(app);
drc.selectedId = null;
drc.selectViolation = id => { drc.selectedId = id; };

drc.moveSelection(1);
assert.equal(drc.selectedId, 'a', 'Arrow Down starts at the first visible violation');
drc.moveSelection(1);
assert.equal(drc.selectedId, 'b', 'Arrow Down selects the next visible violation');
assert.equal(rows[1].focused, true, 'keyboard navigation moves focus to the selected row');
assert.equal(rows[1].scrolled, true, 'keyboard navigation scrolls the selected row into view');
drc.moveSelection(-1);
assert.equal(drc.selectedId, 'a', 'Arrow Up selects the previous visible violation');
drc.moveSelection(-1);
assert.equal(drc.selectedId, 'a', 'Arrow Up stops at the first visible violation');
drc.selectedId = null;
drc.moveSelection(-1);
assert.equal(drc.selectedId, 'c', 'Arrow Up starts at the last visible violation');

const listeners = new Map();
const panel = {
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, handler, options) { listeners.set(name, { handler, options }); },
    focus(options) {
        assert.equal(options.preventScroll, true);
        assert.equal(getPcbSelection(app).length, 0, 'board selection clears before panel receives focus');
        document.activeElement = panel;
        listeners.get('focusin').handler();
    },
};
document.getElementById = id => id === 'pcbDrcList' ? list : id === 'pcbDrcSlidePanel' ? panel : null;
document.querySelector = () => null;
let clearedProperties = 0;
Object.assign(app, {
    _active: true, currentTool: 'select', placements: new Map(), boardShapes: [],
    _pcbSelection: new SelectionManager(), viewport: { isPanning: false },
    getLayerGroup: () => null,
    _selectComponent() {}, selectText() {}, drawRefOverlay() {}, selectFill() {},
    clearProperties() { clearedProperties++; },
    refreshText() {}, _updateDRCStatus() {},
});
const objects = [{ id: 'via:one', kind: 'via', object: { id: 'one', x: 5, y: 6 } },
    { id: 'via:two', kind: 'via', object: { id: 'two', x: 7, y: 8 } },
    { id: 'text:label', kind: 'text', object: { id: 'label', x: 9, y: 10 } }];
for (const object of objects) object.invalidate = () => {};
app._pcbSelection.setShapes(objects);
initDrc(app);
assert.equal(panel.attributes.tabindex, '-1', 'panel padding can receive pointer focus');
assert.equal(listeners.get('pointerdown').options.capture, true, 'deselection precedes row click handling');

const before = objects.map(entry => ({ ...entry.object }));
for (const ids of [['via:one'], objects.map(entry => entry.id)]) {
    app._pcbSelection.selectMultiple(ids);
    app._trackEdit = {};
    setBoardOutlineSelected(app, true);
    drc.selectedId = 'a';
    listeners.get('pointerdown').handler();
    assert.equal(getPcbSelection(app).length, 0, 'clicking anywhere in the panel clears single/multiple selection');
    assert.equal(app._trackEdit, null, 'Track edit state is cleared');
    assert.equal(isBoardOutlineSelected(app), false, 'board-outline selection is cleared');
    assert.equal(drc.selectedId, 'a', 'deselection preserves the selected DRC issue');
    assert.equal(document.activeElement, panel);

    let prevented = false, stopped = false;
    const event = {
        key: 'ArrowDown', target: { tagName: 'LI', closest: () => panel },
        preventDefault() { prevented = true; }, stopPropagation() { stopped = true; },
    };
    assert.equal(app.handleKeyDown(event), false, 'window-capture handler yields to the DRC panel');
    listeners.get('keydown').handler(event);
    assert.equal(drc.selectedId, 'b', 'Arrow Down navigates after the panel click');
    assert.ok(prevented && stopped);
    assert.deepEqual(objects.map(entry => entry.object), before, 'navigation never moves board objects');
}
assert.equal(clearedProperties, 2, 'properties clear once per selection, not again on focus');

app._pcbSelection.selectMultiple(['via:one']);
assert.equal(app.handleKeyDown({ key: 'ArrowUp', target: { tagName: 'LI', closest: () => panel } }), false,
    'even a stale board selection cannot intercept a DRC navigation key');
listeners.get('focusin').handler();
assert.equal(getPcbSelection(app).length, 0, 'keyboard focus into the panel also deselects the board');
assert.equal(clearedProperties, 3);

console.log('PASS: DRC arrow navigation, panel focus, board deselection and capture-phase keyboard ownership');
