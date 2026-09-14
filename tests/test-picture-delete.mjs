import assert from 'node:assert/strict';
import { pictureShape } from '../src/pcb/modules/picture-raster.js';

const element = () => ({
    children: [], parentNode: null, style: {}, attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    removeAttribute(name) { this.attributes.delete(name); },
    appendChild(child) { this.children.push(child); child.parentNode = this; },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; },
    querySelectorAll() { return []; },
});
globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: element, getElementById() { return null; } };
const { renderBoardShape, setBoardShapeHover } = await import('../src/pcb/modules/board-shapes.js');
const { AddBoardShapeCommand, RemoveBoardShapeCommand } = await import('../src/pcb/modules/shape-commands.js');
const { setPcbSelection, getPcbSelectionEntries } = await import('../src/pcb/modules/selection-registry.js');
const image = { ...pictureShape({ width: 2, height: 2, rectangles: [{ x: 0, y: 0, width: 2, height: 2 }] },
    { widthMm: 2, layer: 'top-copper' }), id: 'pshape_1' };
const layer = element();
const overlay = element();
const app = { boardShapes: [image], placements: new Map(), tracks: [], vias: [], texts: new Map(),
    _shapeElements: new Map(), _boardShapeClearanceCache: new Map(), viewport: { scale: 10 },
    _getLayerGroup(id) { return id === 'top-copper' ? layer : null; } };
setPcbSelection(app, [{ kind: 'shape', object: image }]);
setBoardShapeHover(app, image);
const halo = element();
overlay.appendChild(halo);
app._boardShapeClearanceCache.set(image.id, { elements: [halo] });
renderBoardShape(app, image, { liveDrag: true });
assert.equal(app._hoveredShape, image, 'Normal redraw preserves hover');
assert.equal(overlay.children.length, 1, 'Normal redraw preserves the cached halo');
assert.equal(layer.children.length, 1);
const deletion = new RemoveBoardShapeCommand(app, image);
deletion.execute();
assert.equal(app.boardShapes.length, 0);
assert.equal(layer.children.length, 0);
assert.equal(overlay.children.length, 0);
assert.equal(app._boardShapeClearanceCache.has(image.id), false);
assert.equal(app._hoveredShape, null);
assert.equal(getPcbSelectionEntries(app).length, 0);
setBoardShapeHover(app, null);
assert.equal(layer.children.length, 0, 'Pointer movement cannot resurrect a deleted image');
deletion.undo();
assert.equal(app.boardShapes.length, 1);
assert.equal(layer.children.length, 1, 'Undo restores exactly one image');
setBoardShapeHover(app, image);
deletion.execute();
setBoardShapeHover(app, null);
assert.equal(layer.children.length, 0, 'Redo leaves no ghost');
const addition = new AddBoardShapeCommand(app, image);
addition.execute();
setBoardShapeHover(app, image);
addition.undo();
setBoardShapeHover(app, null);
assert.equal(layer.children.length, 0, 'Undo import clears the hover reference too');
console.log('PASS image deletion, hover cleanup, clearance cleanup and undo/redo without ghosts');