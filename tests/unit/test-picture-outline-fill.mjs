import assert from 'node:assert/strict';
import Clipper from '../../assets/vendor/clipper.esm.js';
import { pictureShape, pictureRegions, pictureOutlineRings } from '../../src/shared/pcb/picture-raster.js';
import { pointInPolygon } from '../../src/core/geometry.js';

globalThis.window = { addEventListener() {} };
const { boardShapeFillPathD, boardShapeRemovalPathD } = await import('../../src/shared/pcb/board-shape-geometry.js');

const square = (x, y, size) => [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }];
// Even-odd traced artwork: a ring with an island in its hole, a shape on the frame edge,
// two squares touching at a corner and a lone triangle.
const contours = [
    square(4, 4, 24), square(8, 8, 16), square(12, 12, 8),
    [{ x: 0, y: 30 }, { x: 10, y: 30 }, { x: 10, y: 40 }, { x: 0, y: 40 }],
    square(32, 4, 6), square(38, 10, 6),
    [{ x: 34, y: 30 }, { x: 46, y: 32 }, { x: 38, y: 39 }],
];
const base = pictureShape({ width: 48, height: 40, contours }, { widthMm: 24, layer: 'top-silk', center: { x: 5, y: -3 } });

const parity = (rings, point) => rings.reduce((inside, ring) => inside !== pointInPolygon(point, ring), false);
const merged = (regions, point) => regions.some(({ outer, holes }) =>
    pointInPolygon(point, outer) && !holes.some(hole => pointInPolygon(point, hole)));
const rotate = (points, degrees) => {
    const angle = degrees * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    return points.map(({ x, y }) => ({ x: x * cos - y * sin + 7, y: x * sin + y * cos - 2 }));
};

let cases = 0;
for (const invert of [false, true]) for (const flipHorizontal of [false, true]) for (const flipVertical of [false, true])
for (const layer of ['top-silk', 'bottom-silk']) for (const degrees of [0, 33]) {
    const shape = { ...base, layer, points: rotate(base.points, degrees),
        artwork: { ...base.artwork, invert, flipHorizontal, flipVertical } };
    const rings = pictureOutlineRings(shape);
    assert.equal(rings.length, contours.length + (invert ? 1 : 0));
    const regions = pictureRegions(shape);
    const xs = shape.points.map(point => point.x), ys = shape.points.map(point => point.y);
    let filled = 0;
    for (let i = 0; i <= 120; i++) for (let j = 0; j <= 120; j++) {
        const point = { x: Math.min(...xs) + (Math.max(...xs) - Math.min(...xs)) * (i + 0.37) / 121,
            y: Math.min(...ys) + (Math.max(...ys) - Math.min(...ys)) * (j + 0.61) / 121 };
        const expected = merged(regions, point);
        assert.equal(parity(rings, point), expected,
            `even-odd outline matches the merged picture at ${point.x},${point.y} (invert ${invert}, flips ${flipHorizontal}/${flipVertical}, ${layer}, ${degrees}°)`);
        if (expected) filled++;
    }
    assert.ok(filled > 100, 'samples cover filled picture area');
    cases++;
}
assert.equal(cases, 32);

const originalExecute = Clipper.Clipper.prototype.Execute;
try {
    Clipper.Clipper.prototype.Execute = () => { throw new Error('Fill-only rendering must not merge traced artwork'); };
    const fresh = { ...base, artwork: { ...base.artwork, invert: true } };
    const d = boardShapeFillPathD(fresh);
    assert.equal((d.match(/M /g) || []).length, contours.length + 1, 'one subpath per traced ring plus the frame');
} finally {
    Clipper.Clipper.prototype.Execute = originalExecute;
}

const rectangles = pictureShape({ width: 4, height: 4, rectangles: [{ x: 0, y: 0, width: 2, height: 2 }, { x: 1, y: 1, width: 2, height: 2 }] },
    { widthMm: 4, layer: 'top-silk' });
assert.equal(pictureOutlineRings(rectangles), null, 'overlapping rectangles keep the non-zero merge');
assert.equal(boardShapeFillPathD(rectangles), boardShapeRemovalPathD(rectangles));
const polygon = { kind: 'polygon', layer: 'top-silk', filled: true, lineWidth: 0.2,
    points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 5 }] };
assert.equal(boardShapeFillPathD(polygon), boardShapeRemovalPathD(polygon), 'other shapes are unchanged');

console.log('PASS traced pictures fill from their raw even-odd rings without merging, matching merged geometry in 32 transforms');
