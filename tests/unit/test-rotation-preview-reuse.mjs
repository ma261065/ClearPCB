import assert from 'node:assert/strict';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { createPcbText } from '../../src/core/pcb-text.js';
import { Pad } from '../../src/shapes/pad.js';
import { createPcbTextSelectionAdapter } from '../../src/pcb/modules/pcb-text-selection.js';
import { createPadSelectionAdapter } from '../../src/pcb/modules/pad-selection.js';
import { padCopperPathD, padOutline } from '../../src/pcb/modules/pad.js';
import { cancelPictureCopperRefresh } from '../../src/pcb/modules/picture-refresh.js';
import { getTextPosePreviewTexts } from '../../src/pcb/modules/text-commands.js';
import { isRotationHandleDragActive } from '../../src/pcb/modules/rotation-handle.js';
import { clearanceOverlayState } from '../../src/pcb/modules/clearance-overlay.js';
import { getBoardShapeElement } from '../../src/pcb/modules/board-shapes.js';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';

const inputs = new Map();
const document = installFakeDom();
document.getElementById = id => inputs.get(id) || null;
document.createElementNS = (_namespace, tag) => {
    const node = fakeElement(tag);
    node.attributes = new Map();
    const setAttribute = node.setAttribute.bind(node);
    node.setAttribute = (name, value) => { node.attributes.set(name, String(value)); setAttribute(name, value); };
    node.getAttribute = name => node.attributes.get(name) ?? null;
    return node;
};
for (const kind of ['text', 'pad']) {
    const originalRotation = 12.3456789;
    const object = kind === 'text'
        ? createPcbText({ id: 'text', x: Math.PI, y: -Math.E, rotation: originalRotation })
        : new Pad({ id: 'pad', x: Math.PI, y: -Math.E, rotation: originalRotation,
            shape: 'rectangle', layers: 'top-copper', drill: 0 });
    const startingRotation = object.rotation;
    const pcbDocument = new PcbDocument();
    if (kind === 'text') pcbDocument.texts.set(object.id, object);
    else pcbDocument.pads.push(object);
    let renders = 0, inputWrites = 0, clearanceInvalidations = 0, highlightUpdates = 0;
    const input = { _value: '', get value() { return this._value; },
        set value(value) { this._value = value; inputWrites++; } };
    inputs.set(kind === 'text' ? 'pcbPropTextRot' : 'pcbPropPadRotation', input);
    const copper = {
        children: [],
        appendChild(child) { this.children.push(child); child.parentNode = this; renders++; },
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
    };
    const highlight = {
        dataset: { padId: object.id }, attributes: new Map(),
        classList: { contains: name => name === 'pcb-box-pad-sel' },
        setAttribute(name, value) {
            this.attributes.set(name, value);
            if (name === 'points') highlightUpdates++;
        },
    };
    const overlay = { querySelectorAll: () => [highlight] };
    const app = {
        pcbDocument, get texts() { return getTextPosePreviewTexts(this) || pcbDocument.texts; },
        pads: pcbDocument.pads, history: new CommandHistory(),
        getLayerGroup: layer => layer === 'top-copper' ? copper : layer === 'selection-overlay' ? overlay : null,
        refreshText: () => renders++,
    };
    clearanceOverlayState(app).boardShapeClearanceCache.set(object.id, { elements: [{
            parentNode: { removeChild: () => clearanceInvalidations++ },
    }] });
    const adapter = kind === 'text' ? createPcbTextSelectionAdapter(app, object, `text:${object.id}`)
        : createPadSelectionAdapter(app, object, `pad:${object.id}`);
    const pointFor = (rotation, initial = startingRotation) => {
        const radians = (initial - rotation) * Math.PI / 180;
        return { x: object.x + 10 * Math.cos(radians), y: object.y + 10 * Math.sin(radians) };
    };
    const start = { x: object.x + 10, y: object.y };
    try {
        assert.equal(adapter.beginAnchorDrag('rotate', start), true);
        const beforeClearance = clearanceInvalidations;
        for (let index = 0; index < 100; index++) adapter.updateAnchorDrag(pointFor(37 + index / 1000));
        assert.equal(adapter.object.rotation, 37);
        assert.equal(object.rotation, startingRotation, 'Authored rotation stays unchanged');
        assert.equal(renders, 1, `${kind}: 100 events resolving to one angle render once`);
        assert.equal(inputWrites, 1, `${kind}: unchanged angles do not rewrite the rotation input`);
        assert.equal(input.value, '37');
        if (kind === 'pad') assert.equal(highlightUpdates, 1, 'Unchanged angles retain pad highlight geometry');
        if (kind === 'text') assert.equal(clearanceInvalidations - beforeClearance, 1,
            'Unchanged text rotations do not repeat clearance invalidation');
        assert.equal(app.history.canUndo(), false);
        for (let angle = 90; angle < 190; angle++) {
            adapter.updateAnchorDrag(pointFor(angle));
            assert.equal(adapter.object.rotation, angle);
        }
        assert.equal(renders, 101, `${kind}: every distinct angle still renders immediately`);
        assert.equal(inputWrites, 101);
        if (kind === 'pad') {
            assert.equal(highlightUpdates, 101);
            assert.equal(copper.children.length, 1);
            assert.equal(copper.children[0].attributes.get('d'), padCopperPathD(adapter.object));
            assert.equal(highlight.attributes.get('points'), padOutline({ ...adapter.object, x: 0, y: 0 })
                .map(point => `${point.x},${point.y}`).join(' '));
            assert.equal(highlight.attributes.get('transform'), `translate(${object.x},${object.y})`);
        }
        adapter.updateAnchorDrag(pointFor(189.49));
        assert.equal(renders, 101, 'Sub-degree pointer movement retains the existing one-degree rounding');
        adapter.updateAnchorDrag(pointFor(189.51));
        assert.equal(adapter.object.rotation, 190);
        assert.equal(renders, 102);
        adapter.endAnchorDrag(true);
        assert.equal(app.history.undoStack.length, 1);
        assert.equal(isRotationHandleDragActive(app), false);
        app.history.undo();
        assert.equal(object.rotation, startingRotation, 'Undo preserves the original fractional rotation');
        adapter.beginAnchorDrag('rotate', start);
        adapter.updateAnchorDrag(pointFor(90));
        adapter.updateAnchorDrag({ x: object.x, y: object.y });
        assert.equal(adapter.object.rotation, startingRotation, 'Centre fallback restores the exact fractional angle');
        const fractionalCenterRenders = renders;
        for (let index = 0; index < 100; index++) adapter.updateAnchorDrag({ x: object.x, y: object.y });
        assert.equal(renders, fractionalCenterRenders);
        adapter.endAnchorDrag(true);
        assert.equal(app.history.undoStack.length, 0, 'Returning to the starting angle records no history');
        assert.equal(app.history.canRedo(), true, 'A no-op drop preserves redo history');
        app.history.redo();
        assert.equal(object.rotation, 190);

        adapter.beginAnchorDrag('rotate', start);
        const beforeCenter = renders;
        for (let index = 0; index < 100; index++) adapter.updateAnchorDrag({ x: object.x, y: object.y });
        assert.equal(renders, beforeCenter, 'Repeated centre points preserve the starting rotation without redraw');
        adapter.updateAnchorDrag(pointFor(359.6, 190));
        assert.equal(adapter.object.rotation, 0, 'Angle wrapping remains unchanged');
        adapter.endAnchorDrag(false);
        assert.equal(object.rotation, 190);
        assert.equal(app.history.undoStack.length, 1, 'Cancel records no history');
        assert.equal(isRotationHandleDragActive(app), false);
    } finally {
        cancelPictureCopperRefresh(app);
        inputs.clear();
    }
}
globalThis.window = { addEventListener() {} };
const { pictureShape } = await import('../../src/shared/pcb/picture-raster.js');
const { createBoardShapeSelectionAdapter } = await import('../../src/pcb/modules/board-shapes.js');
const { rotatedImagePoints } = await import('../../src/pcb/modules/rotation-handle.js');
for (const layer of ['top-silk', 'bottom-copper']) {
    const shape = pictureShape({ width: 4, height: 2, rectangles: [{ x: 0, y: 0, width: 4, height: 2 }] },
        { widthMm: 8, layer, center: { x: Math.PI, y: -Math.E } });
    shape.id = `image-${layer}`;
    shape.points = rotatedImagePoints(shape.points, { x: Math.PI, y: -Math.E }, 12.3456789);
    const initialPoints = structuredClone(shape.points);
    const center = { x: (shape.points[0].x + shape.points[2].x) / 2,
        y: (shape.points[0].y + shape.points[2].y) / 2 };
    const startingRotation = ((-Math.atan2(shape.points[1].y - shape.points[0].y,
        shape.points[1].x - shape.points[0].x) * 180 / Math.PI) % 360 + 360) % 360;
    const pointFor = rotation => {
        const radians = (startingRotation - rotation) * Math.PI / 180;
        return { x: center.x + 10 * Math.cos(radians), y: center.y + 10 * Math.sin(radians) };
    };
    let renders = 0, inputWrites = 0, clearanceRequests = 0;
    const input = { _value: '', get value() { return this._value; },
        set value(value) { this._value = value; inputWrites++; } };
    inputs.set('pcbPropImageRot', input);
    const group = {
        children: [], style: {},
        appendChild(child) { this.children.push(child); child.parentNode = this; renders++; },
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
    };
    const clearanceOverlay = {
        children: [], style: {},
        appendChild(child) { this.children.push(child); child.parentNode = this; },
        removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
    };
    const pcbDocument = new PcbDocument();
    pcbDocument.boardShapes.push(shape);
    const app = {
        pcbDocument, boardShapes: pcbDocument.boardShapes, history: new CommandHistory(), _shapeElements: new Map(),
        getLayerGroup: id => id === layer ? group : id === 'clearance-overlay' ? clearanceOverlay : null,
        existingLayerGroups: () => new Map([[layer, group], ['clearance-overlay', clearanceOverlay]]),
        getRoutingParams: () => ({ clearance: 0.25 }),
    };
    clearanceOverlayState(app).clearancesVisible = true;
    const staleClearance = {};
    staleClearance.parentNode = { removeChild: child => { clearanceRequests++; child.parentNode = null; } };
    clearanceOverlayState(app).boardShapeClearanceCache.set(shape.id, { elements: [staleClearance] });
    const adapter = createBoardShapeSelectionAdapter(app, shape, `shape:${shape.id}`);
    const start = { x: center.x + 10, y: center.y };
    try {
        assert.equal(adapter.beginAnchorDrag('rotate', start), true);
        adapter.updateAnchorDrag(pointFor(37));
        const retainedPoints = adapter.object.points;
        const retainedElement = getBoardShapeElement(app, shape.id);
        for (let index = 1; index < 100; index++) adapter.updateAnchorDrag(pointFor(37 + index / 1000));
        assert.equal(renders, 1, '100 image events resolving to one angle render once');
        assert.equal(inputWrites, 1);
        assert.equal(clearanceRequests, 1, 'Unchanged image rotations hide stale clearance once');
        assert.equal(input.value, '37');
        assert.equal(adapter.object.points, retainedPoints, 'Unchanged image angles retain geometry identity');
        assert.deepEqual(shape.points, initialPoints, 'Image rotation leaves authored points unchanged');
        assert.equal(getBoardShapeElement(app, shape.id), retainedElement, 'Unchanged image angles retain the SVG node');
        assert.equal(app.history.canUndo(), false);
        for (let angle = 90; angle < 190; angle++) {
            adapter.updateAnchorDrag(pointFor(angle));
            assert.deepEqual(adapter.object.points, rotatedImagePoints(initialPoints, center, angle - startingRotation),
                'Each preview is calculated from the original points without accumulating drift');
            assert.equal(input.value, String(angle));
        }
        assert.equal(renders, 101, 'Every distinct image angle renders immediately');
        assert.equal(inputWrites, 101);
        assert.equal(clearanceRequests, 1, 'Pending image rotations do not repeatedly detach stale clearance');
        adapter.updateAnchorDrag(pointFor(189.49));
        assert.equal(renders, 101);
        adapter.updateAnchorDrag(pointFor(189.51));
        assert.equal(renders, 102);
        assert.equal(input.value, '190');
        adapter.updateAnchorDrag(pointFor(359.6));
        assert.equal(input.value, '0');
        const committedPoints = structuredClone(adapter.object.points);
        adapter.endAnchorDrag(true);
        assert.equal(isRotationHandleDragActive(app), false);
        assert.equal(app.history.undoStack.length, 1);
        app.history.undo();
        assert.deepEqual(shape.points, initialPoints, 'Image undo restores exact fractional geometry');
        adapter.beginAnchorDrag('rotate', start);
        const beforeCenter = renders;
        for (let index = 0; index < 100; index++) adapter.updateAnchorDrag(center);
        assert.equal(renders, beforeCenter, 'Centre events at pickup leave unchanged image geometry alone');
        adapter.updateAnchorDrag(pointFor(90));
        adapter.updateAnchorDrag(center);
        assert.deepEqual(adapter.object.points, initialPoints, 'Returning to the centre restores original points exactly');
        const returnedPoints = adapter.object.points;
        const afterCenter = renders;
        for (let index = 0; index < 100; index++) adapter.updateAnchorDrag(center);
        assert.equal(renders, afterCenter);
        assert.equal(adapter.object.points, returnedPoints);
        adapter.endAnchorDrag(true);
        assert.equal(app.history.undoStack.length, 0, 'Returning to the original angle records no image history');
        assert.equal(app.history.canRedo(), true);
        app.history.redo();
        assert.deepEqual(shape.points, committedPoints);
        adapter.beginAnchorDrag('rotate', start);
        const beforeNewGesture = renders;
        adapter.updateAnchorDrag(pointFor(90));
        assert.equal(renders, beforeNewGesture + 1, 'A new gesture does not reuse the previous gesture angle');
        adapter.endAnchorDrag(false);
        assert.deepEqual(shape.points, committedPoints, 'Cancellation restores the committed image geometry');
        assert.equal(app.history.undoStack.length, 1);
        assert.equal(group.children.length, 1, 'Image redraws replace rather than accumulate SVG nodes');
    } finally {
        cancelPictureCopperRefresh(app);
        inputs.clear();
    }
}
delete globalThis.window;
delete globalThis.document;
console.log('PASS unchanged text/pad/image rotation reuse, one-degree boundaries, centre handling and precise history');
