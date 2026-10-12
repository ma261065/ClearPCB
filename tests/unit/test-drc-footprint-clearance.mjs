import assert from 'node:assert/strict';
import { runDRC, resolveDrcPairMarker } from '../../src/pcb/modules/drc.js';
import { Pad } from '../../src/shapes/pad.js';
import { Track } from '../../src/shapes/track.js';

const fixture = () => ({
    placements: new Map([['U1', { x: 0, y: 0, side: 'top', reference: 'U1', padOffsets: [
        { padId: '1', number: '1', dx: 0, dy: 0, width: 1, height: 1, shape: 'rect', layer: 'top' },
        { padId: '2', number: '2', dx: 1.2, dy: 0, width: 1, height: 1, shape: 'rect', layer: 'top' },
    ] }]]),
    netlist: [
        { net: 'A', pins: [{ componentId: 'U1', pinNumber: '1' }] },
        { net: 'B', pins: [{ componentId: 'U1', pinNumber: '2' }] },
    ],
    tracks: [], vias: [], pads: [], texts: new Map(), boardShapes: [],
});
const rules = { clearance: 0.3 };
const excluded = { ...rules, excludeSameFootprintPadClearance: true };

for (const clipped of [false, true]) {
    const app = fixture();
    if (clipped) app.boardShapes.push({ id: 'cut', kind: 'rect', layer: 'top-copper', filled: true,
        copperMode: 'remove-copper', points: [
            { x: -1, y: 0.25 }, { x: 2, y: 0.25 }, { x: 2, y: 1 }, { x: -1, y: 1 },
        ] });
    const result = runDRC(app, rules);
    assert.deepEqual(result.violations.map(item => item.rule), ['clearance'],
        'Different-net footprint pads are checked by default, including clipped fragments');
    assert.match(result.violations[0].message, /Clearance 0.200 mm/);
    assert.ok(resolveDrcPairMarker(app, result.violations[0], rules));
    assert.deepEqual(runDRC(app, excluded).violations, [], 'Explicit exclusion suppresses internal pad clearance');
    assert.equal(resolveDrcPairMarker(app, result.violations[0], excluded), null,
        'Live selected markers follow the same exclusion policy');
    app.placements.get('U1').padOffsets[1].dx = 0.8;
    const short = runDRC(app, excluded).violations.find(item => item.rule === 'short');
    assert.ok(short, 'Exclusion never hides actual different-net pad contact');
    assert.ok(resolveDrcPairMarker(app, short, excluded));
    app.placements.get('U1').padOffsets[1].dx = 1.2;
    app.netlist[1].net = 'A';
    assert.deepEqual(runDRC(app, rules).violations, [], 'Same-net footprint pads are still allowed');
}

{
    const app = fixture();
    app.placements.set('U2', { x: 10, y: 0, side: 'top', reference: 'U2', padOffsets: [
        { padId: '1', number: '1', dx: 0, dy: 0, width: 1, height: 1, shape: 'rect', layer: 'top' },
    ] });
    app.placements.get('U1').padOffsets[1].dx = 11.2;
    app.netlist[0].pins.push({ componentId: 'U2', pinNumber: '1' });
    assert.deepEqual(runDRC(app, excluded).violations.map(item => item.rule), ['clearance'],
        'Pads of different components are not excluded');
}

{
    const app = fixture();
    app.pads.push(new Pad({ id: 'a', x: 20, y: 0, shape: 'square', size: 1, drill: 0,
        layers: 'top-copper', net: 'A' }),
    new Pad({ id: 'b', x: 21.2, y: 0, shape: 'square', size: 1, drill: 0,
        layers: 'top-copper', net: 'B' }));
    const result = runDRC(app, excluded);
    assert.equal(result.violations.length, 1, 'Standalone pads do not share a footprint through null identities');
    assert.ok(resolveDrcPairMarker(app, result.violations[0], excluded));
}

for (const kind of ['track', 'via']) {
    const app = fixture();
    if (kind === 'track') app.tracks.push(new Track({ id: 'external', net: 'C', width: 0.2,
        points: [{ x: -0.4, y: 0.7 }, { x: 1.6, y: 0.7 }] }));
    else app.vias.push({ id: 'external', net: 'C', x: 0, y: 1, diameter: 0.6, drill: 0.3 });
    const result = runDRC(app, excluded);
    assert.ok(result.violations.some(item => item.rule === 'clearance'), `Footprint-pad-to-${kind} checks remain`);
}

for (const value of [0, 1, null, 'true']) {
    assert.throws(() => runDRC(fixture(), { ...rules, excludeSameFootprintPadClearance: value }),
        /exclusion must be a boolean/);
}

console.log('PASS default-on footprint clearance, explicit exclusion, shorts, fragments, live markers and external copper');
