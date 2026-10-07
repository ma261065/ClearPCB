import assert from 'node:assert/strict';
import {
    copperContactsTouch, copperShapesTouch, copperRegionShape, resolveTrackContactGeometry,
    copperSegmentShape, copperSegmentContact,
} from '../../src/pcb/modules/track-contact-geometry.js';
import { CopperFill } from '../../src/shapes/copper-fill.js';
import { setComputedFill } from '../../src/pcb/modules/computed-fill-cache.js';

globalThis.window = { addEventListener() {} };
globalThis.document = { createElementNS: () => ({ setAttribute() {}, dataset: {} }) };
const { reconcileRatsnest, collectBondedCopper } = await import('../../src/pcb/modules/track-draw.js');
const { Track } = await import('../../src/shapes/track.js');

const ring = (radius, count) => Array.from({ length: count }, (_, index) => ({
    x: radius * Math.cos(index * Math.PI * 2 / count),
    y: radius * Math.sin(index * Math.PI * 2 / count),
}));
const outer = ring(10, 512), hole = ring(8, 256);
let distantReads = 0;
outer[256] = {
    get x() { distantReads++; return -10; },
    get y() { distantReads++; return 0; },
};
for (const points of [outer, hole]) {
    points.forEach(Object.freeze);
    Object.freeze(points);
}
const region = Object.freeze({ outer, holes: Object.freeze([hole]) });
const regionShape = copperRegionShape(region);
assert.equal(copperRegionShape(region), regionShape, 'Immutable computed regions retain their shape identity');
const contact = resolveTrackContactGeometry(regionShape);
const circle = (x, y = 0) => ({ kind: 'circle', x, y, radius: 0.2, lineWidth: 0, filled: true });
const copper = circle(9), empty = circle(0), outside = circle(12);
const prepared = [copper, empty, outside].map(resolveTrackContactGeometry);
for (const [index, expected] of [true, false, false].entries()) {
    assert.equal(copperContactsTouch(contact, prepared[index]), expected);
    assert.equal(copperContactsTouch(prepared[index], contact), expected);
    assert.equal(copperShapesTouch(regionShape, [copper, empty, outside][index]), expected);
}
distantReads = 0;
for (let index = 0; index < 100; index++) {
    assert.equal(copperContactsTouch(contact, prepared[0]), true);
    assert.equal(copperContactsTouch(contact, prepared[1]), false);
    assert.equal(copperContactsTouch(contact, prepared[2]), false);
}
assert.equal(distantReads, 0,
    'Prepared narrow phases neither rescan the outer contour nor rebuild distant triangle bounds');

const mutable = circle(12);
assert.equal(copperShapesTouch(regionShape, mutable), false);
mutable.x = 9;
assert.equal(copperShapesTouch(regionShape, mutable), true, 'Unprepared API still detects authored changes');
mutable.x = 0;
assert.equal(copperShapesTouch(regionShape, mutable), false, 'Hole interiors stay disconnected');
const noHoles = Object.freeze({ outer: Object.freeze(ring(3, 32)) });
const normalized = copperRegionShape(noHoles);
assert.equal(copperRegionShape(noHoles), normalized);
assert.deepEqual(normalized.region.holes, []);
assert.equal(Object.hasOwn(noHoles, 'holes'), false, 'Normalization does not modify published regions');
const replacedRegion = { kind: 'polygon', filled: true, lineWidth: 0, points: outer,
    region: { outer, holes: [] } };
assert.equal(copperShapesTouch(replacedRegion, empty), true);
replacedRegion.region = region;
assert.equal(copperShapesTouch(replacedRegion, empty), false,
    'Replacing a region on an existing shape invalidates its prepared contact too');
for (const width of [0, 0.001, 0.2, 5]) {
    for (const end of [{ x: 2, y: 3 }, { x: -4, y: 3 }, { x: 2, y: -5 }, { x: 9, y: 8 }]) {
        const segment = { start: { x: 2, y: 3 }, end, width, layer: 'top-copper' };
        const expected = resolveTrackContactGeometry(copperSegmentShape(segment));
        const preparedSegment = copperSegmentContact(segment);
        assert.deepEqual(preparedSegment.geometry, expected.geometry);
        assert.deepEqual(preparedSegment.bounds, expected.bounds);
    }
}

const fill = new CopperFill({ net: 'N', outline: outer, layer: 'top-copper' });
setComputedFill(fill, [region]);
const probes = ring(9, 16).map((point, index) => ({
    ...circle(point.x, point.y), id: `probe-${index}`, layer: 'top-copper', net: 'N',
}));
const lines = [];
const ratLayer = { children: [], appendChild(line) { lines.push(line); } };
const app = { boardShapes: [...probes, fill], copperFills: [fill], tracks: [], vias: [], pads: [],
    placements: new Map(), netlist: [], getLayerGroup: () => ratLayer };
reconcileRatsnest(app);
assert.equal(lines.length, 0, 'The annular pour connects all sixteen isolated copper probes');
const every = Array.prototype.every;
let outerChecks = 0;
try {
    Array.prototype.every = function (...args) {
        if (this === outer) outerChecks++;
        return every.apply(this, args);
    };
    reconcileRatsnest(app);
    assert.equal(outerChecks, 1, 'Ratsnest validates a published contour once per pass, not once per contact pair');
    const track = new Track({ points: [{ x: 9, y: 0 }, { x: 9.1, y: 0 }], net: 'N' });
    app.tracks.push(track);
    outerChecks = 0;
    const bonded = collectBondedCopper(app, { track }, { includeShapes: true });
    assert.ok(bonded.shapes.has(fill));
    assert.equal(bonded.shapes.size, 17, 'The fill connects all probes during bonded-Net traversal too');
    assert.equal(outerChecks, 1, 'Bonded traversal shares its prepared broad/narrow-phase contacts');
} finally {
    Array.prototype.every = every;
}
setComputedFill(fill, [{ outer: ring(1, 32), holes: [] }]);
assert.equal(collectBondedCopper(app, { track: app.tracks[0] }, { includeShapes: true }).shapes.has(fill), false,
    'Replacing computed geometry invalidates old connectivity without an explicit global cache reset');
{
    const tracks = Array.from({ length: 100 }, (_, index) => new Track({
        points: Array.from({ length: 40 }, (_, node) => ({ x: node, y: index * 10 })),
        net: `N${index}`,
    }));
    const denseApp = { ...app, tracks, boardShapes: [], copperFills: [] };
    const before = tracks.map(track => track.toJSON());
    const clone = globalThis.structuredClone;
    let segmentSnapshots = 0;
    try {
        globalThis.structuredClone = value => {
            if (value?.copperSegment) segmentSnapshots++;
            return clone(value);
        };
        reconcileRatsnest(denseApp);
        assert.equal(segmentSnapshots, 0, 'A 3,900-segment pass does not snapshot ephemeral segment descriptors');
    } finally {
        globalThis.structuredClone = clone;
    }
    assert.deepEqual(tracks.map(track => track.toJSON()), before, 'Prepared contacts never modify authored tracks');
}
console.log('PASS prepared contact reuse, immutable region identity, triangle bounds reuse, holes and replaced pours');
