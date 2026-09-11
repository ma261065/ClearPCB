import assert from 'node:assert/strict';

const element = () => ({ setAttribute() {}, appendChild() {}, addEventListener() {},
    remove() {}, focus() {}, querySelectorAll: () => [], classList: { add() {}, remove() {} } });
globalThis.window = { addEventListener() {} };
globalThis.document = { createElement: element, createElementNS: element, body: element(),
    addEventListener() {}, removeEventListener() {} };
globalThis.requestAnimationFrame = () => 0;
const { startTrackDraw, addTrackWaypoint, resolveTrackDrawSnap } = await import('../src/pcb/modules/track-draw.js');

const shape = (x, net, extra = {}) => ({ id: `shape-${x}`, kind: 'rect', layer: 'top-copper',
    net, filled: true, copperMode: 'add', lineWidth: 0.2,
    points: [{ x: x - 2, y: -2 }, { x: x + 2, y: -2 }, { x: x + 2, y: 2 }, { x: x - 2, y: 2 }],
    ...extra });
const via = (x, net) => ({ id: `via-${x}`, x, y: 0, diameter: 1, drill: 0.3, net });
const board = () => ({ tracks: [], vias: [], boardShapes: [], placements: new Map(), netlist: [],
    _trackToolLayer: 'top-copper', _getLayerGroup: () => null,
    viewport: { scale: 100, gridVisible: false, setCrosshair() {}, hideCrosshair() {} },
    _commitTracks(tracks) { this.tracks.push(...tracks); } });

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
            assert.equal(app._trackDraw, null);
            assert.equal(app.tracks.length, 1);
            assert.equal(app.tracks[0].net, 'GND', `${startKind} to ${endKind}, source=${sourceNet}`);
        }
    }
}

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
strokeApp._trackDraw = { currentLayer: 'bottom-copper' };
assert.deepEqual(resolveTrackDrawSnap(strokeApp, { x: 2, y: 0 }).contactNets, []);

const viaApp = board();
viaApp.vias.push(via(0, 'GND'));
assert.equal(resolveTrackDrawSnap(viaApp, { x: 0.3, y: 0 }).x, 0);
viaApp._trackToolLayer = 'bottom-copper';
assert.deepEqual(resolveTrackDrawSnap(viaApp, { x: 0.3, y: 0 }).contactNets, ['GND']);

const overlap = board();
overlap.boardShapes.push(shape(0, 'GND'), shape(0, 'VCC'));
assert.equal(startTrackDraw(overlap, { x: 0, y: 0 }), null);
assert.equal(overlap._trackDraw, undefined);

const explicit = board();
explicit._trackToolNet = 'VCC';
explicit.vias.push(via(0, 'GND'));
assert.equal(startTrackDraw(explicit, { x: 0, y: 0 }), null);

const { resolveTrackContactGeometry } = await import('../src/pcb/modules/track-contact-geometry.js');
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