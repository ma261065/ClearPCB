import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { connectBoxOutlines, connectPointToBoxOutline } from '../src/core/geometry.js';
import { getTextEditBoxWorldCorners } from '../src/ui/modules/text-edit-geometry.js';
import { applyTextConnectionGuide } from '../src/ui/modules/inline-text-overlay.js';
import { clearPcbSelection, setPcbSelection, togglePcbSelection }
    from '../src/pcb/modules/selection-registry.js';
import '../src/pcb/modules/component-selection.js';
import '../src/pcb/modules/ref-text-selection.js';

const placement = { x: 10, y: 20, refDx: 0, refDy: 0 };
const overlay = { children: [] };
const app = {
    placements: new Map([['U1', placement], ['U2', { x: 30, y: 40, refDx: 2, refDy: 3 }]]),
    viewport: { scale: 10 },
    _refOverlay: null,
    _drawRefOverlay(componentId, withTether) {
        this._refOverlay = overlay;
        overlay.children = [];
        const current = this.placements.get(componentId);
        if (current) overlay.children.push({ componentId, x: current.x + current.refDx,
            y: current.y + current.refDy, withTether });
    },
};
const select = (kind, object) => setPcbSelection(app, [{ kind, object }]);

select('component', 'U1');
assert.equal(app._refOverlay, null, 'Component selection must not create a reference overlay');
select('reftext', 'U1');
placement.refDx = 5;
placement.refDy = -3;
app._drawRefOverlay('U1', false);
assert.deepEqual(overlay.children, [{ componentId: 'U1', x: 15, y: 17, withTether: false }]);
select('component', 'U1');
assert.deepEqual(overlay.children, [], 'Selecting the component must remove its old reference box');
placement.x += 10;
placement.y += 5;
assert.deepEqual(overlay.children, [], 'No stale reference box should remain during component movement');

select('reftext', 'U1');
assert.deepEqual(overlay.children, [{ componentId: 'U1', x: 25, y: 22, withTether: false }]);
select('reftext', 'U2');
assert.deepEqual(overlay.children, [{ componentId: 'U2', x: 32, y: 43, withTether: false }]);
togglePcbSelection(app, 'reftext', 'U2');
assert.deepEqual(overlay.children, [], 'Ctrl deselection must clear the reference overlay');

select('reftext', 'U1');
togglePcbSelection(app, 'component', 'U2');
assert.equal(overlay.children[0]?.componentId, 'U1', 'An additively selected reference keeps its overlay');
clearPcbSelection(app);
assert.deepEqual(overlay.children, [], 'Clearing multi-selection must clear the reference overlay');
console.log('PASS: moved reference box clears on component selection, retargets across references, and respects additive selection');

globalThis.window = { addEventListener() {} };
globalThis.HTMLElement = class {};
globalThis.document = {
    createElementNS() { return { setAttribute() {}, appendChild() {} }; },
    getElementById() { return null; },
    querySelector() { return null; },
};
const { ModifyPropertyCommand } = await import('../src/schematic/modules/commands.js');
const { idleState } = await import('../src/schematic/modules/draw-states.js');
const source = readFileSync(new URL('../src/ui/PCBApp.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const method = source.match(/    _tryEditReferenceAt\(worldPos\) \{([\s\S]*?)\n    \}/);
assert.ok(method, 'PCB reference inline-edit entry point exists');
let layerLocked = false;
let layerVisible = true;
const dependencies = {
    ModifyPropertyCommand,
    REF_DEFAULT_SIZE: 0.9,
    REF_DEFAULT_STROKE: 0.15,
    isLayerLocked: () => layerLocked,
    isLayerVisible: () => layerVisible,
    extractNetlist: () => [],
};
const startReferenceEdit = new Function(...Object.keys(dependencies), `return function(worldPos) {${method[1]}\n};`)
    (...Object.values(dependencies));
const component = { id: 'component-1', reference: 'R1', invalidate() {},
    refText: { text: 'R1', invalidate() {} } };
const alerts = [];
window.app = { components: [component, { id: 'component-2', reference: 'R2' }], shapes: [],
    renderShapes() {}, _alert(message) { alerts.push(message); } };
let dirty = false;
const editor = {
    placements: new Map([[component.id, { reference: 'R1', side: 'top', x: 10, y: 20 }]]),
    history: new CommandHistory({ onChanged() { dirty = true; } }),
    _hitTestText() { return null; }, _hitTestRefText() { return component.id; },
    _startTextInlineEdit(text, point, options) { this.edit = { text, options }; },
    _rerenderRef() {}, _drawRefOverlay() {}, _showRefProperties() {}, _updateRatsnest() {},
};
assert.equal(startReferenceEdit.call(editor, { x: 10, y: 20 }), true);
editor.edit.text.content = 'R7';
editor.edit.options.render();
assert.equal(editor.placements.get(component.id).reference, 'R7', 'PCB previews the typed reference');
assert.equal(component.reference, 'R1', 'Typing does not change the schematic before commit');
assert.equal(editor.edit.options.validate(' r2 '), false, 'Duplicate names are case-insensitive');
assert.equal(editor.edit.options.validate('   '), false, 'Blank references are rejected');
assert.equal(alerts.length, 2);
assert.equal(editor.edit.options.validate(' R7 '), true);
editor.edit.options.finish(' R7 ', true);
assert.equal(component.reference, 'R7');
assert.equal(component.refText.text, 'R7', 'Schematic field text follows its component');
assert.equal(editor.placements.get(component.id).reference, 'R7');
assert.equal(editor.history.undoStack.length, 1, 'One rename creates one PCB undo entry');
assert.equal(editor.history.getUndoDescription(), 'Rename R1 to R7');
assert.equal(dirty, true, 'PCB history marks the combined document dirty');

editor.placements.set(component.id, { reference: 'R7', side: 'top', x: 10, y: 20 });
editor.history.undo();
assert.equal(component.reference, 'R1');
assert.equal(component.refText.text, 'R1');
assert.equal(editor.placements.get(component.id).reference, 'R1', 'Undo resolves the current placement after a rebuild');
editor.history.redo();
assert.equal(component.reference, 'R7');
assert.equal(component.refText.text, 'R7');
assert.equal(editor.placements.get(component.id).reference, 'R7');
startReferenceEdit.call(editor, { x: 10, y: 20 });
editor.edit.text.content = 'R99';
editor.edit.options.render();
editor.edit.options.finish('R99', false);
assert.equal(component.reference, 'R7');
assert.equal(editor.placements.get(component.id).reference, 'R7', 'Cancel restores the PCB preview');
assert.equal(editor.history.undoStack.length, 1, 'Cancel creates no history entry');
layerLocked = true;
assert.equal(startReferenceEdit.call(editor, { x: 10, y: 20 }), false);
layerLocked = false;
layerVisible = false;
assert.equal(startReferenceEdit.call(editor, { x: 10, y: 20 }), false);
layerVisible = true;
component.locked = true;
assert.equal(startReferenceEdit.call(editor, { x: 10, y: 20 }), false);
console.log('PASS: PCB reference rename updates both views, validates names, cancels, and supports undo/redo');

const selectedComponent = { supportsInlineEdit: false };
const editableReference = { supportsInlineEdit: true };
let selectedForEdit = null;
let startedEdit = null;
let caretScreenPos = null;
const schematicEditApp = {
    textEdit: null,
    selection: {
        hitTest(point, all) {
            return all ? [editableReference, selectedComponent] : selectedComponent;
        },
        select(shape) { selectedForEdit = shape; },
    },
    renderShapes() {},
    pendingAnchorDrag: {},
    _startTextEdit(shape) { startedEdit = shape; },
    _setTextEditCaretFromScreen(point) { caretScreenPos = point; },
    viewport: { _onTitleBlockDblClick() { throw new Error('Unexpected title block edit'); } },
};
let prevented = false;
idleState.mousedown(schematicEditApp, {
    button: 0,
    detail: 2,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: { __shape: editableReference },
    preventDefault() { prevented = true; },
}, {
    screenPos: { x: 100, y: 200 },
    worldPos: { x: 10, y: 20 },
    snapped: { x: 10, y: 20 },
});
assert.equal(selectedForEdit, editableReference);
assert.equal(startedEdit, editableReference,
    'Second mouse press must start editing before schematic drag handling');
assert.deepEqual(caretScreenPos, { x: 100, y: 200 });
assert.equal(schematicEditApp.pendingAnchorDrag, null);
assert.equal(prevented, true);

selectedForEdit = null;
startedEdit = null;
schematicEditApp.selection.hitTest = (point, all) => all ? [selectedComponent] : selectedComponent;
idleState.dblclick(schematicEditApp, { target: { __shape: editableReference } }, {
    screenPos: { x: 300, y: 400 },
    worldPos: { x: 30, y: 40 },
});
assert.equal(selectedForEdit, editableReference);
assert.equal(startedEdit, editableReference,
    'Double-click must use the clicked SVG text when geometric hit testing is stale');
console.log('PASS: schematic reference text keeps double-click inline editing over its component');

const { updateLabelGuide } = await import('../src/ui/modules/label-attachment.js');
const guideLayer = { children: [], appendChild(child) {
    child.remove();
    this.children.push(child);
} };
document.createElementNS = () => ({ attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    remove() { guideLayer.children = guideLayer.children.filter(child => child !== this); } });
const near = (actual, expected) => assert.ok(Math.abs(Number(actual) - expected) < 1e-9,
    `Expected ${actual} to equal ${expected}`);
for (const rotation of [0, 37, 90]) for (const mirrored of [false, true]) {
    const local = { minX: mirrored ? -5 : -3, maxX: mirrored ? 3 : 5, minY: -2, maxY: 2 };
    const parent = { x: 20, y: 30, rotation, _getLocalBounds: () => local };
    const angle = rotation * Math.PI / 180;
    const toWorld = (x, y) => ({ x: parent.x + x * Math.cos(angle) - y * Math.sin(angle),
        y: parent.y + x * Math.sin(angle) + y * Math.cos(angle) });
    let center = toWorld(12, 0);
    const reference = { type: 'text', parentComponent: parent, selected: true,
        textAnchor: 'middle', fontSize: 2, rotation: 0,
        get x() { return center.x; }, get y() { return center.y; },
        element: {
            getBBox() { return { x: center.x - 1, y: center.y - 1, width: 2, height: 2 }; },
            getAttribute(name) { return name === 'y' ? String(center.y) : null; },
        } };
    parent.refText = reference;
    let selected = [reference];
    const guideApp = { selection: { getSelection: () => selected }, viewport: { contentLayer: guideLayer } };
    updateLabelGuide(guideApp);
    const firstGuide = guideApp._labelGuide;
    const componentBox = [
        toWorld(local.minX - 0.5, local.minY - 0.5), toWorld(local.maxX + 0.5, local.minY - 0.5),
        toWorld(local.maxX + 0.5, local.maxY + 0.5), toWorld(local.minX - 0.5, local.maxY + 0.5),
    ];
    const textBox = getTextEditBoxWorldCorners(reference);
    near(textBox[0].x, center.x - 1.3);
    near(textBox[0].y, center.y - 1.3);
    near(textBox[2].x, center.x + 1.3);
    near(textBox[2].y, center.y + 1.3);
    const expected = connectBoxOutlines(componentBox, textBox);
    near(firstGuide.attributes.x1, expected.end.x);
    near(firstGuide.attributes.y1, expected.end.y);
    near(firstGuide.attributes.x2, expected.start.x);
    near(firstGuide.attributes.y2, expected.start.y);
    assert.ok(Math.hypot(Number(firstGuide.attributes.x1) - center.x,
        Number(firstGuide.attributes.y1) - center.y) > 0.1,
        'Reference guide must stop at the text outline, not its baseline anchor');
    assert.equal(guideLayer.children.length, 1);

    center = toWorld((local.minX + local.maxX) / 2, 10);
    updateLabelGuide(guideApp);
    assert.equal(guideApp._labelGuide, firstGuide, 'Dragging reuses the single guide');
    const movedTextBox = getTextEditBoxWorldCorners(reference);
    const movedConnection = connectBoxOutlines(componentBox, movedTextBox);
    near(firstGuide.attributes.x1, movedConnection.end.x);
    near(firstGuide.attributes.y1, movedConnection.end.y);
    near(firstGuide.attributes.x2, movedConnection.start.x);
    near(firstGuide.attributes.y2, movedConnection.start.y);
    assert.equal(guideLayer.children.length, 1, 'Live updates never create a duplicate line');

    center = toWorld((local.minX + local.maxX) / 2, 0);
    updateLabelGuide(guideApp);
    assert.equal(guideApp._labelGuide, null, 'Reference inside the outline needs no connection');
    center = toWorld(12, 0);
    selected = [];
    guideApp.textEdit = { shape: reference };
    updateLabelGuide(guideApp);
    assert.ok(guideApp._labelGuide, 'Inline editing uses the same renderer');
    guideApp.textEdit = null;
    updateLabelGuide(guideApp);
    assert.equal(guideLayer.children.length, 0, 'Deselecting clears the guide');
}

const shapeSource = readFileSync(new URL('../src/schematic/modules/shape-management.js', import.meta.url), 'utf8');
const renderBody = shapeSource.match(/export function renderShapes\(app, force = false\) \{([\s\S]*?)\n\}/);
assert.ok(renderBody);
const renderDependencies = {
    syncAttachedLabels() {}, renderShapeSegmentSelection() {}, refreshAxisGlow() {},
    OVERLAY_TYPES: new Set(), updateLabelGuide,
};
const renderShapes = new Function(...Object.keys(renderDependencies), `return function(app, force = false) {${renderBody[1]}\n};`)
    (...Object.values(renderDependencies));
let renderedX = 10;
const renderReference = { id: 'schematic-reference', type: 'text', selected: true,
    textAnchor: 'middle', get x() { return renderedX; }, y: 0,
    render() { renderedX = 15; },
    element: {
        getBBox() { return { x: renderedX - 1, y: -1, width: 2, height: 2 }; },
        getAttribute(name) { return name === 'y' ? String(renderReference.y) : null; },
    } };
renderReference.parentComponent = { x: 0, y: 0, rotation: 0, refText: renderReference,
    _getLocalBounds: () => ({ minX: -2, maxX: 2, minY: -2, maxY: 2 }) };
const renderApp = { shapes: [renderReference], components: [],
    selection: { getSelection: () => [renderReference], selected: new Set(['reference']) },
    _selectedShapeNode: null, _selectedShapeSegment: null,
    viewport: { scale: 10, contentLayer: guideLayer } };
renderShapes(renderApp);
near(renderApp._labelGuide.attributes.x1, 13.7);
assert.equal(guideLayer.children.length, 1, 'Post-render hook draws exactly one guide using current text geometry');
for (const textAnchor of ['start', 'middle', 'end']) for (const rotation of [0, 37, 90, 270]) {
    Object.assign(renderReference, { text: 'R123', fontSize: 2, textAnchor, rotation, y: 8 });
    updateLabelGuide(renderApp);
    assert.ok(Math.hypot(Number(renderApp._labelGuide.attributes.x1) - renderedX,
        Number(renderApp._labelGuide.attributes.y1) - 8) > 0.1,
        'Reference guide must stop at the text outline, not its baseline');
    assert.equal(guideLayer.children.length, 1, 'Baseline alignment changes keep a single guide');
}
console.log('PASS: one schematic guide follows rendering, clips rotated/mirrored bounds, and clears on deselection');

const netParent = { type: 'net', getPosition: () => ({ x: 0, y: 0 }) };
const netLabel = {
    type: 'text', text: 'VCC', x: 8, y: 0, fontSize: 2, rotation: 0,
    textAnchor: 'start', visible: true, parentComponent: netParent,
    element: {
        getBBox: () => ({ x: 8, y: -2, width: 4, height: 2 }),
        getAttribute: name => name === 'y' ? '0' : null,
    },
};
const netGuideApp = {
    selection: { getSelection: () => [netLabel] },
    viewport: { contentLayer: guideLayer },
};
updateLabelGuide(netGuideApp);
const netTextBox = getTextEditBoxWorldCorners(netLabel);
const netConnection = connectPointToBoxOutline({ x: 0, y: 0 }, netTextBox);
near(netGuideApp._labelGuide.attributes.x1, netConnection.end.x);
near(netGuideApp._labelGuide.attributes.y1, netConnection.end.y);
near(netGuideApp._labelGuide.attributes.x2, 0);
near(netGuideApp._labelGuide.attributes.y2, 0);
assert.notEqual(Number(netGuideApp._labelGuide.attributes.x1), netLabel.x,
    'Net-label guide must stop at the visible edit box, not the text anchor');
console.log('PASS: net-label guide clips to the shared edit-box boundary');

const { isPcbSelected } = await import('../src/pcb/modules/selection-registry.js');
const { textColorForLayer } = await import('../src/pcb/modules/pcb-text.js');
const highlightBody = source.match(/    _refreshRefHighlight\(compId\) \{([\s\S]*?)\n    \}/);
assert.ok(highlightBody);
const refreshRefHighlight = new Function('isPcbSelected', 'textColorForLayer',
    `return function(compId) {${highlightBody[1]}\n};`)(isPcbSelected, textColorForLayer);
let theme = 'dark';
document.documentElement = { getAttribute() { return theme; } };
const refElement = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
const highlightPlacement = { side: 'top', _refEl: refElement,
    refDx: 0, refDy: -5, refStrokeWidth: 0.15,
    bounds: { x: -2, y: -1, width: 4, height: 2 } };
const highlightApp = { placements: new Map([['ref', highlightPlacement]]),
    _refBox: placement => placement
        ? { bx: -1, by: -2, bw: 2, bh: 1, cx: 0, cy: -1.5 }
        : null,
    _refEditBoxWorldCorners: () => [
        { x: -1, y: -6 }, { x: 1, y: -6 },
        { x: 1, y: -4 }, { x: -1, y: -4 },
    ],
    _placementLocalToWorld(placement, x, y) { return { x, y }; },
    _drawRefOverlay() {},
    _refreshRefHighlight: refreshRefHighlight };
setPcbSelection(highlightApp, [{ kind: 'reftext', object: 'ref' }]);
assert.equal(refElement.attributes.stroke, '#ffffff', 'Selected reference matches silk text in dark theme');
theme = 'light';
highlightApp._refreshRefHighlight('ref');
assert.equal(refElement.attributes.stroke, '#000000', 'Selected reference matches silk text in light theme');
clearPcbSelection(highlightApp);
assert.equal(refElement.attributes.stroke, textColorForLayer('top-silk'), 'Deselecting restores the silk color');
highlightPlacement.side = 'bottom';
highlightApp._refreshRefHighlight('ref');
assert.equal(refElement.attributes.stroke, textColorForLayer('bottom-silk'));

const referenceOverlay = { children: [], get firstChild() { return this.children[0] || null; },
    appendChild(child) { this.children.push(child); },
    removeChild(child) { this.children = this.children.filter(item => item !== child); } };
document.createElementNS = (namespace, tagName) => ({ tagName, attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); } });
highlightApp._ensureRefOverlay = () => referenceOverlay;
const overlayBody = source.match(/    _drawRefOverlay\(compId, withTether\) \{([\s\S]*?)\n    \}/);
assert.ok(overlayBody);
const drawRefOverlay = new Function(
    'placementTransform', 'isPcbSelected', 'connectBoxOutlines', 'applyTextConnectionGuide',
    `return function(compId, withTether) {${overlayBody[1]}\n};`,
)(() => 'translate(10,20)', isPcbSelected, connectBoxOutlines, applyTextConnectionGuide);
drawRefOverlay.call(highlightApp, 'ref', false);
assert.equal(referenceOverlay.children.length, 1, 'Reference selection retains only the associated component outline');
assert.equal(referenceOverlay.children[0].attributes.class, 'pcb-ref-component-outline');
assert.equal(referenceOverlay.children[0].attributes.fill, 'none');
assert.equal(referenceOverlay.children.some(child => child.tagName === 'polygon'), false, 'No reference selection box is drawn');
drawRefOverlay.call(highlightApp, 'ref', true);
const pcbGuide = referenceOverlay.children.find(child => child.tagName === 'line');
assert.ok(pcbGuide, 'PCB reference overlay includes its connection guide while dragging');
near(pcbGuide.attributes.x1, 0);
near(pcbGuide.attributes.y1, -4);
near(pcbGuide.attributes.x2, 0);
near(pcbGuide.attributes.y2, -1);
drawRefOverlay.call(highlightApp, null, false);
assert.equal(referenceOverlay.children.length, 0);
console.log('PASS: PCB references use silk selection colors, restore on deselection, and draw no reference box');