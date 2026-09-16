import assert from 'node:assert/strict';
import { layoutReferenceText, referenceAnchor, resolveReferenceText } from '../src/pcb/modules/reference-text.js';
import { applyRefGeometry } from '../src/pcb/modules/footprint.js';

const element = () => ({ attributes: {}, children: [],
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(child) { this.children.push(child); } });
globalThis.document = { createElementNS: element };
assert.deepEqual(referenceAnchor(null), { cx: 0, baseY: -2.8 });
assert.deepEqual(referenceAnchor({ x: 2, y: -4, width: 6 }), { cx: 5, baseY: -4.8 });
for (const outline of [null, { x: 2, y: -4, width: 6 }]) {
    const { cx, baseY } = referenceAnchor(outline);
    const local = layoutReferenceText('R12', cx, baseY, 1.2, 0.2);
    const group = element();
    applyRefGeometry(group, 'R12', cx, baseY, 1.2, 0.2);
    assert.deepEqual(group.children.map(child => child.attributes.points),
        local.polylines.map(poly => poly.map(point => `${point.x},${point.y}`).join(' ')));
    for (const side of ['top', 'bottom']) for (const mirror of [false, true]) {
        const placement = { reference: 'R12', outline, x: 20, y: -20, side, mirror,
            refSize: 1.2, refStrokeWidth: 0.2, refRot: 90, rotation: 90, refDx: 3, refDy: -2 };
        const resolved = resolveReferenceText(placement);
        const expected = local.polylines.map(poly => poly.map(point => {
            let x = cx - (point.y - local.box.cy);
            const y = local.box.cy + (point.x - cx) - 2;
            if (mirror) x = 2 * cx - x;
            x += 3;
            if (mirror !== (side === 'bottom')) x = -x;
            return { x: 20 - y, y: -20 + x };
        }));
        resolved.polylines.forEach((poly, polyIndex) => poly.forEach((point, pointIndex) => {
            assert.ok(Math.hypot(point.x - expected[polyIndex][pointIndex].x,
                point.y - expected[polyIndex][pointIndex].y) < 1e-10);
        }));
        assert.equal(resolved.layer, `${side}-silk`);
        assert.equal(resolved.strokeWidth, 0.2);
    }
}
assert.equal(resolveReferenceText({ reference: 'R1', refVisible: false }), null);
assert.equal(resolveReferenceText({ reference: '' }), null);
console.log('PASS reference baseline, SVG glyphs and independent side/mirror/rotation transforms');

globalThis.window = { addEventListener() {} };
const { Board2D } = await import('../src/pcb/modules/board2d.js');
const { buildTextMesh } = await import('../src/pcb/modules/board3d.js');
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
const near = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance,
    `Expected ${actual} to equal ${expected}`);
function canvasStrokes(placement, side) {
    const paths = [];
    let path = [];
    const context = { save() {}, restore() {}, beginPath() { path = []; },
        moveTo(x, y) { path.push({ x, y }); }, lineTo(x, y) { path.push({ x, y }); },
        stroke() { paths.push({ points: path, width: this.lineWidth }); } };
    Board2D.prototype._drawSilk.call({ data: { placements: new Map([['ref', placement]]) }, side }, context);
    return paths;
}
for (const outline of [null, { x: 2, y: -4, width: 6 }]) {
    for (const side of ['top', 'bottom']) for (const mirror of [false, true]) for (const rotation of [0, 37, 90]) {
        const placement = { reference: 'R12', outline, x: 30, y: -30, side, mirror, rotation,
            refRot: rotation, refSize: 1.2, refStrokeWidth: 0.2, refDx: 3, refDy: -2 };
        const reference = resolveReferenceText(placement);
        const endpoints = reference.polylines.flatMap(poly => poly.slice(1).flatMap((point, index) => [poly[index], point]));
        const paths = canvasStrokes(placement, side);
        assert.equal(paths.length, 1);
        assert.deepEqual(paths[0].points, endpoints);
        assert.equal(paths[0].width, 0.2);
        assert.deepEqual(canvasStrokes(placement, side === 'top' ? 'bottom' : 'top'), []);

        const app = { placements: new Map([['ref', placement]]), boardWidth: 100, boardHeight: 80 };
        const silk = exportGerbers(app).get(side === 'top' ? 'board.gto' : 'board.gbo');
        const coordinates = [...silk.matchAll(/X(-?\d+)Y(-?\d+)D0[12]\*/g)]
            .map(match => ({ x: Number(match[1]) / 1e6, y: -Number(match[2]) / 1e6 }));
        assert.equal(coordinates.length, endpoints.length);
        coordinates.forEach((point, index) => {
            near(point.x, endpoints[index].x, 1e-6);
            near(point.y, endpoints[index].y, 1e-6);
        });
        assert.ok([...silk.matchAll(/%ADD\d+C,([\d.]+)\*/g)].some(match => Number(match[1]) === 0.2));

        const mesh = buildTextMesh(app);
        const vertices = mesh.verts;
        assert.ok(vertices.length > 0);
        for (const [axis, meshAxis] of [['x', 'x'], ['y', 'z']]) {
            near(Math.min(...vertices.map(point => point[meshAxis])), Math.min(...endpoints.map(point => point[axis])) - 0.1);
            near(Math.max(...vertices.map(point => point[meshAxis])), Math.max(...endpoints.map(point => point[axis])) + 0.1);
        }
        assert.ok(vertices.every(point => side === 'top' ? point.y > 1 : point.y <= 0));
        placement.refVisible = false;
        assert.deepEqual(canvasStrokes(placement, side), []);
        assert.equal(buildTextMesh(app).verts.length, 0);
        assert.doesNotMatch(exportGerbers(app).get(side === 'top' ? 'board.gto' : 'board.gbo'), /D01\*/);
    }
}
console.log('PASS Canvas, 3D and Gerber reference positions, sides, visibility and stroke extents');