import assert from 'node:assert/strict';
import { getComputedFill, setComputedFill } from '../src/pcb/modules/computed-fill-cache.js';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { getTrackDraw } from '../src/pcb/modules/track-draw.js';

const element = () => ({ setAttribute() {}, appendChild() {}, remove() {}, classList: { add() {} } });
globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: element, getElementById() { return null; } };
globalThis.requestAnimationFrame = () => 0;
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const copperPrototype = Object.create(null, Object.fromEntries(['tracks', 'vias', 'pads', 'boardShapes']
    .map(key => [key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key)])));
const { Track } = await import('../src/shapes/track.js');
const { Via } = await import('../src/shapes/via.js');
const { Pad } = await import('../src/shapes/pad.js');
const { CopperFill } = await import('../src/shapes/copper-fill.js');
const { startTrackDraw, addTrackWaypoint, cancelTrackDraw, toggleTrackLayer } =
    await import('../src/pcb/modules/track-draw.js');
const { buildDrawnTrackCommands } = await import('../src/pcb/modules/track-drag.js');
const { computeFillPolygons, loadClipper } = await import('../src/pcb/modules/copper-fill-geom.js');
const { buildFillContext } = await import('../src/pcb/modules/fill-context.js');
const { pointInCopperRegion } = await import('../src/pcb/modules/track-contact-geometry.js');

function fixture() {
    const commands = [];
    return Object.assign(Object.create(copperPrototype), {
        pcbDocument: new PcbDocument(),
        tracks: [], vias: [], pads: [], boardShapes: [], copperFills: [], netlist: [
            { net: 'SIGNAL', pins: [{ componentId: 'U1', pinNumber: '1' }] },
        ],
        placements: new Map([['U1', { pads: new Map([['1', { x: 20, y: 0, number: '1' }]]) }]]),
        _commitTracks: PCBApp.prototype._commitTracks,
        getLayerGroup() { return null; },
        _shapeElements: new Map(),
        alert(message) { this.lastAlert = message; },
        viewport: { scale: 100, gridVisible: false, setCrosshair() {}, hideCrosshair() {} },
        commands, history: { execute(command) { commands.push(command); command.execute(); } },
    });
}
const track = (x1, y1, x2, y2, layer = 'top-copper') =>
    new Track({ points: [{ x: x1, y: y1 }, { x: x2, y: y2 }], layer });
const rectangle = (x1, y1, x2, y2, extra = {}) => ({
    id: `shape-${x1}-${y1}`, kind: 'rect', filled: true, lineWidth: 0, copperMode: 'add',
    layer: 'top-copper', net: '', points: [
        { x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 },
    ], ...extra,
});

for (const gap of [0.001, 0.025, 0.1, 0.5]) {
    for (const reverse of [false, true]) {
        for (const nearPadOnly of [false, true]) {
            const app = fixture();
            const via = new Via({ x: 0, y: 0 });
            const pin = app.placements.get('U1').pads.get('1');
            pin.width = pin.height = 1.2;
            const ground = new CopperFill({ layer: 'top-copper', net: 'GND' });
            setComputedFill(ground, nearPadOnly
                ? [{ outer: rectangle(pin.x + pin.width / 2 + gap, -2, 25, 2).points, holes: [] }]
                : [{ outer: rectangle(-5, -5, 25, 5).points, holes: [
                    rectangle(-1, -1, 1, 1).points,
                    rectangle(19, -1, 21, 1).points,
                ] }]);
            app.boardShapes.push(ground);
            app.vias.push(via);
            startTrackDraw(app, { x: reverse ? 20 : 0, y: 0 });
            addTrackWaypoint(app, { x: reverse ? 0 : 20, y: 0 });
            assert.equal(app.lastAlert, undefined, nearPadOnly
                ? `a Pad separated from a GND pour by ${gap} mm is not bonded to it`
                : 'a new Track through a GND pour reserves clearance instead of adopting its Net');
            assert.equal(via.net, 'SIGNAL');
            assert.equal(app.tracks[0].net, 'SIGNAL');
            assert.equal(ground.net, 'GND');
            app.commands[0].undo();
            assert.equal(via.net, '');
            assert.equal(app.tracks.length, 0);
            assert.equal(ground.net, 'GND');
            app.commands[0].execute();
            assert.equal(via.net, 'SIGNAL');
            assert.equal(ground.net, 'GND');
        }
    }
}

await loadClipper();
{
    // Starting on a SIGNAL pin and bending/finishing inside a GND pour reserves clearance;
    // the pour is not copper the new Track connects to.
    const app = fixture();
    const pin = app.placements.get('U1').pads.get('1');
    pin.width = pin.height = 1.2;
    const ground = new CopperFill({ layer: 'top-copper', net: 'GND' });
    setComputedFill(ground, [{ outer: rectangle(-5, -5, 25, 5).points, holes: [rectangle(19, -1, 21, 1).points] }]);
    app.boardShapes.push(ground);
    const draw = startTrackDraw(app, { x: 20, y: 0 });
    assert.equal(draw?.net, 'SIGNAL', 'The draw starts on the pin despite the surrounding GND pour');
    addTrackWaypoint(app, { x: 10, y: 3 });
    assert.equal(getTrackDraw(app)?.points.length, 2, 'A bend inside a foreign-net pour is accepted, not a Net conflict');
    addTrackWaypoint(app, { x: 5, y: 3 });
    addTrackWaypoint(app, { x: 5, y: 3 });
    assert.equal(getTrackDraw(app), null, 'Finishing inside the pour completes the Track');
    assert.equal(app.tracks.length, 1);
    assert.equal(app.tracks[0].net, 'SIGNAL');
    assert.equal(ground.net, 'GND');
}
for (const clearance of [0.025, 0.1, 0.3, 0.5]) {
    const app = fixture();
    app.texts = new Map();
    app.getRoutingParams = () => ({ clearance });
    const via = new Via({ x: 0, y: 0 });
    const ground = new CopperFill({ layer: 'top-copper', net: 'GND',
        outline: rectangle(-5, -5, 25, 5).points });
    app.vias.push(via);
    app.boardShapes.push(ground);
    app.copperFills.push(ground);
    app.refreshFills = () => {
        const context = buildFillContext(app);
        assert.equal(context.params.clearance, clearance);
        setComputedFill(ground, computeFillPolygons(ground, context));
        return false;
    };
    const hasCopper = point => getComputedFill(ground).some(region => pointInCopperRegion(point, region));
    app.refreshFills();
    assert.ok(hasCopper({ x: 10, y: 0 }), 'GND copper initially occupies the future route');
    startTrackDraw(app, { x: 20, y: 0 });
    addTrackWaypoint(app, { x: 0, y: 0 });
    assert.equal(app.lastAlert, undefined);
    assert.equal(via.net, 'SIGNAL');
    assert.equal(ground.net, 'GND');
    assert.ok(!hasCopper({ x: 10, y: 0 }));
    const halfWidth = app.tracks[0].width / 2;
    assert.ok(!hasCopper({ x: 10, y: halfWidth + clearance * 0.9 }),
        `repouring keeps the configured ${clearance} mm clearance empty`);
    assert.ok(hasCopper({ x: 10, y: halfWidth + clearance + 0.05 }), 'nearby GND copper is preserved');
    app.commands[0].undo();
    assert.equal(via.net, '');
    assert.ok(hasCopper({ x: 10, y: 0 }), 'Undo restores the original pour');
    app.commands[0].execute();
    assert.equal(via.net, 'SIGNAL');
    assert.ok(!hasCopper({ x: 10, y: 0 }), 'Redo cuts the routing clearance again');
}

for (const reverse of [false, true]) {
    const app = fixture();
    const source = new Via({ x: 0, y: 0 });
    const bridge = new Via({ x: -5, y: 0 });
    const pad = new Pad({ x: -10, y: 0, layers: 'both' });
    app.vias.push(source, bridge);
    app.pads.push(pad);
    app.tracks.push(track(0, 0, -5, 0), track(-5, 0, -10, 0, 'bottom-copper'));
    const unrelated = new Via({ x: -30, y: 0 });
    app.vias.push(unrelated);
    const originals = [...app.tracks];
    const before = originals.map(item => item.captureState());
    startTrackDraw(app, { x: reverse ? 20 : 0, y: 0 });
    addTrackWaypoint(app, { x: reverse ? 0 : 20, y: 0 });
    assert.equal(getTrackDraw(app), null);
    assert.equal(app.commands.length, 1);
    for (const item of [...app.tracks, source, bridge, pad]) assert.equal(item.net, 'SIGNAL');
    assert.equal(unrelated.net, '');
    assert.equal(app.netlist[0].net, 'SIGNAL', 'schematic assignments are never modified');
    app.commands[0].undo();
    assert.deepEqual(app.tracks, originals);
    assert.deepEqual(originals.map(item => item.captureState()), before);
    for (const item of [source, bridge, pad]) assert.equal(item.net, '');
    app.commands[0].execute();
    for (const item of [...app.tracks, source, bridge, pad]) assert.equal(item.net, 'SIGNAL');
}

{
    const app = fixture();
    const source = new Via({ x: 0, y: 0 });
    app.vias.push(source);
    startTrackDraw(app, { x: 0, y: 0 });
    addTrackWaypoint(app, { x: 20, y: 0 });
    assert.equal(source.net, 'SIGNAL', 'the original Via-only reproduction inherits the destination pin Net');
    app.commands[0].undo();
    assert.equal(source.net, '');
    assert.equal(app.tracks.length, 0);
}

{
    const app = fixture();
    app.placements.clear();
    const source = new Via({ x: 0, y: 0 });
    const destination = new Via({ x: 20, y: 10, net: 'SIGNAL' });
    app.vias.push(source, destination);
    startTrackDraw(app, { x: 0, y: 0 });
    addTrackWaypoint(app, { x: 10, y: 0 });
    toggleTrackLayer(app);
    addTrackWaypoint(app, { x: 20, y: 10 });
    assert.equal(app.tracks.length, 2, 'layer changes retain separate single-layer Tracks');
    assert.equal(app.vias.length, 3);
    for (const item of [...app.tracks, ...app.vias]) assert.equal(item.net, 'SIGNAL');
    app.commands[0].undo();
    assert.equal(app.tracks.length, 0);
    assert.deepEqual(app.vias, [source, destination]);
    assert.equal(source.net, '');
    app.commands[0].execute();
    assert.equal(app.tracks.length, 2);
    assert.equal(app.vias.length, 3);
    assert.equal(source.net, 'SIGNAL');
}

{
    const app = fixture();
    const disconnected = track(0, 0, -5, 0);
    const remoteStart = disconnected.addNode(-30, 0);
    const remoteEnd = disconnected.addNode(-35, 0);
    disconnected.addEdge(remoteStart, remoteEnd);
    const before = disconnected.captureState();
    app.tracks.push(disconnected);
    app.vias.push(new Via({ x: -30, y: 0 }));
    const drawn = track(0, 0, 20, 0);
    const command = buildDrawnTrackCommands(app, [drawn]);
    assert.deepEqual(disconnected.captureState(), before, 'command construction does not mutate existing copper');
    command.execute();
    assert.equal(disconnected.net, 'SIGNAL');
    assert.equal(app.tracks.find(item => item.nodes.has(remoteStart))?.net, '',
        'disconnected subgraphs keep their unassigned Net');
    assert.equal(app.vias[0].net, '');
    command.undo();
    assert.deepEqual(app.tracks, [disconnected]);
    assert.deepEqual(disconnected.captureState(), before);
    command.execute();
    assert.equal(app.tracks.length, 2);
}

{
    const app = fixture();
    const source = new Via({ x: 0, y: 0 });
    const bottom = track(0, 0, -10, 0, 'bottom-copper');
    app.tracks.push(bottom);
    app._commitTracks([track(0, 0, 20, 0)]);
    assert.equal(bottom.net, '', 'opposite layers do not bond without a plated terminal');
    app.commands[0].undo();
    app.vias.push(source);
    app._commitTracks([track(0, 0, 20, 0)]);
    assert.equal(bottom.net, 'SIGNAL');
    assert.equal(source.net, 'SIGNAL');
}

{
    const app = fixture();
    const sourceShape = rectangle(-3, -1, 1, 1);
    const nextShape = rectangle(-6, -1, -3, 1);
    const lastTrack = track(-6, 0, -10, 0);
    const pad = new Pad({ x: -10, y: 0 });
    app.boardShapes.push(sourceShape, nextShape,
        rectangle(-3, -1, 1, 1, { id: 'other-layer', layer: 'bottom-copper' }),
        rectangle(-20, -1, -15, 1));
    app.tracks.push(lastTrack);
    app.pads.push(pad);
    startTrackDraw(app, { x: 0, y: 0 });
    addTrackWaypoint(app, { x: 20, y: 0 });
    for (const item of [sourceShape, nextShape, lastTrack, pad]) assert.equal(item.net, 'SIGNAL');
    assert.equal(app.boardShapes[2].net, '');
    assert.equal(app.boardShapes[3].net, '');
    app.commands[0].undo();
    for (const item of [sourceShape, nextShape, lastTrack, pad]) assert.equal(item.net, '');
    app.commands[0].execute();
    for (const item of [sourceShape, nextShape, lastTrack, pad]) assert.equal(item.net, 'SIGNAL');
}

{
    const app = fixture();
    const fill = new CopperFill({ layer: 'top-copper', net: '' });
    setComputedFill(fill, [{ outer: rectangle(-10, -2, 1, 2).points,
        holes: [rectangle(-8, -1, -6, 1).points] }]);
    const holeVia = new Via({ x: -7, y: 0, diameter: 0.6 });
    const connectedVia = new Via({ x: -4, y: 0 });
    app.boardShapes.push(fill);
    app.vias.push(holeVia, connectedVia);
    app._commitTracks([track(0, 0, 20, 0)]);
    assert.equal(fill.net, 'SIGNAL');
    assert.equal(connectedVia.net, 'SIGNAL');
    assert.equal(holeVia.net, '', 'a fill hole is not conductive');
    app.commands[0].undo();
    assert.equal(fill.net, '');
    assert.equal(connectedVia.net, '');
}

for (const kind of ['via', 'track', 'pad', 'shape', 'component']) {
    const app = fixture();
    const source = new Via({ x: 0, y: 0 });
    const chain = track(0, 0, -5, 0);
    app.vias.push(source);
    app.tracks.push(chain);
    if (kind === 'via') app.vias.push(new Via({ x: -5, y: 0, net: 'OTHER' }));
    if (kind === 'track') {
        const assignedTrack = track(-5, 0, -10, 0);
        assignedTrack.net = 'OTHER';
        app.tracks.push(assignedTrack);
    }
    if (kind === 'pad') app.pads.push(new Pad({ x: -5, y: 0, net: 'OTHER' }));
    if (kind === 'shape') app.boardShapes.push(rectangle(-6, -1, -4, 1, { net: 'OTHER' }));
    if (kind === 'component') {
        app.placements.set('U2', { pads: new Map([['1', { x: -5, y: 0, number: '1' }]]) });
        app.netlist.push({ net: 'OTHER', pins: [{ componentId: 'U2', pinNumber: '1' }] });
    }
    const before = chain.captureState();
    startTrackDraw(app, { x: 0, y: 0 });
    addTrackWaypoint(app, { x: 20, y: 0 });
    assert.equal(app.commands.length, 0, `${kind} conflict rejects the whole route`);
    assert.equal(getTrackDraw(app).points.length, 1, 'a rejected destination does not become a waypoint');
    assert.equal(getTrackDraw(app).net, '', 'a rejected destination does not change the drawing Net');
    assert.equal(source.net, '');
    assert.deepEqual(chain.captureState(), before);
    assert.match(app.lastAlert, /Cannot connect different nets/);
    cancelTrackDraw(app);
}

console.log('PASS drawn Net propagation, connected chains, shapes/fills, layer isolation, conflicts and atomic undo/redo');
