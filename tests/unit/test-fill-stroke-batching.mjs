import assert from 'node:assert/strict';
import Clipper from '../../assets/vendor/clipper.esm.js';
import { computeFillPolygons } from '../../src/pcb/modules/copper-fill-geom.js';
import { CopperFill } from '../../src/shapes/copper-fill.js';
import { Track } from '../../src/shapes/track.js';

const rectangle = [
    { x: -40, y: -40 }, { x: 40, y: -40 }, { x: 40, y: 40 }, { x: -40, y: 40 },
];
const fill = new CopperFill({ id: 'pour', net: 'GND', layer: 'top-copper', outline: rectangle });
const track = new Track({ net: 'SIGNAL', layer: 'top-copper', width: 0.5 });
const a = track.addNode(-15, 10), b = track.addNode(15, 10);
track.addEdge(a, b, { bulge: 0.5 });
const context = {
    tracks: [track], vias: [], pads: [], holes: [], fills: [fill],
    boardShapes: [{ kind: 'arc', layer: 'top-copper', net: 'SIGNAL',
        start: { x: -12, y: 0 }, bulge: { x: 0, y: -12 }, end: { x: 12, y: 0 }, lineWidth: 0.7 }],
    texts: [{ content: 'OBOB OBOB OBOB OBOB OBOB OBOB OBOB OBOB', x: -30, y: -10,
        size: 1.5, rotation: 0, layer: 'top-copper', strokeWidth: 0.7 }],
    params: { clearance: 0.15 },
};

function namespace(bypassMerge) {
    let maximumClipVertices = 0;
    class InstrumentedClipper extends Clipper.Clipper {
        subjects = [];
        AddPaths(paths, type, closed) {
            if (type === Clipper.PolyType.ptClip) {
                maximumClipVertices = Math.max(maximumClipVertices,
                    paths.reduce((sum, path) => sum + path.length, 0));
            } else this.subjects.push(...paths);
            return super.AddPaths(paths, type, closed);
        }
        Execute(type, solution, subjectFill, clipFill) {
            if (bypassMerge && type === Clipper.ClipType.ctUnion && Array.isArray(solution)) {
                // Reproduce the original board-wide clipping of individual capsules.
                solution.push(...this.subjects);
                return true;
            }
            return super.Execute(type, solution, subjectFill, clipFill);
        }
    }
    return { C: { ...Clipper, Clipper: InstrumentedClipper },
        maximum: () => maximumClipVertices };
}
const batched = namespace(false), original = namespace(true);
const started = performance.now();
const actual = computeFillPolygons(fill, context, batched.C);
const elapsed = performance.now() - started;
const expected = computeFillPolygons(fill, context, original.C);
assert.ok(actual.length > 0);
assert.ok(original.maximum() > 30000, `Fixture reproduces dense overlapping stroke obstacles: ${original.maximum()}`);
assert.ok(batched.maximum() < original.maximum() / 4,
    `Board-wide clip workload is reduced: ${batched.maximum()} vs ${original.maximum()} vertices`);
assert.ok(elapsed < 3000, `Batched dense stroke pour took ${elapsed.toFixed(1)} ms`);

const paths = regions => regions.flatMap(region => [region.outer, ...region.holes])
    .map(ring => ring.map(point => ({ X: Math.round(point.x * 10000), Y: Math.round(point.y * 10000) })));
const comparison = new Clipper.Clipper();
comparison.AddPaths(paths(actual), Clipper.PolyType.ptSubject, true);
comparison.AddPaths(paths(expected), Clipper.PolyType.ptClip, true);
const difference = new Clipper.Paths();
comparison.Execute(Clipper.ClipType.ctXor, difference,
    Clipper.PolyFillType.pftNonZero, Clipper.PolyFillType.pftNonZero);
const changedArea = difference.reduce((sum, ring) => sum + Math.abs(Clipper.Clipper.Area(ring)), 0) / 1e8;
assert.ok(changedArea < 0.01, `Pour area changes only by integer clipping quantization: ${changedArea} mm²`);
console.log(`PASS dense stroke batching: ${original.maximum()} -> ${batched.maximum()} clip vertices, `
    + `${elapsed.toFixed(1)} ms, ${changedArea.toFixed(6)} mm² quantization difference`);
