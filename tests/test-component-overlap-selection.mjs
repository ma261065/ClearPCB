import assert from 'node:assert/strict';
import { Component } from '../src/components/Component.js';
import { SelectionManager } from '../src/core/SelectionManager.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { createRect } from '../src/shapes/polyline.js';

const frames = new Map();
let frameId = 0;
const schematicTip = { hidden: true, textContent: '' };
globalThis.window = { addEventListener() {} };
globalThis.HTMLElement = class {};
globalThis.document = {
    getElementById: id => id === 'schematicStatusTip' ? schematicTip : null,
    querySelector: () => null,
    createElementNS: () => ({ setAttribute() {}, appendChild() {}, remove() {}, style: {} }),
};
globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
const flushFrames = () => {
    const queued = [...frames.values()];
    frames.clear();
    for (const callback of queued) callback();
};

const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { default: SchematicApp } = await import('../src/ui/SchematicApp.js');
const { beginSelectionInteraction, finishSelectionInteraction, updateSelectionInteraction }
    = await import('../src/pcb/modules/selection-interaction.js');
const { getPcbSelectionHits, getPcbSelectionEntries, setPcbSelection, syncPcbSelection }
    = await import('../src/pcb/modules/selection-registry.js');
const { pointInBoxSelection } = await import('../src/pcb/modules/box-select.js');
const { PCB_LAYERS } = await import('../src/pcb/modules/layers.js');
const { idleState, overlapCycleState, moveDragState } = await import('../src/schematic/modules/draw-states.js');
const { updateSelectableItems } = await import('../src/schematic/modules/components.js');
const { setupCallbacks } = await import('../src/schematic/modules/callbacks.js');

const point = { x: 0, y: 0 };
const definition = { name: 'Overlap', symbol: {
    graphics: [{ type: 'rect', x: -10, y: -10, width: 20, height: 20 }], pins: [],
} };
const component = id => new Component(definition, { id, showReference: false, showValue: false });
const boardShape = () => ({ id: 'shape', kind: 'rect', layer: 'top-silk', filled: true,
    lineWidth: 0.2, points: [{ x: -10, y: -10 }, { x: 10, y: -10 },
        { x: 10, y: 10 }, { x: -10, y: 10 }] });

function pcbFixture(withShape = false) {
    const project = new ProjectDocument();
    project.schematicDocument.components.push(component('below'), component('top'), component('other'));
    const placement = (x = 0) => ({ x, y: 0, rotation: 0, side: 'top', mirror: false,
        bounds: { x: -10, y: -10, width: 20, height: 20 }, refVisible: false,
        padOffsets: [], pads: new Map(), elements: [] });
    const app = {
        project, pcbDocument: project.pcbDocument, history: new CommandHistory(),
        placements: new Map([['below', placement()], ['top', placement()], ['other', placement(100)]]),
        tracks: [], vias: [], pads: [], boardShapes: withShape ? [boardShape()] : [], texts: new Map(),
        _shapeElements: new Map(), _active: true, currentTool: 'select', activeLayer: 'top-copper',
        viewport: { scale: 10, svg: { style: {} }, snapToGrid: false, hideCrosshair() {} },
        status: { modeStatus: {}, tipStatus: { hidden: true, textContent: '' } },
        getLayerGroup: () => null, _selectComponent() {}, _selectBoardOutline() {},
        selectText() {}, _selectRefText() {}, selectFill() {}, clearProperties() {},
        _showPcbMultiSelectionProperties() {}, _hoverComponent(id) { this.hoveredComponent = id; },
        _hideNetTooltip() {}, updateRatsnest() {}, _netsForComponent: () => new Set(),
        _markDirty() {}, _updatePcbCulling() {}, refreshClearanceHalos() {},
        _hitTestBoardOutline: () => false, _hoverBoardOutline() {},
        _hitTestPad: () => null, _updateNetTooltip() {}, _hitTestText: () => null,
        _hitTestRefText: () => null, _setTextHover() {},
        _screenToWorld: event => ({ x: event.clientX, y: event.clientY }),
    };
    for (const name of ['_hitTestComponent', '_worldToPlacementLocal', '_beginComponentDrag',
        '_updateComponentDrag', '_endDrag', '_snapToGrid', 'setPcbStatus', '_scheduleHoverUpdate']) {
        app[name] = PCBApp.prototype[name];
    }
    syncPcbSelection(app);
    return app;
}

const selectedPcb = app => getPcbSelectionEntries(app).map(entry => entry.object);
function cyclePcb(app, additive = false) {
    assert.equal(beginSelectionInteraction(app, point, additive, true), true);
    finishSelectionInteraction(app, true);
}

for (const withShape of [false, true]) {
    const app = pcbFixture(withShape);
    const expected = withShape ? [app.boardShapes[0], 'top', 'below'] : ['top', 'below'];
    assert.equal(app._hitTestComponent(point), 'top', 'Legacy single-hit callers retain topmost ordering');
    assert.deepEqual(app._hitTestComponent(point, true), ['top', 'below']);
    assert.deepEqual(getPcbSelectionHits(app, point).map(hit => hit.object), expected);
    for (const target of [...expected, expected[0]]) {
        cyclePcb(app);
        assert.deepEqual(selectedPcb(app), [target], 'Cycling includes all components and preserves shape priority');
    }
    setPcbSelection(app, [{ kind: 'component', object: 'top' }, { kind: 'component', object: 'other' }]);
    cyclePcb(app, true);
    assert.deepEqual(new Set(selectedPcb(app)), new Set(['below', 'other']),
        'Ctrl+Shift replaces only the selected overlap member');
    assert.equal(pointInBoxSelection(app, point), true, 'An obscured component can pick up a multi-selection');
    assert.equal(beginSelectionInteraction(app, point, false), false, 'Multi-selection still uses group movement');
    setPcbSelection(app, [{ kind: 'component', object: 'below' }]);
    app.placements.get('below').locked = true;
    beginSelectionInteraction(app, point, false);
    assert.deepEqual(selectedPcb(app), ['below']);
    assert.equal(app._pcbSelectionInteraction, null, 'Locked obscured components remain selectable but cannot move');
    assert.equal(app._drag, undefined);
    app.placements.get('below').locked = false;
    beginSelectionInteraction(app, point, true);
    assert.ok(selectedPcb(app).includes(expected[0]), 'Ctrl still toggles the top-priority hit');
    setPcbSelection(app, [{ kind: 'component', object: 'below' }]);
    cyclePcb(app);
    assert.deepEqual(selectedPcb(app), [expected[0]], 'Cycling wraps after the bottom component');
}

for (const withShape of [false, true]) for (const shiftDrag of [false, true]) {
    const app = pcbFixture(withShape);
    setPcbSelection(app, [{ kind: 'component', object: 'top' }]);
    cyclePcb(app);
    assert.deepEqual(selectedPcb(app), ['below']);
    assert.equal(beginSelectionInteraction(app, point, false, shiftDrag), true);
    updateSelectionInteraction(app, { x: 30, y: 0 });
    assert.equal(app._drag.compId, 'below', 'Pickup retains the selected component beneath the stack');
    assert.equal(app.placements.get('below').x, 30, 'Real component drag moves the obscured placement');
    assert.equal(app.placements.get('top').x, 0, 'The covering component stays still');
    finishSelectionInteraction(app, true);
    assert.equal(app.history.undoStack.length, 1);
    app.history.undo();
    assert.equal(app.placements.get('below').x, 0, 'The chosen component movement is undoable');
    app.history.redo();
    assert.equal(app.placements.get('below').x, 30);
}

{
    const app = pcbFixture(true);
    const silk = PCB_LAYERS.find(layer => layer.id === 'top-silk');
    const wasVisible = silk.visible;
    try {
        silk.visible = false;
        assert.deepEqual(getPcbSelectionHits(app, point).map(hit => hit.object), ['top', 'below'],
            'Hidden shapes do not enter the component overlap cycle');
    } finally {
        silk.visible = wasVisible;
    }
    setPcbSelection(app, [{ kind: 'component', object: 'below' }]);
    const entry = getPcbSelectionEntries(app)[0];
    const anchor = entry.getAnchors()[0];
    assert.equal(beginSelectionInteraction(app, anchor, false), true);
    assert.equal(app._pcbSelectionInteraction.mode, 'anchor', 'Selected component rotation anchors retain priority');
    finishSelectionInteraction(app, false);
}

{
    const app = pcbFixture();
    for (const placement of app.placements.values()) {
        placement.rotation = 90;
        placement.mirror = true;
        placement.side = 'bottom';
        placement.bounds = { x: -8, y: -2, width: 16, height: 4 };
    }
    assert.deepEqual(getPcbSelectionHits(app, { x: 0, y: 6 }).map(hit => hit.object), ['top', 'below']);
    assert.deepEqual(getPcbSelectionHits(app, { x: 6, y: 0 }), [],
        'Overlap membership uses transformed geometry, not only its broad bounds');
    for (const id of ['below', 'top']) {
        const placement = app.placements.get(id);
        delete placement.bounds;
        placement.padOffsets = [{ padId: '1', width: 2, height: 2 }];
        placement.pads.set('1', { x: 8, y: 4 });
    }
    assert.deepEqual(getPcbSelectionHits(app, { x: 8, y: 4 }).map(hit => hit.object), ['top', 'below'],
        'Footprints with pad-only fallback extents participate in cycling away from their origin');
}

{
    const app = pcbFixture();
    setPcbSelection(app, [{ kind: 'component', object: 'below' }]);
    app._scheduleHoverUpdate({ clientX: 0, clientY: 0 });
    flushFrames();
    assert.equal(app._overlapHitCount, 2);
    assert.match(app.status.tipStatus.textContent, /Shift\+Click/);
    assert.equal(app.status.tipStatus.hidden, false);
    assert.equal(app.hoveredComponent, 'below', 'Hover follows the component that will be dragged');
    assert.equal(app.viewport.svg.style.cursor, 'move');
    app._scheduleHoverUpdate({ clientX: 100, clientY: 0 });
    flushFrames();
    assert.equal(app._overlapHitCount, 1);
    assert.equal(app.status.tipStatus.hidden, true, 'PCB tip disappears away from overlaps');
    app._overlapHitCount = 2;
    app.currentTool = 'pan';
    app.setPcbStatus();
    assert.equal(app.status.tipStatus.hidden, true, 'PCB overlap tip is select-tool-only');
}

function schematicFixture(withShape = false) {
    const app = {
        components: [component('below'), component('top'), component('other')],
        shapes: withShape ? [createRect({ id: 'shape', x: -10, y: -10, width: 20, height: 20, fill: true })] : [],
        selection: new SelectionManager({ getScale: () => 10 }),
        interactionState: 'idle', currentTool: 'select', renderShapes() {},
        viewport: { scale: 10, svg: { style: {} }, getSnappedPosition: point => ({ ...point }),
            formatValue: value => String(value), layers: new Map() },
        ui: {}, eventBus: { on() {} }, fileManager: { setDirty() {} },
        updateShapeSelectionTip: SchematicApp.prototype.updateShapeSelectionTip,
    };
    app.components[2].x = 100;
    updateSelectableItems(app);
    setupCallbacks(app);
    return app;
}
const positions = p => ({ worldPos: p, snapped: p, screenPos: { x: p.x * 10, y: p.y * 10 } });
const event = modifiers => ({ button: 0, preventDefault() {}, ...modifiers });
function cycleSchematic(app, additive = false) {
    idleState.mousedown(app, event({ shiftKey: true, ctrlKey: additive }), positions(point));
    overlapCycleState.mouseup(app, event(), positions(point));
}

for (const withShape of [false, true]) {
    const app = schematicFixture(withShape);
    const expected = withShape ? [app.shapes[0], app.components[1], app.components[0]] : [app.components[1], app.components[0]];
    assert.deepEqual(app.selection.hitTest(point, true), expected);
    for (const target of [...expected, expected[0]]) {
        cycleSchematic(app);
        assert.deepEqual(app.selection.getSelection(), [target]);
    }
    app.selection.selectMultiple([app.components[1], app.components[2]]);
    cycleSchematic(app, true);
    assert.deepEqual(new Set(app.selection.getSelection()), new Set([app.components[0], app.components[2]]));
    app.selection.select(app.components[0], false);
    idleState.mousedown(app, event(), positions(point));
    assert.equal(app.interactionState, 'moveDrag');
    moveDragState.mousemove(app, event(), positions({ x: 30, y: 0 }));
    assert.equal(app.components[0].x, 30, 'Real schematic Component beneath the stack moves');
    assert.equal(app.components[1].x, 0);
}

{
    const app = schematicFixture();
    app.viewport.onMouseMove(point, point);
    flushFrames();
    assert.equal(app._overlapHitCount, 2);
    assert.equal(schematicTip.hidden, false);
    assert.match(schematicTip.textContent, /Shift\+Click/);
    app.viewport.onMouseMove({ x: 100, y: 0 }, { x: 100, y: 0 });
    flushFrames();
    assert.equal(schematicTip.hidden, true, 'Schematic overlap tip disappears at a single component');
    app._overlapHitCount = 2;
    app.currentTool = 'pan';
    app.updateShapeSelectionTip();
    assert.equal(schematicTip.hidden, true);
    app.currentTool = 'select';
    app.components[1].visible = false;
    app.selection._invalidateHitTestCache();
    cycleSchematic(app);
    assert.deepEqual(app.selection.getSelection(), [app.components[0]], 'Hidden components are excluded');
    app.components[0].locked = true;
    idleState.mousedown(app, event(), positions(point));
    assert.equal(app.interactionState, 'idle', 'Locked selected schematic components do not start a drag');
}

console.log('PASS: actual PCB/schematic component overlap order, additive cycling, hidden/locked/anchor precedence, obscured drag/undo, transformed and pad fallback hits, hover and status tips');
