import assert from 'node:assert/strict';
import { Track } from '../../src/shapes/track.js';
import { Via } from '../../src/shapes/via.js';
import { runDRC } from '../../src/pcb/modules/drc.js';

const board = () => ({ placements: new Map(), netlist: [], tracks: [], pads: [], vias: [],
    boardShapes: [], texts: new Map() });
const rules = { trackWidth: 0.2, viaDiameter: 0.6, viaDrill: 0.3 };
const check = app => runDRC(app, rules);

for (const offset of [-0.01, -0.00005, 0, 0.01]) {
    const app = board();
    app.tracks.push(new Track({ id: 'track', width: rules.trackWidth + offset,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }));
    app.vias.push(new Via({ id: 'via', x: 20, y: 0,
        diameter: rules.viaDiameter + offset, drill: rules.viaDrill + offset }));
    const result = check(app);
    assert.deepEqual(result.violations.map(item => item.rule),
        offset < -0.0001 ? ['track-width', 'via-diameter', 'via-drill'] : [],
        'Only dimensions below the minimum outside numerical tolerance fail');
    assert.deepEqual(result.counts, { errors: offset < -0.0001 ? 3 : 0, warnings: 0 });
    assert.equal(result.ok, offset >= -0.0001);
}

{
    const app = board();
    const track = new Track({ id: 'per-edge', width: 0.1, net: 'SIGNAL',
        points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 15, y: 0 }] });
    const [first, second, third] = [...track.edges.keys()];
    track.setEdgeAttr(first, 'width', 0.2);
    track.setEdgeAttr(second, 'width', 0.15);
    track.setEdgeAttr(second, 'bulge', 0.5);
    track.setEdgeAttr(third, 'layer', 'bottom-copper');
    app.tracks.push(track);
    const before = track.captureState();
    const result = check(app);
    assert.equal(result.violations.length, 2, 'One issue per undersized authored edge, not per arc sample');
    assert.deepEqual(result.violations.map(item => item.id),
        [`drc:track-width|trk:per-edge:${second}`, `drc:track-width|trk:per-edge:${third}`]);
    assert.match(result.violations[0].message, /Track SIGNAL: width 0.150 mm < 0.200 mm/);
    assert.deepEqual([result.violations[1].x, result.violations[1].y], [12.5, 0]);
    assert.ok(result.violations[0].x > 5 && result.violations[0].x < 10
        && Math.abs(result.violations[0].y) > 0.1, 'Curved edge marker is on its sampled path');
    assert.ok(result.violations.every(item => !item.marker.pair), 'Size markers do not use pair clearance rechecks');
    app.tracks.unshift(new Track({ id: 'unrelated', width: 0.3,
        points: [{ x: 50, y: 0 }, { x: 60, y: 0 }] }));
    assert.deepEqual(check(app).violations, result.violations, 'Unrelated geometry does not renumber issues');
    app.boardShapes.push({ id: 'cut', kind: 'rect', layer: 'top-copper', filled: true,
        copperMode: 'remove-copper', points: [
            { x: -1, y: -10 }, { x: 20, y: -10 }, { x: 20, y: 10 }, { x: -1, y: 10 },
        ] });
    assert.deepEqual(check(app).violations, result.violations, 'Removal does not alter authored-size validation');
    assert.deepEqual(track.captureState(), before, 'DRC does not resize or edit track geometry');
}

{
    const app = board();
    app.vias.push(new Via({ id: 'diameter', x: 0, y: 0, diameter: 0.55, drill: 0.3 }),
        new Via({ id: 'drill', x: 10, y: 0, diameter: 0.6, drill: 0.25 }),
        new Via({ id: 'ring', x: 20, y: 0, diameter: 0.61, drill: 0.6 }),
        new Via({ id: 'no-drill', x: 30, y: 0, diameter: 0.6, drill: 0 }));
    app.vias[3].drill = 0;
    const before = app.vias.map(via => via.captureState());
    const result = check(app);
    assert.deepEqual(result.violations.map(item => [item.rule, item.severity]), [
        ['via-diameter', 'error'], ['via-drill', 'error'], ['via-drill', 'error'], ['via', 'warning'],
    ], 'Independent minimum-size checks preserve annular-ring warnings');
    assert.equal(result.violations[0].id, 'drc:via-diameter|via:diameter');
    assert.equal(result.violations[1].id, 'drc:via-drill|via:drill');
    assert.equal(result.violations[2].id, 'drc:via-drill|via:no-drill');
    assert.deepEqual([result.violations[1].x, result.violations[1].y], [10, 0]);
    assert.deepEqual(app.vias.map(via => via.captureState()), before, 'DRC does not edit Via dimensions');
}

{
    const app = board();
    for (const x of [0, 20]) {
        const track = new Track({ width: 0.1, points: [{ x, y: 0 }, { x: x + 10, y: 0 }] });
        delete track.id;
        app.tracks.push(track);
    }
    const result = check(app);
    assert.equal(result.violations.length, 2, 'Anonymous tracks do not collapse into one undersized edge');
    assert.equal(new Set(result.violations.map(item => item.id)).size, 2);
}

{
    const app = board();
    app.tracks.push(new Track({ width: 0.1, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }));
    app.vias.push(new Via({ x: 20, y: 0, diameter: 0.4, drill: 0.2 }));
    app.boardShapes.push({ id: 'artwork', kind: 'line', layer: 'top-copper',
        points: [{ x: 30, y: 0 }, { x: 40, y: 0 }], lineWidth: 0.1 });
    assert.deepEqual(runDRC(app).violations, [], 'Omitted minimum rules preserve direct-call behavior');
    assert.deepEqual(runDRC(app, { trackWidth: 0.2 }).violations.map(item => item.rule), ['track-width'],
        'Track width excludes decorative copper strokes and does not imply Via size rules');
    for (const key of ['trackWidth', 'viaDiameter', 'viaDrill']) {
        for (const value of [0, -1, NaN, Infinity, null, '0.2']) {
            assert.throws(() => runDRC(app, { [key]: value }), new RegExp(`DRC ${key} must be a positive finite`));
        }
    }
}

console.log('PASS DRC minimum track/Via sizes, per-edge curves/layers, exact limits, stable IDs and model isolation');
