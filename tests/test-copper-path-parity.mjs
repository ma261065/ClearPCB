/**
 * Copper-path parity: a net-carrying copper shape and the Track it converts to
 * are the same copper, so selection hits, connectivity and ratline endpoints
 * must agree between the two models. Points within a small band of either
 * copper edge are skipped because the models sample curves at different densities.
 */
import assert from 'node:assert/strict';

function element() {
    const attributes = new Map();
    return {
        style: {}, dataset: {}, children: [], classList: { add() {}, remove() {}, contains: () => false },
        attributes: {},
        setAttribute(name, value) { attributes.set(name, String(value)); this.attributes[name] = value; },
        getAttribute(name) { return attributes.get(name) ?? null; },
        removeAttribute(name) { attributes.delete(name); },
        appendChild(child) { child.parent = this; this.children.push(child); return child; },
        insertBefore(child) { this.children.push(child); return child; },
        remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); },
        querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
    };
}
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: element, createElementNS: element };

const { createBoardShapeSelectionAdapter } = await import('../src/pcb/modules/board-shapes.js');
const { trackFromBoardShape } = await import('../src/shared/pcb/copper-path-tracks.js');
const { createTrackSelectionAdapter } = await import('../src/pcb/modules/track-select.js');
const { reconcileRatsnest } = await import('../src/pcb/modules/track-draw.js');
const { resolveTrackSegments } = await import('../src/shapes/track-geometry.js');
const { distanceToSegment } = await import('../src/core/geometry.js');

const BAND = 0.03;
const quad = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 12 }, { x: 0, y: 12 }];
const fixtures = [
    ['polygon with a large node radius', { kind: 'polygon', lineWidth: 0.3,
        points: [{ x: 0, y: 0 }, { x: 17, y: 29 }, { x: 28, y: 20 }, { x: 22, y: -2 }], nodeCornerRadii: { 1: 9.5 } }],
    ['polygon with a shared corner radius', { kind: 'polygon', lineWidth: 0.5,
        points: [{ x: 0, y: 0 }, { x: 17, y: 29 }, { x: 28, y: 20 }], cornerRadius: 4 }],
    ['rectangle with an oversized radius', { kind: 'rect', lineWidth: 1, points: quad, cornerRadius: 50 }],
    ['line with a node radius', { kind: 'line', lineWidth: 0.8,
        points: [{ x: 0, y: 0 }, { x: 15, y: 0 }, { x: 15, y: 15 }, { x: 30, y: 20 }], nodeCornerRadii: { 1: 6, 2: 3 } }],
    ['polygon with a bulge beside rounded corners', { kind: 'polygon', lineWidth: 0.4, points: quad,
        cornerRadius: 3, segmentBulges: { 0: 0.5 } }],
    ['line with segment widths and a radius', { kind: 'line', lineWidth: 0.3,
        points: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 12 }], segmentWidths: { 1: 1.6 }, cornerRadius: 5 }],
];

function shapeFor(spec) {
    return { id: 'shape', layer: 'top-copper', filled: false, copperMode: 'add', net: 'N',
        ...structuredClone(spec) };
}
function trackFor(spec) {
    return trackFromBoardShape(shapeFor(spec), 'N');
}
function board(extra) {
    const layer = element();
    return { pads: [], vias: [], tracks: [], boardShapes: [], copperFills: [], placements: new Map(), netlist: [],
        texts: new Map(), _shapeElements: new Map(), viewport: { scale: 10 }, getLayerGroup: () => layer, ...extra };
}
/** Signed clearance from the drawn copper edge (negative inside), measured on the Track's rendered centreline. */
function edgeClearance(segments, point, extra = 0) {
    let best = Infinity;
    for (const segment of segments) best = Math.min(best, distanceToSegment(point, segment.start, segment.end) - segment.width / 2 - extra);
    return best;
}
function ratlines(app) {
    reconcileRatsnest(app);
    return app.getLayerGroup().children.map(line => ({ x1: +line.attributes.x1, y1: +line.attributes.y1,
        x2: +line.attributes.x2, y2: +line.attributes.y2 }));
}

const mismatches = [];
let compared = 0;
for (const [name, spec] of fixtures) {
    const shape = shapeFor(spec);
    const track = trackFor(spec);
    const segments = resolveTrackSegments(track);
    const bounds = track.getBounds();
    const sample = (steps, margin, visit) => {
        for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps; j++) visit({
            x: bounds.minX - margin + (bounds.maxX - bounds.minX + 2 * margin) * i / steps,
            y: bounds.minY - margin + (bounds.maxY - bounds.minY + 2 * margin) * j / steps,
        });
    };
    const record = (kind, point, shapeValue, trackValue) => {
        compared++;
        if (shapeValue !== trackValue) mismatches.push(`${name}: ${kind} at (${point.x.toFixed(2)}, ${point.y.toFixed(2)}) `
            + `shape=${shapeValue} track=${trackValue}`);
    };

    // Selection hits (unselected), at the default selection tolerance.
    const hitApp = board({ boardShapes: [shape], tracks: [track] });
    const shapeAdapter = createBoardShapeSelectionAdapter(hitApp, shape, 'shape:shape');
    const trackAdapter = createTrackSelectionAdapter(hitApp, track, 'track:track');
    const tolerance = 0.6;
    sample(60, 3, point => {
        if (Math.abs(edgeClearance(segments, point, tolerance)) < BAND) return;
        record('hit', point, shapeAdapter.hitTest(point, tolerance), trackAdapter.hitTest(point, tolerance));
    });

    // Connectivity of a small probe pad and via, and where the ratline lands when they are apart.
    sample(14, 2, point => {
        const radius = 0.3;
        if (Math.abs(edgeClearance(segments, point, radius)) < BAND) return;
        for (const probe of ['pad', 'via']) {
            const terminal = probe === 'pad'
                ? { pads: [{ id: 'p', x: point.x, y: point.y, size: radius * 2, shape: 'round', drill: 0.2, layers: 'both', net: 'N' }] }
                : { vias: [{ id: 'v', x: point.x, y: point.y, diameter: radius * 2, drill: 0.2, net: 'N' }] };
            const shapeLines = ratlines(board({ boardShapes: [shapeFor(spec)], ...structuredClone(terminal) }));
            const trackLines = ratlines(board({ tracks: [trackFor(spec)], ...structuredClone(terminal) }));
            record(`${probe} connected`, point, shapeLines.length === 0, trackLines.length === 0);
            if (shapeLines.length === 1 && trackLines.length === 1) {
                const end = line => Math.hypot(line.x1 - point.x, line.y1 - point.y) < 1e-9
                    ? { x: line.x2, y: line.y2 } : { x: line.x1, y: line.y1 };
                const a = end(shapeLines[0]), b = end(trackLines[0]);
                // Both models must end the ratline on drawn copper, at (nearly) the same place.
                record(`${probe} ratline end`, point, edgeClearance(segments, a) <= 1e-6 ? 'on copper' : `off copper (${a.x.toFixed(2)}, ${a.y.toFixed(2)})`,
                    edgeClearance(segments, b) <= 1e-6 ? 'on copper' : `off copper (${b.x.toFixed(2)}, ${b.y.toFixed(2)})`);
                // Curves offer a few on-curve points each, sampled differently per model; allow half their spacing.
                const lengths = [a, b].map(end => Math.hypot(end.x - point.x, end.y - point.y));
                record(`${probe} ratline length`, point, true,
                    Math.abs(lengths[0] - lengths[1]) <= 1 || `${lengths[0].toFixed(2)} vs ${lengths[1].toFixed(2)}`);
            }
        }
    });
}

const firstPerKind = new Map();
for (const mismatch of mismatches) {
    const key = mismatch.replace(/ at \(.*$/, '');
    firstPerKind.set(key, (firstPerKind.get(key) || []).concat(mismatch));
}
assert.deepEqual([...firstPerKind].map(([key, list]) => `${list.length}x ${list[0]}`), [],
    'copper shapes and their converted Tracks disagree');
console.log(`PASS copper-path parity: ${fixtures.length} shapes vs converted Tracks, ${compared} hit/connectivity/ratline comparisons`);

{
    // Schematic strokes share the reach: half the stroke width plus the pick tolerance.
    const { Polyline } = await import('../src/shapes/polyline.js');
    const { boardShapeHitTest } = await import('../src/shared/pcb/board-shape-geometry.js');
    const points = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }];
    const schematic = new Polyline({ points, lineWidth: 0.8 });
    const pcb = { kind: 'line', layer: 'top-silk', lineWidth: 0.8, points };
    for (const tolerance of [0.5, 1.2]) {
        for (const [offset, expected] of [[0.4 + tolerance - 0.01, true], [0.4 + tolerance + 0.01, false]]) {
            const point = { x: 10, y: offset };
            assert.equal(schematic.hitTest(point, tolerance), expected, `schematic polyline reach at ${offset}`);
            assert.equal(boardShapeHitTest(pcb, point, tolerance), expected, `PCB line reach at ${offset}`);
        }
    }
    console.log('PASS schematic and PCB strokes share one hit reach');
}
