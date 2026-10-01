import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { showBoardShapeProperties, getBoardShapePropertyPreview, getBoardShapeRotationPreview, createBoardShapeSelectionAdapter,
    renderBoardShape, startBoardShapeDrag, handleBoardShapeDrag, endBoardShapeDrag } from '../src/pcb/modules/board-shapes.js';
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
    set innerHTML(html) {
        fields.clear();
        for (const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)) {
            const listeners = new Map();
            const input = {
                value: /\bvalue="([^"]*)"/.exec(match[0])?.[1] || '', style: {}, dataset: {},
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

function fixture(kind, count = 1, unrelatedCount = 1) {
    const project = new ProjectDocument(), model = project.pcbDocument;
    const shapes = Array.from({ length: count }, (_, index) => {
        const shape = { id: `shape-${index}`, kind: 'polygon', layer: 'top-copper', lineWidth: 0.23456789,
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
        _getLayerGroup: id => id === 'selection-overlay' ? null : group,
        _pcbPropsItems: () => items, _setActiveRibbonTab() {}, _refreshPcbSelectionHighlights() {},
        _refreshFills() { pours++; }, _refreshBoardShapeClearance() {}, _scheduleRemovalHatchRender() {},
        _cancelDrawingMode() {}, _ensureViewport() {}, markSectionClean() {},
    };
    for (const key of ['boardShapes', 'tracks', 'vias', 'pads', 'texts', '_shapeIdCounter']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    for (const key of ['_cancelPosePreviews', 'isSectionEditing', '_setPcbPropsTitle', '_clearProperties',
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
