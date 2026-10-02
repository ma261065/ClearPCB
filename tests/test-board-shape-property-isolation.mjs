import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { bulgeRatio } from '../src/core/geometry.js';
import { showBoardShapeProperties, getBoardShapePropertyPreview, getBoardShapeRotationPreview, createBoardShapeSelectionAdapter,
    renderBoardShape, startBoardShapeDrag, handleBoardShapeDrag, endBoardShapeDrag,
    deleteBoardShapeVertex, captureBoardShapeState } from '../src/pcb/modules/board-shapes.js';
import { setPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { cancelPictureCopperRefresh } from '../src/pcb/modules/picture-refresh.js';
import { loadPcb } from '../src/pcb/modules/project-state.js';
import { prepareFabricationSnapshot } from '../src/pcb/modules/fabrication-snapshot.js';
import { PCB_LAYERS } from '../src/pcb/modules/layers.js';
import { beginPcbAnchorInteraction, updateSelectionInteraction, finishSelectionInteraction } from '../src/pcb/modules/selection-interaction.js';

let allocations = 0;
class Element {
    constructor() { allocations++; this.children = []; this.attributes = new Map(); this.style = {}; this.dataset = {}; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
    remove() { this.parentNode?.removeChild(this); }
    querySelectorAll() { return []; }
    querySelector() { return null; }
}
const fields = new Map();
const items = {
    contains(target) { return [...fields.values()].includes(target); },
    set innerHTML(html) {
        if ([...fields.values()].includes(document.activeElement)) document.activeElement = document.body;
        fields.clear();
        for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
            const listeners = new Map();
            const input = {
                value: /\bvalue="([^"]*)"/.exec(match[0])?.[1] || '', style: {}, dataset: {},
                placeholder: /\bplaceholder="([^"]*)"/.exec(match[0])?.[1] || '',
                tagName: match[0].match(/^<(\w+)/)[1].toUpperCase(),
                focus() { document.activeElement = this; },
                matches: selector => selector === 'input[type="number"]',
                get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); },
                addEventListener(name, callback) {
                    if (!listeners.has(name)) listeners.set(name, []);
                    listeners.get(name).push(callback);
                },
                fire(name, options = {}) {
                    for (const callback of [...listeners.get(name) || []]) callback({
                        type: name, preventDefault() {}, stopPropagation() {}, ...options,
                    });
                },
            };
            fields.set(match[1], input);
        }
    },
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = {
    body: { tagName: 'BODY' }, activeElement: null,
    createElementNS: () => new Element(), getElementById: id => fields.get(id) || null,
    querySelector: () => null, querySelectorAll: () => [],
};
globalThis.localStorage = { setItem() {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const cases = [
    ['lineWidth', 'pcbPropShapeLineWidth', 0.8],
    ['segmentWidth', 'pcbPropShapeLineWidth', 0.8],
    ['cornerRadius', 'pcbPropShapeCornerRadius', 2],
    ['nodeRadius', 'pcbPropShapeNodeCornerRadius', 2],
    ['diameter', 'pcbPropShapeDiameter', 9],
    ['arcBulge', 'pcbPropShapeBulge', 0.6],
    ['segmentBulge', 'pcbPropShapeBulge', 0.6],
    ['imageWidth', 'pcbPropImageWidth', 14],
    ['imageHeight', 'pcbPropImageHeight', 14],
    ['imageRotation', 'pcbPropImageRot', 73],
];

function fixture(kind, count = 1, unrelatedCount = 1, shapeLayer = 'top-copper') {
    const project = new ProjectDocument(), model = project.pcbDocument;
    const shapes = Array.from({ length: count }, (_, index) => {
        const shape = { id: shapeLayer === 'board-outline' ? 'board-outline' : `shape-${index}`,
            kind: 'polygon', layer: shapeLayer, lineWidth: 0.23456789,
            points: [{ x: 2, y: 3 }, { x: 12, y: 3 }, { x: 12, y: 9 }, { x: 2, y: 9 }],
            filled: false, cornerRadius: 0.123456789, copperMode: 'add' };
        if (kind === 'diameter') { shape.kind = 'circle'; delete shape.points; Object.assign(shape, { x: 7, y: 6, radius: 3.123456789 }); }
        if (kind === 'arcBulge') {
            shape.kind = 'arc'; delete shape.points;
            Object.assign(shape, { start: { x: 2, y: 3 }, end: { x: 12, y: 3 }, bulge: { x: 7, y: 4.25 } });
        }
        if (kind === 'segmentBulge') shape.segmentBulges = { 0: 0.25 };
        if (kind.startsWith('image')) {
            shape.kind = 'image'; shape.filled = true;
            shape.artwork = { width: 4, height: 2, rectangles: [{ x: 0, y: 0, width: 4, height: 2 }] };
        }
        return shape;
    });
    const unrelated = Array.from({ length: unrelatedCount }, (_, index) => ({
        id: `other-${index}`, kind: 'circle', x: index + 50, y: 50, radius: 2, layer: 'top-silk', lineWidth: 0.2,
    }));
    model.boardShapes.push(...shapes, ...unrelated);
    const group = new Element();
    let pours = 0;
    const app = {
        project, pcbDocument: model, history: new CommandHistory(), placements: new Map(), netlist: [],
        _active: true, _deferDragOverlays: false, _shapeElements: new Map(), _textElements: new Map(), _layerGroups: new Map(),
        viewport: { scale: 100, svg: new Element(), setCrosshair() {}, hideCrosshair() {} },
        getLayerGroup: id => id === 'selection-overlay' ? null : group,
        _pcbPropsItems: () => items, _setActiveRibbonTab() {}, _refreshPcbSelectionHighlights() {},
        refreshFills() { pours++; }, _refreshBoardShapeClearance() {}, _scheduleRemovalHatchRender() {},
        _cancelDrawingMode() {}, _ensureViewport() {}, markSectionClean() {},
    };
    for (const key of ['boardShapes', 'tracks', 'vias', 'pads', 'texts', '_shapeIdCounter']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    for (const key of ['_cancelPosePreviews', 'isSectionEditing', '_setPcbPropsTitle', 'clearProperties',
        '_onLayerLockChanged', '_onLayerVisibilityChanged']) app[key] = PCBApp.prototype[key];
    project.registerView('pcb', app);
    const adapters = shapes.map(shape => createBoardShapeSelectionAdapter(app, shape, shape.id));
    setPcbSelection(app, shapes.map(object => ({ kind: 'shape', object })));
    if (kind === 'segmentWidth' || kind === 'segmentBulge') app._selectedBoardShapeSegment = { shapeId: shapes[0].id, segment: 0 };
    if (kind === 'nodeRadius') app._selectedBoardShapeNode = { shapeId: shapes[0].id, index: 1 };
    shapes.forEach(shape => renderBoardShape(app, shape));
    renderBoardShape(app, unrelated[0]);
    showBoardShapeProperties(app, shapes[0]);
    return { app, model, project, shapes, adapters, group, unrelated, pours: () => pours };
}

{
    const { app, shapes } = fixture('cornerRadius', 1, 1, 'board-outline');
    const outline = shapes[0];
    const kind = fields.get('pcbPropOutlineKind');
    kind.value = 'circle';
    kind.fire('change');
    assert.equal(outline.kind, 'circle');
    assert.equal(outline.radius, 3);
    assert.equal(app.history.undoStack.length, 1);
    app.history.undo();
    assert.equal(outline.kind, 'polygon');
}

for (const index of [0, 1]) for (const action of ['Delete', 'Backspace', 'context']) {
    const { app, model, shapes } = fixture('nodeRadius');
    const shape = shapes[0];
    shape.kind = 'line';
    shape.points = shape.points.slice(0, 2);
    app._selectedBoardShapeNode = { shapeId: shape.id, index };
    let activeTab = 'pcb-properties';
    app._setActiveRibbonTab = tab => { activeTab = tab; };
    showBoardShapeProperties(app, shape);
    const before = captureBoardShapeState(shape);
    if (action === 'context') assert.equal(deleteBoardShapeVertex(app, shape, index), true);
    else assert.equal(PCBApp.prototype.handleKeyDown.call(app, { key: action }), true);
    assert.equal(model.boardShapes.includes(shape), false);
    assert.equal(fields.has('pcbPropShapeNodeX'), false, 'Deleted endpoint Properties must be removed');
    assert.equal(fields.has('pcbPropShapeNodeCornerRadius'), false);
    assert.equal(activeTab, 'pcb-home', 'Deleting a two-node line leaves Properties');
    assert.equal(app._selectedBoardShapeNode, null);
    assert.equal(app._selectedBoardShapeSegment, null);
    assert.equal(app.history.undoStack.length, 1);
    app.history.undo();
    assert.ok(model.boardShapes.includes(shape));
    assert.deepEqual(captureBoardShapeState(shape), before);
    app.history.redo();
    assert.equal(model.boardShapes.includes(shape), false);
}

for (const index of [0, 2]) {
    const { app, model, shapes } = fixture('nodeRadius');
    const shape = shapes[0];
    shape.kind = 'line';
    shape.points = shape.points.slice(0, 3);
    app._selectedBoardShapeNode = { shapeId: shape.id, index };
    let activeTab = 'pcb-properties';
    app._setActiveRibbonTab = tab => { activeTab = tab; };
    showBoardShapeProperties(app, shape);
    assert.equal(deleteBoardShapeVertex(app, shape, index), true);
    assert.ok(model.boardShapes.includes(shape));
    assert.equal(shape.points.length, 2);
    assert.equal(activeTab, 'pcb-properties', 'A surviving longer line keeps Properties');
    assert.equal(fields.has('pcbPropShapeNodeX'), false);
    assert.ok(fields.has('pcbPropShapeLineWidth'), 'Surviving lines return to whole-object controls');
}

for (const [kind, points, bulges, expected] of [
    ['line', [{ x: 0, y: 0 }, { x: 10, y: 0 }], {}, [false, false]],
    ['line', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], {}, [false, true, false]],
    ['line', [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }], {}, [false, false, false]],
    ['polygon', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], {}, [true, true, true]],
    ['line', [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], { 0: 0.25 }, [false, false, false]],
]) {
    const { app, shapes } = fixture('nodeRadius');
    Object.assign(shapes[0], { kind, points, segmentBulges: bulges });
    const before = captureBoardShapeState(shapes[0]);
    for (const [index, showRadius] of expected.entries()) {
        app._selectedBoardShapeNode = { shapeId: shapes[0].id, index };
        showBoardShapeProperties(app, shapes[0]);
        assert.equal(fields.has('pcbPropShapeNodeCornerRadius'), showRadius, `${kind} node ${index}: radius is only for a corner`);
        assert.ok(fields.has('pcbPropShapeNodeX'), 'Non-corner nodes still expose their position');
    }
    assert.deepEqual(captureBoardShapeState(shapes[0]), before, 'Control visibility does not alter authored geometry');
}

for (const closed of [false, true]) for (const boundary of ['uniform', 'width-change', 'curve']) {
    const { app, shapes } = fixture('nodeRadius');
    const shape = shapes[0];
    Object.assign(shape, {
        kind: closed ? 'polygon' : 'line',
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 20, y: 0 },
            ...(closed ? [{ x: 20, y: 10 }, { x: 0, y: 10 }] : [{ x: 30, y: 0 }])],
        segmentWidths: boundary === 'width-change' ? { 0: 0.7 } : {},
        segmentBulges: boundary === 'curve' ? { 0: 0.25 } : {},
        nodeCornerRadii: { 1: 0.75, 4: 1.25 },
    });
    const points = structuredClone(shape.points);
    const before = captureBoardShapeState(shape);
    app._selectedBoardShapeNode = { shapeId: shape.id, index: 2 };
    showBoardShapeProperties(app, shape);
    assert.equal(PCBApp.prototype.handleKeyDown.call(app, { key: 'Delete' }), true);
    const expected = closed
        ? [points[0], ...(boundary === 'uniform' ? [] : [points[1]]), ...points.slice(3)]
        : [points[0], ...(boundary === 'uniform' ? [] : [points[1]]), points[4]];
    assert.deepEqual(shape.points, expected, 'Deleting a node removes newly redundant straight-through nodes');
    if (boundary === 'width-change') assert.equal(shape.segmentWidths[0], 0.7);
    if (boundary === 'curve') assert.equal(shape.segmentBulges[0], 0.25);
    const lastRadiusIndex = shape.points.findIndex(point => point.x === points[4].x && point.y === points[4].y);
    assert.equal(shape.nodeCornerRadii[lastRadiusIndex], 1.25, 'Surviving radius metadata follows its node');
    assert.equal(app.history.undoStack.length, 1, 'Deletion and simplification are one command');
    const after = captureBoardShapeState(shape);
    app.history.undo();
    assert.deepEqual(captureBoardShapeState(shape), before);
    app.history.redo();
    assert.deepEqual(captureBoardShapeState(shape), after);
}

let checked = 0;
for (const [kind, id, value] of cases) for (const count of ['lineWidth', 'cornerRadius', 'diameter'].includes(kind) ? [1, 4] : [1]) {
    for (const finish of ['commit', 'escape', 'dispose', 'load', 'lock', 'missing', 'failure']) {
        const { app, model, project, shapes, adapters, unrelated, group, pours } = fixture(kind, count);
        const before = model.captureGeometry(), serialized = model.serialize();
        const references = shapes.map(shape => ({ points: shape.points, artwork: shape.artwork, widths: shape.segmentWidths }));
        const input = fields.get(id);
        assert.ok(input, `${kind} control`);
        try {
            input.value = String(value);
            input.fire('input');
            const preview = getBoardShapePropertyPreview(app), collection = app.boardShapes;
            assert.ok(preview, kind);
            shapes.forEach((shape, index) => {
                assert.notEqual(adapters[index].object, shape);
                assert.equal(adapters[index].object, preview.copies[index]);
                assert.equal(shape.points, references[index].points);
                assert.equal(shape.artwork, references[index].artwork);
                assert.equal(shape.segmentWidths, references[index].widths);
            });
            assert.equal(app.boardShapes[count], unrelated[0]);
            const work = allocations;
            for (let index = 0; index < 100; index++) input.fire('input');
            assert.equal(allocations, work, `${kind}: repeated values do no SVG work`);
            assert.equal(app.boardShapes, collection);
            assert.deepEqual(model.captureGeometry(), before);
            assert.deepEqual(model.serialize(), serialized);
            assert.equal(pours(), 0);
            assert.equal(group.children.length, count + 1);
            assert.throws(() => project.serialize(), /current edit/i);
            await assert.rejects(prepareFabricationSnapshot(app), /current edit/i);
            if (finish === 'commit') {
                const execute = app.history.execute.bind(app.history);
                app.history.execute = command => {
                    assert.equal(getBoardShapePropertyPreview(app), undefined);
                    assert.equal(app.boardShapes, model.boardShapes);
                    assert.deepEqual(model.captureGeometry(), before);
                    execute(command);
                };
                input.fire('change');
                assert.equal(app.history.undoStack.length, 1);
                const after = model.captureGeometry();
                app.history.undo();
                assert.deepEqual(model.captureGeometry(), before);
                app.history.redo();
                assert.deepEqual(model.captureGeometry(), after);
            } else {
                if (finish === 'escape') {
                    shapes.forEach(shape => { shape.points?.forEach(Object.freeze); if (shape.points) Object.freeze(shape.points); Object.freeze(shape); });
                    input.fire('keydown', { key: 'Escape' });
                    input.fire('change');
                    input.fire('blur');
                    await Promise.resolve();
                } else if (finish === 'dispose') app._setPcbPropsTitle('Replacement');
                else if (finish === 'load') loadPcb(app, null);
                else if (finish === 'lock') {
                    const layer = PCB_LAYERS.find(layer => layer.id === 'top-copper');
                    layer.locked = true;
                    try { app._onLayerLockChanged(layer.id, true); } finally { layer.locked = false; }
                } else if (finish === 'missing') {
                    model.boardShapes.splice(model.boardShapes.indexOf(shapes.at(-1)), 1);
                    assert.throws(() => input.fire('change'), /missing board shape/);
                } else {
                    app.history.execute = () => { throw new Error('Rejected property edit'); };
                    assert.throws(() => input.fire('change'), /Rejected property edit/);
                }
                if (finish === 'load') assert.equal(model.boardShapes.length, 0);
                else if (finish !== 'missing') assert.deepEqual(model.captureGeometry(), before);
                assert.equal(app.history.undoStack.length, 0);
                assert.equal(pours(), 0);
            }
            assert.equal(getBoardShapePropertyPreview(app), undefined);
            assert.equal(app.boardShapes, model.boardShapes);
            assert.equal(app._deferDragOverlays, false);
            if (finish !== 'missing' && finish !== 'load') assert.equal(group.children.length, count + 1);
            checked++;
        } finally {
            app._boardShapePropertyBinding?.dispose();
            cancelPictureCopperRefresh(app);
        }
    }
}
console.log(`PASS ${checked} shape/image numeric ownership cases: isolation, lifecycle, work counts, frozen cancellation and exact history`);

{
    const { app, shapes, model } = fixture('lineWidth', 1, 5000);
    const input = fields.get('pcbPropShapeLineWidth');
    input.value = '0.8'; input.fire('input');
    const projection = app.boardShapes, copy = getBoardShapePropertyPreview(app).copies[0];
    for (let index = 1; index <= 100; index++) {
        input.value = String(0.8 + index / 100); input.fire('input');
        assert.equal(app.boardShapes, projection);
        assert.equal(getBoardShapePropertyPreview(app).copies[0], copy);
    }
    assert.equal(model.boardShapes[0].lineWidth, 0.23456789);
    const displayed = app.boardShapes[0];
    startBoardShapeDrag(app, displayed, shapes[0].points[0], 0);
    assert.equal(app.history.undoStack.length, 1);
    assert.equal(shapes[0].lineWidth, 1.8);
    assert.equal(app._shapeDrag.original, shapes[0]);
    endBoardShapeDrag(app, false);
    cancelPictureCopperRefresh(app);
}
console.log('PASS 5001-shape collection reuse and property-to-pointer canonical handoff');

for (const [kind, id, value] of cases) {
    const { app, model, shapes } = fixture(kind);
    if (kind === 'diameter') shapes[0].radius = 3;
    const input = fields.get(id);
    const initial = kind === 'lineWidth' || kind === 'segmentWidth' ? shapes[0].lineWidth
        : kind === 'cornerRadius' || kind === 'nodeRadius' ? shapes[0].cornerRadius
            : kind === 'diameter' ? shapes[0].radius * 2
                : kind.endsWith('Bulge') ? 0.25
                    : kind === 'imageWidth' ? 10 : kind === 'imageHeight' ? 6 : 0;
    const before = model.captureGeometry();
    app.history.execute({ execute() {}, undo() {} });
    app.history.undo();
    input.value = String(value); input.fire('input');
    input.value = String(initial); input.fire('input');
    app._boardShapePropertyBinding.commit();
    assert.equal(app.history.undoStack.length, 0, `${kind} return to baseline`);
    assert.equal(app.history.redoStack.length, 1);
    assert.deepEqual(model.captureGeometry(), before);
    app._boardShapePropertyBinding?.dispose();
    input.value = String(value); input.fire('input'); input.fire('change');
    assert.equal(getBoardShapePropertyPreview(app), undefined, 'Disposed controls cannot restart a preview');
    assert.deepEqual(model.captureGeometry(), before);
    cancelPictureCopperRefresh(app);
}
console.log('PASS exact no-op properties preserve redo and disposed controls cannot restart previews');

for (const replacement of ['refresh', 'selection']) {
    const { app, model, shapes, unrelated } = fixture('cornerRadius');
    const retiredLayer = fields.get('pcbPropShapeLayer'), retiredFill = fields.get('pcbPropShapeFilled');
    const currentShape = replacement === 'selection' ? unrelated[0] : shapes[0];
    setPcbSelection(app, [{ kind: 'shape', object: currentShape }]);
    showBoardShapeProperties(app, currentShape);
    const currentWidth = fields.get('pcbPropShapeLineWidth'), before = model.captureGeometry();
    retiredFill.checked = true; retiredFill.fire('change');
    retiredLayer.value = 'bottom-silk'; retiredLayer.fire('change');
    assert.deepEqual(model.captureGeometry(), before);
    assert.equal(app.history.undoStack.length, 0);
    assert.equal(fields.get('pcbPropShapeLineWidth'), currentWidth, 'Retired PCB controls cannot replace the current Properties panel');
    const currentLayer = fields.get('pcbPropShapeLayer');
    currentLayer.value = 'bottom-silk'; currentLayer.fire('change');
    assert.equal(currentShape.layer, 'bottom-silk', 'Current layer controls still work');
    assert.equal(app.history.undoStack.length, 1);
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    cancelPictureCopperRefresh(app);
}

{
    const { app, model, shapes } = fixture('imageWidth');
    const width = fields.get('pcbPropImageWidth'), height = fields.get('pcbPropImageHeight');
    const before = model.captureGeometry();
    width.value = '20'; width.fire('input');
    height.value = '18'; height.fire('input');
    assert.equal(app.history.undoStack.length, 1, 'Changing fields commits the previous preview');
    assert.equal(shapes[0].points[1].x - shapes[0].points[0].x, 20);
    const candidate = getBoardShapePropertyPreview(app).copies[0];
    assert.equal(candidate.points[3].y - candidate.points[0].y, 18);
    assert.equal(candidate.points[1].x - candidate.points[0].x, 30);
    height.fire('change');
    assert.equal(app.history.undoStack.length, 2);
    app.history.undo(); app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    cancelPictureCopperRefresh(app);
}
{
    const { app, model, shapes } = fixture('lineWidth');
    const input = fields.get('pcbPropShapeLineWidth');
    shapes[0].lineWidth = 0.7654321;
    const before = model.captureGeometry();
    input.value = '1.2'; input.fire('input'); input.fire('change');
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), before, 'History captures first-change state, not panel-open state');
    cancelPictureCopperRefresh(app);
}
{
    const { app, model, shapes } = fixture('lineWidth');
    const input = fields.get('pcbPropShapeLineWidth');
    model.boardShapes.splice(0, 1);
    input.value = '0.8';
    assert.throws(() => input.fire('input'), /missing board shape/);
    assert.equal(app._shapeElements.has(shapes[0].id), false);
    assert.equal(getBoardShapePropertyPreview(app), undefined);
    assert.equal(app._deferDragOverlays, false);
}
console.log('PASS cross-field image dimensions, first-change baselines and pre-pickup missing-target cleanup');

for (const [kind, id, values] of [
    ['imageRotation', 'pcbPropImageRot', [1, 2, 3, 2, 1, 0, 359, 360, -1]],
    ['imageWidth', 'pcbPropImageWidth', [10.1, 10.2, 10.3, 10.2]],
    ['imageHeight', 'pcbPropImageHeight', [6.1, 6.2, 6.3, 6.2]],
]) {
    const { app, model, shapes } = fixture(kind);
    app.currentTool = 'select';
    const before = model.captureGeometry();
    const input = fields.get(id), binding = app._boardShapePropertyBinding;
    input.focus();
    const center = () => ({ x: (shapes[0].points[0].x + shapes[0].points[2].x) / 2,
        y: (shapes[0].points[0].y + shapes[0].points[2].y) / 2 });
    const originalCenter = center();
    for (const value of values) {
        const key = { key: 'ArrowUp', target: document.activeElement };
        assert.equal(PCBApp.prototype.handleKeyDown.call(app, key), false, 'Focused input owns every arrow key');
        input.fire('keydown', { key: 'ArrowUp' });
        input.value = String(value);
        input.fire('input');
        input.fire('change');
        assert.equal(fields.get(id), input, `${kind}: native input/change must not replace the focused field`);
        assert.equal(document.activeElement, input, `${kind}: repeated arrow keys retain focus`);
        assert.equal(app._boardShapePropertyBinding, binding);
        assert.equal(getBoardShapePropertyPreview(app), undefined);
        const points = shapes[0].points;
        if (kind === 'imageRotation') {
            const actual = ((-Math.atan2(points[1].y - points[0].y,
                points[1].x - points[0].x) * 180 / Math.PI) % 360 + 360) % 360;
            const expected = ((value % 360) + 360) % 360;
            assert.ok(Math.abs(((actual - expected + 180) % 360 + 360) % 360 - 180) < 1e-9);
            assert.equal(input.valueAsNumber, expected);
        } else {
            const edge = kind === 'imageWidth' ? 1 : 3;
            assert.ok(Math.abs(Math.hypot(points[edge].x - points[0].x,
                points[edge].y - points[0].y) - value) < 1e-9);
        }
        assert.ok(Math.abs(center().x - originalCenter.x) < 1e-9);
        assert.ok(Math.abs(center().y - originalCenter.y) < 1e-9, 'No arrow-key nudge leaks to the image');
    }
    const after = model.captureGeometry(), depth = app.history.undoStack.length;
    assert.equal(depth, values.length, 'Each completed native change remains one undoable edit');
    input.fire('change');
    assert.equal(app.history.undoStack.length, depth, 'Repeated unchanged values do not author commands');
    assert.equal(fields.get(id), input, 'A no-op change also retains the focused field');
    input.value = ''; input.fire('change');
    assert.equal(fields.get(id), input, 'Invalid input resets in place instead of dropping focus');
    assert.ok(Number.isFinite(input.valueAsNumber));
    assert.deepEqual(model.captureGeometry(), after);
    document.activeElement = document.body;
    for (let i = 0; i < depth; i++) app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    for (let i = 0; i < depth; i++) app.history.redo();
    assert.deepEqual(model.captureGeometry(), after);
    cancelPictureCopperRefresh(app);
}
console.log('PASS repeated image numeric input/change keeps focus, center, field identity and exact history');

for (const [kind, id, value] of cases.filter(([kind]) => !kind.startsWith('image'))) {
    for (const count of ['lineWidth', 'cornerRadius', 'diameter'].includes(kind) ? [1, 3] : [1]) {
        const { app, model, shapes } = fixture(kind, count);
        app.currentTool = 'select';
        const before = model.captureGeometry();
        const input = fields.get(id), binding = app._boardShapePropertyBinding;
        const propertyValue = shape => kind === 'lineWidth' ? shape.lineWidth
            : kind === 'segmentWidth' ? shape.segmentWidths[0]
                : kind === 'cornerRadius' ? shape.cornerRadius
                    : kind === 'nodeRadius' ? shape.nodeCornerRadii[1]
                        : kind === 'diameter' ? shape.radius * 2
                            : kind === 'arcBulge' ? bulgeRatio(shape.start, shape.end, shape.bulge)
                                : shape.segmentBulges[0];
        input.focus();
        for (const next of [value, value + 0.1, value + 0.2]) {
            assert.equal(PCBApp.prototype.handleKeyDown.call(app, { key: 'ArrowUp', target: document.activeElement }), false);
            input.fire('keydown', { key: 'ArrowUp' });
            input.value = String(next); input.fire('input'); input.fire('change');
            assert.equal(fields.get(id), input, `${kind}: retain the focused numeric control across native changes`);
            assert.equal(document.activeElement, input);
            assert.equal(app._boardShapePropertyBinding, binding);
            assert.equal(getBoardShapePropertyPreview(app), undefined);
            for (const shape of shapes) assert.ok(Math.abs(propertyValue(shape) - next) < 1e-9, `${kind}: apply the numeric value`);
        }
        const after = model.captureGeometry(), depth = app.history.undoStack.length;
        assert.equal(depth, 3);
        input.fire('change');
        assert.equal(app.history.undoStack.length, depth);
        input.value = ''; input.fire('change');
        assert.equal(fields.get(id), input, `${kind}: invalid values reset without dropping focus`);
        assert.ok(Number.isFinite(input.valueAsNumber));
        assert.deepEqual(model.captureGeometry(), after);
        document.activeElement = document.body;
        for (let i = 0; i < depth; i++) app.history.undo();
        assert.deepEqual(model.captureGeometry(), before);
        for (let i = 0; i < depth; i++) app.history.redo();
        assert.deepEqual(model.captureGeometry(), after);
        cancelPictureCopperRefresh(app);
    }
}
console.log('PASS focused shape numeric changes preserve controls, single/batch values and exact history');

for (const kind of ['lineWidth', 'diameter', 'cornerRadius']) {
    const { app, model, shapes } = fixture(kind, 3);
    const property = kind === 'diameter' ? 'radius' : kind;
    shapes[1][property] += 0.3;
    shapes[2][property] += 0.6;
    showBoardShapeProperties(app, shapes[0]);
    const id = kind === 'lineWidth' ? 'pcbPropShapeLineWidth'
        : kind === 'diameter' ? 'pcbPropShapeDiameter' : 'pcbPropShapeCornerRadius';
    const input = fields.get(id), before = model.captureGeometry();
    assert.equal(input.value, '');
    assert.equal(input.placeholder, 'Mixed');
    input.focus();
    input.value = kind === 'diameter' ? '0.4' : '0.5';
    input.fire('input'); input.fire('change');
    assert.equal(input.placeholder, '', 'Batch commit clears the obsolete Mixed placeholder in place');
    assert.equal(fields.get(id), input);
    if (kind === 'diameter') {
        assert.equal(fields.get('pcbPropShapeLineWidth').value, '0.20', 'Clamped width follows the new diameter');
        assert.ok(shapes.every(shape => shape.lineWidth === 0.2 && shape.radius === 0.2));
    }
    document.activeElement = document.body;
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), before, 'Mixed values and coupled dimensions restore exactly');
    cancelPictureCopperRefresh(app);
}
for (const kind of ['arcBulge', 'segmentBulge']) {
    const { app, model, shapes } = fixture(kind);
    const before = model.captureGeometry();
    const input = fields.get('pcbPropShapeBulge');
    input.focus();
    input.value = '0'; input.fire('input'); input.fire('change');
    assert.equal(fields.has('pcbPropShapeBulge'), false, 'Straightening removes the obsolete bulge control');
    assert.equal(document.activeElement, document.body, 'A removed control must not retain phantom focus');
    assert.equal(shapes[0].kind, kind === 'arcBulge' ? 'line' : 'polygon');
    const after = model.captureGeometry();
    input.value = '0.5'; input.fire('input'); input.fire('change');
    assert.deepEqual(model.captureGeometry(), after, 'A removed curved-geometry control cannot edit the new shape');
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    assert.ok(fields.has('pcbPropShapeBulge'));
    cancelPictureCopperRefresh(app);
}
console.log('PASS mixed-field synchronization, coupled diameter/width clamps and intentional arc-to-line panel changes');

for (const closed of [false, true]) for (const boundary of ['uniform', 'width', 'curve', 'selected-width']) {
    for (const completion of ['change', 'blur']) {
        const { app, model, shapes } = fixture('segmentBulge');
        const shape = shapes[0];
        shape.kind = closed ? 'polygon' : 'line';
        shape.points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
        if (closed) shape.points.push({ x: 30, y: 10 }, { x: 0, y: 10 });
        shape.segmentBulges = { 1: 0.25 };
        if (boundary === 'width') shape.segmentWidths = { 0: 0.7 };
        if (boundary === 'curve') shape.segmentBulges[0] = 0.3;
        if (boundary === 'selected-width') shape.segmentWidths = { 1: 0.7 };
        shape.nodeCornerRadii = { 3: 0.8 };
        app._selectedBoardShapeSegment = { shapeId: shape.id, segment: 1 };
        showBoardShapeProperties(app, shape);
        const points = structuredClone(shape.points), before = model.captureGeometry();
        let input = fields.get('pcbPropShapeBulge');
        input.focus();
        input.value = '0'; input.fire('input');
        assert.deepEqual(model.captureGeometry(), before, 'Numeric straightening remains isolated until commit');
        assert.equal(getBoardShapePropertyPreview(app).copies[0].points.length, points.length);
        input.fire('keydown', { key: 'Escape' });
        assert.deepEqual(model.captureGeometry(), before);
        assert.equal(app.history.undoStack.length, 0);
        input = fields.get('pcbPropShapeBulge');
        input.focus();
        input.value = '0'; input.fire('input');
        input.value = '0.4'; input.fire('input');
        assert.equal(getBoardShapePropertyPreview(app).copies[0].points.length, points.length,
            'Passing through zero during a preview does not merge nodes');
        assert.equal(getBoardShapePropertyPreview(app).copies[0].segmentBulges[1], 0.4);
        input.value = '0'; input.fire('input');
        input.fire(completion);
        await Promise.resolve();
        const expected = points.filter((_, index) => boundary === 'selected-width'
            || index !== 2 && (index !== 1 || boundary !== 'uniform'));
        assert.deepEqual(shape.points, expected, 'Committed straightening merges only redundant equal-width nodes');
        assert.equal(shape.nodeCornerRadii[expected.findIndex(point => point.x === 30 && point.y === 0)], 0.8);
        if (boundary === 'curve') assert.equal(shape.segmentBulges[0], 0.3);
        if (boundary === 'width') assert.equal(shape.segmentWidths[0], 0.7);
        if (boundary === 'selected-width') assert.equal(shape.segmentWidths[1], 0.7);
        assert.equal(fields.has('pcbPropShapeBulge'), false);
        assert.deepEqual(app._selectedBoardShapeSegment,
            boundary === 'selected-width' ? { shapeId: shape.id, segment: 1 } : null,
            'Merging indexed segments clears obsolete refinement');
        assert.equal(app.history.undoStack.length, 1);
        const after = model.captureGeometry();
        app.history.undo();
        assert.deepEqual(model.captureGeometry(), before);
        app.history.redo();
        assert.deepEqual(model.captureGeometry(), after);
        document.activeElement = document.body;
        cancelPictureCopperRefresh(app);
    }
}
console.log('PASS numeric segment straightening cleans collinear nodes at commit with exact cancellation and history');

for (const kind of ['arcBulge', 'segmentBulge']) for (const completion of ['field', 'prepare', 'commit']) {
    const { app, model, shapes } = fixture(kind);
    const shape = shapes[0];
    if (kind === 'segmentBulge') {
        shape.kind = 'line';
        shape.points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
        shape.segmentBulges = { 1: 0.25 };
        app._selectedBoardShapeSegment = { shapeId: shape.id, segment: 1 };
        showBoardShapeProperties(app, shape);
    }
    const before = model.captureGeometry(), width = shape.lineWidth;
    const binding = app._boardShapePropertyBinding;
    const bulge = fields.get('pcbPropShapeBulge'), next = fields.get('pcbPropShapeLineWidth');
    bulge.focus();
    bulge.value = '0'; bulge.fire('input');
    assert.deepEqual(model.captureGeometry(), before);
    if (completion === 'field') {
        next.focus(); next.value = '0.8'; next.fire('input');
    } else binding[completion]();
    assert.equal(shape.kind, 'line', 'Every completion path normalizes a straightened arc');
    assert.equal(shape.points.length, 2, 'Every completion path removes newly redundant nodes');
    assert.equal(fields.has('pcbPropShapeBulge'), false, 'Structural completion removes obsolete controls');
    assert.equal(binding.disposed, true, 'The old form cannot continue an action against changed geometry');
    assert.notEqual(fields.get('pcbPropShapeLineWidth'), next);
    assert.equal(shape.lineWidth, width);
    assert.equal(app.history.undoStack.length, 1);
    assert.equal(app._boardShapePropertyBinding.active, false);
    const after = model.captureGeometry();
    bulge.fire('blur'); next.fire('change');
    await Promise.resolve();
    assert.deepEqual(model.captureGeometry(), after, 'Delayed events cannot alter the completed straight line');
    app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    app.history.redo();
    assert.deepEqual(model.captureGeometry(), after);
    document.activeElement = document.body;
    cancelPictureCopperRefresh(app);
}

for (const kind of ['cornerRadius', 'imageWidth']) for (const completion of ['change', 'blur']) {
    for (const withinPanel of [false, true]) {
        const { app, model } = fixture(kind);
        const previousId = kind === 'imageWidth' ? 'pcbPropImageWidth' : 'pcbPropShapeLineWidth';
        const nextId = kind === 'imageWidth' ? 'pcbPropImageHeight' : 'pcbPropShapeCornerRadius';
        const previous = fields.get(previousId), next = fields.get(nextId);
        const before = model.captureGeometry();
        previous.focus();
        previous.value = kind === 'imageWidth' ? '20' : '0.8'; previous.fire('input');
        if (withinPanel) next.focus();
        else document.activeElement = document.body;
        previous.fire(completion);
        await Promise.resolve();
        assert.equal(app.history.undoStack.length, 1);
        if (withinPanel) {
            assert.ok(document.activeElement === next, 'Finishing the previous field must retain focus in Properties');
            assert.equal(fields.get(nextId), next, 'A pending commit must not replace the next field before typing starts');
            next.value = kind === 'imageWidth' ? '18' : '2'; next.fire('input'); next.fire('change');
            assert.equal(app.history.undoStack.length, 2);
            document.activeElement = document.body;
            app.history.undo();
        } else assert.notEqual(fields.get(nextId), next, 'Leaving Properties retains the normal rebuild');
        app.history.undo();
        assert.deepEqual(model.captureGeometry(), before);
        cancelPictureCopperRefresh(app);
    }
}

for (const kind of ['cornerRadius', 'imageWidth', 'arcBulge']) {
    for (const completion of ['field', 'prepare', 'commit']) {
        const { app, model } = fixture(kind);
        const before = model.captureGeometry();
        const binding = app._boardShapePropertyBinding;
        const previous = fields.get(kind === 'imageWidth' ? 'pcbPropImageWidth'
            : kind === 'arcBulge' ? 'pcbPropShapeBulge' : 'pcbPropShapeLineWidth');
        const next = fields.get(kind === 'imageWidth' ? 'pcbPropImageHeight'
            : kind === 'arcBulge' ? 'pcbPropShapeLineWidth' : 'pcbPropShapeCornerRadius');
        previous.focus();
        previous.value = kind === 'imageWidth' ? '20' : kind === 'arcBulge' ? '0' : '0.8';
        previous.fire('input');
        previous.value = ''; previous.fire('input'); previous.fire('blur');
        if (completion === 'field') {
            next.focus(); next.value = kind === 'imageWidth' ? '18' : '1.5'; next.fire('input');
        } else binding[completion]();
        assert.deepEqual(model.captureGeometry(), before, 'Invalid previous input must not commit its last valid preview');
        assert.equal(app.history.undoStack.length, 0);
        await Promise.resolve();
        assert.equal(app.history.undoStack.length, 0);
        if (completion === 'field') {
            assert.ok(document.activeElement === next);
            assert.equal(fields.get(kind === 'imageWidth' ? 'pcbPropImageHeight'
                : kind === 'arcBulge' ? 'pcbPropShapeLineWidth' : 'pcbPropShapeCornerRadius'), next);
            next.fire('change');
            assert.equal(app.history.undoStack.length, 1);
            const after = model.captureGeometry();
            app.history.undo();
            assert.deepEqual(model.captureGeometry(), before);
            app.history.redo();
            assert.deepEqual(model.captureGeometry(), after);
        }
        document.activeElement = document.body;
        cancelPictureCopperRefresh(app);
    }
}

for (const valid of [false, true]) {
    const { app, model, shapes } = fixture('cornerRadius');
    const shape = shapes[0], before = model.captureGeometry(), originalWidth = shape.lineWidth;
    const width = fields.get('pcbPropShapeLineWidth'), fill = fields.get('pcbPropShapeFilled');
    width.focus(); width.value = '0.8'; width.fire('input');
    if (!valid) { width.value = ''; width.fire('input'); }
    width.fire('blur');
    fill.focus(); fill.checked = true; fill.fire('change');
    assert.equal(app.history.undoStack.length, valid ? 2 : 1);
    assert.equal(shape.lineWidth, valid ? 0.8 : originalWidth);
    assert.equal(shape.filled, true);
    const after = model.captureGeometry();
    await Promise.resolve();
    assert.deepEqual(model.captureGeometry(), after);
    assert.equal(app.history.undoStack.length, valid ? 2 : 1);
    document.activeElement = document.body;
    app.history.undo();
    assert.equal(shape.filled, false);
    assert.equal(shape.lineWidth, valid ? 0.8 : originalWidth);
    if (valid) app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    if (valid) app.history.redo();
    app.history.redo();
    assert.deepEqual(model.captureGeometry(), after);
    cancelPictureCopperRefresh(app);
}

{
    const { app, shapes } = fixture('cornerRadius');
    const width = fields.get('pcbPropShapeLineWidth'), radius = fields.get('pcbPropShapeCornerRadius');
    width.focus(); width.value = '0.8'; width.fire('input'); width.fire('change');
    radius.focus(); width.fire('blur');
    radius.value = '2'; radius.fire('input');
    await Promise.resolve();
    assert.equal(document.activeElement, radius, 'Deferred blur of a committed field must not steal the next field focus');
    assert.equal(fields.get('pcbPropShapeCornerRadius'), radius);
    assert.equal(getBoardShapePropertyPreview(app).copies[0].cornerRadius, 2, 'The next field retains its own pending preview');
    assert.equal(shapes[0].cornerRadius, 0.123456789);
    radius.fire('change');
    assert.equal(shapes[0].cornerRadius, 2);
    assert.equal(app.history.undoStack.length, 2);
    document.activeElement = document.body;
    cancelPictureCopperRefresh(app);
}

{
    const { app, model, shapes } = fixture('imageWidth');
    const width = fields.get('pcbPropImageWidth'), height = fields.get('pcbPropImageHeight');
    const before = model.captureGeometry();
    width.focus(); width.value = '20'; width.fire('input'); width.fire('change');
    assert.equal(height.value, '12.00');
    height.focus(); height.fire('change');
    assert.equal(height.value, '12.00', 'A paired-field no-op must not restore its panel-open value');
    assert.equal(app.history.undoStack.length, 1);
    height.value = '18'; height.fire('input'); height.fire('change');
    assert.equal(width.value, '30.00');
    assert.equal(shapes[0].points[1].x - shapes[0].points[0].x, 30);
    assert.equal(fields.get('pcbPropImageWidth'), width);
    assert.equal(fields.get('pcbPropImageHeight'), height);
    document.activeElement = document.body;
    app.history.undo(); app.history.undo();
    assert.deepEqual(model.captureGeometry(), before, 'Cross-field focus retention preserves exact undo');
    cancelPictureCopperRefresh(app);
}

{
    const { app, shapes, model } = fixture('diameter');
    const shape = shapes[0], before = model.captureGeometry();
    startBoardShapeDrag(app, shape, { x: shape.x + shape.radius, y: shape.y }, 'radius');
    handleBoardShapeDrag(app, { x: shape.x + 7, y: shape.y });
    showBoardShapeProperties(app, shape);
    const input = fields.get('pcbPropShapeDiameter');
    input.value = '12.0'; input.fire('input');
    assert.equal(app._shapeDrag, null);
    assert.equal(app.history.undoStack.length, 1);
    assert.equal(shape.radius, 7, 'Numeric pickup first accepts the pointer geometry');
    assert.equal(getBoardShapePropertyPreview(app).copies[0].radius, 6);
    assert.equal(input.value, '12.0', 'Pointer completion cannot overwrite the in-progress typed value');
    input.fire('change');
    assert.equal(app.history.undoStack.length, 2);
    app.history.undo(); app.history.undo();
    assert.deepEqual(model.captureGeometry(), before);
    cancelPictureCopperRefresh(app);
}
console.log('PASS pointer-to-numeric handoff preserves the typed value and separate canonical history');

for (const finish of ['commit', 'cancel', 'panel', 'different-owner']) {
    const { app, shapes, model } = fixture('imageRotation');
    const shape = shapes[0], before = model.captureGeometry();
    const adapter = createBoardShapeSelectionAdapter(app, shape, `shape:${shape.id}`);
    assert.equal(beginPcbAnchorInteraction(app, adapter, { id: 'rotate', symbol: 'rotate' }, { x: 17, y: 6 }), true);
    assert.ok(getBoardShapeRotationPreview(app), 'Showing the image properties must not cancel rotation pickup');
    assert.equal(app._pcbSelectionInteraction?.mode, 'anchor');
    updateSelectionInteraction(app, { x: 7, y: -4 });
    const preview = getBoardShapeRotationPreview(app);
    assert.equal(preview.currentRotation, 90);
    assert.deepEqual(model.captureGeometry(), before, 'The real properties-panel path retains detached geometry');
    showBoardShapeProperties(app, shape);
    assert.equal(getBoardShapeRotationPreview(app), preview, 'Same-owner panel refresh preserves the pointer session');
    assert.equal(fields.get('pcbPropImageRot').value, '90', 'Properties display the in-flight rotation');
    if (finish === 'commit') {
        finishSelectionInteraction(app, true);
        const after = model.captureGeometry();
        assert.notDeepEqual(after, before);
        assert.equal(app.history.undoStack.length, 1);
        app.history.undo();
        assert.deepEqual(model.captureGeometry(), before);
        app.history.redo();
        assert.deepEqual(model.captureGeometry(), after);
    } else {
        if (finish === 'panel') app._setPcbPropsTitle('Other');
        else if (finish === 'different-owner') app._setPcbPropsTitle('Image', { ...shape });
        else finishSelectionInteraction(app, false);
        assert.deepEqual(model.captureGeometry(), before);
        assert.equal(app.history.canUndo(), false);
    }
    assert.equal(getBoardShapeRotationPreview(app), undefined);
    assert.equal(app._pcbSelectionInteraction, null);
    assert.equal(app._rotationHandleDrag, false);
    cancelPictureCopperRefresh(app);
}
console.log('PASS image rotation through selection and real property bindings, same-owner refresh, cancellation and history');
