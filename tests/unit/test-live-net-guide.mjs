import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { setComputedFill } from '../../src/pcb/modules/computed-fill-cache.js';
import { getVertexDrag } from '../../src/pcb/modules/track-drag.js';
import { getNetGuideLine } from '../../src/pcb/modules/ratsnest.js';
import { getTrackDraw, setTrackToolNet } from '../../src/pcb/modules/track-draw.js';
import { storedDrcRatlines } from '../../src/pcb/modules/drc-state.js';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';

function element() {
    const classes = new Set();
    return {
        attributes: new Map(), children: [], dataset: {}, style: {},
        classList: { add(name) { classes.add(name); }, contains(name) { return classes.has(name); } },
        setAttribute(key, value) {
            this.attributes.set(key, String(value));
            if (key === 'class') { classes.clear(); String(value).split(/\s+/).forEach(name => classes.add(name)); }
        },
        getAttribute(key) { return this.attributes.get(key); },
        appendChild(child) { this.children.push(child); child.parent = this; },
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); },
    };
}
const document = installFakeDom();
document.createElementNS = element;
document.getElementById = () => null;
const { nearestPointOnNet, reconcileRatsnest } = await import('../../src/pcb/modules/ratsnest.js');
const { startTrackDraw, updateTrackDraw, cancelTrackDraw, toggleTrackLayer, addTrackWaypoint, finishTrackDraw } = await import('../../src/pcb/modules/track-draw.js');
const { startVertexDrag, updateVertexDrag, cancelVertexDrag } = await import('../../src/pcb/modules/track-drag.js');
const { PCB_OVERLAYS } = await import('../../src/pcb/modules/layers.js');
const { Pad } = await import('../../src/shapes/pad.js');
const { Track } = await import('../../src/shapes/track.js');
const { pictureShape } = await import('../../src/shared/pcb/picture-raster.js');
const board = () => {
    const ratLayer = element(), svg = element();
    svg.appendChild(ratLayer);
    const app = { ...pcbEditorStubs(),
        tracks: [], vias: [], pads: [], boardShapes: [], copperFills: [], placements: new Map(), netlist: [], ratLayer,
        getLayerGroup(id) { return id === 'ratlines' ? ratLayer : null; },
        viewport: { svg, scale: 100, gridVisible: false, setCrosshair() {}, hideCrosshair() {} },
        history: { execute(command) { command.execute(); } },
        // The editor's ratline service, which drags call after each move.
        updateRatsnest(options) { reconcileRatsnest(app, options); },
    };
    app.pcbDocument = {
        get tracks() { return app.tracks; },
        get vias() { return app.vias; },
        get pads() { return app.pads; },
        get boardShapes() { return app.boardShapes; },
        get copperFills() { return app.copperFills; },
    };
    setTrackToolNet(app, 'GND');
    return app;
};
const endpoints = line => ['x1', 'y1', 'x2', 'y2'].map(key => Number(line.getAttribute(key)));
const edgeKey = (net, [x1, y1, x2, y2]) => `${net}:${[[x1, y1], [x2, y2]].map(point => point.join(',')).sort().join('|')}`;
function assertCompleteGraph(app, layer) {
    const visible = layer.children.filter(line => line.style.visibility !== 'hidden');
    if (getNetGuideLine(app)) visible.push(getNetGuideLine(app));
    assert.deepEqual(visible.map(line => edgeKey(line.dataset.net, endpoints(line))).sort(),
        storedDrcRatlines(app).map(line => edgeKey(line.net, [line.x1, line.y1, line.x2, line.y2])).sort(),
        'solid lines plus the dashed replacement represent every real ratline exactly once');
    assert.equal(layer.children.filter(line => line.style.visibility === 'hidden').length,
        getNetGuideLine(app) ? 1 : 0, 'only the exact dashed replacement is hidden');
}
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
    const fill = { type: 'fill', layer: 'top-copper', net: 'GND' };
    setComputedFill(fill, [{ outer: square(0, 20), holes: [square(5, 15)] }]);
    app.copperFills = [fill];
    const target = nearestPointOnNet(app, 'GND', { x: 10, y: 10 });
    assert.equal(Math.hypot(target.x - 10, target.y - 10), 5,
        'guide from a fill hole targets real poured copper, not the empty hole');
    setComputedFill(fill, []);
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
        assert.ok(endpoints(getNetGuideLine(app)).includes(20),
            `guide exists with Ratlines ${visible ? 'visible' : 'hidden'} and excludes source-bonded Track`);
        assert.ok(endpoints(getNetGuideLine(app)).includes(8));
        assertCompleteGraph(app, app.ratLayer);
        toggleTrackLayer(app);
        updateTrackDraw(app, { x: 8, y: 4 });
        assertCompleteGraph(app, app.ratLayer);
        cancelTrackDraw(app);
        assert.equal(getNetGuideLine(app), null);

        const dragged = board();
        const track = new Track({ points: [{ x: 0, y: 0 }, { x: 5, y: 0 }], net: 'GND' });
        dragged.tracks = [track];
        dragged.pads = [new Pad({ x: 20, y: 0, net: 'GND' })];
        startVertexDrag(dragged, track, { x: 5, y: 0 });
        updateVertexDrag(dragged, { x: 8, y: 4 });
        assert.ok(endpoints(getNetGuideLine(dragged)).includes(20), 'endpoint drag uses the same guide policy');
        assertCompleteGraph(dragged, dragged.ratLayer);
        cancelVertexDrag(dragged);
    }
    for (const visible of [true, false]) {
        ratlines.visible = visible;
        const app = board(), layer = element();
        app.viewport.svg.appendChild(layer);
        layer.style.display = visible ? '' : 'none';
        app.getLayerGroup = id => id === 'ratlines' ? layer : null;
        app.pads = [
            new Pad({ x: 0, y: 0, net: 'GND' }),
            new Pad({ x: 20, y: 0, net: 'GND', layers: 'top-copper' }),
            new Pad({ x: 40, y: 0, net: 'GND', layers: 'top-copper' }),
            new Pad({ x: 0, y: 10, net: 'OTHER' }), new Pad({ x: 30, y: 10, net: 'OTHER' }),
        ];
        app.tracks = [new Track({ points: [{ x: 0, y: 0 }, { x: 5, y: 0 }], net: 'GND' })];
        reconcileRatsnest(app);
        const originalTracks = [...app.tracks];
        const geometry = originalTracks.map(track => track.captureState());
        const idleGraph = storedDrcRatlines(app).map(line => JSON.stringify(line)).sort();
        startTrackDraw(app, { x: 0, y: 0 });
        updateTrackDraw(app, { x: 8, y: 4 });
        assert.deepEqual(app.tracks, originalTracks, 'draft connectivity never installs provisional tracks in the authored model');
        assert.deepEqual(app.tracks.map(track => track.captureState()), geometry);
        const preview = getTrackDraw(app).ratlinePreview;
        updateTrackDraw(app, { x: 8, y: 4 });
        assert.equal(getTrackDraw(app).ratlinePreview, preview, 'unchanged pointer positions reuse provisional graph input');
        assertCompleteGraph(app, layer);
        assert.equal(getNetGuideLine(app).parent, app.viewport.svg, 'dashed guide is outside the toggleable ratline layer');
        assert.equal(getNetGuideLine(app).getAttribute('stroke-dasharray'), '4 3');
        const records = structuredClone(storedDrcRatlines(app));
        reconcileRatsnest(app);
        assertCompleteGraph(app, layer);
        assert.deepEqual(storedDrcRatlines(app).map(line => JSON.stringify(line)).sort(),
            records.map(line => JSON.stringify(line)).sort(), 'presentation styling never removes DRC connectivity records');
        layer.style.display = visible ? 'none' : '';
        updateTrackDraw(app, { x: 9, y: 4 });
        assert.ok(getNetGuideLine(app), 'mid-gesture visibility toggling never hides the live guide');
        toggleTrackLayer(app);
        updateTrackDraw(app, { x: 9, y: 4 });
        assertCompleteGraph(app, layer);
        cancelTrackDraw(app);
        assert.deepEqual(storedDrcRatlines(app).map(line => JSON.stringify(line)).sort(), idleGraph,
            'cancelling removes every provisional connectivity change');
        startTrackDraw(app, { x: 0, y: 0 });
        updateTrackDraw(app, { x: 8, y: 4 });
        cancelTrackDraw(app);
        assert.ok(layer.children.every(line => line.style.visibility !== 'hidden'), 'cancel restores suppressed lines');
        startTrackDraw(app, { x: 0, y: 0 });
        updateTrackDraw(app, { x: 8, y: 4 });
        addTrackWaypoint(app, { x: 8, y: 4 });
        finishTrackDraw(app);
        assert.equal(getNetGuideLine(app), null);
        assert.ok(layer.children.every(line => line.style.visibility !== 'hidden'), 'commit restores the rebuilt ratlines');
    }
    {
        const app = board(), layer = element();
        app.getLayerGroup = id => id === 'ratlines' ? layer : null;
        const source = new Track({ points: [{ x: 0, y: 0 }, { x: 5, y: 0 }], net: 'GND' });
        const target = new Track({ points: [{ x: 20, y: -5 }, { x: 20, y: 5 }], net: 'GND' });
        target.edges.values().next().value.bulge = 0.5;
        const tracks = [source, target];
        Object.defineProperty(app, 'tracks', { get: () => getVertexDrag(app)?.preview?.tracks || tracks });
        reconcileRatsnest(app);
        startVertexDrag(app, source, { x: 5, y: 0 });
        updateVertexDrag(app, { x: 8, y: 1 });
        assert.ok(getNetGuideLine(app));
        assert.equal(layer.children.length, 1);
        assertCompleteGraph(app, layer);
        assert.deepEqual(endpoints(getNetGuideLine(app)), endpoints(layer.children[0]),
            'arc guide uses the exact node-to-node ratline, never an independently projected point on its curve');
        app.pads = [new Pad({ x: 10, y: 20, net: 'GND' }), new Pad({ x: 25, y: 20, net: 'GND' })];
        const graphs = new Set();
        for (const point of [{ x: 8, y: 1 }, { x: 12, y: 14 }, { x: 28, y: 9 }, { x: 8, y: 1 }]) {
            updateVertexDrag(app, point);
            assertCompleteGraph(app, layer);
            graphs.add(JSON.stringify(storedDrcRatlines(app)));
        }
        assert.ok(graphs.size >= 3, 'coverage is checked across real multi-island MST rewiring, not a fixed two-object graph');
        cancelVertexDrag(app);
        assert.equal(getNetGuideLine(app), null);
        assert.ok(layer.children.every(line => line.style.visibility !== 'hidden'));
    }
    const app = board();
    const source = rect();
    app.boardShapes = [source];
    app.pads = [new Pad({ x: 30, y: 15, net: 'GND' })];
    startTrackDraw(app, { x: 15, y: 15 });
    updateTrackDraw(app, { x: 22, y: 15 });
    assert.ok(endpoints(getNetGuideLine(app)).includes(30), 'guide does not return to the originating copper shape');
    cancelTrackDraw(app);
} finally {
    ratlines.visible = previous;
}
console.log('PASS live net guide visibility, duplicate ratline suppression, DRC isolation, copper targets and cleanup');
