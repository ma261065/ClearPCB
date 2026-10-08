/** Ratlines end on a rounded Track's drawn copper, not on the off-copper corner node. */
import assert from 'node:assert/strict';
import { fakeElement, installFakeDom } from './helpers/fake-dom.mjs';
import { pcbEditorStubs } from './helpers/pcb-editor-stubs.mjs';

const document = installFakeDom();
document.createElementNS = () => {
    const element = fakeElement('line');
    element.attributes = {};
    element.setAttribute = (name, value) => { element.attributes[name] = String(value); };
    element.getAttribute = name => element.attributes[name] ?? null;
    element.removeAttribute = name => { delete element.attributes[name]; };
    return element;
};
const { reconcileRatsnest } = await import('../../src/pcb/modules/ratsnest.js');
const { Track } = await import('../../src/shapes/track.js');
const { resolveTrackSegments } = await import('../../src/shapes/track-geometry.js');
const { distanceToSegment } = await import('../../src/core/geometry.js');

function board(extra = {}) {
    const layer = { children: [], appendChild(line) { line.parent = this; this.children.push(line); } };
    return { ...pcbEditorStubs(), pads: [], vias: [], tracks: [], boardShapes: [], copperFills: [],
        placements: new Map(), netlist: [], texts: new Map(), get pcbDocument() { return this; },
        getLayerGroup: () => layer, ...extra };
}
const ratlines = app => {
    reconcileRatsnest(app);
    return app.getLayerGroup().children.map(line =>
        Object.fromEntries(['x1', 'y1', 'x2', 'y2'].map(key => [key, +line.attributes[key]])));
};
const lTrack = radii => new Track({ net: 'N', layer: 'top-copper', width: 0.25,
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], nodeCornerRadii: radii });
// Standalone pad beyond the corner, nearest to the corner node.
const pad = () => ({ id: 'pad', x: 14, y: -4, size: 1, shape: 'round', drill: 0.5, layers: 'both', net: 'N' });
const trackEnd = (line) => Math.hypot(line.x1 - 14, line.y1 + 4) < 1e-9 ? { x: line.x2, y: line.y2 } : { x: line.x1, y: line.y1 };
const distanceToCopper = (track, point) => Math.min(...resolveTrackSegments(track)
    .map(segment => distanceToSegment(point, segment.start, segment.end)));

{
    const track = lTrack({ n1: 6 });
    const lines = ratlines(board({ tracks: [track], pads: [pad()] }));
    assert.equal(lines.length, 1);
    const end = trackEnd(lines[0]);
    assert.ok(Math.hypot(end.x - 10, end.y) > 1, `ratline avoids the off-copper corner node (${end.x}, ${end.y})`);
    assert.ok(distanceToCopper(track, end) < 1e-9, 'ratline ends on the drawn centreline');
    const nearest = Math.min(...resolveTrackSegments(track).flatMap(segment => [segment.start, segment.end])
        .map(point => Math.hypot(point.x - 14, point.y + 4)));
    // Curves offer a few on-curve points, so the end is near (not exactly at) the nearest drawn point.
    assert.ok(Math.hypot(end.x - 14, end.y + 4) - nearest < 0.5, 'it is close to the drawn point nearest the pad');
}

{
    const track = new Track({ net: 'N', layer: 'top-copper', width: 0.25, cornerRadius: 6,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] });
    const end = trackEnd(ratlines(board({ tracks: [track], pads: [pad()] }))[0]);
    assert.ok(distanceToCopper(track, end) < 1e-9 && Math.hypot(end.x - 10, end.y) > 1, 'a track-wide radius behaves the same');
}

{
    const lines = ratlines(board({ tracks: [lTrack({})], pads: [pad()] }));
    assert.deepEqual(trackEnd(lines[0]), { x: 10, y: 0 }, 'a sharp corner still ends on its node');
}

{
    const track = new Track({ net: 'N', layer: 'top-copper', width: 0.25, cornerRadius: 6,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], edgeBulges: { e1: 0.5 } });
    // Rounding is skipped beside an arc edge; the arc itself offers points along it, all on copper.
    const end = trackEnd(ratlines(board({ tracks: [track], pads: [pad()] }))[0]);
    assert.ok(distanceToCopper(track, end) < 1e-9, 'an arc-adjacent corner ends on copper');
}

{
    // Junction bonding still uses nodes: a via placed on the rounded node joins the track.
    const via = { id: 'via', x: 10, y: 0, diameter: 0.6, drill: 0.3, net: 'N' };
    assert.equal(ratlines(board({ tracks: [lTrack({ n1: 6 })], vias: [via] })).length, 0,
        'coincident-node bonding is unchanged');
}

console.log('PASS ratlines end on rounded Track copper; sharp, arc and junction behaviour unchanged');
