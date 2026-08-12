/** Headless regression tests for shared Track render/selection layer runs. */

import { Track } from './src/shapes/track.js';
import { buildTrackLayerRuns } from './src/pcb/modules/track-render.js';

let failures = 0;

function expect(name, condition) {
    if (condition) {
        console.log(`PASS: ${name}`);
        return;
    }
    failures++;
    console.error(`FAIL: ${name}`);
}

{
    const track = new Track({
        points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }],
        layer: 'top-copper',
        width: 0.2,
    });
    const runs = buildTrackLayerRuns(track);
    expect('contiguous matching edges become one run', runs.length === 1);
    expect('contiguous run retains every point', runs[0]?.points.length === 3);
}

{
    const track = new Track({
        points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }],
        layer: 'top-copper',
        width: 0.2,
    });
    track.setEdgeAttr('e1', 'width', 0.4);
    const runs = buildTrackLayerRuns(track);
    expect('a width change splits the run', runs.length === 2);
    expect('split runs retain their edge widths', runs[0]?.width === 0.2 && runs[1]?.width === 0.4);
}

{
    const track = new Track({
        graphNodes: {
            n0: { x: 0, y: 0 },
            n1: { x: 5, y: 0 },
            n2: { x: 10, y: 0 },
            n3: { x: 5, y: 5 },
        },
        graphEdges: {
            e0: { from: 'n0', to: 'n1' },
            e1: { from: 'n1', to: 'n2' },
            e2: { from: 'n1', to: 'n3' },
        },
        layer: 'top-copper',
        width: 0.2,
    });
    const runs = buildTrackLayerRuns(track);
    expect('a branch produces a through-run and a separate branch run', runs.length === 2);
    expect('a branch retains all three edges', runs.reduce((count, run) => count + run.points.length - 1, 0) === 3);
}

if (failures) process.exitCode = 1;