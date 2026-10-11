import assert from 'node:assert/strict';
import { Track } from '../../src/shapes/track.js';
import { Pad } from '../../src/shapes/pad.js';
import { collectCopper, createCopperDistanceChecker, resolveDrcPairMarker, runDRC } from '../../src/pcb/modules/drc.js';

const board = () => ({ placements: new Map(), netlist: [], tracks: [], pads: [], vias: [],
    boardShapes: [], texts: new Map() });
const track = (id, net, points, width = 0.2, layer = 'top-copper') =>
    new Track({ id, net, points: points.map(([x, y]) => ({ x, y })), width, layer });
const rules = { clearance: 0.2 };
const expectShort = (app, pair) => {
    const result = runDRC(app, rules);
    const shorts = result.violations.filter(item => item.rule === 'short');
    assert.equal(shorts.length, 1);
    assert.deepEqual(new Set(shorts[0].marker.pair.map(item => item.key)), new Set(pair));
    assert.equal(result.violations.filter(item => item.rule === 'clearance').length, 0,
        'The overlapping pair must not be duplicated as clearance');
    return shorts[0];
};

for (const rotation of [0, 37, 90, 180]) {
    const app = board();
    app.placements.set('U1', { x: 10, y: 0, rotation, side: 'top', reference: 'U1',
        padOffsets: [{ padId: '31', number: '31', dx: 0, dy: 0, width: 2, height: 1,
            shape: 'rect', layer: 'top' }] });
    app.netlist.push({ net: 'PAD_NET', pins: [{ componentId: 'U1', pinNumber: '31' }] });
    app.tracks.push(track('crossing', 'TRACK_NET', [[0, 0], [20, 0]]));
    const violation = expectShort(app, ['trk:crossing', 'pad:U1.31']);
    const { segments, pads } = collectCopper(app);
    const contact = createCopperDistanceChecker()(segments[0], pads[0]);
    assert.equal(contact.dist, 0);
    assert.ok(Math.abs(violation.x - contact.x) < 1e-9 && Math.abs(violation.y - contact.y) < 1e-9,
        'Marker is on the actual track/pad copper contact, not an endpoint');
    const before = app.tracks[0].captureState();
    runDRC(app, rules);
    assert.deepEqual(app.tracks[0].captureState(), before, 'Classification does not edit model nets or geometry');
    for (const id of app.tracks[0].edges.keys()) app.tracks[0].setEdgeAttr(id, 'layer', 'bottom-copper');
    assert.deepEqual(runDRC(app, rules).violations, [], 'Opposite-side copper is not shorted to an SMD pad');
}

for (const layer of ['top-copper', 'bottom-copper']) {
    const app = board();
    app.pads.push(new Pad({ id: 'standalone', x: 10, y: 0, shape: 'square', size: 2,
        drill: 0, layers: layer, net: 'PAD_NET' }));
    app.tracks.push(track('crossing', 'TRACK_NET', [[0, 0], [20, 0]], 0.2, layer));
    expectShort(app, ['trk:crossing', 'pad:null.standalone']);
    for (const id of app.tracks[0].edges.keys()) {
        app.tracks[0].setEdgeAttr(id, 'layer', layer === 'top-copper' ? 'bottom-copper' : 'top-copper');
    }
    assert.deepEqual(runDRC(app, rules).violations, [], 'Single-side standalone pad layers are normalized consistently');
}

{
    const app = board();
    app.tracks.push(track('wide', 'A', [[0, 0], [20, 0]], 1),
        track('edge', 'B', [[5, 0.55], [15, 0.55]], 0.2));
    expectShort(app, ['trk:wide', 'trk:edge']);
    // Exact tangency, then a positive physical gap: centreline proximity alone is not the criterion.
    for (const point of app.tracks[1].nodes.values()) point.y = 0.6;
    expectShort(app, ['trk:wide', 'trk:edge']);
    for (const point of app.tracks[1].nodes.values()) point.y = 0.65;
    const gaps = runDRC(app, rules).violations;
    assert.deepEqual(gaps.map(item => item.rule), ['clearance']);
    assert.match(gaps[0].message, /Clearance 0.050 mm/);
    app.tracks[1].net = 'A';
    assert.deepEqual(runDRC(app, rules).violations, []);
    app.tracks[1].net = '';
    for (const point of app.tracks[1].nodes.values()) point.y = 0.55;
    assert.deepEqual(runDRC(app, rules).violations.map(item => item.rule), ['clearance'],
        'Touching unassigned copper is not a short unless it bridges distinct named nets');
}

{
    const app = board();
    app.vias.push({ id: 'ring', x: 0, y: 0, diameter: 2, drill: 1, net: 'B' });
    app.tracks.push(track('inside-drill', 'A', [[-0.1, 0], [0.1, 0]], 0.1));
    assert.deepEqual(runDRC(app, rules).violations, [], 'Copper entirely within a Via drill does not short');
    app.tracks[0] = track('cross-ring', 'A', [[-2, 0], [2, 0]], 0.1);
    const violation = expectShort(app, ['trk:cross-ring', 'via:ring']);
    const radius = Math.hypot(violation.x, violation.y);
    assert.ok(radius >= 0.5 - 1e-9 && radius <= 1 + 1e-9, 'Short marker belongs on the annulus');
}

{
    const app = board();
    app.tracks.push(track('a', 'A', [[-5, 0], [5, 0]]),
        track('b', 'B', [[0, -5], [0, 5]]));
    const before = expectShort(app, ['trk:a', 'trk:b']);
    app.boardShapes.push({ id: 'cut', kind: 'rect', layer: 'top-copper', filled: true,
        lineWidth: 0.05, copperMode: 'remove-copper',
        points: [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }] });
    assert.deepEqual(runDRC(app, rules).violations, [], 'Removed crossing copper cannot short');
    app.boardShapes[0].copperMode = 'remove-solder-mask';
    assert.equal(expectShort(app, ['trk:a', 'trk:b']).id, before.id,
        'Mask-only removal keeps the same physical short identity');
}
{
    const app = board();
    app.tracks.push(track('a', 'A', [[0, 0], [30, 0]]),
        track('b', 'B', [[0, 0.1], [30, 0.1]]));
    for (const x of [10, 20]) {
        app.boardShapes.push({ id: `cut-${x}`, kind: 'rect', layer: 'top-copper', filled: true,
            lineWidth: 0.05, copperMode: 'remove-copper', points: [
                { x: x - 1, y: -1 }, { x: x + 1, y: -1 }, { x: x + 1, y: 1 }, { x: x - 1, y: 1 },
            ] });
    }
    const check = () => runDRC(app, rules).violations.filter(item => item.rule === 'short').sort((a, b) => a.x - b.x);
    const shorts = check();
    assert.equal(shorts.length, 3, 'Two cuts form three disconnected contacts from the same primitives');
    assert.equal(new Set(shorts.map(item => item.id)).size, 3, 'Split primitive IDs cannot collide');
    for (const [index, item] of shorts.entries()) {
        assert.ok(item.x >= [0, 11, 21][index] - 0.1 && item.x <= [9, 19, 30][index] + 0.1,
            'Each short marker remains in its own copper island');
        const live = resolveDrcPairMarker(app, item, rules);
        assert.equal(live.id, item.id);
        assert.ok(Math.abs(live.x - item.x) < 1e-9 && Math.abs(live.y - item.y) < 1e-9,
            'Live selected-pair witness stays on the selected disconnected contact');
    }
    app.tracks.reverse();
    app.boardShapes.reverse();
    assert.deepEqual(check().map(item => item.id), shorts.map(item => item.id),
        'Reordering tracks and cuts preserves each disconnected short selection identity');
}

console.log('PASS physical shorts, posed pads, strokes, gaps, nets, layers, Via drills, removal and disconnected markers');
