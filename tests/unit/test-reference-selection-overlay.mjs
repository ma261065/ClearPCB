import assert from 'node:assert/strict';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { connectBoxOutlines, connectPointToBoxOutline } from '../../src/core/geometry.js';
import { getTextEditBoxWorldCorners, setTextEditElementProvider } from '../../src/core/text-edit-geometry.js';
import { clearPcbSelection, setPcbSelection, togglePcbSelection }
    from '../../src/pcb/modules/selection-registry.js';
import '../../src/pcb/modules/component-selection.js';
import { drawRefOverlay, refreshRefHighlight, tryEditReferenceAt } from '../../src/pcb/modules/ref-text-selection.js';
import { activeTextInlineEdit } from '../../src/pcb/modules/text-inline-edit.js';
import { setPcbInteraction } from '../../src/pcb/modules/pcb-interactions.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

const near = (actual, expected) => assert.ok(Math.abs(Number(actual) - expected) < 1e-9,
    `Expected ${actual} to equal ${expected}`);

const document = installFakeDom();
const svgElement = (tagName = 'g') => {
    const el = fakeElement(tagName);
    const attributes = {};
    const setAttribute = el.setAttribute.bind(el);
    const removeAttribute = el.removeAttribute.bind(el);
    const appendChild = el.appendChild.bind(el);
    const removeChild = el.removeChild.bind(el);
    el.attributes = attributes;
    Object.defineProperty(el, 'isConnected', { value: false, writable: true, configurable: true });
    el.setAttribute = (key, value) => { attributes[key] = String(value); setAttribute(key, value); };
    el.removeAttribute = key => { delete attributes[key]; removeAttribute(key); };
    el.appendChild = child => {
        const appended = appendChild(child);
        Object.defineProperty(child, 'isConnected', { value: true, writable: true, configurable: true });
        return appended;
    };
    el.removeChild = child => {
        const removed = removeChild(child);
        Object.defineProperty(child, 'isConnected', { value: false, writable: true, configurable: true });
        return removed;
    };
    return el;
};
document.createElementNS = (_namespace, tagName) => svgElement(tagName);
const refEl = () => ({ isConnected: true, attributes: { 'data-ref-anchor-y': '0', 'data-ref-cy': '0' },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; } });
const placement = { x: 10, y: 20, refDx: 0, refDy: 0, side: 'top',
    bounds: { x: 0, y: 0, width: 10, height: 8 }, _refEl: refEl(),
    _refBox: { bx: -1, by: -1, bw: 2, bh: 2, cx: 0, cy: 0 },
    elements: [{ classList: { toggle() {} } }] };
const placement2 = { x: 30, y: 40, refDx: 2, refDy: 3, side: 'top',
    bounds: { x: 20, y: 0, width: 10, height: 8 }, _refEl: refEl(),
    _refBox: { bx: -1, by: -1, bw: 2, bh: 2, cx: 0, cy: 0 },
    elements: [{ classList: { toggle() {} } }] };
const overlayHost = svgElement();
const app = {
    placements: new Map([['U1', placement], ['U2', placement2]]),
    viewport: { scale: 10, addContent: node => overlayHost.appendChild(node),
        getVisibleBounds: () => ({ minX: -100, minY: -100, maxX: 100, maxY: 100 }) },
    // The editor's presentation seam (PCBApp.drawRefOverlay), drawing the real overlay.
    drawRefOverlay(compId, withTether) { drawRefOverlay(this, compId, withTether); },
};
const select = (kind, object) => setPcbSelection(app, [{ kind, object }]);
const overlayChildren = () => overlayHost.children[0]?.children || [];
const componentOutline = () => overlayChildren().find(child =>
    child.getAttribute?.('class') === 'pcb-ref-component-outline');
const guideLine = () => overlayChildren().find(child => child.tagName === 'line');
function assertOverlayFor(componentId, expected) {
    const outline = componentOutline();
    assert.ok(outline, `${componentId}: overlay includes the component outline`);
    assert.equal(outline.getAttribute('transform'), expected.transform);
    assert.equal(outline.getAttribute('x'), String(expected.bounds.x));
    assert.equal(outline.getAttribute('y'), String(expected.bounds.y));
    assert.equal(outline.getAttribute('width'), String(expected.bounds.width));
    assert.equal(outline.getAttribute('height'), String(expected.bounds.height));
    const guide = guideLine();
    assert.ok(guide, `${componentId}: overlay includes the reference tether`);
    near(Number(guide.getAttribute('x1')), expected.guide.x1);
    near(Number(guide.getAttribute('y1')), expected.guide.y1);
    near(Number(guide.getAttribute('x2')), expected.guide.x2);
    near(Number(guide.getAttribute('y2')), expected.guide.y2);
}

select('component', 'U1');
assert.equal(overlayHost.children.length, 0, 'Component selection must not create a reference overlay');
select('reftext', 'U1');
placement.refDx = 5;
placement.refDy = -3;
drawRefOverlay(app, 'U1', false);
assertOverlayFor('U1', {
    transform: 'translate(10, 20)',
    bounds: placement.bounds,
    guide: { x1: 15, y1: 17.9, x2: 15, y2: 20 },
});
select('component', 'U1');
assert.deepEqual(overlayChildren(), [], 'Selecting the component must remove its old reference box');
placement.x += 10;
placement.y += 5;
assert.deepEqual(overlayChildren(), [], 'No stale reference box should remain during component movement');

select('reftext', 'U1');
assertOverlayFor('U1', {
    transform: 'translate(20, 25)',
    bounds: placement.bounds,
    guide: { x1: 25, y1: 22.9, x2: 25, y2: 25 },
});
select('reftext', 'U2');
assertOverlayFor('U2', {
    transform: 'translate(30, 40)',
    bounds: placement2.bounds,
    guide: { x1: 32.135, y1: 42.89402989130435, x2: 50, y2: 43.75815217391305 },
});
togglePcbSelection(app, 'reftext', 'U2');
assert.deepEqual(overlayChildren(), [], 'Ctrl deselection must clear the reference overlay');

select('reftext', 'U1');
togglePcbSelection(app, 'component', 'U2');
assertOverlayFor('U1', {
    transform: 'translate(20, 25)',
    bounds: placement.bounds,
    guide: { x1: 25, y1: 22.9, x2: 25, y2: 25 },
});
clearPcbSelection(app);
assert.deepEqual(overlayChildren(), [], 'Clearing multi-selection must clear the reference overlay');
console.log('PASS: moved reference box clears on component selection, retargets across references, and respects additive selection');

globalThis.HTMLElement = class {};
const alerts = [];
const htmlElement = (tagName = 'div') => {
    const el = fakeElement(tagName);
    el.querySelector = () => null;
    return el;
};
document.createElementNS = (_namespace, tagName) => svgElement(tagName);
document.createElement = htmlElement;
document.body.replaceChildren();
const appendToBody = document.body.appendChild.bind(document.body);
document.body.appendChild = overlay => {
    if (overlay.className === 'app-modal-overlay') alerts.push(overlay);
    return appendToBody(overlay);
};
document.body.contains = () => false;
const { ProjectDocument } = await import('../../src/core/ProjectDocument.js');
const { default: SchematicApp } = await import('../../src/ui/SchematicApp.js');
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');
const { idleState } = await import('../../src/schematic/modules/draw-states.js');
const { PCB_LAYERS } = await import('../../src/pcb/modules/layers.js');
const topSilk = PCB_LAYERS.find(layer => layer.id === 'top-silk');
const startReferenceEdit = function startReferenceEdit(worldPos) { return tryEditReferenceAt(this, worldPos); };
const component = { id: 'component-1', reference: 'R1', invalidate() {},
    definition: { name: 'Part' }, symbol: { pins: [{ number: '1' }] },
    refText: { text: 'R1', invalidate() {} } };
const project = new ProjectDocument();
assert.equal(project.getComponentInfo('missing'), null);
assert.deepEqual(project.getNetlist(), []);
assert.match(project.validateComponentReference('missing', 'R3').message, /available/);
assert.throws(() => project.createReferenceRenameCommand('missing', 'R3'), /available/);
const schematic = Object.create(SchematicApp.prototype);
schematic.document = project.schematicDocument;
schematic.components = [component, { id: 'component-2', reference: 'R2' }];
let schematicRenders = 0;
schematic.renderShapes = () => { schematicRenders++; };
project.registerView('schematic', schematic);
const componentApi = {
    getComponentInfo: id => project.getComponentInfo(id),
    validateComponentReference: (id, value) => project.validateComponentReference(id, value),
    createReferenceRenameCommand: (id, value) => project.createReferenceRenameCommand(id, value),
    getNetlist: () => project.getNetlist(),
};
Object.defineProperty(componentApi, 'schematic', {
    get() { assert.fail('PCB component operations must not access the schematic editor'); },
});
Object.defineProperty(window, 'app', {
    get() { assert.fail('PCB component access must use the registered schematic'); },
});
let dirty = false;
const referenceRenders = [], referenceOverlays = [], referencePanels = [];
let referenceRatsnestUpdates = 0, referenceBoardUpdates = 0;
const inlineRefElement = {
    getAttribute(name) {
        return ({
            'data-ref-bx': '-1', 'data-ref-by': '-1', 'data-ref-bw': '2', 'data-ref-bh': '2',
            'data-mx-center': '0', 'data-ref-cy': '0', 'data-ref-anchor-y': '0',
            transform: '',
        })[name] ?? null;
    },
};
const referencePlacement = reference => ({
    reference, side: 'top', x: 10, y: 20, refVisible: true,
    elements: [{ querySelector: () => inlineRefElement }],
});
const editor = {
    project: componentApi,
    placements: new Map([[component.id, referencePlacement('R1')]]),
    history: new CommandHistory({ onChanged() { dirty = true; } }),
    texts: new Map(),
    _hitTestRefText() { return component.id; },
    _startTextInlineEdit(text, point, options) { this.edit = { text, options }; },
    startTextInlineEdit(text, point, options) { this._startTextInlineEdit(text, point, options); },
    rerenderRef(id) { referenceRenders.push(this.placements.get(id)?.reference); },
    drawRefOverlay(id) { referenceOverlays.push(this.placements.get(id)?.reference); },
    showRefProperties(id) { referencePanels.push(this.placements.get(id)?.reference); },
    updateRatsnest() { referenceRatsnestUpdates++; },
    _board3d: { refresh() { referenceBoardUpdates++; } },
    refreshComponent3D() { this._board3d?.refresh?.(); },
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
const beforeRenameRenders = referenceRenders.length, beforeRenameOverlays = referenceOverlays.length;
let editOverlayDestroyed = 0;
setPcbInteraction(editor, '_textEdit', {
    ...editor.edit, originalContent: 'R1', input: { value: 'R2' },
    overlay: { destroy() { editOverlayDestroyed++; } },
});
const activeReferenceEdit = activeTextInlineEdit(editor);
assert.equal(PCBApp.prototype._endTextInlineEdit.call(editor, true), false);
assert.equal(activeTextInlineEdit(editor), activeReferenceEdit, 'Invalid names keep the inline editor open');
assert.equal(editOverlayDestroyed, 0);
assert.equal(editor.history.canUndo(), false);
assert.equal(component.reference, 'R1');
activeTextInlineEdit(editor).input.value = ' R7 ';
PCBApp.prototype._endTextInlineEdit.call(editor, true);
assert.equal(activeTextInlineEdit(editor), null);
assert.equal(editOverlayDestroyed, 1, 'Commit retains inline editing teardown');
assert.deepEqual(referenceRenders.slice(beforeRenameRenders), ['R7'],
    'Rename commit renders only the final reference, never a rollback to the old label');
assert.deepEqual(referenceOverlays.slice(beforeRenameOverlays), ['R7']);
assert.deepEqual(referencePanels, ['R7'], 'The rename command owns the single final properties refresh');
assert.equal(referenceRatsnestUpdates, 1);
assert.equal(referenceBoardUpdates, 1);
assert.equal(component.reference, 'R7');
assert.equal(component.refText.text, 'R7', 'Schematic field text follows its component');
assert.equal(editor.netlist[0].net, 'R7.1', 'Reference-derived net names refresh through the project');
assert.equal(editor.placements.get(component.id).reference, 'R7');
assert.equal(editor.history.undoStack.length, 1, 'One rename creates one PCB undo entry');
assert.equal(editor.history.getUndoDescription(), 'Rename R1 to R7');
assert.equal(dirty, true, 'PCB history marks the combined document dirty');

editor.placements.set(component.id, referencePlacement('R7'));
editor.history.undo();
assert.equal(component.reference, 'R1');
assert.equal(component.refText.text, 'R1');
assert.equal(editor.netlist[0].net, 'R1.1');
assert.equal(editor.placements.get(component.id).reference, 'R1', 'Undo resolves the current placement after a rebuild');
editor.history.redo();
assert.equal(component.reference, 'R7');
assert.equal(component.refText.text, 'R7');
assert.equal(editor.placements.get(component.id).reference, 'R7');
assert.deepEqual(referencePanels, ['R7', 'R1', 'R7'], 'Undo/redo each refresh the properties panel once');
assert.equal(referenceRatsnestUpdates, 3);
assert.equal(referenceBoardUpdates, 3);
startReferenceEdit.call(editor, { x: 10, y: 20 });
editor.edit.text.content = 'R99';
editor.edit.options.render();
editor.edit.options.finish('R99', false);
assert.equal(component.reference, 'R7');
assert.equal(editor.placements.get(component.id).reference, 'R7', 'Cancel restores the PCB preview');
assert.equal(editor.history.undoStack.length, 1, 'Cancel creates no history entry');
assert.equal(referenceRenders.at(-1), 'R7');
assert.equal(referencePanels.length, 4, 'Cancel restores the properties panel once');
assert.equal(referenceRatsnestUpdates, 3, 'Cancel does not rebuild the netlist presentation');
assert.equal(referenceBoardUpdates, 3);
startReferenceEdit.call(editor, { x: 10, y: 20 });
editor.edit.text.content = ' R7 ';
editor.edit.options.render();
editor.edit.options.finish(' R7 ', true);
assert.equal(editor.placements.get(component.id).reference, 'R7', 'No-op commits discard whitespace-only previews');
assert.equal(editor.history.undoStack.length, 1);
assert.equal(referencePanels.length, 5);
assert.equal(referenceRatsnestUpdates, 3);
assert.equal(referenceBoardUpdates, 3);
topSilk.locked = true;
assert.equal(startReferenceEdit.call(editor, { x: 10, y: 20 }), false, 'A locked silk layer blocks reference editing');
topSilk.locked = false;
topSilk.visible = false;
assert.equal(startReferenceEdit.call(editor, { x: 10, y: 20 }), false, 'A hidden silk layer blocks reference editing');
topSilk.visible = true;
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
    startTextEdit(shape) { startedEdit = shape; },
    setTextEditCaretFromScreen(point) { caretScreenPos = point; },
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

const { getLabelGuideElement, updateLabelGuide } = await import('../../src/schematic/modules/label-attachment.js');
setTextEditElementProvider(shape => shape?.element || null);
const guideLayer = { children: [], appendChild(child) {
    child.remove();
    this.children.push(child);
} };
document.createElementNS = (_namespace, tagName) => {
    const el = svgElement(tagName);
    el.remove = () => { guideLayer.children = guideLayer.children.filter(child => child !== el); };
    return el;
};
for (const rotation of [0, 37, 90]) for (const mirrored of [false, true]) {
    const local = { minX: mirrored ? -5 : -3, maxX: mirrored ? 3 : 5, minY: -2, maxY: 2 };
    const parent = { x: 20, y: 30, rotation, _getLocalBounds: () => local };
    const angle = rotation * Math.PI / 180;
    const toWorld = (x, y) => ({ x: parent.x + x * Math.cos(angle) - y * Math.sin(angle),
        y: parent.y + x * Math.sin(angle) + y * Math.cos(angle) });
    let center = toWorld(12, 0);
    const reference = { type: 'text', parentComponent: parent,
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
    const firstGuide = getLabelGuideElement(guideApp);
    const componentBox = [
        toWorld(local.minX - 0.5, local.minY - 0.5), toWorld(local.maxX + 0.5, local.minY - 0.5),
        toWorld(local.maxX + 0.5, local.maxY + 0.5), toWorld(local.minX - 0.5, local.maxY + 0.5),
    ];
    const textBox = getTextEditBoxWorldCorners(reference);
    near(textBox[0].x, center.x - 1.8);
    near(textBox[0].y, center.y - 1.8);
    near(textBox[2].x, center.x + 1.8);
    near(textBox[2].y, center.y + 1.8);
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
    assert.equal(getLabelGuideElement(guideApp), firstGuide, 'Dragging reuses the single guide');
    const movedTextBox = getTextEditBoxWorldCorners(reference);
    const movedConnection = connectBoxOutlines(componentBox, movedTextBox);
    near(firstGuide.attributes.x1, movedConnection.end.x);
    near(firstGuide.attributes.y1, movedConnection.end.y);
    near(firstGuide.attributes.x2, movedConnection.start.x);
    near(firstGuide.attributes.y2, movedConnection.start.y);
    assert.equal(guideLayer.children.length, 1, 'Live updates never create a duplicate line');

    center = toWorld((local.minX + local.maxX) / 2, 0);
    updateLabelGuide(guideApp);
    assert.equal(getLabelGuideElement(guideApp), null, 'Reference inside the outline needs no connection');
    center = toWorld(12, 0);
    selected = [];
    guideApp.textEdit = { shape: reference };
    updateLabelGuide(guideApp);
    assert.ok(getLabelGuideElement(guideApp), 'Inline editing uses the same renderer');
    guideApp.textEdit = null;
    updateLabelGuide(guideApp);
    assert.equal(guideLayer.children.length, 0, 'Deselecting clears the guide');

    // The value leads from the component outline too, never from its centre.
    let valueCenter = toWorld(-12, 0);
    const value = { type: 'text', parentComponent: parent, textAnchor: 'middle', fontSize: 2, rotation: 0,
        get x() { return valueCenter.x; }, get y() { return valueCenter.y; },
        element: {
            getBBox() { return { x: valueCenter.x - 1, y: valueCenter.y - 1, width: 2, height: 2 }; },
            getAttribute(name) { return name === 'y' ? String(valueCenter.y) : null; },
        } };
    parent.valueText = value;
    selected = [value];
    updateLabelGuide(guideApp);
    const valueConnection = connectBoxOutlines(componentBox, getTextEditBoxWorldCorners(value));
    const valueGuide = getLabelGuideElement(guideApp);
    near(valueGuide.attributes.x2, valueConnection.start.x);
    near(valueGuide.attributes.y2, valueConnection.start.y);
    near(valueGuide.attributes.x1, valueConnection.end.x);
    near(valueGuide.attributes.y1, valueConnection.end.y);
    assert.ok(Math.hypot(Number(valueGuide.attributes.x2) - parent.x,
        Number(valueGuide.attributes.y2) - parent.y) > 1, 'The value guide starts on the outline, not the centre');
    valueCenter = toWorld(12, 0);
    selected = [];
    updateLabelGuide(guideApp);
}

let renderedX = 10;
const renderReference = { id: 'schematic-reference', type: 'text',
    textAnchor: 'middle', get x() { return renderedX; }, y: 0,
    element: {
        getBBox() { return { x: renderedX - 1, y: -1, width: 2, height: 2 }; },
        getAttribute(name) { return name === 'y' ? String(renderReference.y) : null; },
    } };
renderReference.parentComponent = { x: 0, y: 0, rotation: 0, refText: renderReference,
    _getLocalBounds: () => ({ minX: -2, maxX: 2, minY: -2, maxY: 2 }) };
const renderApp = { shapes: [renderReference], components: [],
    selection: { getSelection: () => [renderReference], isSelected: item => item === renderReference, isHovered: () => false },
    viewport: { scale: 10, contentLayer: guideLayer } };
renderedX = 15;
updateLabelGuide(renderApp);
near(getLabelGuideElement(renderApp).attributes.x1, 13.2);
assert.equal(guideLayer.children.length, 1, 'Post-render hook draws exactly one guide using current text geometry');
for (const textAnchor of ['start', 'middle', 'end']) for (const rotation of [0, 37, 90, 270]) {
    Object.assign(renderReference, { text: 'R123', fontSize: 2, textAnchor, rotation, y: 8 });
    updateLabelGuide(renderApp);
    const renderGuide = getLabelGuideElement(renderApp);
    assert.ok(Math.hypot(Number(renderGuide.attributes.x1) - renderedX,
        Number(renderGuide.attributes.y1) - 8) > 0.1,
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
const netGuide = getLabelGuideElement(netGuideApp);
near(netGuide.attributes.x1, netConnection.end.x);
near(netGuide.attributes.y1, netConnection.end.y);
near(netGuide.attributes.x2, 0);
near(netGuide.attributes.y2, 0);
assert.notEqual(Number(netGuide.attributes.x1), netLabel.x,
    'Net-label guide must stop at the visible edit box, not the text anchor');
console.log('PASS: net-label guide clips to the shared edit-box boundary');

const { textColorForLayer } = await import('../../src/pcb/modules/pcb-text.js');
let theme = 'dark';
document.documentElement = { getAttribute() { return theme; } };
const refElement = { attributes: { 'data-ref-anchor-y': '-5', 'data-ref-cy': '-1.5' },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; } };
const highlightPlacement = { x: 0, y: 0, side: 'top', reference: 'R1', _refEl: refElement,
    _refBox: { bx: -1, by: -2, bw: 2, bh: 1, cx: 0, cy: -1.5 },
    refDx: 0, refDy: -30, refSize: 1.2, refStrokeWidth: 0.15,
    bounds: { x: 20, y: 0, width: 4, height: 2 } };
refElement.isConnected = true;
const highlightApp = { placements: new Map([['ref', highlightPlacement]]),
    viewport: { addContent(node) {
        Object.defineProperty(node, 'isConnected', { value: true, writable: true, configurable: true });
        this.overlay = node;
    } } };
document.createElementNS = (_namespace, tagName) => svgElement(tagName);
setPcbSelection(highlightApp, [{ kind: 'reftext', object: 'ref' }]);
assert.equal(refElement.attributes.stroke, '#ffffff', 'Selected reference matches silk text in dark theme');
theme = 'light';
refreshRefHighlight(highlightApp, 'ref');
assert.equal(refElement.attributes.stroke, '#000000', 'Selected reference matches silk text in light theme');
clearPcbSelection(highlightApp);
assert.equal(refElement.attributes.stroke, textColorForLayer('top-silk'), 'Deselecting restores the silk color');
highlightPlacement.side = 'bottom';
refreshRefHighlight(highlightApp, 'ref');
assert.equal(refElement.attributes.stroke, textColorForLayer('bottom-silk'));

drawRefOverlay(highlightApp, 'ref', false);
const referenceOverlay = highlightApp.viewport.overlay;
assert.equal(referenceOverlay.children.length, 1, 'Reference selection retains only the associated component outline');
assert.equal(referenceOverlay.children[0].attributes.class, 'pcb-ref-component-outline');
assert.equal(referenceOverlay.children[0].attributes.fill, 'none');
assert.equal(referenceOverlay.children.some(child => child.tagName === 'polygon'), false, 'No reference selection box is drawn');
drawRefOverlay(highlightApp, 'ref', true);
const pcbGuide = referenceOverlay.children.find(child => child.tagName === 'line');
assert.ok(pcbGuide, 'PCB reference overlay includes its connection guide while dragging');
near(pcbGuide.attributes.x1, -0.821576763485478);
near(pcbGuide.attributes.y1, -33.8);
near(pcbGuide.attributes.x2, -21.391424619640386);
near(pcbGuide.attributes.y2, 0);
drawRefOverlay(highlightApp, null, false);
assert.equal(referenceOverlay.children.length, 0);
console.log('PASS: PCB references use silk selection colors, restore on deselection, and draw no reference box');

const { debugTooltipState, updateDebugTooltip } = await import('../../src/pcb/modules/debug-tooltip.js');
component.definition = { footprintShapes: ['PAD~owned-footprint'] };
const inspectorText = { value: '' };
const inspector = {
    project: componentApi,
    viewport: { svg: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
        screenToWorld: () => ({ x: 0, y: 0 }) },
    placements: new Map([[component.id, { pads: new Map([['1', { x: 0, y: 0 }]]) }]]),
};
Object.assign(debugTooltipState(inspector), {
    enabled: true,
    element: { dataset: {}, style: {}, offsetWidth: 100, offsetHeight: 100, querySelector: () => inspectorText },
});
window.innerWidth = window.innerHeight = 800;
updateDebugTooltip(inspector, { clientX: 10, clientY: 10 });
assert.equal(inspectorText.value, 'PAD~owned-footprint');
assert.equal(debugTooltipState(inspector).element.style.display, 'block');
{
    const { toggleDebugTooltipPin } = await import('../../src/pcb/modules/debug-tooltip.js');
    const tooltip = debugTooltipState(inspector);
    assert.equal(toggleDebugTooltipPin(inspector), true, 'A right press over the visible tooltip pins it');
    assert.equal(tooltip.pinned, true);
    tooltip.element.style.left = 'pinned';
    updateDebugTooltip(inspector, { clientX: 300, clientY: 300 });
    assert.equal(tooltip.element.style.left, 'pinned', 'A pinned tooltip does not follow the pointer');
    assert.equal(toggleDebugTooltipPin(inspector), true, 'A second right press hides the pinned tooltip');
    assert.deepEqual([tooltip.pinned, tooltip.visible, tooltip.element.style.display], [false, false, 'none']);
    assert.equal(toggleDebugTooltipPin(inspector), false, 'A hidden tooltip leaves right presses to panning');
    assert.equal(toggleDebugTooltipPin({}), false, 'Editors without a tooltip ignore right presses');
}
const info = project.getComponentInfo(component.id);
info.reference = 'NOT-A-RENAME';
info.footprintShapes.push('NOT-MODEL-DATA');
assert.equal(component.reference, 'R7');
assert.deepEqual(component.definition.footprintShapes, ['PAD~owned-footprint'], 'Queries do not expose mutable model data');
component.locked = false;
assert.throws(() => project.createReferenceRenameCommand(component.id, ' r2 '), /already used/);
assert.throws(() => project.createReferenceRenameCommand(component.id, ' '), /blank/);
assert.throws(() => project.createReferenceRenameCommand('missing', 'R3'), /available/);
component.locked = true;
assert.throws(() => project.createReferenceRenameCommand(component.id, 'R3'), /locked/);
component.locked = false;
const rename = project.createReferenceRenameCommand(component.id, ' R3 ');
assert.equal(component.reference, 'R7', 'Creating a command does not execute or record it');
assert.deepEqual(Object.keys(rename).sort(), ['execute', 'undo'], 'Command exposes no editor/model implementation');
rename.execute();
assert.equal(component.reference, 'R3');
const rendersAfterRename = schematicRenders;
rename.undo();
assert.equal(component.reference, 'R7');
assert.equal(schematicRenders, rendersAfterRename + 1, 'Project undo refreshes the registered editor');
assert.equal(schematic.components, project.schematicDocument.components, 'Editor aliases authoritative model state');

const { loadDocument } = await import('../../src/schematic/modules/files.js');
const { renderShape } = await import('../../src/schematic/render/shape-renderer.js');
const { viewOf, componentViewOf } = await import('../../src/schematic/render/shape-view-state.js');
const { SchematicDocument } = await import('../../src/core/SchematicDocument.js');
const loadedModel = new SchematicDocument();
const loadInput = { type: 'clearpcb-project', version: '1.0', schematic: {
    components: [{ type: 'component', id: 'comp_800', dn: 'Resistor', x: 0, y: 0, ref: 'R8', val: '10k' }],
    shapes: [{ type: 'text', id: 'shape_800', x: 0, y: -2, t: 'R8', cid: 'comp_800', fk: 'reference' }],
} };
const prepared = loadedModel.prepare(loadInput);
const loadedField = prepared.shapes[0].shape;
const loadedComponent = prepared.components[0];
const attached = [];
document.createElementNS = (_namespace, tagName) => Object.assign(svgElement(tagName), {
    getBBox() { return { x: 0, y: -2, width: 4, height: 2 }; },
});
const fieldElement = renderShape(loadedField, 1);
const loadingEditor = Object.create(SchematicApp.prototype);
Object.assign(loadingEditor, {
    document: loadedModel, selection: { clearSelection() {} },
    viewport: { scale: 1, addContent: element => attached.push(element),
        addComponentContent: element => attached.push(element) },
    history: { clear() {} },
    updateSelectableItems() {}, renderShapes() {},
});
await loadDocument(loadingEditor, loadInput, prepared);
assert.equal(loadingEditor.components[0], loadedComponent, 'Editor load adopts prepared model instances');
assert.equal(loadingEditor.shapes[0], loadedField);
assert.equal(loadedComponent.refText, loadedField);
assert.deepEqual(attached, [fieldElement, componentViewOf(loadedComponent).element], 'Editor alone attaches loaded SVG');
assert.equal(viewOf(loadedField).element, fieldElement);
loadingEditor.shapes = [];
loadingEditor.components = [];
assert.deepEqual(loadedModel.shapes, [], 'Editor clearing replaces the authoritative collections');
assert.deepEqual(loadedModel.components, []);
console.log('PASS: editor load and clear use the project-owned collections without copying entities');