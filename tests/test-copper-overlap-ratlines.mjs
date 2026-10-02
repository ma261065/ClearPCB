import assert from 'node:assert/strict';
import { setComputedFill } from '../src/pcb/modules/computed-fill-cache.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: () => ({
    attributes: {}, dataset: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); },
}) };
const { reconcileRatsnest, collectBondedCopper } = await import('../src/pcb/modules/track-draw.js');
const { runDRC } = await import('../src/pcb/modules/drc.js');
const { Track } = await import('../src/shapes/track.js');
const { pictureShape } = await import('../src/pcb/modules/picture-raster.js');

const rectangle = (left, top, right, bottom) => [
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
];
const outline = () => ({
    id: 'outline', kind: 'rect', net: 'Net0002', layer: 'top-copper',
    filled: false, lineWidth: 0.2, cornerRadius: 0.4, points: rectangle(-1, -1.5, 3, 1.5),
});
const pad = (id = 'pad', x = 0) => ({
    id, x, y: 0, size: 2, shape: 'round', drill: 0.8, layers: 'both', net: 'Net0002',
});
const via = () => ({ id: 'via', x: 0, y: 0, diameter: 2, drill: 0.8, net: 'Net0002' });
function board(extra = {}) {
    const layer = { children: [], appendChild(line) { line.parent = this; this.children.push(line); } };
    return { pads: [], vias: [], tracks: [], boardShapes: [], copperFills: [],
        placements: new Map(), netlist: [], texts: new Map(), getLayerGroup: () => layer, ...extra };
}
function check(app, expected, message, options) {
    reconcileRatsnest(app, options);
    const ratlines = app.getLayerGroup().children.map(line => ({
        net: line.dataset.net, ...Object.fromEntries(['x1', 'y1', 'x2', 'y2'].map(key => [key, +line.attributes[key]])),
    }));
    assert.equal(ratlines.length, expected, message);
    assert.equal(runDRC(app, { clearance: 0.3, ratlines }).violations.filter(v => v.rule === 'unrouted').length,
        expected, `${message}: incomplete-connection DRC follows physical connectivity`);
}

for (const kind of ['pad', 'via', 'component']) {
    const app = board({ boardShapes: [outline()] });
    if (kind === 'pad') app.pads.push(pad());
    else if (kind === 'via') app.vias.push(via());
    else {
        app.placements.set('U1', { x: 0, y: 0, padOffsets: [
            { padId: '1', number: '1', dx: 0, dy: 0, width: 2, height: 2, shape: 'circle', drill: 0.8 },
        ] });
        app.netlist = [{ net: 'Net0002', pins: [{ componentId: 'U1', pinNumber: '1' }] }];
    }
    check(app, 0, `${kind} rim overlapping an unfilled rounded shape is connected`);
    const seed = kind === 'via' ? { via: app.vias[0] } : { padKey: kind === 'pad' ? 'null|pad' : 'U1|1' };
    assert.ok(collectBondedCopper(app, seed, { includeShapes: true }).shapes.has(app.boardShapes[0]),
        'ratlines and Net adoption share physical contact geometry');
    app.boardShapes[0].points = rectangle(-1.2, -1.5, 3, 1.5);
    check(app, 1, `${kind} with an actual gap stays disconnected`, { nets: new Set(['Net0002']) });
    app.boardShapes[0].filled = true;
    check(app, 0, `${kind} inside a filled copper shape is connected`);
}

{
    const app = board({ pads: [pad()], boardShapes: [outline()] });
    app.pads[0].layers = 'bottom';
    check(app, 1, 'overlap on incompatible layers is not a connection');
    app.boardShapes[0].layer = 'bottom-copper';
    check(app, 0, 'matching bottom copper connects');
    app.boardShapes[0].copperMode = 'remove-solder-mask';
    app.pads.push(pad('other', 8));
    check(app, 1, 'mask artwork cannot electrically bridge the pads');
}

for (const kind of ['pad', 'via']) {
    const app = board({ boardShapes: [{
        ...outline(), filled: true, cornerRadius: 0, lineWidth: 0.05, points: rectangle(0, 0, 0.15, 0.15),
    }] });
    if (kind === 'pad') app.pads.push(pad());
    else app.vias.push(via());
    check(app, 1, `${kind} drill void does not connect to artwork inside it, even with a coincident vertex`);
    const seed = kind === 'pad' ? { padKey: 'null|pad' } : { via: app.vias[0] };
    assert.equal(collectBondedCopper(app, seed, { includeShapes: true }).shapes.size, 0,
        'Net propagation does not cross a drill void');
}

{
    const app = board({ pads: [{ ...pad(), size: 0.4, drill: 0 }], boardShapes: [outline()] });
    check(app, 1, 'a pad inside the empty centre of an outline is not connected');
    app.boardShapes[0].net = 'OTHER';
    app.pads.push({ ...pad('second', 5), size: 0.4, drill: 0 });
    check(app, 1, 'different-Net artwork does not bridge same-Net pads');
}

{
    const app = board({ pads: [{ ...pad(), size: 0.4, drill: 0 }], boardShapes: [{
        id: 'ring', kind: 'circle', x: 0, y: 0, radius: 2, lineWidth: 0.2,
        net: 'Net0002', layer: 'top-copper', filled: false,
    }] });
    check(app, 1, 'a solid Pad inside a hollow circle is not connected');
    app.boardShapes[0].filled = true;
    check(app, 0, 'filling the circle connects its interior Pad');
}

{
    const app = board({ pads: [pad()], tracks: [new Track({
        net: 'Net0002', width: 0.2, points: [{ x: -0.95, y: -2 }, { x: -0.95, y: 2 }],
    })] });
    check(app, 0, 'a Track mid-segment overlapping a standalone Pad rim is connected');
    assert.ok(collectBondedCopper(app, { track: app.tracks[0] }, { includeShapes: true }).padKeys.has('null|pad'),
        'Net propagation follows the same Track-to-Pad rim contact');
    for (const node of app.tracks[0].nodes.values()) node.x -= 0.3;
    check(app, 1, 'moving the Track clear restores the ratline');
    assert.equal(collectBondedCopper(app, { track: app.tracks[0] }, { includeShapes: true }).padKeys.size, 0);
}

{
    const app = board({ pads: [pad('left', -1), pad('right', 3)], copperFills: [{
        id: 'pour', net: 'Net0002', layer: 'top-copper',
    }] });
    setComputedFill(app.copperFills[0], [{ outer: rectangle(-0.1, -0.5, 2.1, 0.5), holes: [] }]);
    check(app, 0, 'a pour touching only pad rims bridges them');
    setComputedFill(app.copperFills[0], [
        { outer: rectangle(-0.1, -0.5, 0.5, 0.5), holes: [] },
        { outer: rectangle(1.5, -0.5, 2.1, 0.5), holes: [] },
    ]);
    check(app, 1, 'separate islands of one pour do not bridge pads');
    app.pads = [];
    check(app, 0, 'isolated pour islands do not introduce standalone ratline targets');
}

const shapes = [
    ['line', { kind: 'line', points: [{ x: -0.95, y: -2 }, { x: -0.95, y: 2 }] }],
    ['rectangle', { kind: 'rect', points: rectangle(-2, -2, -0.95, 2) }],
    ['rounded rectangle', { kind: 'rect', cornerRadius: 0.4, points: rectangle(-2, -2, -0.95, 2) }],
    ['polygon', { kind: 'polygon', points: [{ x: -2, y: -2 }, { x: -0.95, y: 0 }, { x: -2, y: 2 }] }],
    ['circle', { kind: 'circle', x: -1.9, y: 0, radius: 1 }],
    ['arc', { kind: 'arc', start: { x: -2, y: -1 }, bulge: { x: -1, y: 0 }, end: { x: -2, y: 1 } }],
];
for (const [name, shape] of shapes) {
    for (const filled of [false, true]) {
        for (const terminal of ['pad', 'via']) {
            const app = board({ boardShapes: [{
                id: 'shape', net: 'Net0002', layer: 'top-copper', lineWidth: 0.2, ...shape, filled,
            }] });
            if (terminal === 'pad') app.pads.push(pad());
            else app.vias.push(via());
            check(app, 0, `${filled ? 'filled' : 'outlined'} ${name} connects at a ${terminal} rim`);
        }
    }
}

{
    const image = pictureShape({ width: 10, height: 10, rectangles: [
        { x: 0, y: 0, width: 10, height: 10 },
    ] }, { widthMm: 1, center: { x: -1.4, y: 0 }, net: 'Net0002', layer: 'top-copper' });
    check(board({ pads: [pad()], boardShapes: [image] }), 0, 'image copper contacting the rim connects without enclosing the Pad centre');
}

for (const terminal of ['standalone', 'component']) {
    const app = board({ boardShapes: [{
        id: 'stroke', kind: 'line', net: 'Net0002', layer: 'top-copper', lineWidth: 0.2,
        points: [{ x: -0.8, y: -2 }, { x: -0.8, y: 2 }],
    }] });
    if (terminal === 'standalone') app.pads.push({ ...pad(), shape: 'rectangle', width: 0.6, height: 2, drill: 0, rotation: 45 });
    else {
        app.placements.set('U1', { x: 0, y: 0, rotation: 45, padOffsets: [
            { padId: '1', number: '1', dx: 0, dy: 0, width: 0.6, height: 2, shape: 'rect', layer: 'top' },
        ] });
        app.netlist = [{ net: 'Net0002', pins: [{ componentId: 'U1', pinNumber: '1' }] }];
    }
    check(app, 0, `rotated ${terminal} Pad uses its posed outline`);
}

{
    const app = board({ pads: [pad('first'), pad('second', 1.9)] });
    check(app, 0, 'overlapping Pads connect without coincident centres');
    app.pads[1].x = 2.001;
    check(app, 1, 'a real gap between Pad outlines remains disconnected');
}

{
    const app = board({ pads: [pad()], tracks: [new Track({
        net: 'Net0002', width: 0.02, points: [{ x: -1.015, y: -2 }, { x: -1.015, y: 2 }],
    })] });
    check(app, 1, 'narrow Track width is not inflated to generic-shape stroke defaults');
    for (const node of app.tracks[0].nodes.values()) node.x += 0.02;
    check(app, 0, 'narrow Track connects when its actual copper reaches the Pad');
}

for (const kind of ['track', 'line', 'polygon']) {
    const app = board({ pads: [{ ...pad('small', -2.15), size: 0.3, drill: 0 }] });
    let curve;
    if (kind === 'track') {
        curve = new Track({ net: 'Net0002', width: 0.2, points: [{ x: 0, y: -2 }, { x: 0, y: 2 }] });
        curve.setEdgeAttr([...curve.edges.keys()][0], 'bulge', 1);
        app.tracks.push(curve);
    } else {
        curve = { id: 'curve', kind, net: 'Net0002', layer: 'top-copper', filled: false, lineWidth: 0.2,
            points: [{ x: 0, y: -2 }, { x: 0, y: 2 }, ...(kind === 'polygon' ? [{ x: 2, y: 0 }] : [])],
            segmentBulges: { 0: 1 } };
        app.boardShapes.push(curve);
    }
    check(app, 0, `${kind} curved edge connects along the arc, away from its endpoints`);
    app.pads[0].x = 0;
    check(app, 1, `${kind} imaginary straight chord is not copper`);
    if (kind === 'track') curve.setEdgeAttr([...curve.edges.keys()][0], 'bulge', 0);
    else curve.segmentBulges = {};
    check(app, 0, `${kind} changing curvature invalidates physical contact geometry`);
}

console.log('PASS all copper shape families, curved edges, Pads/Vias/Tracks/pours, voids, layers, gaps and incomplete DRC');
