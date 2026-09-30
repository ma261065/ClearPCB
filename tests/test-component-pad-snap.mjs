import assert from 'node:assert/strict';

const element = () => ({ setAttribute() {}, appendChild() {}, remove() {}, classList: { add() {} } });
globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: element, getElementById() { return null; } };
const { findNearbyPad, resolveTrackDrawSnap, startTrackDraw, updateTrackDraw, cancelTrackDraw } =
    await import('../src/pcb/modules/track-draw.js');
const { startVertexDrag, updateVertexDrag, cancelVertexDrag } = await import('../src/pcb/modules/track-drag.js');
const { snapPathPoint, snapPathTranslation } = await import('../src/pcb/modules/path-edit.js');
const { Track } = await import('../src/shapes/track.js');

function fixture(shape = 'rect', width = 0.5, height = 0.5, rotation = 0) {
    return {
        placements: new Map([['U1', {
            x: 10, y: 10, rotation,
            pads: new Map([['1:2', { x: 10, y: 10, number: '1' }]]),
            padOffsets: [{ padId: '1:2', number: '1', dx: 0, dy: 0, width, height, shape }],
        }]]),
        netlist: [{ net: 'SIGNAL', pins: [{ componentId: 'U1', pinNumber: '1' }] }],
        tracks: [], vias: [], pads: [], boardShapes: [],
        _getLayerGroup() { return null; },
        viewport: { svg: element(), scale: 100, gridVisible: false, setCrosshair() {}, hideCrosshair() {} },
    };
}

for (const scale of [1, 10, 100, 1000]) {
    const app = fixture();
    app.viewport.scale = scale;
    const outside = { x: 10.251, y: 10 };
    const inside = { x: 10.249, y: 10 };
    assert.equal(findNearbyPad(app, outside, 100), null, 'tolerance cannot expand a component Pad');
    assert.equal(resolveTrackDrawSnap(app, outside).snapType, 'free');
    const snap = resolveTrackDrawSnap(app, inside);
    assert.equal(snap.snapType, 'pad');
    assert.deepEqual([snap.x, snap.y, snap.pad.pinNumber, snap.pad.net], [10, 10, '1:2', 'SIGNAL']);
    assert.ok(findNearbyPad(app, { x: 10.25, y: 10 }), 'Pad boundary is included');
    assert.deepEqual(snapPathPoint(app, outside, [], true), outside, 'line editing does not snap outside');
    assert.deepEqual(snapPathPoint(app, inside, [], true), { x: 10, y: 10 });
    assert.deepEqual(snapPathTranslation(app, [{ x: 0, y: 0 }], outside), outside);
    const translation = snapPathTranslation(app, [{ x: 0, y: 0 }], inside);
    assert.deepEqual([translation.x, translation.y], [10, 10]);

    startTrackDraw(app, { x: -50, y: -20 });
    updateTrackDraw(app, outside);
    assert.notEqual(app._trackDraw.snap.snapType, 'pad');
    assert.ok(!app._trackSnapMarker, 'no yellow marker before entering the Pad');
    updateTrackDraw(app, inside);
    assert.equal(app._trackDraw.snap.snapType, 'pad');
    assert.ok(app._trackSnapMarker);
    cancelTrackDraw(app);

    const track = new Track({ points: [{ x: -50, y: -20 }, { x: -30, y: -10 }] });
    app.tracks = [track];
    const nodeId = [...track.nodes.keys()][1];
    startVertexDrag(app, track, track.nodes.get(nodeId), { nodeId });
    updateVertexDrag(app, outside);
    assert.ok(!track.padConnections.has(nodeId), 'dragging does not bond outside the Pad');
    assert.ok(!app._trackSnapMarker);
    updateVertexDrag(app, inside);
    assert.deepEqual(app._vertexDrag.track.nodes.get(nodeId), { x: 10, y: 10 });
    assert.deepEqual(app._vertexDrag.track.padConnections.get(nodeId), { componentId: 'U1', pinNumber: '1:2' });
    assert.deepEqual(track.nodes.get(nodeId), { x: -30, y: -10 }, 'Canonical node is not snapped during preview');
    assert.ok(app._trackSnapMarker);
    updateVertexDrag(app, outside);
    assert.ok(!app._vertexDrag.track.padConnections.has(nodeId), 'leaving the Pad releases the snap');
    assert.ok(!app._trackSnapMarker);
    cancelVertexDrag(app);
}

for (const [shape, width, height, rotation, inside, outside] of [
    ['rect', 4, 0.5, 0, [1.99, 0], [0, 0.251]],
    ['rect', 4, 0.5, 90, [0, 1.99], [0.251, 0]],
    ['rect', 2, 0.5, 45, [0.5, 0.5], [0.5, -0.5]],
    ['circle', 1, 1, 0, [0.49, 0], [0.4, 0.4]],
    ['ellipse', 2, 1, 0, [0.99, 0], [0.9, 0.4]],
    ['oval', 2, 1, 0, [0.99, 0], [0.9, 0.4]],
]) {
    const app = fixture(shape, width, height, rotation);
    assert.ok(findNearbyPad(app, { x: 10 + inside[0], y: 10 + inside[1] }, 0.001),
        `${shape} at ${rotation} degrees snaps throughout its outline, not just near its centre`);
    assert.equal(findNearbyPad(app, { x: 10 + outside[0], y: 10 + outside[1] }), null,
        `${shape} at ${rotation} degrees rejects points outside its outline`);
}

{
    const app = fixture();
    app.placements.get('U1').padOffsets = [];
    assert.equal(findNearbyPad(app, { x: 10.601, y: 10 }), null, 'legacy Pads use their default dimensions');
    assert.ok(findNearbyPad(app, { x: 10.599, y: 10 }));
    app.viewport.shiftHeld = true;
    assert.equal(resolveTrackDrawSnap(app, { x: 10, y: 10 }).snapType, 'free');
}

console.log('PASS component Pad outline snapping for drawing, endpoint/line dragging, shapes, rotation and zoom');
