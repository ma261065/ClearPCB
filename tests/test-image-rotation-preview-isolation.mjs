import assert from 'node:assert/strict';
import { ProjectDocument } from '../src/core/ProjectDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { pictureShape } from '../src/shared/pcb/picture-raster.js';
import { boardShapeBounds, boardShapeHitTest, boardShapeRemovalPathD } from '../src/shared/pcb/board-shape-geometry.js';
import { createBoardShapeSelectionAdapter, getBoardShapeRotationPreview, renderBoardShape,
    selectBoardShape, setBoardShapeHover, captureBoardShapeState, endBoardShapeDrag } from '../src/pcb/modules/board-shapes.js';
import { RemoveBoardShapeCommand } from '../src/pcb/modules/shape-commands.js';
import { rotatedImagePoints } from '../src/pcb/modules/rotation-handle.js';
import { setPcbSelection, syncPcbSelection, getPcbSelection } from '../src/pcb/modules/selection-registry.js';
import { finishSelectionInteraction } from '../src/pcb/modules/selection-interaction.js';
import { prepareFabricationSnapshot } from '../src/pcb/modules/fabrication-snapshot.js';
import { loadPcb } from '../src/pcb/modules/project-state.js';
import { cancelPictureCopperRefresh } from '../src/pcb/modules/picture-refresh.js';
import { getHoveredBoardShape } from '../src/pcb/modules/board-shape-state.js';
import { getSelectionInteraction } from '../src/pcb/modules/selection-interaction.js';
import { isRotationHandleDragActive } from '../src/pcb/modules/rotation-handle.js';
import { setPcbInteraction } from '../src/pcb/modules/pcb-interactions.js';

let allocations = 0;
class Element {
    constructor(tag) { allocations++; this.tag = tag; this.attributes = new Map(); this.dataset = {}; this.children = []; this.style = {}; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
    remove() { this.parentNode?.removeChild(this); }
    querySelectorAll() { return []; }
}
const input = { value: '' };
globalThis.document = {
    createElementNS: (_, tag) => new Element(tag),
    getElementById: id => id === 'pcbPropImageRot' ? input : null,
    querySelector: () => null,
    querySelectorAll: () => [],
};
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { setItem() {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
const { default: PCBApp } = await import('../src/ui/PCBApp.js');

function fixture(layer = 'top-copper', unrelatedCount = 1) {
    const project = new ProjectDocument(), model = project.pcbDocument;
    const center = { x: Math.PI, y: -Math.E };
    const shape = pictureShape({ width: 4, height: 2, rectangles: [{ x: 0, y: 0, width: 4, height: 2 }] },
        { widthMm: 8, layer, center });
    shape.id = 'image';
    shape.points = rotatedImagePoints(shape.points, center, 37.123456789);
    const rotation = ((-Math.atan2(shape.points[1].y - shape.points[0].y,
        shape.points[1].x - shape.points[0].x) * 180 / Math.PI) % 360 + 360) % 360;
    const unrelated = Array.from({ length: unrelatedCount }, (_, index) => ({
        id: `other-${index}`, kind: 'circle', layer: 'top-silk', x: 20 + index, y: 20,
        radius: 1, lineWidth: 0.2, filled: false,
    }));
    model.boardShapes.push(shape, ...unrelated);
    const groups = new Map([layer, 'top-silk'].map(id => [id, new Element('g')]));
    let fills = 0, clearances = 0;
    const app = {
        project, pcbDocument: model, placements: new Map(), netlist: [], history: new CommandHistory(), _active: true,
        viewport: { scale: 100, svg: new Element('svg'), hideCrosshair() {}, setCrosshair() {} },
        getLayerGroup: id => groups.get(id) || null, _layerGroups: groups, existingLayerGroups() { return this._layerGroups; },
        _shapeElements: new Map(), _textElements: new Map(),
        refreshFills() { fills++; }, _refreshBoardShapeClearance() { clearances++; },
        _cancelDrawingMode() {}, _clearCursorCrosshair() {}, markSectionClean() {}, _ensureViewport() {},
        _refreshPcbSelectionHighlights() {},
        propertiesItems: () => null,
    };
    for (const key of ['tracks', 'vias', 'pads', 'boardShapes', 'texts']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    for (const key of ['_cancelPosePreviews', 'isSectionEditing', '_onLayerVisibilityChanged', '_onLayerLockChanged',
        'setPropertiesTitle', 'clearProperties']) app[key] = PCBApp.prototype[key];
    project.registerView('pcb', app);
    const adapter = createBoardShapeSelectionAdapter(app, shape, `shape:${shape.id}`);
    setPcbSelection(app, [{ kind: 'shape', object: shape }]);
    renderBoardShape(app, shape);
    renderBoardShape(app, unrelated[0]);
    const start = { x: center.x + 10, y: center.y };
    const pointFor = angle => {
        const radians = (rotation - angle) * Math.PI / 180;
        return { x: center.x + 10 * Math.cos(radians), y: center.y + 10 * Math.sin(radians) };
    };
    return { app, project, model, shape, unrelated, adapter, center, start, pointFor, groups,
        fills: () => fills, clearances: () => clearances };
}

let cases = 0;
for (const layer of ['top-silk', 'bottom-silk', 'top-copper', 'bottom-copper']) {
    for (const finish of ['commit', 'cancel', 'no-op', 'deactivate', 'load', 'failure', 'missing',
        'panel', 'hidden', 'locked', 'deselect', 'remove']) {
        const f = fixture(layer);
        const { app, project, model, shape, unrelated, adapter, center, start, pointFor } = f;
        const before = model.captureGeometry(), serialized = model.serialize();
        const shapeState = captureBoardShapeState(shape);
        const points = shape.points, artwork = shape.artwork, otherElement = app._shapeElements.get(unrelated[0].id);
        const redo = { execute() {}, undo() {} };
        app.history.redoStack.push(redo);
        try {
            assert.equal(adapter.beginAnchorDrag('rotate', start), true);
            assert.equal(app.isSectionEditing(), true);
            const pickup = allocations, pickupClearances = f.clearances();
            for (let index = 0; index < 100; index++) adapter.updateAnchorDrag(center);
            assert.equal(allocations, pickup);
            assert.equal(f.clearances(), pickupClearances);
            assert.equal(app.boardShapes, model.boardShapes);
            assert.equal(getBoardShapeRotationPreview(app).boardShapes, undefined);
            adapter.updateAnchorDrag(pointFor(90));
            const copy = adapter.object, collection = app.boardShapes;
            assert.notEqual(copy, shape);
            assert.equal(collection[0], copy);
            assert.equal(collection[1], unrelated[0]);
            assert.equal(copy.artwork, artwork, 'Immutable artwork is shared, never duplicated');
            for (let angle = 91; angle <= 190; angle++) {
                adapter.updateAnchorDrag(pointFor(angle));
                assert.equal(app.boardShapes, collection);
                assert.equal(adapter.object, copy);
            }
            const renderedPoints = copy.points, repeated = allocations, repeatedClearances = f.clearances();
            for (let index = 0; index < 100; index++) adapter.updateAnchorDrag(pointFor(190.1));
            assert.equal(allocations, repeated);
            assert.equal(f.clearances(), repeatedClearances);
            assert.equal(copy.points, renderedPoints);
            assert.equal(shape.points, points);
            assert.equal(shape.artwork, artwork);
            assert.deepEqual(model.captureGeometry(), before);
            assert.deepEqual(model.serialize(), serialized);
            assert.deepEqual(adapter.getBounds(), boardShapeBounds(copy));
            const corner = copy.points[0];
            const interior = { x: center.x + (corner.x - center.x) * 0.95, y: center.y + (corner.y - center.y) * 0.95 };
            assert.notEqual(boardShapeHitTest(shape, interior, 0), boardShapeHitTest(copy, interior, 0));
            assert.equal(adapter.hitTest(interior, 0), boardShapeHitTest(copy, interior, 0));
            const rebuilt = createBoardShapeSelectionAdapter(app, copy, adapter.id);
            assert.equal(rebuilt.object, copy);
            assert.deepEqual(rebuilt.getAnchors(), adapter.getAnchors());
            assert.deepEqual(rebuilt.getLockPosition(interior, 100), adapter.getLockPosition(interior, 100));
            syncPcbSelection(app);
            assert.equal(getPcbSelection(app, 'shape')[0], copy);
            setBoardShapeHover(app, copy);
            assert.equal(getHoveredBoardShape(app), shape, 'Hover retains canonical identity while rendering the copy');
            renderBoardShape(app, shape, { liveDrag: true });
            assert.equal(app._shapeElements.get(shape.id).getAttribute('d'), boardShapeRemovalPathD(copy),
                'Canonical render requests retain displayed geometry');
            assert.equal(f.fills(), 0);
            assert.throws(() => project.serialize(), /Finish the current edit before saving/);
            await assert.rejects(prepareFabricationSnapshot(app), /Finish the current edit before exporting/);
            setPcbInteraction(app, '_pcbSelectionInteraction', { mode: 'anchor', adapter: rebuilt, moved: true,
                anchorId: 'rotate', anchor: { symbol: 'rotate' } });
            if (finish === 'commit') {
                const execute = app.history.execute.bind(app.history);
                app.history.execute = command => {
                    assert.equal(command.shape, shape);
                    assert.equal(app.boardShapes, model.boardShapes);
                    assert.deepEqual(model.captureGeometry(), before);
                    execute(command);
                };
                finishSelectionInteraction(app, true);
                assert.equal(app.history.undoStack.length, 1);
                const after = model.captureGeometry();
                app.history.undo();
                assert.deepEqual(model.captureGeometry(), before);
                app.history.redo();
                assert.deepEqual(model.captureGeometry(), after);
            } else if (finish === 'load') loadPcb(app, null);
            else if (finish === 'remove') {
                const command = new RemoveBoardShapeCommand(app, copy);
                assert.equal(command.shape, shape);
                app.history.execute(command);
                assert.equal(getSelectionInteraction(app), null);
                assert.equal(model.boardShapes.includes(shape), false);
                app.history.undo();
                assert.deepEqual(captureBoardShapeState(shape), shapeState);
                assert.equal(model.boardShapes.includes(shape), true);
            } else {
                if (finish === 'no-op') {
                    rebuilt.updateAnchorDrag(center);
                    assert.deepEqual(copy.points, points);
                    finishSelectionInteraction(app, true);
                } else if (finish === 'deactivate') PCBApp.prototype.deactivate.call(app);
                else if (finish === 'failure') {
                    app.history.execute = () => { throw new Error('Rejected image rotation'); };
                    assert.throws(() => finishSelectionInteraction(app, true), /Rejected image rotation/);
                } else if (finish === 'missing') {
                    model.boardShapes.splice(0, 1);
                    assert.throws(() => finishSelectionInteraction(app, true), /Cannot rotate a missing board shape/);
                } else if (finish === 'panel') app.setPropertiesTitle('Replacement');
                else if (finish === 'hidden') app._onLayerVisibilityChanged(layer, false);
                else if (finish === 'locked') app._onLayerLockChanged(layer, true);
                else if (finish === 'deselect') selectBoardShape(app, null);
                else {
                    for (const point of shape.points) Object.freeze(point);
                    Object.freeze(shape.points);
                    Object.freeze(shape);
                    assert.equal(PCBApp.prototype.handleKeyDown.call(app, { key: 'Escape' }), true);
                }
                if (finish !== 'missing') {
                    assert.deepEqual(model.captureGeometry(), before);
                    assert.deepEqual(model.serialize(), serialized);
                    assert.equal(shape.points, points, 'Discarding geometry does not restore into authored arrays');
                    assert.equal(f.fills(), 0, 'Discarded rotation does not repour unchanged copper');
                }
                assert.equal(app.history.canUndo(), false);
                assert.equal(app.history.redoStack[0], redo);
            }
            assert.equal(getBoardShapeRotationPreview(app), undefined);
            assert.equal(isRotationHandleDragActive(app), false);
            assert.equal(getSelectionInteraction(app), null);
            assert.equal(app.boardShapes, model.boardShapes);
            assert.equal(rebuilt.object, shape);
            assert.equal(app.isSectionEditing(), false);
            setBoardShapeHover(app, null);
            if (finish !== 'load') {
                assert.equal(app._shapeElements.get(unrelated[0].id), otherElement);
                assert.equal(app._shapeElements.size, finish === 'missing' ? 1 : 2);
                if (finish !== 'missing') assert.equal(app._shapeElements.get(shape.id).getAttribute('d'), boardShapeRemovalPathD(shape));
            } else assert.equal(app._shapeElements.size, 0);
            const finishedAllocations = allocations;
            rebuilt.updateAnchorDrag(pointFor(240));
            rebuilt.endAnchorDrag(true);
            assert.equal(allocations, finishedAllocations, 'Stale callbacks cannot restart the projection');
            cases++;
        } finally { cancelPictureCopperRefresh(app); }
    }
}

for (const changed of [false, true]) {
    const { app, model, shape, adapter, start, pointFor } = fixture('top-silk', 5000);
    const before = captureBoardShapeState(shape), collection = model.boardShapes;
    adapter.beginAnchorDrag('rotate', start);
    if (changed) {
        adapter.updateAnchorDrag(pointFor(90));
        const projected = app.boardShapes;
        for (let angle = 91; angle <= 190; angle++) {
            adapter.updateAnchorDrag(pointFor(angle));
            assert.equal(app.boardShapes, projected);
        }
        assert.equal(projected.length, 5001);
        assert.equal(projected[5000], collection[5000]);
    }
    app._cancelPosePreviews();
    assert.equal(app.boardShapes, collection);
    assert.deepEqual(captureBoardShapeState(shape), before);
    assert.equal(app.isSectionEditing(), false);
    assert.equal(getBoardShapeRotationPreview(app), undefined);
    cancelPictureCopperRefresh(app);
    cases++;
}

for (const action of ['undo', 'redo', 'move']) {
    const { app, model, shape, adapter, start, pointFor } = fixture();
    const before = model.captureGeometry();
    adapter.beginAnchorDrag('rotate', start);
    adapter.updateAnchorDrag(pointFor(90));
    adapter.endAnchorDrag(true);
    const rotated = model.captureGeometry();
    if (action === 'redo') app.history.undo();
    adapter.beginAnchorDrag('rotate', start);
    adapter.updateAnchorDrag(pointFor(180));
    setPcbInteraction(app, '_pcbSelectionInteraction', { mode: 'anchor', adapter, moved: true,
        anchorId: 'rotate', anchor: { symbol: 'rotate' } });
    if (action === 'move') {
        const copy = adapter.object;
        const next = createBoardShapeSelectionAdapter(app, copy, adapter.id);
        next.beginAnchorDrag(0, copy.points[0]);
        assert.equal(app.history.undoStack.length, 2);
        assert.equal(getBoardShapeRotationPreview(app), undefined);
        const movedBaseline = model.captureGeometry();
        endBoardShapeDrag(app, false);
        assert.deepEqual(model.captureGeometry(), movedBaseline);
        app.history.undo();
        assert.deepEqual(model.captureGeometry(), rotated);
    } else {
        PCBApp.prototype.handleKeyDown.call(app, { key: action === 'undo' ? 'z' : 'y', ctrlKey: true });
        assert.equal(getBoardShapeRotationPreview(app), undefined);
        assert.equal(getSelectionInteraction(app), null);
        assert.deepEqual(model.captureGeometry(), action === 'undo' ? before : rotated);
    }
    cancelPictureCopperRefresh(app);
    cases++;
}

for (const action of ['commit', 'cancel', 'update']) {
    const { app, model, shape, adapter, start, pointFor } = fixture();
    adapter.beginAnchorDrag('rotate', start);
    setPcbInteraction(app, '_pcbSelectionInteraction', { mode: 'anchor', adapter, moved: true,
        anchorId: 'rotate', anchor: { symbol: 'rotate' } });
    model.boardShapes.splice(model.boardShapes.indexOf(shape), 1);
    if (action === 'update') assert.throws(() => adapter.updateAnchorDrag(pointFor(90)), /Cannot rotate a missing board shape/);
    else if (action === 'commit') assert.throws(() => finishSelectionInteraction(app, true), /Cannot rotate a missing board shape/);
    else finishSelectionInteraction(app, false);
    assert.equal(getBoardShapeRotationPreview(app), undefined);
    assert.equal(getSelectionInteraction(app), null);
    assert.equal(app._shapeElements.has(shape.id), false);
    assert.equal(app.isSectionEditing(), false);
    cancelPictureCopperRefresh(app);
    cases++;
}
console.log(`PASS ${cases} image rotation cases: isolated snapshots, lazy copies, dynamic selection, exact history, lifecycle and bounded work`);
