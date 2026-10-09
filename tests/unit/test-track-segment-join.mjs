import assert from 'node:assert/strict';
import { installFakeDom, fakeElement } from './helpers/fake-dom.mjs';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';
import { CommandHistory } from '../../src/core/CommandHistory.js';
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { Track } from '../../src/shapes/track.js';
import { closestPointOnArcEdge } from '../../src/shapes/arc-edge.js';

installFakeDom();
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
const { startTrackDraw, updateTrackDraw, addTrackWaypoint, cancelTrackDraw, getTrackDraw,
    setTrackToolLayer } = await import('../../src/pcb/modules/track-draw.js');
const { resolveTrackSnap, hasTrackSnapMarker } = await import('../../src/pcb/modules/track-snap.js');
const { startVertexDrag, updateVertexDrag, finishVertexDrag, cancelVertexDrag } =
    await import('../../src/pcb/modules/track-drag.js');
const { default: PCBApp } = await import('../../src/ui/PCBApp.js');

function fixture(net = '', bulge = 0) {
    const target = new Track({ net: 'SIGNAL', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], width: 0.4 });
    target.setEdgeAttr([...target.edges.keys()][0], 'bulge', bulge);
    const moving = new Track({ net, points: [{ x: 5, y: 5 }, { x: 5, y: 10 }] });
    const pcbDocument = new PcbDocument();
    pcbDocument.tracks.push(target, moving);
    const groups = new Map();
    const app = {
        ...pcbEditorStubs(), pcbDocument, history: new CommandHistory(),
        placements: new Map(), netlist: [], copperFills: [],
        viewport: { scale: 100, svg: fakeElement('svg'), gridVisible: false,
            setCrosshair() {}, hideCrosshair() {} },
        getLayerGroup(id) {
            if (!groups.has(id)) groups.set(id, fakeElement('g'));
            return groups.get(id);
        },
        existingLayerGroups: () => groups,
        getRoutingParams: () => ({ trackWidth: 0.2, clearance: 0.1, viaDiameter: 0.6, viaDrill: 0.3 }),
        alert(message) { throw new Error(message); },
    };
    for (const key of ['tracks', 'vias', 'pads', 'boardShapes', 'texts']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    setTrackToolLayer(app, 'top-copper');
    return { app, target, moving };
}

for (const net of ['', 'SIGNAL']) {
    for (const bulge of [0, 0.3]) {
        const { app, target, moving } = fixture(net, bulge);
        const point = closestPointOnArcEdge({ x: 5, y: -2 }, { x: 0, y: 0 }, { x: 10, y: 0 }, bulge);
        const before = target.captureState();
        const movingBefore = moving.captureState();
        const snap = resolveTrackSnap(app, point, { net });
        assert.equal(snap.snapType, 'track-segment');
        assert.equal(snap.trackSegment.track, target);
        startVertexDrag(app, moving, { x: 5, y: 5 }, { nodeId: [...moving.nodes.keys()][0] });
        updateVertexDrag(app, point);
        assert.ok(hasTrackSnapMarker(app), 'dragging over a segment shows the yellow join marker');
        assert.deepEqual(target.captureState(), before, 'hover does not split canonical target copper');
        finishVertexDrag(app);
        assert.equal(app.tracks.length, 1, 'drop joins both tracks into one graph');
        const junction = [...moving.nodes].find(([, p]) => Math.hypot(p.x - point.x, p.y - point.y) < 1e-6);
        assert.ok(junction);
        assert.equal(moving.degree(junction[0]), 3, 'target segment is split into a T junction');
        assert.equal(moving.net, 'SIGNAL');
        assert.equal(app.history.undoStack.length, 1);
        app.history.undo();
        assert.equal(app.tracks.length, 2);
        assert.deepEqual(target.captureState(), before);
        assert.deepEqual(moving.captureState(), movingBefore);
        app.history.redo();
        assert.equal(app.tracks.length, 1);
    }
}

for (const [startOnTarget, bulge] of [[false, 0], [true, 0], [false, -0.3], [true, -0.3]]) {
    const { app, target, moving } = fixture('', bulge);
    app.tracks.splice(app.tracks.indexOf(moving), 1);
    const before = target.captureState();
    const point = closestPointOnArcEdge({ x: 5, y: 2 }, { x: 0, y: 0 }, { x: 10, y: 0 }, bulge);
    startTrackDraw(app, startOnTarget ? point : { x: 5, y: 5 });
    if (startOnTarget) assert.equal(getTrackDraw(app).net, 'SIGNAL');
    updateTrackDraw(app, startOnTarget ? { x: 5, y: 5 } : point);
    if (!startOnTarget) assert.ok(hasTrackSnapMarker(app), 'drawing over a segment shows the yellow join marker');
    assert.deepEqual(target.captureState(), before);
    addTrackWaypoint(app, startOnTarget ? { x: 5, y: 5 } : point);
    if (startOnTarget) addTrackWaypoint(app, { x: 5, y: 5 });
    assert.equal(getTrackDraw(app), null);
    assert.equal(app.tracks.length, 1);
    assert.equal(target.net, 'SIGNAL');
    assert.ok([...target.nodes.keys()].some(id => target.degree(id) === 3));
    app.history.undo();
    assert.deepEqual(target.captureState(), before);
    app.history.redo();
    assert.ok([...target.nodes.keys()].some(id => target.degree(id) === 3));
}

{
    const { app, target, moving } = fixture('SIGNAL');
    target.net = '';
    startVertexDrag(app, moving, { x: 5, y: 5 }, { nodeId: [...moving.nodes.keys()][0] });
    updateVertexDrag(app, { x: 5, y: 0 });
    finishVertexDrag(app);
    assert.equal(app.tracks.length, 1, 'a named track can join an unassigned target');
    assert.equal(moving.net, 'SIGNAL');
    app.history.undo();
    assert.equal(target.net, '');
}

{
    const { app, target, moving } = fixture();
    const nodeId = [...moving.nodes.keys()][0];
    Object.assign(moving.nodes.get(nodeId), { x: 5, y: 0 });
    startVertexDrag(app, moving, { x: 5, y: 0 }, { nodeId });
    updateVertexDrag(app, { x: 5, y: 0 });
    finishVertexDrag(app);
    assert.equal(app.tracks.length, 1, 'picking up and dropping an already coincident endpoint still joins');
    assert.equal(moving.net, target.net);
    app.history.undo();
    assert.equal(app.tracks.length, 2);
}

{
    const { app, target, moving } = fixture();
    const before = target.captureState();
    startVertexDrag(app, moving, { x: 5, y: 5 }, { nodeId: [...moving.nodes.keys()][0] });
    updateVertexDrag(app, { x: 5, y: 0 });
    cancelVertexDrag(app);
    assert.deepEqual(target.captureState(), before);
    assert.equal(app.history.undoStack.length, 0);
    startTrackDraw(app, { x: 5, y: 0 });
    cancelTrackDraw(app);
    assert.deepEqual(target.captureState(), before);
}

for (const restriction of ['locked', 'hidden', 'other-layer', 'other-net', 'shift']) {
    const { app, target } = fixture();
    if (restriction === 'locked') target.locked = true;
    if (restriction === 'hidden') target.visible = false;
    if (restriction === 'other-layer') {
        for (const edgeId of target.edges.keys()) target.setEdgeAttr(edgeId, 'layer', 'bottom-copper');
    }
    if (restriction === 'shift') app.viewport.shiftHeld = true;
    const snap = resolveTrackSnap(app, { x: 5, y: 0 }, { net: restriction === 'other-net' ? 'OTHER' : '' });
    assert.notEqual(snap.snapType, 'track-segment', restriction);
}

console.log('PASS track segment joins: drawing, node drags, arcs, yellow markers, cancellation and atomic undo/redo');
