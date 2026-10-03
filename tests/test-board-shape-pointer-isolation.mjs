import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { shapePathD, boardShapeBounds } from '../src/shared/pcb/board-shape-geometry.js';
import { createBoardShapeSelectionAdapter, renderBoardShape, startBoardShapeDrag, handleBoardShapeDrag,
    endBoardShapeDrag, openBoardShape, setBoardShapeSegmentType, selectBoardShape, deleteFocusedBoardShape } from '../src/pcb/modules/board-shapes.js';
import { setPcbSelection, getPcbSelection, syncPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { prepareFabricationSnapshot } from '../src/pcb/modules/fabrication-snapshot.js';
import { loadPcb } from '../src/pcb/modules/project-state.js';
import { cancelPictureCopperRefresh } from '../src/pcb/modules/picture-refresh.js';
import { PCB_LAYERS } from '../src/pcb/modules/layers.js';
import { areDragOverlaysDeferred, isPictureCopperRefreshPending, setDragOverlaysDeferred } from '../src/pcb/modules/refresh-state.js';
import { setBoardShapeNodeFocus } from '../src/pcb/modules/board-shape-state.js';

let allocations = 0;
class Element {
    constructor() { allocations++; this.children = []; this.attributes = new Map(); this.style = {}; this.dataset = {}; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; }
    insertBefore(child, sibling) {
        if (!sibling) return this.appendChild(child);
        child.remove(); this.children.splice(this.children.indexOf(sibling), 0, child); child.parentNode = this;
    }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
    remove() { this.parentNode?.removeChild(this); }
    querySelectorAll() { return []; }
    querySelector() { return null; }
}
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = {
    createElementNS: () => new Element(), getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [],
};
globalThis.localStorage = { setItem() {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

function fixture(mode, deferred = false, unrelatedCount = 1) {
    const project = new ProjectDocument(), model = project.pcbDocument;
    const points = [{ x: 2.123456789, y: 3.234567891 }, { x: 12, y: 3.234567891 },
        { x: 12, y: 13 }, { x: 2.123456789, y: 13 }];
    let shape = { id: 'shape', kind: 'rect', layer: 'top-silk', lineWidth: 0.2, filled: false,
        copperMode: 'add', points, segmentWidths: { 2: 0.4 }, nodeCornerRadii: { 2: 0.1 } };
    let handle = 0, start = { ...points[0] }, target = { x: -2, y: 1 };
    if (mode === 'move') { handle = null; target = { x: start.x + 3, y: start.y + 5 }; }
    if (mode === 'segment') { handle = null; start = { x: 7, y: points[0].y }; target = { x: 7, y: 1 }; }
    if (mode === 'vertex' || mode === 'split' || mode === 'line-split') shape.kind = 'polygon';
    if (mode === 'line-split') shape.kind = 'line';
    if (mode === 'midpoint') { handle = 'mid:0'; start = { x: (points[0].x + points[1].x) / 2, y: points[0].y }; target = { x: start.x, y: 1 }; }
    if (mode === 'bulge') { shape.kind = 'polygon'; shape.segmentBulges = { 0: 0.25 }; handle = 'bulge:0'; start = { x: 7, y: 4.5 }; target = { x: 7, y: 1 }; }
    if (mode === 'outline') { shape.layer = 'board-outline'; shape = model.setBoardOutline(shape); }
    else model.boardShapes.push(shape);
    if (mode === 'circle') {
        shape.kind = 'circle'; delete shape.points;
        Object.assign(shape, { x: 7, y: 7, radius: 3 });
        handle = 'radius'; start = { x: 10, y: 7 }; target = { x: 12, y: 7 };
    }
    if (mode === 'arc') {
        shape.kind = 'arc'; delete shape.points;
        Object.assign(shape, { start: { x: 2, y: 3 }, end: { x: 12, y: 3 }, bulge: { x: 7, y: 5 } });
        handle = 'end'; start = { x: 12, y: 3 }; target = { x: 14, y: 4 };
    }
    if (mode === 'image') {
        shape.kind = 'image'; shape.filled = true;
        shape.artwork = { width: 4, height: 2, rectangles: [{ x: 0, y: 0, width: 4, height: 2 }] };
    }
    const unrelated = Array.from({ length: unrelatedCount }, (_, index) => ({
        id: `unrelated-${index}`, kind: 'circle', x: 50 + index, y: 50, radius: 1, layer: 'top-silk', lineWidth: 0.2,
    }));
    model.boardShapes.push(...unrelated);
    let fills = 0;
    const group = new Element();
    const app = {
        pcbDocument: model, project, placements: new Map(), netlist: [], history: new CommandHistory(),
        _active: true, _shapeElements: new Map(), _textElements: new Map(),
        _layerGroups: new Map(), viewport: { scale: 100, shiftHeld: true, svg: new Element(), setCrosshair() {}, hideCrosshair() {} },
        getLayerGroup: id => id === 'selection-overlay' ? null : group,
        refreshFills() { fills++; }, _refreshBoardShapeClearance() {},
        propertiesItems: () => null, _cancelDrawingMode() {}, _ensureViewport() {}, markSectionClean() {},
        _scheduleRemovalHatchRender() {}, _refreshPcbSelectionHighlights() {},
    };
    setDragOverlaysDeferred(app, deferred);
    for (const key of ['boardShapes', 'tracks', 'vias', 'pads', 'texts', '_shapeIdCounter']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    for (const key of ['_cancelPosePreviews', 'isSectionEditing', '_onLayerLockChanged', '_onLayerVisibilityChanged', 'clearProperties']) {
        app[key] = PCBApp.prototype[key];
    }
    project.registerView('pcb', app);
    const adapter = createBoardShapeSelectionAdapter(app, shape, shape.id);
    setPcbSelection(app, [{ kind: 'shape', object: shape }]);
    renderBoardShape(app, shape);
    renderBoardShape(app, unrelated[0]);
    const begin = () => mode === 'split' || mode === 'line-split' ? openBoardShape(app, shape, 1)
        : mode === 'convert' ? setBoardShapeSegmentType(app, shape, 0, 'arc', { floating: true })
            : startBoardShapeDrag(app, shape, start, handle, { whole: mode === 'move', allowSegment: mode === 'segment' });
    return { app, model, project, shape, adapter, begin, start, target, group, unrelated, fills: () => fills };
}

let cases = 0;
for (const mode of ['move', 'segment', 'vertex', 'midpoint', 'bulge', 'outline', 'circle', 'arc', 'image', 'split', 'line-split', 'convert']) {
    for (const deferred of [false, true]) for (const finish of ['commit', 'cancel', 'load', 'failure', 'missing', 'deactivate', 'lock', 'deselect']) {
        const { app, model, project, shape, adapter, begin, target, group, unrelated, fills } = fixture(mode, deferred);
        const before = model.captureGeometry(), serialized = model.serialize(), points = shape.points;
        const metadata = [shape.nodeCornerRadii, shape.segmentWidths, shape.segmentBulges, shape.artwork];
        const board = { ...model.board }, otherElement = app._shapeElements.get(unrelated[0].id);
        const counter = model.shapeIdCounter;
        try {
            assert.equal(begin(), true, mode);
            assert.deepEqual(model.captureGeometry(), before, 'Pickup and staged topology leave authored geometry unchanged');
            handleBoardShapeDrag(app, target);
            const copy = app._shapeDrag.shape, collection = app.boardShapes;
            assert.notEqual(copy, shape);
            assert.equal(copy.id, shape.id);
            assert.equal(adapter.object, copy);
            assert.equal(copy.artwork, shape.artwork);
            assert.equal(collection[1], unrelated[0]);
            for (let index = 1; index <= 20; index++) {
                handleBoardShapeDrag(app, { x: target.x + index / 100, y: target.y });
                assert.equal(app._shapeDrag.shape, copy);
                assert.equal(app.boardShapes, collection);
            }
            const work = allocations;
            for (let index = 0; index < 100; index++) handleBoardShapeDrag(app, { x: target.x + 0.2, y: target.y });
            assert.equal(allocations, work, 'Identical pointer events do no SVG work');
            assert.deepEqual(model.captureGeometry(), before);
            assert.deepEqual(model.serialize(), serialized);
            assert.equal(model.shapeIdCounter, counter, 'Staged remainders do not consume authored IDs');
            assert.deepEqual(model.board, board);
            assert.equal(shape.points, points);
            [shape.nodeCornerRadii, shape.segmentWidths, shape.segmentBulges, shape.artwork].forEach((value, index) => assert.equal(value, metadata[index]));
            assert.deepEqual(adapter.getBounds(), boardShapeBounds(copy));
            assert.equal(adapter.getEditPath(), shapePathD({ ...copy, cornerRadius: 0, nodeCornerRadii: {} }));
            syncPcbSelection(app);
            assert.equal(getPcbSelection(app, 'shape')[0], copy);
            const rebuilt = createBoardShapeSelectionAdapter(app, copy, shape.id);
            assert.equal(rebuilt.object, copy);
            assert.deepEqual(rebuilt.getAnchors(), adapter.getAnchors());
            assert.throws(() => project.serialize(), /current edit/i);
            await assert.rejects(prepareFabricationSnapshot(app), /current edit/i);
            const splitArtwork = mode === 'line-split' ? 1 : 0;
            assert.equal(group.children.filter(child => child.getAttribute('data-board-shape-layer') !== null).length, 2 + splitArtwork);
            if (finish === 'commit') {
                const execute = app.history.execute.bind(app.history);
                app.history.execute = command => {
                    assert.equal(app._shapeDrag, null);
                    assert.equal(app.boardShapes, model.boardShapes);
                    assert.deepEqual(model.captureGeometry(), before);
                    execute(command);
                };
                endBoardShapeDrag(app, true);
                assert.equal(app.history.undoStack.length, 1, mode);
                if (mode === 'line-split') assert.equal(model.shapeIdCounter, counter + 1);
                const after = model.captureGeometry();
                app.history.undo();
                assert.deepEqual(model.captureGeometry(), before);
                app.history.redo();
                assert.deepEqual(model.captureGeometry(), after);
            } else if (finish === 'load') loadPcb(app, null);
            else {
                if (finish === 'failure') {
                    app.history.execute = () => { throw new Error('Rejected shape edit'); };
                    assert.throws(() => endBoardShapeDrag(app, true), /Rejected shape edit/);
                } else if (finish === 'missing') {
                    model.boardShapes.splice(model.boardShapes.indexOf(shape), 1);
                    assert.throws(() => endBoardShapeDrag(app, true), /missing board shape/);
                } else if (finish === 'deselect') selectBoardShape(app, null);
                else if (finish === 'deactivate') PCBApp.prototype.deactivate.call(app);
                else if (finish === 'lock') {
                    const layer = PCB_LAYERS.find(layer => layer.id === shape.layer);
                    layer.locked = true;
                    try { app._onLayerLockChanged(layer.id, true); } finally { layer.locked = false; }
                } else {
                    if (shape.points) { shape.points.forEach(Object.freeze); Object.freeze(shape.points); }
                    Object.freeze(shape);
                    endBoardShapeDrag(app, false);
                }
                if (finish !== 'missing') {
                    assert.deepEqual(model.captureGeometry(), before);
                    assert.deepEqual(model.board, board);
                    assert.equal(shape.points, points);
                }
                assert.equal(app.history.undoStack.length, 0);
                assert.equal(model.shapeIdCounter, counter);
                assert.equal(fills(), 0, 'Discarding an isolated edit retains settled pours');
            }
            assert.equal(app._shapeDrag, null);
            assert.equal(areDragOverlaysDeferred(app), deferred);
            assert.equal(app.boardShapes, model.boardShapes);
            assert.equal(rebuilt.object, shape);
            if (finish !== 'load') assert.equal(app._shapeElements.get(unrelated[0].id), otherElement);
            cases++;
        } finally { cancelPictureCopperRefresh(app); }
    }
}
console.log(`PASS ${cases} board shape pointer isolation cases: topology, geometry, canonical dimensions, work counts, history and lifecycle`);

for (const mode of ['move', 'segment', 'vertex', 'outline', 'circle', 'arc', 'image']) {
    const { app, model, begin, start } = fixture(mode, false, 1000);
    const before = model.captureGeometry();
    begin();
    const work = allocations;
    for (let index = 0; index < 100; index++) handleBoardShapeDrag(app, start);
    assert.equal(allocations, work, 'Stationary pickup does not create artwork');
    assert.equal(app._shapeDrag.preview, undefined, 'Stationary pickup does not copy a large shape collection');
    endBoardShapeDrag(app, true);
    assert.equal(app.history.undoStack.length, 0);
    assert.deepEqual(model.captureGeometry(), before);
    cancelPictureCopperRefresh(app);
}
for (const invalid of [{ x: NaN, y: 0 }, { x: 0, y: Infinity }, null]) {
    const { app, model, begin } = fixture('vertex');
    const before = model.captureGeometry();
    begin();
    assert.throws(() => handleBoardShapeDrag(app, invalid), /finite position/);
    assert.equal(app._shapeDrag, null);
    assert.deepEqual(model.captureGeometry(), before);
    assert.equal(isPictureCopperRefreshPending(app), false);
}
{
    const { app, model, shape, begin, target } = fixture('vertex');
    begin();
    model.boardShapes.splice(model.boardShapes.indexOf(shape), 1);
    assert.throws(() => handleBoardShapeDrag(app, target), /missing board shape/);
    assert.equal(app._shapeDrag, null);
    assert.equal(app._shapeElements.has(shape.id), false);
    assert.equal(getPcbSelection(app).length, 0);
}
console.log('PASS stationary pickup on 1001 shapes, invalid coordinates and missing-target cleanup');

for (const mode of ['vertex', 'split']) {
    const { app, model, shape, begin, target } = fixture(mode);
    const before = model.captureGeometry();
    begin();
    handleBoardShapeDrag(app, target);
    setBoardShapeNodeFocus(app, { shapeId: shape.id, index: 0 });
    assert.equal(deleteFocusedBoardShape(app), true);
    assert.equal(app._shapeDrag, null);
    assert.equal(app.history.undoStack.length, mode === 'split' ? 0 : 1);
    if (mode === 'vertex') {
        assert.equal(shape.points.length, 3, 'Focused deletion targets authored shape, not discarded copy');
        app.history.undo();
    }
    assert.deepEqual(model.captureGeometry(), before);
    cancelPictureCopperRefresh(app);
}
console.log('PASS focused deletion cancels staged edits before canonical topology commands');

for (const mode of ['move', 'segment', 'vertex', 'outline', 'circle', 'arc', 'image']) {
    const { app, model, begin, start, target } = fixture(mode);
    const before = model.captureGeometry();
    begin();
    handleBoardShapeDrag(app, target);
    handleBoardShapeDrag(app, start);
    endBoardShapeDrag(app, true);
    assert.equal(app.history.undoStack.length, 0, `${mode} return to pickup makes no history`);
    assert.deepEqual(model.captureGeometry(), before, `${mode} return retains exact authored geometry`);
    cancelPictureCopperRefresh(app);
}
console.log('PASS return-to-origin discards geometry previews without changing history');
