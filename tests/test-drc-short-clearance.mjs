import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
const { runDRC } = await import('../src/pcb/modules/drc.js');

const track = (id, net, points) => ({
    id, net, layer: 'top-copper', width: 0.2,
    nodes: new Map(points.map(([x, y], index) => [index, { x, y }])),
    edges: new Map(points.slice(1).map((_, index) => [index, { from: index, to: index + 1 }])),
});
const board = () => ({ placements: new Map(), texts: new Map(), vias: [], tracks: [], boardShapes: [] });
const check = (app, clearance = 0.5) => runDRC(app, { clearance });
const byRule = (result, rule) => result.violations.filter(v => v.rule === rule);
const shortBoard = () => {
    const app = board();
    app.tracks = [track('a', 'A', [[0, 0], [10, 0]]), track('b', 'B', [[10, 0], [10, 10]])];
    return app;
};

{
    const result = check(shortBoard());
    assert.deepEqual(result.violations.map(v => v.rule), ['short'], 'a short is not also reported as zero clearance');
    assert.deepEqual(result.counts, { errors: 1, warnings: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.violations[0].id, 'drc:short|A~B');
    assert.deepEqual(result.violations[0].marker, { type: 'short' });
}

for (const terminal of ['pad', 'via']) {
    const app = board();
    app.tracks.push(track('a', 'A', [[0, 0], [10, 0]]));
    if (terminal === 'via') app.vias.push({ id: 'v', x: 10, y: 0, diameter: 0.6, drill: 0.3, net: 'B' });
    else {
        app.placements.set('U1', { x: 10, y: 0, padOffsets: [
            { padId: '1', number: '1', dx: 0, dy: 0, width: 1, height: 1, shape: 'rect', layer: 'top' },
        ] });
        app.netlist = [{ net: 'B', pins: [{ componentId: 'U1', pinNumber: '1' }] }];
    }
    assert.deepEqual(check(app).violations.map(v => v.rule), ['short'], `${terminal} contact reports only the short`);
}

{
    const app = board();
    app.tracks = [track('a', 'A', [[0, 0], [10, 0]]),
        track('bridge', '', [[10, 0], [20, 0]]), track('b', 'B', [[20, 0], [30, 0]])];
    assert.deepEqual(check(app).violations.map(v => v.rule), ['clearance', 'short'],
        'the other end of a No Net bridge remains a separate unassigned-copper clearance issue');
    app.tracks.pop();
    assert.deepEqual(check(app).violations.map(v => v.rule), ['clearance'],
        'a named-to-unassigned contact without a short remains a clearance issue');
}

for (const clearance of [0.025, 0.3, 0.5]) {
    const app = shortBoard();
    const gap = clearance / 2;
    app.tracks.push(track('near-a', 'A', [[30, 0], [40, 0]]),
        track('near-b', 'B', [[30, 0.2 + gap], [40, 0.2 + gap]]));
    const result = check(app, clearance);
    assert.equal(byRule(result, 'short').length, 1);
    assert.equal(byRule(result, 'clearance').length, 1, 'a separate positive gap on the same nets is retained');
    assert.match(byRule(result, 'clearance')[0].id, /near-a.*near-b/);
    assert.equal(result.counts.errors, 2);
}

{
    const app = board();
    app.tracks = [
        track('a', 'A', [[0, 0], [10, 0], [30, 0]]),
        track('b', 'B', [[10, 0], [10, 5], [20, 5], [20, 0.4], [30, 0.4]]),
    ];
    const result = check(app);
    assert.equal(byRule(result, 'short').length, 1);
    assert.equal(byRule(result, 'clearance').length, 1, 'separate clearance on the same connected objects is retained');
    assert.match(byRule(result, 'clearance')[0].message, /Clearance 0.200 mm/,
        'deduplicate contacts before worst-gap aggregation so they do not mask a real gap');
}

{
    const app = shortBoard();
    app.tracks.push(track('cross-a', 'A', [[30, 0], [40, 0]]),
        track('cross-b', 'B', [[35, -5], [35, 5]]));
    const result = check(app);
    assert.equal(byRule(result, 'short').length, 1);
    assert.equal(byRule(result, 'clearance').length, 1,
        'an independent overlap not covered by the terminal-based short detector is never hidden');
    assert.match(byRule(result, 'clearance')[0].id, /cross-a.*cross-b/);
}

{
    const app = board();
    app.tracks = [
        track('a', 'A', [[0, 0], [10, 0], [30, 0], [40, 0]]),
        track('b', 'B', [[10, 0], [10, 10], [35, -5], [35, 5]]),
    ];
    for (const wire of app.tracks) wire.edges.delete(1);
    const result = check(app);
    assert.equal(byRule(result, 'short').length, 1);
    assert.equal(byRule(result, 'clearance').length, 1,
        'disconnected sections of the same Track objects are not treated as part of the short');
}

{
    const app = board();
    app.tracks = [track('a', 'A', [[0, 20], [100, 20]]), track('b', 'B', [[10, 0], [10, 100]])];
    app.boardShapes.push({
        id: 'cut', kind: 'rect', layer: 'top-copper', copperMode: 'remove-copper', filled: true, lineWidth: 0.05,
        points: [{ x: 79, y: 19 }, { x: 81, y: 19 }, { x: 81, y: 21 }, { x: 79, y: 21 }],
    });
    const result = check(app);
    assert.deepEqual(result.violations.map(v => v.rule), ['short'], 'clipped copper also reports a contact only once');
}

{
    const app = board();
    app.tracks = [track('a', 'A', [[0, 0], [10, 0]]), track('b', 'B', [[0, 0], [0, 10]])];
    app.vias.push({ id: 'via', x: 10, y: 0, diameter: 2, drill: 0.8, net: 'A' });
    app.boardShapes.push({
        id: 'foreign', kind: 'rect', layer: 'top-copper', net: 'B', filled: true, lineWidth: 0.05,
        points: [{ x: 10.6, y: -0.5 }, { x: 12, y: -0.5 }, { x: 12, y: 0.5 }, { x: 10.6, y: 0.5 }],
    }, {
        id: 'trim', kind: 'rect', layer: 'top-copper', copperMode: 'remove-copper', filled: true, lineWidth: 0.05,
        points: [{ x: 4, y: 0.075 }, { x: 6, y: 0.075 }, { x: 6, y: 1 }, { x: 4, y: 1 }],
    });
    const result = check(app, 0.15);
    assert.equal(byRule(result, 'short').length, 1);
    assert.ok(result.violations.some(v => v.id === 'drc:clearance|shape:foreign~via:via'),
        'a remote Via/shape overlap is not hidden by a different short in the same connected group');
    assert.equal(result.violations.some(v => v.id === 'drc:clearance|trk:a~trk:b'), false,
        'the pair actually represented by the short still has no duplicate clearance report');
}

console.log('PASS short/clearance deduplication, terminal and No Net contacts, clipped copper and independent clearance retention');
