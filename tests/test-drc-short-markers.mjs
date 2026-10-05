import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
const { runDRC } = await import('../src/pcb/modules/drc.js');
const { default: PCBApp } = await import('../src/ui/PCBApp.js');
const { getDrcPresentation } = await import('../src/pcb/modules/drc-state.js');

const track = (id, net, points, layer = 'top-copper') => ({
    id, net, layer, width: 0.2,
    nodes: new Map(points.map(([x, y], index) => [index, { x, y }])),
    edges: new Map(points.slice(1).map((_, index) => [index, { from: index, to: index + 1 }])),
});
const board = () => ({ placements: new Map(), texts: new Map(), vias: [], tracks: [], boardShapes: [] });
const shorts = app => runDRC(app, { clearance: 0.5 }).violations.filter(v => v.rule === 'short');
const cut = (x, y) => ({
    id: 'cut', kind: 'rect', layer: 'top-copper', copperMode: 'remove-copper',
    filled: true, lineWidth: 0.05,
    points: [{ x: x - 0.5, y: y - 0.5 }, { x: x + 0.5, y: y - 0.5 },
        { x: x + 0.5, y: y + 0.5 }, { x: x - 0.5, y: y + 0.5 }],
});

const app = board();
app.placements.set('U1', { x: 0, y: 0, padOffsets: [
    { padId: '52', number: '52', dx: 0, dy: 0, width: 1, height: 1, shape: 'rect', layer: 'top' },
    { padId: '53', number: '53', dx: 100, dy: 0, width: 1, height: 1, shape: 'rect', layer: 'top' },
] });
app.netlist = [
    { net: 'U1.52', pins: [{ componentId: 'U1', pinNumber: '52' }] },
    { net: 'U1.53', pins: [{ componentId: 'U1', pinNumber: '53' }] },
];
app.tracks.push(track('long-track', 'U1.52', [[0, 0], [100, 0]]));
const [violation] = shorts(app);
assert.equal(shorts(app).length, 1);
assert.equal(violation.x, 100, 'marker belongs at the mismatched pad junction, not halfway along the net');
assert.equal(violation.y, 0);
assert.equal(violation.message, 'Shorted nets: U1.52 and U1.53');
assert.equal(violation.id, 'drc:short|U1.52~U1.53', 'selection identity is preserved');
assert.equal(violation.marker.type, 'short');
assert.deepEqual(new Set(violation.marker.pair.map(item => item.key)), new Set(['trk:long-track', 'pad:U1.53']));
assert.equal(violation.marker.a, undefined, 'no remote sample endpoints are exported');
app.tracks.unshift(track('unrelated', 'OTHER', [[-100, -100], [-90, -100]]));
assert.deepEqual(shorts(app), [violation], 'unrelated copper does not move or renumber the marker');

{
    const target = board();
    target.tracks = [track('a', 'A', [[0, 0], [10, 0]]),
        track('bridge', '', [[10, 0], [90, 0]]), track('b', 'B', [[90, 0], [100, 0]])];
    const [v] = shorts(target);
    assert.ok([10, 90].includes(v.x), 'a no-net bridge is marked at an actual joining junction');
    assert.equal(v.y, 0);
    target.tracks.push(track('c', 'C', [[100, 0], [110, 0]]));
    const [three] = shorts(target);
    assert.equal(shorts(target).length, 1, 'one report per bonded component is retained');
    assert.equal(three.message, 'Shorted nets: A, B, C');
    assert.equal(three.x, v.x, 'later contacts do not replace the first short location');
}

{
    const target = board();
    target.tracks = [track('a', 'A', [[0, 0], [10, 0]]),
        track('b', 'B', [[10, 0], [10, 30]], 'bottom-copper')];
    assert.equal(shorts(target).length, 0, 'opposite layers without a bridge are not shorted');
    target.vias.push({ id: 'bridge', x: 10, y: 0, diameter: 0.6, drill: 0.3, net: '' });
    const [v] = shorts(target);
    const radial = Math.hypot(v.x - 10, v.y);
    assert.ok(radial >= 0.15 - 1e-9 && radial <= 0.3 + 1e-9,
        'layer-transition short points to the Via copper, not its empty drill');
}

{
    const target = board();
    target.tracks = [track('horizontal', 'A', [[0, 20], [100, 20]]),
        track('vertical', 'B', [[10, 0], [10, 100]])];
    // Exercise clipped-copper connectivity while leaving the crossing intact.
    target.boardShapes.push(cut(80, 20));
    const [v] = shorts(target);
    assert.ok(Math.abs(v.x - 10) <= 0.11 && Math.abs(v.y - 20) <= 0.11,
        'clipped copper uses the detected contact, not primitive centres');
    target.boardShapes.push({ ...cut(10, 20), id: 'remove-crossing' });
    assert.equal(shorts(target).length, 0, 'a removed contact cannot leave a short marker');
}

class Element {
    constructor(tag) { this.tag = tag; this.attributes = {}; this.children = []; this.style = {}; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    appendChild(child) { this.children.push(child); }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
    get firstChild() { return this.children[0]; }
}
const panel = {
    classList: { contains: () => true },
    querySelector: () => null,
    getBoundingClientRect: () => ({ right: 320, top: 0 }),
};
globalThis.document = {
    createElementNS: (_, tag) => new Element(tag),
    getElementById: id => id === 'pcbDrcSlidePanel' ? panel : null,
};
const ui = Object.create(PCBApp.prototype);
const overlay = new Element('g');
ui.getLayerGroup = () => overlay;
const drc = getDrcPresentation(ui);
drc.violations = [violation];
drc.connectorLine = new Element('polyline');
const connector = new Element('svg');
connector.parentElement = { getBoundingClientRect: () => ({ left: 0, top: 0 }) };
drc.ensureConnector = () => connector;
ui.viewport = {
    scale: 5,
    worldToScreen: p => ({ x: p.x * 5 + 100, y: p.y * 5 + 100 }),
    svg: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
};
let navigation;
drc.ensurePointVisible = (x, y) => { navigation = { x, y }; };
drc.selectViolation(violation.id);
assert.deepEqual(navigation, { x: 100, y: 0 }, 'navigation targets the physical junction');
assert.deepEqual(overlay.children.map(el => el.tag), ['circle'], 'exactly one ring, without a red sample line');
assert.equal(overlay.children[0].getAttribute('cx'), '100');
assert.equal(overlay.children[0].getAttribute('cy'), '0');
const leader = drc.connectorLine.getAttribute('points').split(' ').map(p => p.split(',').map(Number));
assert.ok(Math.abs(Math.hypot(leader[1][0] - 600, leader[1][1] - 100) - 3) < 1e-7,
    'panel leader ends at the contact ring');
drc.selectViolation(violation.id);
assert.equal(overlay.children.length, 1, 'reselecting does not accumulate rings');
drc.drawMarker({ x: 1, y: 2, marker: { type: 'clearance' } });
assert.equal(overlay.children.length, 1, 'clearance retains its location ring');
drc.drawMarker({ x: 1, y: 2, marker: { type: 'ring', r: 0.8 } });
assert.equal(overlay.children[0].getAttribute('r'), '1.05', 'annular-ring sizing is unchanged');
drc.isRatlineVisible = () => false;
drc.drawMarker({ x: 1, y: 2, marker: { type: 'ratline', a: { x: 0, y: 0 }, b: { x: 2, y: 4 } } });
assert.deepEqual(overlay.children.map(el => el.tag), ['circle', 'line'], 'hidden incomplete connections remain visible');

console.log('PASS short contact locations, No Net bridges, layers, clipped copper, single-ring rendering and panel leader');
