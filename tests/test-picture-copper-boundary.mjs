import assert from 'node:assert/strict';
import { getComputedFill, setComputedFill } from '../src/pcb/modules/computed-fill-cache.js';
import { distanceToSegment, pointInPolygon } from '../src/core/geometry.js';
import { pictureShape, pictureContours } from '../src/shared/pcb/picture-raster.js';

function element() {
    return {
        attributes: {}, children: [], dataset: {},
        classList: { contains: () => false },
        setAttribute(key, value) { this.attributes[key] = String(value); },
        appendChild(child) { this.children.push(child); child.parent = this; },
        remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); },
    };
}
globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: element };
const { collectCopper, runDRC } = await import('../src/pcb/modules/drc.js');
const { reconcileRatsnest, nearestPointOnNet, collectBondedCopper } = await import('../src/pcb/modules/track-draw.js');
const { resolveTrackContactGeometry } = await import('../src/pcb/modules/track-contact-geometry.js');
const { computeFillPolygons, loadClipper, boardShapeClearanceOutlines } = await import('../src/pcb/modules/copper-fill-geom.js');
const { buildFillContext } = await import('../src/pcb/modules/fill-context.js');
const { CopperFill } = await import('../src/shapes/copper-fill.js');
const { exportGerbers } = await import('../src/pcb/modules/gerber.js');
await loadClipper();

const rectangle = (left, top, right, bottom) => [
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
];
const onBoundary = (point, points) => points.some((start, index) =>
    distanceToSegment(point, start, points[(index + 1) % points.length]) < 1e-8);
const gerberRegions = file => [...file.matchAll(/G36\*\n([\s\S]*?)G37\*/g)].map(match =>
    [...match[1].matchAll(/X(-?\d+)Y(-?\d+)D0[12]\*/g)].map(point =>
        ({ x: Number(point[1]) / 1e6, y: -Number(point[2]) / 1e6 })));
const board = shape => ({
    boardShapes: [shape], tracks: [], vias: [], pads: [], copperFills: [],
    placements: new Map(), texts: new Map(), netlist: [],
    ratLayer: element(),
    getLayerGroup() { return this.ratLayer; },
    getRoutingParams: () => ({ clearance: 0.2 }),
});
const ratlines = app => {
    reconcileRatsnest(app);
    return app.ratLayer.children.map(({ attributes: a, dataset }) => ({
        x1: +a.x1, y1: +a.y1, x2: +a.x2, y2: +a.y2, net: dataset.net,
    }));
};
const artwork = [
    { rectangles: [{ x: 0, y: 0, width: 1, height: 1 }, { x: 9, y: 5, width: 1, height: 1 }] },
    { contours: [rectangle(0, 0, 10, 6), rectangle(1, 1, 9, 5)] },
    { circles: [{ x: 1, y: 1, radius: 0.5 }, { x: 9, y: 5, radius: 0.5 }] },
    { rectangles: [{ x: 0, y: 0, width: 10, height: 6 }], invert: true },
];

for (const source of artwork) for (const degrees of [0, 37, 90]) {
    const radians = degrees * Math.PI / 180;
    const pose = (x, y) => ({ x: 20 + x * Math.cos(radians) - y * Math.sin(radians),
        y: -30 + x * Math.sin(radians) + y * Math.cos(radians) });
    const image = pictureShape({ width: 10, height: 6, ...source },
        { widthMm: 10, layer: 'top-copper', net: 'GND' });
    image.id = 'picture';
    if (source.invert) image.artwork.invert = true;
    image.points = image.points.map(point => pose(point.x, point.y));
    const physical = structuredClone(pictureContours(image));
    if (source.invert) assert.equal(physical.length, 0, 'inverted solid fixture has no physical copper');
    const app = board(image);
    const copper = collectCopper(app);
    assert.equal(copper.areas.length, 1, 'one logical rectangle, regardless of dots, holes or empty artwork');
    assert.deepEqual(copper.areas[0].outer, image.points);
    assert.deepEqual(copper.areas[0].holes, []);
    assert.equal(ratlines(app).length, 0, 'no internal picture ratlines');
    const inside = { id: 'inside', ...pose(0, 0), diameter: 0.4, drill: 0.2, net: 'GND' };
    app.vias = [inside];
    assert.equal(ratlines(app).length, 0, 'empty artwork interior is logically connected');
    assert.equal(runDRC(app, { clearance: 0.2 }).ok, true, 'same-net interior contact passes');
    const other = { id: 'other', ...pose(2, 0), diameter: 0.4, drill: 0.2, net: 'GND' };
    app.vias.push(other);
    const bonded = collectBondedCopper(app, { via: inside }, { includeShapes: true });
    assert.ok(bonded.shapes.has(image) && bonded.vias.has(other), 'picture frame joins contacts across pixel gaps');
    assert.equal(ratlines(app).length, 0);

    inside.net = 'SIGNAL';
    app.vias = [inside];
    assert.ok(runDRC(app, { clearance: 0.2 }).violations.some(v => v.rule === 'clearance'),
        'foreign copper inside a pixel gap conflicts with the logical rectangle');
    inside.net = '';
    assert.equal(runDRC(app, { clearance: 0.2 }).ok, false, 'No Net copper also respects the boundary');
    for (const gap of [0.19, 0.21]) {
        Object.assign(inside, pose(5 + inside.diameter / 2 + gap, 0));
        assert.equal(runDRC(app, { clearance: 0.2 }).ok, gap > 0.2,
            'clearance is measured from the rotated edge, not pixels or an axis-aligned bounding box');
    }
    Object.assign(inside, pose(8, 0), { net: 'GND' });
    const lines = ratlines(app);
    assert.equal(lines.length, 1, 'one external ratline for one disconnected picture');
    const line = lines[0];
    assert.ok(onBoundary({ x: line.x1, y: line.y1 }, image.points)
        || onBoundary({ x: line.x2, y: line.y2 }, image.points), 'ratline attaches to the picture frame');
    assert.equal(runDRC(app, { clearance: 0.2, ratlines: lines }).violations.filter(v => v.rule === 'unrouted').length, 1);
    const nearest = nearestPointOnNet({ ...app, vias: [] }, 'GND', pose(8, 0), { layer: 'top-copper' });
    assert.ok(Math.hypot(nearest.x - pose(5, 0).x, nearest.y - pose(5, 0).y) < 1e-8,
        'live routing guide targets the closest point on the rectangular edge');
    assert.deepEqual(nearestPointOnNet({ ...app, vias: [] }, 'GND', pose(0, 0)), pose(0, 0));
    assert.equal(nearestPointOnNet({ ...app, vias: [] }, 'GND', pose(8, 0), { layer: 'bottom-copper' }), null);

    app.vias = [];
    const fill = new CopperFill({ net: 'SIGNAL', layer: 'top-copper', outline: rectangle(0, -50, 40, -10) });
    app.copperFills = [fill];
    setComputedFill(fill, computeFillPolygons(fill, buildFillContext(app)));
    assert.ok(getComputedFill(fill).length);
    assert.ok(!getComputedFill(fill).some(region => pointInPolygon(pose(0, 0), region.outer)
        && !region.holes.some(hole => pointInPolygon(pose(0, 0), hole))), 'pour keeps the whole picture frame clear');
    assert.equal(runDRC(app, { clearance: 0.2 }).ok, true, 'pour and DRC agree on picture clearance');
    assert.ok(boardShapeClearanceOutlines(image, 0.2).some(points => pointInPolygon(pose(0, 0), points)),
        'clearance overlay surrounds the same frame');
    app.copperFills = [];
    for (const mode of ['remove-copper', 'remove-solder-mask', 'remove-copper-mask']) {
        image.copperMode = mode;
        assert.equal(collectCopper(app).areas.length, 0, 'removal pictures never become solid conductors');
        assert.equal(nearestPointOnNet(app, 'GND', pose(8, 0)), null);
        assert.equal(ratlines(app).length, 0);
    }
    image.copperMode = 'add';
    image.layer = 'top-silk';
    assert.equal(collectCopper(app).areas.length, 0, 'non-copper pictures do not participate');
    assert.equal(ratlines(app).length, 0);
    assert.deepEqual(pictureContours(image), physical, 'analysis never changes rendering/manufactured artwork');
    for (const [layer, filename] of [['top-copper', 'board.gtl'], ['bottom-copper', 'board.gbl']]) {
        const exportedShape = { ...image, layer };
        const expected = pictureContours(exportedShape);
        const output = exportGerbers({ placements: new Map(), boardWidth: 100, boardHeight: 80,
            boardShapes: [exportedShape] }).get(filename);
        const regions = gerberRegions(output);
        for (let x = -4.87; x < 5; x += 0.5) for (let y = -2.83; y < 3; y += 0.5) {
            const point = pose(x, y);
            assert.equal(regions.some(region => pointInPolygon(point, region)),
                expected.filter(contour => pointInPolygon(point, contour)).length % 2 === 1,
                `${Object.keys(source)[0]} ${degrees} ${layer} at ${JSON.stringify(point)}: Gerber retains physical artwork`);
        }
    }
}

const moving = pictureShape({ width: 10, height: 6, ...artwork[0] },
    { widthMm: 10, layer: 'top-copper', net: 'GND' });
const previous = resolveTrackContactGeometry(moving);
moving.points.forEach(point => { point.x += 10; });
assert.notEqual(resolveTrackContactGeometry(moving), previous, 'in-place movement invalidates the contact frame');
assert.equal(resolveTrackContactGeometry(moving).bounds.minX, 5);
moving.points = moving.points.map(point => ({ x: point.x * 2, y: point.y * 2 }));
assert.equal(resolveTrackContactGeometry(moving).bounds.minX, 10, 'resize updates the frame');
const clipped = board(moving);
clipped.vias = [{ id: 'foreign', x: 20, y: 0, net: 'SIGNAL', diameter: 0.4, drill: 0.2 }];
clipped.boardShapes.push({ id: 'cut', kind: 'rect', layer: 'top-copper', copperMode: 'remove-copper',
    filled: true, lineWidth: 0.1, points: rectangle(10, -6, 11, -5) });
assert.ok(runDRC(clipped, { clearance: 0.2 }).violations.some(v => v.rule === 'short'),
    'short detection after copper subtraction also uses the solid picture frame');
console.log('PASS solid picture boundaries: ratlines, DRC, routing, pours, rotation, empty artwork and physical-output preservation');
