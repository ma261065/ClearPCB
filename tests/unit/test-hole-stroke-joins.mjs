import assert from 'node:assert/strict';
import { distanceToSegment, pointInPolygon } from '../../src/core/geometry.js';
import { boardShapeRemovalPathD, resolveBoardShapeGeometry } from '../../src/shared/pcb/board-shape-geometry.js';
import { setHoveredBoardShape } from '../../src/pcb/modules/board-shape-state.js';
import { setPcbSelection } from '../../src/pcb/modules/selection-registry.js';

globalThis.window = { addEventListener() {} };
const element = (localName = 'g') => ({
    localName, attributes: new Map(), children: [], dataset: {}, style: {}, parentNode: null,
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.get(name); },
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; },
    removeChild(child) { child.remove(); },
    remove() {
        if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
        this.parentNode = null;
    },
});
globalThis.document = { createElementNS: (_, tag) => element(tag), getElementById: () => null };
const { getBoardShapeElement, renderBoardShape } = await import('../../src/pcb/modules/board-shapes.js');
const { exportGerbers } = await import('../../src/pcb/modules/gerber.js');
const contoursOf = path => [...path.matchAll(/M\s+([^Z]+)Z/g)].map(match => {
    const values = match[1].replaceAll('L', '').trim().split(/\s+/).map(Number);
    return Array.from({ length: values.length / 2 }, (_, i) => ({ x: values[i * 2], y: values[i * 2 + 1] }));
});
const contains = (contours, point) => contours.reduce((inside, contour) => inside !== pointInPolygon(point, contour), false);
const clipIds = new Set();
function checkInsideBorder(root, path) {
    const [clip, painted] = root.children;
    assert.equal(clip.localName, 'clipPath');
    assert.equal(clip.getAttribute('clipPathUnits'), 'userSpaceOnUse', 'no bounding-box or viewport-origin offset');
    assert.equal(clip.children[0].getAttribute('d'), path, 'border clipped to the exact physical contour');
    assert.equal(clip.children[0].getAttribute('clip-rule'), painted.getAttribute('fill-rule'));
    assert.equal(painted.getAttribute('d'), path);
    assert.equal(painted.getAttribute('clip-path'), `url(#${clip.getAttribute('id')})`);
    assert.equal(clipIds.has(clip.getAttribute('id')), false, 'clips remain unique across shapes and redraws');
    clipIds.add(clip.getAttribute('id'));
    assert.equal(Number(painted.getAttribute('stroke-width')) / 2, 0.05, 'retains a 0.05 mm inner border');
    return painted;
}
const shapes = [
    { name: 'acute', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0.02, y: 0.01 }] },
    { name: 'oblique', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 4, y: 3 }] },
    { name: 'crossing', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }] },
    { name: 'retraced', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }] },
    { name: 'variable', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 3, y: 1 }], segmentWidths: { 0: 1, 1: 3 } },
    { name: 'curved', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 3 }], segmentBulges: { 0: 0.4 } },
    { name: 'rounded', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], cornerRadius: 3 },
].map(shape => ({ id: shape.name, kind: 'line', layer: 'hole', lineWidth: 2, ...shape }));

let samples = 0;
for (const shape of shapes) {
    const saved = structuredClone(shape);
    const path = boardShapeRemovalPathD(shape), contours = contoursOf(path);
    assert.ok(contours.length, shape.name);
    assert.doesNotMatch(path, /NaN|Infinity/);
    const geometry = resolveBoardShapeGeometry(shape);
    const segments = geometry.strokeSegments.length ? geometry.strokeSegments
        : geometry.centerline.slice(1).map((end, i) => ({
            start: geometry.centerline[i], end, lineWidth: geometry.lineWidth,
        }));
    const gap = point => Math.min(...segments.map(segment =>
        distanceToSegment(point, segment.start, segment.end) - segment.lineWidth / 2));
    for (const point of contours.flat()) assert.ok(gap(point) <= 0.002,
        `${shape.name}: no contour vertex can spike beyond the round-ended stroke`);
    assert.equal(contains(contours, shape.points[1]), shape.name !== 'rounded',
        `${shape.name}: ordinary joins stay solid while explicit corner rounding removes the original sharp tip`);
    if (shape.name === 'crossing') {
        assert.equal(contains(contours, { x: 5, y: 5 }), true, 'crossing strokes do not cancel each other');
        assert.equal(contains(contours, { x: 5, y: 8 }), false, 'enclosed untouched material remains an island');
        assert.ok(contours.length > 1, 'self-crossing slot retains a genuine internal contour');
    }
    for (const layer of ['top-copper', 'top-silk']) {
        assert.equal(boardShapeRemovalPathD({ ...shape, layer }), path, 'physical open stroke is layer-independent');
    }
    const rendered = element();
    renderBoardShape({ _shapeElements: new Map(), getLayerGroup: () => rendered }, shape);
    assert.equal(checkInsideBorder(rendered.children[0], path).getAttribute('fill-rule'), 'evenodd',
        'hole renderer preserves nested contours');
    for (const state of ['normal', 'selected', 'hovered']) {
        const group = element(), app = {
            _shapeElements: new Map(), getLayerGroup: () => group,
        };
        for (const layer of ['hole', 'top-copper', 'top-silk', 'hole']) {
            const target = { ...shape, layer,
                points: shape.points.map(point => ({ x: point.x + 24, y: point.y - 13 })) };
            app.boardShapes = [target];
            setPcbSelection(app, state === 'selected' ? [{ kind: 'shape', object: target }] : []);
            setHoveredBoardShape(app, state === 'hovered' ? target : null);
            const previous = getBoardShapeElement(app, target.id);
            renderBoardShape(app, target);
            assert.equal(group.children.length, 1, 'redraw/layer changes do not leave stale clip definitions');
            if (previous) assert.equal(previous.parentNode, null, 'whole old subtree is removed');
            const root = getBoardShapeElement(app, target.id);
            const rendered = layer === 'hole' ? checkInsideBorder(root, boardShapeRemovalPathD(target)) : root;
            if (layer !== 'hole') assert.equal(rendered.getAttribute('clip-path'), undefined, 'native strokes unchanged');
            if (layer === 'hole' && state !== 'normal') {
                assert.equal(rendered.getAttribute('fill'), rendered.getAttribute('stroke'),
                    'hover and selection remain solid to the same physical edge');
            }
        }
    }

    const translated = { ...shape, points: shape.points.map(point => ({ x: point.x + 20, y: point.y - 20 })) };
    const files = exportGerbers({ placements: new Map(), boardWidth: 100, boardHeight: 80, boardShapes: [translated] });
    const moves = [...files.get('board.gko').matchAll(/X(-?\d+)Y(-?\d+)D02\*\n([\s\S]*?)(?=X-?\d+Y-?\d+D02\*|M02\*)/g)];
    const exported = moves.slice(1).map(move => [
        { x: Number(move[1]) / 1e6 - 20, y: -Number(move[2]) / 1e6 + 20 },
        ...[...move[3].matchAll(/X(-?\d+)Y(-?\d+)D01\*/g)].map(point => ({
            x: Number(point[1]) / 1e6 - 20, y: -Number(point[2]) / 1e6 + 20,
        })),
    ]);
    assert.ok(exported.length, `${shape.name}: profile export contains the routed slot`);
    for (let x = -2; x <= 12; x += 0.31) for (let y = -4; y <= 12; y += 0.37) {
        const point = { x, y }, separation = gap(point);
        if (Math.abs(separation) < 0.005) continue;
        const expected = separation < 0;
        assert.equal(contains(contours, point), expected, `${shape.name}: preview matches round stroke at ${x},${y}`);
        assert.equal(contains(exported, point), expected, `${shape.name}: routed outline agrees at ${x},${y}`);
        samples++;
    }
    assert.deepEqual(shape, saved, 'contour queries never mutate authored geometry');
}

for (const fixture of [
    { kind: 'circle', x: 24, y: -13, radius: 0.5 },
    { kind: 'rect', points: [{ x: 24, y: -13 }, { x: 34, y: -13 }, { x: 34, y: -3 }, { x: 24, y: -3 }] },
    { kind: 'polygon', points: [{ x: 24, y: -13 }, { x: 34, y: -13 }, { x: 24, y: -3 }] },
    { kind: 'image', points: [{ x: 24, y: -13 }, { x: 34, y: -13 }, { x: 34, y: -3 }, { x: 24, y: -3 }],
        artwork: { width: 10, height: 10, circles: [{ x: 4, y: 5, radius: 2 }, { x: 6, y: 5, radius: 2 }] } },
]) {
    const shape = { id: fixture.kind, layer: 'hole', lineWidth: 0.8, ...fixture };
    const before = structuredClone(shape), group = element();
    renderBoardShape({ _shapeElements: new Map(), getLayerGroup: () => group }, shape);
    const painted = checkInsideBorder(group.children[0], boardShapeRemovalPathD(shape));
    assert.equal(painted.getAttribute('fill-rule'), shape.kind === 'image' ? 'nonzero' : 'evenodd',
        'clipping respects both compound contours and overlapping picture circles');
    assert.deepEqual(shape, before, 'inside border is presentation-only');
}

console.log(`PASS round hole joins: acute/retraced/crossing/variable/curved strokes, inside-only borders, SVG winding and ${samples} export-parity samples`);
