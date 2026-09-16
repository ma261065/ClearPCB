import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
const { runDRC } = await import('../src/pcb/modules/drc.js');
const track = (id, net, points, layer = 'top-copper') => ({
    id, net, layer, width: 0.2,
    nodes: new Map(points.map((point, index) => [index, { x: point[0], y: point[1] }])),
    edges: new Map(points.slice(1).map((_, index) => [index, { from: index, to: index + 1 }])),
});
const removal = {
    id: 'cut', kind: 'rect', layer: 'top-copper', copperMode: 'remove-copper', filled: true,
    lineWidth: 0.05,
    points: [{ x: -0.5, y: -0.5 }, { x: 0.5, y: -0.5 }, { x: 0.5, y: 0.5 }, { x: -0.5, y: 0.5 }],
};
const app = {
    placements: new Map(), texts: new Map(), vias: [], boardShapes: [],
    tracks: [track('horizontal', 'GND', [[-2, 0], [0, 0], [2, 0]]),
        track('vertical', 'VCC', [[0, -2], [0, 0], [0, 2]])],
};
const violations = () => runDRC(app, { clearance: 0.2 }).violations;
assert.ok(violations().some(item => item.rule === 'clearance'));
assert.ok(violations().some(item => item.rule === 'short'));
app.boardShapes = [removal];
assert.deepEqual(violations(), [], 'removed crossing must not report clearance or short violations');
removal.copperMode = 'remove-solder-mask';
assert.ok(violations().some(item => item.rule === 'clearance'), 'mask-only artwork retains copper');
removal.copperMode = 'remove-copper-mask';
assert.deepEqual(violations(), [], 'combined removal cuts copper');
removal.layer = 'bottom-copper';
assert.ok(violations().some(item => item.rule === 'clearance'), 'opposite layer is not cut');
console.log('PASS: DRC copper removal clears crossings without clearing opposite layers or mask-only artwork');

const rectangle = (left, top, right, bottom) => [
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
];
const board = () => ({ placements: new Map(), texts: new Map(), vias: [], tracks: [], boardShapes: [] });
const cut = (points, options = {}) => ({ ...removal, copperMode: 'remove-copper', layer: 'top-copper', points, ...options });
const clearanceErrors = target => runDRC(target, { clearance: 0.2 }).violations.filter(item => item.rule === 'clearance');
const shortErrors = target => runDRC(target, { clearance: 0.2 }).violations.filter(item => item.rule === 'short');

for (const kind of ['pad', 'via', 'pour', 'circle', 'polygon']) {
    const target = board();
    const probe = track('probe', 'VCC', [[1.15, -0.3], [1.15, 0.3]]);
    probe.width = 0.1;
    target.tracks.push(probe);
    if (kind === 'pad') {
        target.placements.set('U1', { x: 0, y: 0, padOffsets: [
            { padId: '1', number: '1', dx: 0, dy: 0, width: 2, height: 2, shape: 'rect', layer: 'top' },
        ] });
        target.netlist = [{ net: 'GND', pins: [{ componentId: 'U1', pinNumber: '1' }] }];
    } else if (kind === 'via') target.vias.push({ id: 'via', x: 0, y: 0, diameter: 2, drill: 0.4, net: 'GND' });
    else if (kind === 'pour') target.boardShapes.push({ id: 'pour', type: 'fill', layer: 'top-copper', net: 'GND',
        _computed: [{ outer: rectangle(-1, -1, 1, 1), holes: [] }] });
    else target.boardShapes.push({ id: 'copper', kind, layer: 'top-copper', net: 'GND', copperMode: 'add',
        filled: true, lineWidth: 0.05, x: 0, y: 0, radius: 1, points: rectangle(-1, -1, 1, 1) });
    assert.ok(clearanceErrors(target).length, `${kind} initially violates clearance`);
    const erase = cut(rectangle(-1.1, -1.1, 1.025, 1.1));
    target.boardShapes.push(erase);
    assert.equal(clearanceErrors(target).length, 0, `${kind} copper is removed without erasing the probe`);
    if (kind === 'via') {
        probe.layer = 'bottom-copper';
        assert.ok(clearanceErrors(target).length, 'through via retains bottom copper');
        probe.layer = 'top-copper';
    }
    erase.points = rectangle(-1.1, -1.1, 0, 1.1);
    assert.ok(clearanceErrors(target).length, `${kind} remaining copper still violates clearance`);
}

{
    const target = board();
    target.tracks = [track('bridge', '', [[-2, 0], [2, 0]]),
        track('left', 'GND', [[-3, 0], [-2, 0]]), track('right', 'VCC', [[2, 0], [3, 0]])];
    assert.ok(shortErrors(target).length, 'continuous no-net bridge shorts its two ends');
    target.boardShapes.push(cut(rectangle(-0.5, -1, 0.5, 1)));
    assert.equal(shortErrors(target).length, 0, 'split islands do not reconnect by original track identity');
    target.boardShapes[0].points = rectangle(-0.5, 0.05, 0.5, 1);
    assert.ok(shortErrors(target).length, 'a surviving thin bridge still shorts its ends');
}

const { pictureShape } = await import('../src/pcb/modules/picture-raster.js');
{
    const target = board();
    target.tracks = [track('first', 'GND', [[-0.3, 0], [0.3, 0]]), track('second', 'VCC', [[0, -0.3], [0, 0.3]])];
    const image = pictureShape({ width: 100, height: 100, contours: [
        rectangle(0, 0, 100, 100), rectangle(25, 25, 75, 75),
    ] }, { widthMm: 5, layer: 'top-copper' });
    image.copperMode = 'remove-copper';
    target.boardShapes.push(image);
    assert.ok(clearanceErrors(target).length, 'a hole in removal artwork preserves the copper inside');
    image.artwork = { ...image.artwork, invert: true };
    assert.equal(clearanceErrors(target).length, 0, 'inverted removal artwork cuts inside the hole');
    image.copperMode = 'add';
    image.artwork = { ...image.artwork, invert: false };
    target.tracks.pop();
    assert.equal(clearanceErrors(target).length, 0, 'additive image holes are not conservative bounding-box copper');
}

{
    const target = board();
    target.tracks = [track('first', 'GND', [[-2, 0], [2, 0]]), track('second', 'VCC', [[0, -2], [0, 2]])];
    target.boardShapes = [cut(rectangle(-0.5, -0.5, 0.5, 0.5)), cut(rectangle(-0.5, -0.5, 0.5, 0.5), { id: 'overlap' })];
    assert.equal(clearanceErrors(target).length, 0, 'overlapping removal shapes union rather than cancel');
    target.boardShapes = [cut([{ x: -0.5, y: 0 }, { x: 0.5, y: 0 }],
        { kind: 'line', filled: false, lineWidth: 0.05, segmentWidths: { 0: 1 } })];
    assert.equal(clearanceErrors(target).length, 0, 'removal strokes use per-edge widths');
    target.boardShapes[0].segmentWidths = {};
    assert.ok(clearanceErrors(target).length, 'a narrow cut still leaves insufficient clearance');
}
console.log('PASS: pad, via, pour, shape, image-hole, overlapping-cut, per-edge-width, and split-connectivity cases');

{
    const target = board();
    const arc = { id: 'arc', kind: 'arc', layer: 'top-copper', net: 'GND', lineWidth: 0.2,
        start: { x: 1, y: 0 }, bulge: { x: 0, y: 1 }, end: { x: -1, y: 0 }, filled: false };
    target.boardShapes.push(arc);
    target.tracks.push(track('probe', 'VCC', [[0, 0.7], [0, 1.3]]));
    assert.ok(clearanceErrors(target).length);
    target.boardShapes.push(cut(rectangle(-0.5, 0.5, 0.5, 1.5)));
    assert.equal(clearanceErrors(target).length, 0, 'arc copper is clipped');
    target.boardShapes = [{ ...arc, id: 'arc-cut', lineWidth: 1, copperMode: 'remove-copper' }];
    target.tracks.push(track('cross', 'GND', [[-0.3, 1], [0.3, 1]]));
    assert.equal(clearanceErrors(target).length, 0, 'analytic arc removal cuts its swept stroke');
}

{
    const { pcbTextSegments } = await import('../src/pcb/modules/pcb-text.js');
    const target = board();
    const text = { id: 'text', content: 'A', x: 0, y: 0, size: 1, strokeWidth: 0.15, layer: 'top-copper' };
    const [start, end] = pcbTextSegments(text)[0];
    target.texts.set(text.id, text);
    target.tracks.push(track('probe', 'GND', [[start.x, start.y], [end.x, end.y]]));
    assert.ok(clearanceErrors(target).length);
    target.boardShapes.push(cut(rectangle(-5, -5, 5, 5)));
    assert.equal(clearanceErrors(target).length, 0, 'copper text is clipped');
}

for (const kind of ['via', 'pad']) {
    const target = board();
    if (kind === 'via') target.vias.push({ id: 'bridge', x: 0, y: 0, diameter: 2, drill: 0.4, net: '' });
    else target.placements.set('U1', { x: 0, y: 0, padOffsets: [
        { padId: '1', number: '1', dx: 0, dy: 0, width: 2, height: 2, drill: 0.4, shape: 'rect' },
    ] });
    target.tracks.push(track('top', 'GND', [[0.3, 0], [2, 0]]), track('bottom', 'VCC', [[0.3, 0], [2, 0]], 'bottom-copper'));
    const erase = cut(rectangle(-2, -2, -0.5, 2));
    target.boardShapes.push(erase);
    assert.ok(shortErrors(target).length, `${kind} surviving copper stays bonded through its barrel`);
    erase.points = rectangle(-2, -2, 1.1, 2);
    assert.equal(shortErrors(target).length, 0, `${kind} erased top surface no longer bridges the two tracks`);
}
console.log('PASS: arc, copper text, and through-hole barrel connectivity after subtraction');

{
    const { collectCopper } = await import('../src/pcb/modules/drc.js');
    const { resolveCopperPads } = await import('../src/pcb/modules/copper-model.js');
    const target = board();
    target.placements.set('U1', { x: 0, y: 0, padOffsets: [
        { padId: '1', number: '1', dx: 0, dy: 0, width: 2, height: 2, shape: 'ellipse' },
    ] });
    assert.equal(Math.max(...collectCopper(target).pads[0].outline.map(point => point.x)), 1,
        'DRC uses the physical pad radius');
    assert.ok(Math.max(...resolveCopperPads(target)[0].outline.map(point => point.x)) > 1,
        'pour callers retain their conservative pad envelope');
}