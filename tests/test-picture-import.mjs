import assert from 'node:assert/strict';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { rasterizePicture, pictureShape } from '../src/pcb/modules/picture-raster.js';
import { pointInPolygon } from '../src/core/geometry.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { getElementById() { return null; }, createElementNS() {
    const attributes = new Map();
    return { style: {}, setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name); }, removeAttribute(name) { attributes.delete(name); },
        appendChild() {}, remove() {}, querySelectorAll() { return []; } };
} };
const { AddBoardShapeCommand, MoveBoardShapeCommand, ModifyBoardShapeCommand } = await import('../src/pcb/modules/shape-commands.js');
const { setPcbSelection, getPcbSelectionEntries } = await import('../src/pcb/modules/selection-registry.js');
const { boardShapeBounds, boardShapeHitTest, resolveBoardShapeGeometry } = await import('../src/pcb/modules/board-shape-geometry.js');
const { serializeBoardShapes, loadBoardShapes,
    cloneShapeGeometry, translateShapeGeometry } = await import('../src/pcb/modules/board-shapes.js');
const { boardShapeClearanceOutlines } = await import('../src/pcb/modules/copper-fill-geom.js');
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
const { collectCopperArtwork } = await import('../src/pcb/modules/copper-artwork.js');
const { copperShapesTouch } = await import('../src/pcb/modules/track-contact-geometry.js');
const { resolveTrackDrawSnap } = await import('../src/pcb/modules/track-draw.js');

const data = new Uint8ClampedArray(3 * 3 * 4);
for (let index = 0; index < 9; index++) data.set(index === 4 ? [0, 0, 0, 255] : [255, 255, 255, 255], index * 4);
const raster = rasterizePicture({ data, width: 3, height: 3 });
for (const layer of ['top-silk', 'bottom-silk', 'top-copper', 'bottom-copper']) {
    const image = { ...pictureShape(raster, { widthMm: 3, layer }), id: 'pshape_1' };
    const shapes = [image];
    const bounds = shapes.map(boardShapeBounds);
    assert.equal(Math.min(...bounds.map(bound => bound.minX)), -1.5);
    assert.equal(Math.max(...bounds.map(bound => bound.maxX)), 1.5);
    assert.equal(Math.min(...bounds.map(bound => bound.minY)), -1.5);
    assert.equal(Math.max(...bounds.map(bound => bound.maxY)), 1.5);
    for (let row = 0; row < 3; row++) {
        for (let column = 0; column < 3; column++) {
            const point = { x: column - 1, y: row - 1 };
            assert.equal(boardShapeHitTest(image, point), true, 'The whole image is selectable');
            assert.equal(resolveBoardShapeGeometry(image).physicalContours.filter(contour => pointInPolygon(point, contour)).length % 2 === 1,
                row !== 1 || column !== 1, 'White centre remains a hole in the artwork');
        }
    }
    assert.equal(boardShapeClearanceOutlines(shapes[0], 0.1).length > 0, layer.endsWith('copper'));
    const copper = collectCopperArtwork({ boardShapes: shapes });
    assert.equal(copper.segments.length, 0, 'Image bounding edges are not copper tracks');
    assert.equal(copper.areas.some(area => pointInPolygon({ x: 0, y: 0 }, area.outer)
        && !area.holes.some(hole => pointInPolygon({ x: 0, y: 0 }, hole))), false);
    assert.equal(copper.areas.some(area => pointInPolygon({ x: -1, y: -1 }, area.outer)), layer.endsWith('copper'));
    const circle = { kind: 'circle', x: 0, y: 0, radius: 0.1, filled: true, lineWidth: 0.05 };
    assert.equal(copperShapesTouch(image, circle), false, 'No electrical contact inside transparent pixels');
    assert.equal(copperShapesTouch(circle, image), false);
    assert.equal(copperShapesTouch(image, { ...circle, x: -1 }), true);
    const snapApp = { boardShapes: shapes, tracks: [], vias: [], placements: new Map(),
        _trackToolLayer: layer, viewport: { scale: 100, snapToGrid: false } };
    assert.equal(resolveTrackDrawSnap(snapApp, { x: 0, y: 0 }).copperContact, false);
    assert.equal(resolveTrackDrawSnap(snapApp, { x: -1, y: 0 }).copperContact, layer.endsWith('copper'));
    const gerbers = exportGerbers({ placements: new Map(), boardWidth: 10, boardHeight: 10,
        boardX: -5, boardY: -5, boardShapes: shapes });
    const filesByLayer = { 'top-silk': 'board.gto', 'bottom-silk': 'board.gbo', 'top-copper': 'board.gtl', 'bottom-copper': 'board.gbl' };
    for (const [target, filename] of Object.entries(filesByLayer)) {
        assert.equal(gerbers.get(filename).includes('G36*'), target === layer, 'Image regions export only on their target artwork layer');
    }
    const original = { ...shapes[0], id: 'original' };
    let fills = 0;
    let views = 0;
    const app = { boardShapes: [original], placements: new Map(), tracks: [], vias: [], texts: new Map(),
        _shapeElements: new Map(), _getLayerGroup() { return null; }, viewport: { scale: 10 },
        _refreshFills() { fills++; }, _board3d: { refresh() { views++; } } };
    setPcbSelection(app, [{ kind: 'shape', object: original }]);
    const history = new CommandHistory();
    history.execute(new AddBoardShapeCommand(app, image));
    setPcbSelection(app, [{ kind: 'shape', object: image }]);
    assert.equal(history.undoStack.length, 1);
    assert.equal(app.boardShapes.length, shapes.length + 1);
    assert.deepEqual(getPcbSelectionEntries(app).map(entry => entry.object), shapes);
    assert.equal(fills, 1);
    assert.equal(views, 1);
    const saved = serializeBoardShapes(app);
    const restored = { boardShapes: [], _shapeIdCounter: 1 };
    loadBoardShapes(restored, saved, { render: false });
    assert.deepEqual(serializeBoardShapes(restored), saved);
    history.undo();
    assert.deepEqual(app.boardShapes, [original]);
    assert.deepEqual(getPcbSelectionEntries(app), []);
    history.redo();
    assert.deepEqual(app.boardShapes, [original, ...shapes]);
    assert.equal(fills, 3);
    assert.equal(views, 3);
    const beforeMove = cloneShapeGeometry(image);
    const afterMove = translateShapeGeometry(beforeMove, 5, 8);
    history.execute(new MoveBoardShapeCommand(app, image, beforeMove, afterMove));
    assert.deepEqual(image.points, afterMove.points);
    history.undo();
    assert.deepEqual(image.points, beforeMove.points);
    history.redo();
    assert.deepEqual(image.points, afterMove.points);
    const beforeLayer = { ...image, geom: cloneShapeGeometry(image) };
    history.execute(new ModifyBoardShapeCommand(app, image, beforeLayer, { ...beforeLayer, layer: 'bottom-copper' }));
    assert.equal(image.layer, 'bottom-copper');
    history.undo();
    assert.equal(image.layer, layer);
    assert.deepEqual(image.artwork.rectangles, raster.rectangles);
}
console.log('PASS single image import, transparent artwork, copper clearance, Gerber, save/load and move/layer undo/redo');