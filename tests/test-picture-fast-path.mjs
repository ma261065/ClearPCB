import assert from 'node:assert/strict';
import Clipper from '../assets/vendor/clipper.esm.js';
import { pictureShape, drawPicture, drawPictureCached, pictureCirclePathD, canDrawPictureCircles, pictureRegions, pictureTriangles } from '../src/pcb/modules/picture-raster.js';
import { pointInPolygon } from '../src/core/geometry.js';

globalThis.window = { addEventListener() {} };
const { boardShapeRemovalPathD, resolveBoardShapeGeometry } = await import('../src/pcb/modules/board-shape-geometry.js');
const { boardShapeClearanceOutlines, computeFillPolygons } = await import('../src/pcb/modules/copper-fill-geom.js');
const { collectCopperArtwork } = await import('../src/pcb/modules/copper-artwork.js');
const { Board2D } = await import('../src/pcb/modules/board2d.js');
const { collectCopper } = await import('../src/pcb/modules/drc.js');
const artwork = { width: 1000, height: 500, circles: Array.from({ length: 20000 }, (_, index) => ({
    x: index % 200 * 5 + 2.5, y: Math.floor(index / 200) * 5 + 2.5, radius: 2,
})) };
const originalExecute = Clipper.Clipper.prototype.Execute;
let shape;
let arcs = 0;
const transforms = [];
const rules = [];
const context = { beginPath() {}, save() {}, restore() {}, moveTo() {}, lineTo() {}, closePath() {},
    transform(...values) { transforms.push(values); }, arc() { arcs++; }, fill(rule) { rules.push(rule); } };
try {
    Clipper.Clipper.prototype.Execute = () => { throw new Error('Unexpected artwork polygon operation'); };
    shape = pictureShape(artwork, { widthMm: 100, layer: 'top-silk', center: { x: 50, y: 25 } });
    assert.equal(resolveBoardShapeGeometry(shape).image, shape);
    for (const invert of [false, true]) {
        const image = { ...shape, artwork: { ...shape.artwork, invert, flipHorizontal: true, flipVertical: true } };
        drawPicture(context, image);
        const path = boardShapeRemovalPathD(image);
        assert.equal((path.match(/ A /g) || []).length, 40000);
        assert.deepEqual(boardShapeClearanceOutlines(image, 0.1), [], 'Silk needs no artwork or clearance processing');
    }
    const viewer = Object.create(Board2D.prototype);
    viewer.side = 'top';
    viewer.data = { boardShapes: [shape], placements: new Map() };
    viewer._drawSilk(context);
} finally {
    Clipper.Clipper.prototype.Execute = originalExecute;
}
assert.equal(arcs, 60000);
assert.deepEqual(rules, ['nonzero', 'nonzero', 'nonzero']);
assert.deepEqual(transforms[0], [0.1, 0, 0, 0.1, 0, 0]);
let pathArcs = 0;
class CachedPath {
    moveTo() {} lineTo() {} closePath() {}
    arc() { pathArcs++; }
}
const paths = [];
const cachedContext = { ...context, canvas: { ownerDocument: { defaultView: { Path2D: CachedPath } } },
    fill(path, rule) { assert.equal(rule, 'nonzero'); paths.push(path); } };
drawPicture(cachedContext, shape);
drawPicture(cachedContext, { ...shape, points: shape.points.map(point => ({ x: point.x + 10, y: point.y })) });
assert.equal(pathArcs, 20000, 'Redraw and movement reuse the source circle path');
assert.equal(paths[0], paths[1]);
drawPicture(cachedContext, { ...shape, artwork: { ...shape.artwork, flipHorizontal: true } });
assert.equal(pathArcs, 40000, 'Artwork replacement invalidates the path cache');
assert.notEqual(paths[0], paths[2]);
let rasterizations = 0;
const blits = [];
const bitmapDocument = { createElement() {
    return { getContext() { return { ...context, setTransform() {}, fill() { rasterizations++; } }; } };
} };
let screenScale = 5;
const bitmapContext = { ...context, canvas: { ownerDocument: bitmapDocument }, fillStyle: '#ffffff',
    getTransform() { return { a: screenScale, b: 0, c: 0, d: screenScale, e: 0, f: 0 }; },
    drawImage(canvas) { blits.push(canvas); } };
drawPictureCached(bitmapContext, shape);
drawPictureCached(bitmapContext, { ...shape, points: shape.points.map(point => ({ x: point.x + 10, y: point.y })) });
assert.equal(rasterizations, 1, 'Panning/moving blits the cached picture without rasterizing dots');
assert.equal(blits[0], blits[1]);
assert.equal(blits[0].width, 512);
screenScale = 10;
drawPictureCached(bitmapContext, shape);
assert.equal(rasterizations, 2, 'Zooming rebuilds at sufficient resolution');
assert.equal(blits[2].width, 1024);
bitmapContext.fillStyle = '#aa0000';
drawPictureCached(bitmapContext, shape);
assert.equal(rasterizations, 3, 'A layer color change invalidates the bitmap');
drawPictureCached(bitmapContext, { ...shape, artwork: { ...shape.artwork, invert: true } });
assert.equal(rasterizations, 4, 'An artwork edit invalidates the bitmap');
screenScale = 100;
drawPictureCached(bitmapContext, shape);
assert.equal(blits.length, 5, 'High zoom uses native curves rather than a blurry capped bitmap');
assert.equal(canDrawPictureCircles({ ...artwork, invert: true, circles: [{ x: 5, y: 5, radius: 3 }, { x: 6, y: 5, radius: 3 }] }), false);
assert.equal(pictureCirclePathD({ ...shape, artwork: { width: 1, height: 1, rectangles: [] } }), null);

const copper = { ...shape, layer: 'top-copper', net: 'LOGO' };
Object.defineProperty(copper, 'artwork', { get() { throw new Error('Clearance must not inspect dots'); } });
const collected = collectCopperArtwork({ boardShapes: [copper] }, { pictureBounds: true });
assert.equal(collected.areas.length, 1);
assert.equal(collected.areas[0].outer.length, 4);
assert.deepEqual(collected.areas[0].holes, []);
assert.equal(collectCopper({ placements: new Map(), boardShapes: [copper] }).areas.length, 1, 'Production DRC uses picture bounds');
const outlines = boardShapeClearanceOutlines(copper, 0.2);
assert.equal(outlines.length, 1);
assert.ok(pointInPolygon({ x: 50, y: 25 }, outlines[0]));
assert.ok(outlines[0].length < 100, 'Clearance complexity is independent of dot count');
const fill = { layer: 'top-copper', net: 'GND', outline: [{ x: -10, y: -10 }, { x: 110, y: -10 }, { x: 110, y: 60 }, { x: -10, y: 60 }] };
const compute = shapes => computeFillPolygons(fill, { boardShapes: shapes, params: { clearance: 0.2 } }, Clipper);
const occupies = (regions, point) => regions.some(region => pointInPolygon(point, region.outer)
    && !region.holes.some(hole => pointInPolygon(point, hole)));
const regions = compute([copper]);
assert.equal(occupies(regions, { x: 50, y: 25 }), false, 'Pour cannot enter gaps inside the image bounds');
assert.equal(occupies(regions, { x: -5, y: 25 }), true);
const sameNet = Object.create(copper);
sameNet.net = 'GND';
assert.equal(occupies(compute([sameNet]), { x: 50, y: 25 }), true, 'Same-net solid-connection rule is unchanged');
const opposite = Object.create(copper);
opposite.layer = 'bottom-copper';
assert.equal(occupies(compute([opposite]), { x: 50, y: 25 }), true);
const rotated = Object.create(copper);
rotated.points = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 5, y: 15 }, { x: -5, y: 5 }];
const rotatedOutline = boardShapeClearanceOutlines(rotated, 0.1)[0];
assert.ok(pointInPolygon({ x: 2.5, y: 7.5 }, rotatedOutline));
assert.equal(pointInPolygon({ x: 9, y: 1 }, rotatedOutline), false, 'Use rotated bounds, not an axis-aligned box');
const small = pictureShape({ width: 10, height: 10, circles: [{ x: 5, y: 5, radius: 2 }] }, { widthMm: 10, layer: 'top-silk' });
const firstRegions = pictureRegions(small);
const firstTriangles = pictureTriangles(small);
assert.equal(pictureRegions(small), firstRegions);
assert.equal(pictureTriangles(small), firstTriangles);
small.points = small.points.map(point => ({ x: point.x + 10, y: point.y }));
assert.deepEqual(pictureTriangles(small), firstTriangles.map(triangle => triangle.map(point => ({ x: point.x + 10, y: point.y }))));
console.log('PASS 20000-dot native drawing without Clipper, native inversion, single-object pour/clearance and lazy geometry caching');