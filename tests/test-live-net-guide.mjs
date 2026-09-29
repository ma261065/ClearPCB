import assert from 'node:assert/strict';

function element() {
    return {
        attributes: new Map(), children: [], dataset: {}, style: {},
        classList: { add() {} },
        setAttribute(key, value) { this.attributes.set(key, String(value)); },
        getAttribute(key) { return this.attributes.get(key); },
        appendChild(child) { this.children.push(child); child.parent = this; },
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
    };
}
globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: element, getElementById() { return null; } };
const { nearestPointOnNet, startTrackDraw, updateTrackDraw, cancelTrackDraw, toggleTrackLayer } =
    await import('../src/pcb/modules/track-draw.js');
const { startVertexDrag, updateVertexDrag, cancelVertexDrag } = await import('../src/pcb/modules/track-drag.js');
const { PCB_OVERLAYS } = await import('../src/pcb/modules/layers.js');
const { Pad } = await import('../src/shapes/pad.js');
const { Track } = await import('../src/shapes/track.js');
const { pictureShape } = await import('../src/pcb/modules/picture-raster.js');
const board = () => ({
    tracks: [], vias: [], pads: [], boardShapes: [], placements: new Map(), netlist: [],
    _trackToolNet: 'GND', _getLayerGroup() { return null; },
    viewport: { svg: element(), scale: 100, gridVisible: false, setCrosshair() {}, hideCrosshair() {} },
});
const square = (min, max) => [
    { x: min, y: min }, { x: max, y: min }, { x: max, y: max }, { x: min, y: max },
];
const rect = (extra = {}) => ({
    id: 'rect', kind: 'rect', points: square(10, 20), filled: true,
    lineWidth: 0.2, net: 'GND', layer: 'top-copper', copperMode: 'add', ...extra,
});

{
    const app = board();
    app.pads = [new Pad({ x: 10, y: 0, net: 'GND', layers: 'bottom-copper' })];
    assert.equal(nearestPointOnNet(app, 'GND', { x: 0, y: 0 }, { layer: 'top-copper' }), null);
    app.pads[0].layers = 'both';
    assert.deepEqual(nearestPointOnNet(app, 'GND', { x: 0, y: 0 }, { layer: 'top-copper' }), { x: 10, y: 0 });
    app.pads[0].visible = false;
    assert.equal(nearestPointOnNet(app, 'GND', { x: 0, y: 0 }), null);
}
{
    const app = board();
    app.boardShapes = [rect()];
    assert.deepEqual(nearestPointOnNet(app, 'GND', { x: 0, y: 15 }), { x: 10, y: 15 });
    assert.deepEqual(nearestPointOnNet(app, 'GND', { x: 15, y: 15 }), { x: 15, y: 15 });
    for (const extra of [{ net: 'OTHER' }, { layer: 'top-silk' },
        { layer: 'bottom-copper' }, { visible: false }, { copperMode: 'remove-copper' }]) {
        app.boardShapes = [rect(extra)];
        assert.equal(nearestPointOnNet(app, 'GND', { x: 0, y: 15 }, { layer: 'top-copper' }), null);
    }
}
{
    const app = board();
    const fill = { type: 'fill', layer: 'top-copper', net: 'GND',
        _computed: [{ outer: square(0, 20), holes: [square(5, 15)] }] };
    app.copperFills = [fill];
    const target = nearestPointOnNet(app, 'GND', { x: 10, y: 10 });
    assert.equal(Math.hypot(target.x - 10, target.y - 10), 5,
        'guide from a fill hole targets real poured copper, not the empty hole');
    fill._computed = [];
    assert.equal(nearestPointOnNet(app, 'GND', { x: 10, y: 10 }), null);
}
{
    const app = board();
    const image = pictureShape({ width: 4, height: 2,
        rectangles: [{ x: 0, y: 0, width: 4, height: 2 }] }, { widthMm: 8, layer: 'top-copper' });
    image.net = 'GND';
    app.boardShapes = [image];
    assert.ok(nearestPointOnNet(app, 'GND', { x: 100, y: 0 }), 'copper artwork is a guide target');
    image.copperMode = 'remove-copper';
    assert.equal(nearestPointOnNet(app, 'GND', { x: 100, y: 0 }), null);
}
{
    const app = board();
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], net: 'GND' });
    track.edges.values().next().value.bulge = 1;
    app.tracks = [track];
    const target = nearestPointOnNet(app, 'GND', { x: 5, y: 0 });
    assert.ok(Math.abs(Math.hypot(target.x - 5, target.y) - 5) < 1e-6,
        'curved Tracks target the arc, not its empty chord');
}

const ratlines = PCB_OVERLAYS.find(overlay => overlay.id === 'ratlines');
const previous = ratlines.visible;
try {
    for (const visible of [true, false]) {
        ratlines.visible = visible;
        const app = board();
        const source = new Pad({ x: 0, y: 0, net: 'GND' });
        app.pads = [source, new Pad({ x: 20, y: 0, net: 'GND', layers: 'top-copper' })];
        app.tracks = [new Track({ points: [{ x: 0, y: 0 }, { x: 5, y: 0 }], net: 'GND' })];
        startTrackDraw(app, { x: 0, y: 0 });
        updateTrackDraw(app, { x: 8, y: 4 });
        assert.equal(app._netGuideLine?.getAttribute('x2'), '20',
            `guide exists with Ratlines ${visible ? 'visible' : 'hidden'} and excludes source-bonded Track`);
        assert.equal(app._netGuideLine.getAttribute('x1'), '8');
        toggleTrackLayer(app);
        updateTrackDraw(app, { x: 8, y: 4 });
        assert.equal(app._netGuideLine, null, 'layer switch does not guide to inaccessible top-only Pad');
        cancelTrackDraw(app);
        assert.equal(app._netGuideLine, null);

        const dragged = board();
        const track = new Track({ points: [{ x: 0, y: 0 }, { x: 5, y: 0 }], net: 'GND' });
        dragged.tracks = [track];
        dragged.pads = [new Pad({ x: 20, y: 0, net: 'GND' })];
        startVertexDrag(dragged, track, { x: 5, y: 0 });
        updateVertexDrag(dragged, { x: 8, y: 4 });
        assert.equal(dragged._netGuideLine?.getAttribute('x2'), '20', 'endpoint drag uses the same guide policy');
        cancelVertexDrag(dragged);
    }
    const app = board();
    const source = rect();
    app.boardShapes = [source];
    app.pads = [new Pad({ x: 30, y: 15, net: 'GND' })];
    startTrackDraw(app, { x: 15, y: 15 });
    updateTrackDraw(app, { x: 22, y: 15 });
    assert.equal(app._netGuideLine?.getAttribute('x2'), '30', 'guide does not return to the originating copper shape');
    cancelTrackDraw(app);
} finally {
    ratlines.visible = previous;
}
console.log('PASS live net guide visibility, all copper targets, layer filtering, source exclusions and cleanup');
