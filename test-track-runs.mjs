/** Headless regression tests for shared Track render/selection layer runs. */

globalThis.window = { addEventListener() {} };
globalThis.document = {
    createElementNS: () => ({
        dataset: {},
        classList: { contains: () => false },
        setAttribute() {},
        remove() {},
    }),
    getElementById: () => null,
};

const { Track } = await import('./src/shapes/track.js');
const { buildTrackLayerRuns } = await import('./src/pcb/modules/track-render.js');
const { collectBondedCopper, reconcileRatsnest } = await import('./src/pcb/modules/track-draw.js');

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

function connectivityApp(viaY) {
    const track = new Track({
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
        layer: 'top-copper',
        width: 0.2,
        net: 'GND',
    });
    const via = { x: 5, y: viaY, diameter: 0.6, net: 'GND' };
    const children = [];
    let drcFollowCount = 0;
    let drcFollowSawRatline = false;
    return {
        track,
        via,
        children,
        drcFollowCount: () => drcFollowCount,
        drcFollowSawRatline: () => drcFollowSawRatline,
        app: {
            tracks: [track],
            vias: [via],
            netlist: [],
            placements: new Map(),
            boardShapes: [],
            copperFills: [],
            _getLayerGroup: () => ({ children, appendChild: (element) => children.push(element) }),
            _followDRCRatline() {
                drcFollowCount++;
                drcFollowSawRatline = children.length > 0;
            },
        },
    };
}

{
    const { app, track, via, children } = connectivityApp(0);
    reconcileRatsnest(app);
    const bonded = collectBondedCopper(app, { track });
    expect('a via overlapping a track midpoint removes the ratline', children.length === 0);
    expect('bonded copper includes a via overlapping a track midpoint', bonded.vias.has(via));
}

{
    const { app, track, via, children, drcFollowCount, drcFollowSawRatline } = connectivityApp(0.401);
    reconcileRatsnest(app);
    const bonded = collectBondedCopper(app, { track });
    expect('a via beyond the combined copper radii retains the ratline', children.length === 1);
    expect('bonded copper excludes a separated via', !bonded.vias.has(via));
    expect('ratsnest rebuild updates the selected DRC ratline follower', drcFollowCount() === 1);
    expect('DRC ratline follower runs after current geometry is drawn', drcFollowSawRatline());
}

if (failures) process.exitCode = 1;