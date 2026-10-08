import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.mjs';
import { getTrackDraw, hasTrackSnapMarker, setTrackToolLayer, setTrackToolNet } from '../../src/pcb/modules/track-draw.js';
import { setPcbInteraction } from '../../src/pcb/modules/pcb-interactions.js';

installFakeDom();
globalThis.requestAnimationFrame = () => 0;
const { startTrackDraw, updateTrackDraw, addTrackWaypoint, resolveTrackDrawSnap } = await import('../../src/pcb/modules/track-draw.js');
const { applyNetToCopperSelection } = await import('../../src/pcb/modules/track-select.js');
const { Via } = await import('../../src/shapes/via.js');

const shape = (x, net, extra = {}) => ({ id: `shape-${x}`, kind: 'rect', layer: 'top-copper',
    net, filled: true, copperMode: 'add', lineWidth: 0.2,
    points: [{ x: x - 2, y: -2 }, { x: x + 2, y: -2 }, { x: x + 2, y: 2 }, { x: x - 2, y: 2 }],
    ...extra });
const via = (x, net) => new Via({ id: `via-${x}`, x, y: 0, diameter: 1, drill: 0.3, net });
const board = () => {
    const app = { tracks: [], vias: [], pads: [], boardShapes: [], copperFills: [], placements: new Map(), netlist: [],
        getLayerGroup: () => null,
        viewport: { scale: 100, gridVisible: false, setCrosshair() {}, hideCrosshair() {} },
        history: { execute(command) { command.execute(); } } };
    app.pcbDocument = { tracks: app.tracks, vias: app.vias, pads: app.pads,
        boardShapes: app.boardShapes, copperFills: app.copperFills };
    setTrackToolLayer(app, 'top-copper');
    return app;
};

for (const startKind of ['shape', 'via']) {
    for (const endKind of ['shape', 'via']) {
        for (const sourceNet of ['', 'GND']) {
            const app = board();
            app[startKind === 'shape' ? 'boardShapes' : 'vias'].push(
                startKind === 'shape' ? shape(0, sourceNet) : via(0, sourceNet));
            app[endKind === 'shape' ? 'boardShapes' : 'vias'].push(
                endKind === 'shape' ? shape(20, 'GND') : via(20, 'GND'));
            assert.equal(startTrackDraw(app, { x: 0, y: 0 }).net, sourceNet);
            addTrackWaypoint(app, { x: 20, y: 0 });
            assert.equal(getTrackDraw(app), null);
            assert.equal(app.tracks.length, 1);
            assert.equal(app.tracks[0].net, 'GND', `${startKind} to ${endKind}, source=${sourceNet}`);
        }
    }
}

const unassignedDestination = board();
setTrackToolNet(unassignedDestination, 'SIGNAL');
const destinationShape = shape(20, '');
unassignedDestination.boardShapes.push(destinationShape);
startTrackDraw(unassignedDestination, { x: 0, y: 0 });
addTrackWaypoint(unassignedDestination, { x: 20, y: 0 });
assert.equal(unassignedDestination.tracks[0].net, 'SIGNAL');
assert.equal(destinationShape.net, 'SIGNAL',
    'an unassigned destination copper shape inherits the terminating Track Net');

for (const startKind of ['shape', 'via']) {
    const app = board();
    app[startKind === 'shape' ? 'boardShapes' : 'vias'].push(
        startKind === 'shape' ? shape(0, 'GND') : via(0, 'GND'));
    app.boardShapes.push(shape(20, 'VCC'));
    const context = startTrackDraw(app, { x: 0, y: 0 });
    addTrackWaypoint(app, { x: 20, y: 0 });
    assert.equal(app.tracks.length, 0);
    assert.equal(context.points.length, 1);
    assert.equal(context.net, 'GND');
}

for (const extra of [{ layer: 'bottom-copper' }, { filled: false },
    { copperMode: 'remove-copper' }, { visible: false }]) {
    const app = board();
    app.boardShapes.push(shape(0, 'GND', extra));
    assert.deepEqual(resolveTrackDrawSnap(app, { x: 0, y: 0 }).contactNets, []);
}

const strokeApp = board();
strokeApp.boardShapes.push(shape(0, 'GND', { filled: false }));
assert.deepEqual(resolveTrackDrawSnap(strokeApp, { x: 2, y: 0 }).contactNets, ['GND']);
setPcbInteraction(strokeApp, '_trackDraw', { currentLayer: 'bottom-copper' });
assert.deepEqual(resolveTrackDrawSnap(strokeApp, { x: 2, y: 0 }).contactNets, []);

const viaApp = board();
viaApp.vias.push(via(0, 'GND'));
assert.equal(resolveTrackDrawSnap(viaApp, { x: 0.3, y: 0 }).snapType, 'via',
    'vias are hard snap targets before drawing starts');
assert.equal(resolveTrackDrawSnap(viaApp, { x: 0.3, y: 0 }).x, 0);
setTrackToolLayer(viaApp, 'bottom-copper');
assert.deepEqual(resolveTrackDrawSnap(viaApp, { x: 0.3, y: 0 }).contactNets, ['GND']);

const standalonePad = (x, net, layers = 'both') => ({
    id: `pad-${x}`, x, y: 0, width: 1.5, height: 1.5, layers, visible: true, net,
});
const standaloneApp = board();
standaloneApp.pads = [standalonePad(0, 'PAD_NET'), standalonePad(20, 'PAD_NET')];
setTrackToolNet(standaloneApp, 'STALE_TOOL_NET');
const standaloneContext = startTrackDraw(standaloneApp, { x: 0.4, y: 0 });
assert.equal(standaloneContext.snap.snapType, 'pad');
assert.deepEqual(standaloneContext.points[0], { x: 0, y: 0 });
assert.equal(standaloneContext.net, 'PAD_NET', 'originating pad overrides the previous Track-tool Net');
addTrackWaypoint(standaloneApp, { x: 19.6, y: 0 });
assert.equal(getTrackDraw(standaloneApp), null, 'releasing on a standalone pad finishes the Track');
assert.equal(standaloneApp.tracks[0].net, 'PAD_NET');
let netCommand = null;
standaloneApp.history = { execute(command) { netCommand = command; command.execute(); } };
const selectedStandalonePad = standaloneApp.pads[0];
const otherStandalonePad = standaloneApp.pads[1];
const padNetCommand = {
    execute() {
        selectedStandalonePad.net = 'RENAMED_NET';
        otherStandalonePad.net = 'RENAMED_NET';
    },
    undo() {
        selectedStandalonePad.net = 'PAD_NET';
        otherStandalonePad.net = 'PAD_NET';
    },
};
assert.equal(applyNetToCopperSelection(standaloneApp, [
    { kind: 'track', object: standaloneApp.tracks[0] },
    { kind: 'pad', object: selectedStandalonePad },
    { kind: 'pad', object: otherStandalonePad },
], 'RENAMED_NET', [padNetCommand]), true,
'selected bonded standalone Pads do not conflict with their own batch Net change');
assert.deepEqual([standaloneApp.tracks[0].net, selectedStandalonePad.net, otherStandalonePad.net],
    ['RENAMED_NET', 'RENAMED_NET', 'RENAMED_NET']);
netCommand.undo();
assert.deepEqual([standaloneApp.tracks[0].net, selectedStandalonePad.net, otherStandalonePad.net],
    ['PAD_NET', 'PAD_NET', 'PAD_NET'], 'mixed Track and Pad Net change undoes atomically');

const componentPadApp = board();
setTrackToolNet(componentPadApp, 'STALE_TOOL_NET');
componentPadApp.placements = new Map([
    ['U1', { pads: new Map([['1', { x: 0, y: 0, number: '1' }]]) }],
    ['U2', { pads: new Map([['1', { x: 20, y: 0, number: '1' }]]) }],
]);
componentPadApp.netlist = [{ net: 'COMPONENT_NET', pins: [
    { componentId: 'U1', pinNumber: '1' },
    { componentId: 'U2', pinNumber: '1' },
] }];
const componentPadContext = startTrackDraw(componentPadApp, { x: 0.4, y: 0 });
assert.equal(componentPadContext.net, 'COMPONENT_NET',
    'originating component pad overrides the previous Track-tool Net');
addTrackWaypoint(componentPadApp, { x: 19.6, y: 0 });
assert.equal(getTrackDraw(componentPadApp), null, 'releasing on a component pad finishes the Track');
assert.deepEqual([...componentPadApp.tracks[0].padConnections.values()], [
    { componentId: 'U1', pinNumber: '1' },
    { componentId: 'U2', pinNumber: '1' },
]);

const viaHighlightApp = board();
viaHighlightApp.viewport.svg = { appendChild() {} };
viaHighlightApp.vias.push(via(10, 'GND'));
startTrackDraw(viaHighlightApp, { x: 0, y: 0 });
updateTrackDraw(viaHighlightApp, { x: 10.2, y: 0 });
assert.equal(getTrackDraw(viaHighlightApp).snap.snapType, 'via');
assert.ok(hasTrackSnapMarker(viaHighlightApp), 'destination via receives the yellow snap highlight');

const overlap = board();
overlap.boardShapes.push(shape(0, 'GND'), shape(0, 'VCC'));
assert.equal(startTrackDraw(overlap, { x: 0, y: 0 }), null);
assert.equal(getTrackDraw(overlap), null);

const explicit = board();
setTrackToolNet(explicit, 'VCC');
explicit.vias.push(via(0, 'GND'));
assert.equal(startTrackDraw(explicit, { x: 0, y: 0 }), null);

const { resolveTrackContactGeometry } = await import('../../src/pcb/modules/track-contact-geometry.js');
const cachedShape = shape(0, 'GND');
const cached = resolveTrackContactGeometry(cachedShape);
for (let index = 0; index < 1000; index++) {
    assert.equal(resolveTrackContactGeometry(cachedShape), cached);
}
cachedShape.net = 'VCC';
assert.equal(resolveTrackContactGeometry(cachedShape), cached);
cachedShape.points = cachedShape.points.map((point) => ({ ...point }));
assert.equal(resolveTrackContactGeometry(cachedShape), cached);

for (const mutate of [
    (item) => { item.points[0].x -= 1; },
    (item) => { item.lineWidth = 1; },
    (item) => { item.filled = false; },
    (item) => { item.cornerRadius = 0.5; },
    (item) => { item.nodeCornerRadii = { 0: 0.25 }; },
    (item) => { item.nodeCornerRadii[0] = 0.75; },
    (item) => { item.segmentWidths = { 0: 2 }; },
    (item) => { item.segmentWidths[0] = 3; },
    (item) => { item.copperMode = 'remove-copper'; },
]) {
    const before = resolveTrackContactGeometry(cachedShape);
    mutate(cachedShape);
    const after = resolveTrackContactGeometry(cachedShape);
    assert.notEqual(after, before);
    assert.equal(resolveTrackContactGeometry(cachedShape), after);
}

const moving = board();
const movingShape = shape(0, 'GND');
moving.boardShapes.push(movingShape);
assert.deepEqual(resolveTrackDrawSnap(moving, { x: 0, y: 0 }).contactNets, ['GND']);
for (const point of movingShape.points) point.x += 20;
assert.deepEqual(resolveTrackDrawSnap(moving, { x: 0, y: 0 }).contactNets, []);
assert.deepEqual(resolveTrackDrawSnap(moving, { x: 20, y: 0 }).contactNets, ['GND']);
for (const point of movingShape.points) point.x -= 20;
movingShape.net = 'VCC';
assert.deepEqual(resolveTrackDrawSnap(moving, { x: 0, y: 0 }).contactNets, ['VCC']);
assert.deepEqual(resolveTrackDrawSnap(moving, { x: 10000, y: 10000 }).contactNets, []);

const wideStroke = board();
wideStroke.boardShapes.push(shape(0, 'GND', { kind: 'line', filled: false,
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], segmentWidths: { 0: 4 } }));
assert.deepEqual(resolveTrackDrawSnap(wideStroke, { x: 5, y: 1.5 }).contactNets, ['GND']);
wideStroke.boardShapes[0].segmentWidths[0] = 0.2;
assert.deepEqual(resolveTrackDrawSnap(wideStroke, { x: 5, y: 1.5 }).contactNets, []);

console.log('Track copper contact regressions passed.');