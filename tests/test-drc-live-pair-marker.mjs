import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { PcbDocument } from '../src/core/PcbDocument.js';
import { CommandHistory } from '../src/core/CommandHistory.js';
import { Track } from '../src/shapes/track.js';
import { Pad } from '../src/shapes/pad.js';
import { Via } from '../src/shapes/via.js';
import { setComputedFill } from '../src/pcb/modules/computed-fill-cache.js';
import { setFillRefreshError, setFillRefreshPending } from '../src/pcb/modules/refresh-state.js';
import { getVertexDrag } from '../src/pcb/modules/track-drag.js';

const element = () => ({
    style: {}, dataset: {}, setAttribute() {}, appendChild() {}, remove() {}, focus() {},
    addEventListener() {}, querySelectorAll: () => [], classList: { add() {}, remove() {} },
});
globalThis.window = { addEventListener() {} };
globalThis.document = {
    createElement: element, createElementNS: element, getElementById: () => null,
    querySelector: () => null, addEventListener() {}, removeEventListener() {}, body: element(),
};
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
const { runDRC, resolveDrcPairMarker } = await import('../src/pcb/modules/drc.js');
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { startVertexDrag, updateVertexDrag, cancelVertexDrag, finishVertexDrag } =
    await import('../src/pcb/modules/track-drag.js');

const rules = { clearance: 0.2 };
const board = () => ({
    placements: new Map(), netlist: [], tracks: [], pads: [], vias: [],
    boardShapes: [], texts: new Map(), copperFills: [],
});
const track = (id, points, net = 'A', extra = {}) =>
    new Track({ id, points: points.map(([x, y]) => ({ x, y })), net, width: 0.2, ...extra });
const rectangle = (left, top, right, bottom) => [
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
];
const polygon = (extra = {}) => ({
    id: 'shape', kind: 'polygon', points: rectangle(-1, -1, 1, 1),
    layer: 'top-copper', net: 'B', copperMode: 'add', filled: true, lineWidth: 0.05, ...extra,
});
const pairKey = violation => violation.marker?.pair?.map(item => item.key).sort().join('~');
const pairViolations = (app, designRules = rules) =>
    runDRC(app, designRules).violations.filter(item => ['short', 'clearance'].includes(item.rule));
const firstViolation = (app, designRules = rules) => {
    const result = pairViolations(app, designRules);
    assert.ok(result.length, 'fixture must start with a copper conflict');
    assert.equal(result[0].marker.pair.length, 2, 'full DRC supplies a persistent entity pair');
    return result[0];
};
const near = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) < 1e-8, `${message}: ${actual} != ${expected}`);
function assertParity(app, violation, message, designRules = rules) {
    const expected = pairViolations(app, designRules).find(item => pairKey(item) === pairKey(violation));
    const before = structuredClone(violation);
    const actual = resolveDrcPairMarker(app, violation, designRules);
    assert.equal(!!actual, !!expected, `${message}: live conflict matches full DRC`);
    assert.deepEqual(violation, before, `${message}: stored result is immutable`);
    if (actual) {
        assert.equal(actual.id, violation.id, `${message}: stable selected violation`);
        assert.deepEqual(actual.marker.pair, violation.marker.pair);
        near(actual.x, expected.x, `${message}: witness x`);
        near(actual.y, expected.y, `${message}: witness y`);
    }
    return actual;
}

{
    const app = board();
    const first = track('first', [[-3, 0], [0, 0], [3, 0]]);
    const second = track('second', [[0, -3], [0, 0], [0, 3]], 'B');
    app.tracks.push(first, second);
    const violation = firstViolation(app);
    assert.equal(violation.rule, 'short');
    assert.deepEqual(new Set(violation.marker.pair.map(item => item.key)), new Set(['trk:first', 'trk:second']));
    for (const y of [0, 1, 8, 2, 0]) {
        for (const node of first.nodes.values()) node.y = y;
        const resolved = assertParity(app, violation, `track crossing y=${y}`);
        if (y < 3) near(resolved.y, y, 'contact follows crossing');
    }
    for (const id of second.edges.keys()) second.setEdgeAttr(id, 'layer', 'bottom-copper');
    assert.equal(assertParity(app, violation, 'opposite layers'), null);
    for (const id of second.edges.keys()) second.setEdgeAttr(id, 'layer', 'top-copper');
    assert.ok(assertParity(app, violation, 'layer restored'));
    app.tracks.pop();
    assert.equal(resolveDrcPairMarker(app, violation, rules), null, 'deleted pair member hides marker');
    assert.equal(resolveDrcPairMarker(app, { rule: 'short' }, rules), null);
    assert.equal(resolveDrcPairMarker(app, { marker: { pair: [] } }, rules), null);
}

{
    const app = board();
    const leftBridge = track('left-bridge', [[0, 0], [2, 0]], '');
    const rightBridge = track('right-bridge', [[2, 0], [4, 0]], '');
    app.tracks = [
        track('left-net', [[-1, 0], [0, 0]], 'A'),
        track('right-net', [[4, 0], [5, 0]], 'B'),
        leftBridge, rightBridge,
    ];
    const violation = pairViolations(app).find(item => item.rule === 'short');
    assert.ok(violation, 'unassigned bridge joins differently named roots');
    assert.deepEqual(new Set(violation.marker.pair.map(item => item.key)),
        new Set(['trk:left-bridge', 'trk:right-bridge']),
        'selected physical contact may consist of two unassigned entities');
    assert.ok(assertParity(app, violation, 'unassigned short contact'));
    const before = structuredClone(violation);
    for (const y of [0.25, 1, 0.25, 0]) {
        for (const node of rightBridge.nodes.values()) node.y = y;
        const marker = resolveDrcPairMarker(app, violation, rules);
        if (y === 1) assert.equal(marker, null, 'unassigned pair hides outside clearance');
        else {
            assert.ok(marker, 'short contact remains visible through a sub-clearance gap');
            assert.equal(marker.id, violation.id, 'short selection retains its rule identity');
            assert.equal(marker.rule, 'short');
            near(marker.x, 2, 'bridge witness x');
            near(marker.y, y / 2, 'bridge witness follows the copper gap');
        }
        if (y > 0) assert.equal(pairViolations(app).some(item => item.rule === 'short'), false,
            'live selected contact can remain a clearance concern after the full short is broken');
    }
    assert.deepEqual(violation, before, 'bridge refresh preserves stored short metadata');
}

for (const designRules of [rules, {}, { clearance: 0 }, { clearance: -1 }, { clearance: NaN }]) {
    const app = board();
    app.tracks = [track('a', [[0, 0], [2, 0]]), track('b', [[0, 0.25], [2, 0.25]], 'B')];
    const violation = firstViolation(app, designRules);
    assert.equal(violation.rule, 'clearance');
    const clearance = designRules.clearance > 0 ? designRules.clearance : 0.1;
    for (const gap of [0.01, clearance - 0.00011, clearance - 0.0001,
        clearance - 0.00009, clearance, clearance + 0.01, 0.01]) {
        for (const node of app.tracks[1].nodes.values()) node.y = 0.2 + gap;
        const live = assertParity(app, violation, `threshold gap=${gap}, clearance=${clearance}`, designRules);
        if (gap === clearance) assert.equal(live, null, 'exact clearance is not a violation');
    }
    app.tracks[1].net = 'A';
    assert.equal(assertParity(app, violation, 'same net clearance', designRules), null);
}

for (const kind of ['curved-track', 'pad', 'mounted-pad', 'via', 'polygon', 'circle', 'arc', 'fill', 'text']) {
    const app = board();
    app.tracks.push(track('probe', [[0, -4], [0, 4]]));
    let target, translate;
    if (kind === 'curved-track') {
        target = track('curve', [[-1, 0], [1, 0]], 'B');
        target.edges.values().next().value.bulge = 1;
        app.tracks.push(target);
        translate = (dx, dy) => { for (const point of target.nodes.values()) { point.x += dx; point.y += dy; } };
    } else if (kind === 'pad' || kind === 'via') {
        target = kind === 'pad'
            ? new Pad({ id: 'pad', x: 0, y: 0, size: 1.5, drill: 0.4, shape: 'rectangle', rotation: 27, net: 'B' })
            : new Via({ id: 'via', x: 0, y: 0, diameter: 1.5, drill: 0.6, net: 'B' });
        app[kind === 'pad' ? 'pads' : 'vias'].push(target);
        translate = (dx, dy) => { target.x += dx; target.y += dy; };
    } else if (kind === 'mounted-pad') {
        target = { x: 0, y: 0, rotation: 31, reference: 'U1', padOffsets: [
            { padId: 'copper-pad', number: '1', dx: 0, dy: 0, width: 2, height: 1, shape: 'rect', layer: 'top' },
        ] };
        app.placements.set('component', target);
        app.netlist.push({ net: 'B', pins: [{ componentId: 'component', pinNumber: '1' }] });
        translate = (dx, dy) => { target.x += dx; target.y += dy; };
    } else if (kind === 'text') {
        target = { id: 'text', content: 'A', x: 0, y: 0, size: 1, strokeWidth: 0.15, layer: 'top-copper' };
        app.texts.set(target.id, target);
        translate = (dx, dy) => { target.x += dx; target.y += dy; };
    } else if (kind === 'fill') {
        target = { id: 'fill', type: 'fill', layer: 'top-copper', net: 'B' };
        let x = 0, y = 0;
        translate = (dx, dy) => {
            x += dx; y += dy;
            setComputedFill(target, [{ outer: rectangle(x - 1, y - 1, x + 1, y + 1), holes: [] }]);
        };
        translate(0, 0);
        app.copperFills.push(target);
    } else {
        target = kind === 'circle' ? polygon({ kind: 'circle', x: 0, y: 0, radius: 1, filled: false })
            : kind === 'arc' ? polygon({ kind: 'arc', start: { x: 1, y: 0 }, bulge: { x: 0, y: 1 },
                end: { x: -1, y: 0 }, filled: false }) : polygon();
        app.boardShapes.push(target);
        translate = (dx, dy) => {
            for (const point of [...target.points, target.start, target.end, target.bulge].filter(Boolean)) {
                point.x += dx; point.y += dy;
            }
            if ('x' in target) { target.x += dx; target.y += dy; }
        };
    }
    const violation = firstViolation(app);
    if (kind === 'mounted-pad') assert.ok(violation.marker.pair.some(item =>
        item.key === 'pad:component.copper-pad' && item.componentId === 'component'));
    if (kind === 'pad') assert.ok(violation.marker.pair.some(item => item.key === 'pad:null.pad'));
    const initial = assertParity(app, violation, `${kind}: initial`);
    translate(0, 1);
    const moved = assertParity(app, violation, `${kind}: translated conflict`);
    near(moved.y - initial.y, 1, `${kind}: marker follows translated copper`);
    translate(10, 0);
    assert.equal(assertParity(app, violation, `${kind}: separated`), null);
    translate(-10, 0);
    assert.ok(assertParity(app, violation, `${kind}: conflict returns`));
    if (kind === 'fill') {
        setFillRefreshPending(app, true);
        assert.equal(resolveDrcPairMarker(app, violation, rules), null, 'pending pour has no live witness');
        setFillRefreshPending(app, false);
        setFillRefreshError(app, new Error('stale pour'));
        assert.equal(resolveDrcPairMarker(app, violation, rules), null, 'failed pour has no live witness');
        setFillRefreshError(app, null);
        assert.ok(resolveDrcPairMarker(app, violation, rules));
    }
}

{
    const app = board();
    app.tracks = [track('a', [[-2, 0], [2, 0]]), track('b', [[0, -2], [0, 2]], 'B')];
    const violation = firstViolation(app);
    const cut = polygon({ id: 'cut', points: rectangle(-0.5, -0.5, 0.5, 0.5), copperMode: 'remove-copper' });
    app.boardShapes.push(cut);
    assert.equal(assertParity(app, violation, 'removal cuts selected crossing'), null);
    for (const mode of ['remove-solder-mask', 'remove-copper-mask', 'remove-copper']) {
        cut.copperMode = mode;
        assertParity(app, violation, `${mode}: removal semantics`);
    }
    cut.layer = 'bottom-copper';
    assert.ok(assertParity(app, violation, 'opposite-layer cut retains crossing'));
    cut.layer = 'top-copper';
    cut.points = rectangle(10, 10, 11, 11);
    assert.ok(assertParity(app, violation, 'moving removal away restores witness'));
    setFillRefreshPending(app, true);
    assert.ok(resolveDrcPairMarker(app, violation, rules), 'unrelated pending fills do not hide a track pair');
}

{
    const app = board();
    app.tracks = [track('a', [[-2, 0], [2, 0]]), track('b', [[0, -2], [0, 2]], 'B')];
    const violation = firstViolation(app);
    let geometryReads = 0;
    const unrelated = (id, field, extra = {}) => Object.defineProperty({ id, ...extra }, field, {
        get() { geometryReads++; throw new Error(`Unrelated ${id}.${field} geometry resolved`); },
    });
    for (let index = 0; index < 300; index++) {
        const id = `unrelated-${index}`;
        app.tracks.push(unrelated(id, 'nodes'));
        app.pads.push(unrelated(id, 'x'));
        app.vias.push(unrelated(id, 'x'));
        app.placements.set(id, unrelated(id, 'padOffsets'));
        app.boardShapes.push(unrelated(id, 'points', { kind: 'polygon', layer: 'top-copper', copperMode: 'add' }));
        app.texts.set(id, unrelated(id, 'content', { layer: 'top-copper' }));
        app.copperFills.push(unrelated(id, 'layer'));
    }
    const refreshed = resolveDrcPairMarker(app, violation, rules);
    assert.ok(refreshed, 'large board still resolves target pair');
    near(refreshed.x, violation.x, 'unrelated entities cannot alter target x');
    near(refreshed.y, violation.y, 'unrelated entities cannot alter target y');
    assert.equal(geometryReads, 0, 'only selected copper geometry is resolved, not the board');
}

function previewFixture() {
    const app = {
        pcbDocument: new PcbDocument(), placements: new Map(), netlist: [], copperFills: [],
        history: new CommandHistory(), _shapeElements: new Map(), 
        getLayerGroup: () => null, refreshClearanceHalos() {}, refreshFills: () => false,
        getRoutingParams: () => ({ trackWidth: 0.2, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3 }),
        viewport: { scale: 100, gridVisible: false, shiftHeld: true, setCrosshair() {}, hideCrosshair() {} },
        alert(message) { assert.fail(message); },
    };
    for (const key of ['tracks', 'vias', 'pads', 'boardShapes', 'texts']) {
        Object.defineProperty(app, key, Object.getOwnPropertyDescriptor(PCBApp.prototype, key));
    }
    return app;
}
for (const finish of ['cancel', 'commit']) {
    const app = previewFixture();
    const moving = track('moving', [[-3, 0], [3, 0]]);
    app.tracks.push(moving, track('fixed', [[0, -3], [0, 3]], 'B'));
    const violation = firstViolation(app);
    const before = app.pcbDocument.captureGeometry();
    assert.equal(startVertexDrag(app, moving, { x: 0, y: 0 }, { whole: true }), true);
    for (const y of [1, 8, 2]) {
        updateVertexDrag(app, { x: 0, y });
        assert.notEqual(app.tracks[0], moving, 'PCBApp getter exposes the detached pointer preview');
        assert.deepEqual(app.pcbDocument.captureGeometry(), before, 'pointer move never changes persistent geometry');
        const marker = assertParity(app, violation, `${finish}: preview y=${y}`);
        if (y < 3) near(marker.y, y, 'live witness follows preview, not document');
        else assert.equal(marker, null, 'preview separation hides marker');
    }
    if (finish === 'cancel') {
        cancelVertexDrag(app);
        assert.deepEqual(app.pcbDocument.captureGeometry(), before);
        assert.equal(app.history.undoStack.length, 0);
        near(assertParity(app, violation, 'cancel restores canonical contact').y, 0, 'cancelled marker y');
    } else {
        finishVertexDrag(app);
        assert.equal(app.history.undoStack.length, 1, 'drag commits one undoable command');
        near(assertParity(app, violation, 'finish retains preview contact').y, 2, 'committed marker y');
        app.history.undo();
        near(assertParity(app, violation, 'undo restores contact').y, 0, 'undone marker y');
        app.history.redo();
        near(assertParity(app, violation, 'redo restores contact').y, 2, 'redone marker y');
    }
    assert.equal(getVertexDrag(app), null);
    assert.equal(app.tracks, app.pcbDocument.tracks, 'collection getter returns document after finish');
}

{
    const app = board();
    app.tracks = [track('a', [[-2, 0], [2, 0]]), track('b', [[0, -2], [0, 2]], 'B')];
    const violation = firstViolation(app);
    for (let index = 0; index < 100; index++) resolveDrcPairMarker(app, violation, rules);
    const iterations = 1000, start = performance.now();
    let visible = 0;
    for (let index = 0; index < iterations; index++) {
        const y = index % 2 ? 0.5 : 4;
        for (const node of app.tracks[0].nodes.values()) node.y = y;
        if (resolveDrcPairMarker(app, violation, rules)) visible++;
    }
    const elapsed = performance.now() - start;
    assert.equal(visible, iterations / 2, 'timed refreshes perform real show/hide geometry work');
    assert.ok(elapsed < 10000, `1000 simple pair refreshes took ${elapsed.toFixed(1)} ms (budget 10 s)`);
    console.log(`PASS: ${iterations} two-track live refreshes in ${elapsed.toFixed(1)} ms`);
}
console.log('PASS: live DRC entity pairs, threshold parity, copper/removal geometry, bounded work, pointer previews and history');
