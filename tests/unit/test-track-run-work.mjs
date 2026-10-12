import assert from 'node:assert/strict';
import { Track } from '../../src/shapes/track.js';

globalThis.window = { addEventListener() {} };
const { buildTrackLayerRuns } = await import('../../src/pcb/modules/track-render.js');

for (const count of [1000, 4000]) {
    const points = Array.from({ length: count }, (_, index) => ({ x: index, y: index % 7 }));
    const track = new Track({ points });
    const before = track.captureState();
    const includes = Array.prototype.includes;
    let membershipWork = 0;
    let runs;
    const start = performance.now();
    try {
        Array.prototype.includes = function (value, ...args) {
            if (typeof value === 'string' && /^n\d+$/.test(value)) membershipWork += this.length;
            return includes.call(this, value, ...args);
        };
        runs = buildTrackLayerRuns(track);
    } finally {
        Array.prototype.includes = includes;
    }
    console.log(`${count} track nodes: ${(performance.now() - start).toFixed(2)} ms; linear-membership work: ${membershipWork}`);
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].points, points, 'Every authored vertex remains in the deterministic run');
    assert.deepEqual(track.captureState(), before, 'Run construction does not mutate authored geometry');
    assert.ok(membershipWork <= count * 4, 'Start-node ordering must not perform quadratic array-membership scans');
}

{
    const track = new Track({
        graphNodes: {
            n0: { x: 0, y: 0 }, n1: { x: 1, y: 0 }, n2: { x: 2, y: 0 },
            n3: { x: 0, y: 1 }, n4: { x: 1, y: 1 }, n5: { x: 0, y: 2 },
            n6: { x: 20, y: 20 },
        },
        graphEdges: {
            e0: { from: 'n0', to: 'n1' }, e1: { from: 'n1', to: 'n2' },
            e2: { from: 'n3', to: 'n4' }, e3: { from: 'n4', to: 'n5' }, e4: { from: 'n5', to: 'n3' },
        },
    });
    assert.deepEqual(buildTrackLayerRuns(track).map(run => run.points), [
        [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
        [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 1 }],
    ], 'Endpoint-first and closed-loop ordering are retained; isolated nodes add no artwork');
}
console.log('PASS linear track-run start ordering, complete geometry, closed loops and read-only models');
