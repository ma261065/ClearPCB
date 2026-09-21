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

const { Track } = await import('../src/shapes/track.js');
const { buildTrackLayerRuns } = await import('../src/pcb/modules/track-render.js');
const { CORNER_CHORD_TOLERANCE, roundedPathCorners, sampleRoundedCorner,
    resolveTrackEdgePaths, resolveTrackSegments } = await import('../src/pcb/modules/board-geometry.js');
const { collectBondedCopper, reconcileRatsnest } = await import('../src/pcb/modules/track-draw.js');

let failures = 0;

function expect(name, condition) {
    if (condition) {
        console.log(`PASS: ${name}`);
        return;
    }
    failures++;
    console.error(`FAIL: ${name}`);
}

for (const radius of [0.05, 2, 50]) {
    const corner = roundedPathCorners([{ x: -2 * radius, y: 0 }, { x: 0, y: 0 },
        { x: 0, y: 2 * radius }], [0, radius, 0])[1];
    const samples = sampleRoundedCorner(corner);
    const count = samples.length - 1;
    expect(`radius ${radius}: sampling is finer than eight steps and retains the midpoint`, count >= 16 && count % 2 === 0);
    expect(`radius ${radius}: chord error stays within tolerance`, samples.slice(0, -1).every((start, index) => {
        const fraction = (index + 0.5) / count;
        const exact = { x: -radius * (1 - fraction) ** 2, y: radius * fraction ** 2 };
        const end = samples[index + 1];
        return Math.hypot(exact.x - (start.x + end.x) / 2, exact.y - (start.y + end.y) / 2)
            <= CORNER_CHORD_TOLERANCE + 1e-12;
    }));
    const track = new Track({ points: [{ x: -2 * radius, y: 0 }, { x: 0, y: 0 },
        { x: 0, y: 2 * radius }], cornerRadius: radius });
    const paths = [...resolveTrackEdgePaths(track).values()];
    expect(`radius ${radius}: rounded edge halves meet exactly`,
        paths[0].at(-1).x === paths[1][0].x && paths[0].at(-1).y === paths[1][0].y);
    expect(`radius ${radius}: track keeps every corner sample`, buildTrackLayerRuns(track)[0].points.length === samples.length + 2);
}

{
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], cornerRadius: 2 });
    const points = buildTrackLayerRuns(track)[0].points;
    expect('overall Track radius rounds the interior corner', points.some(point => point.x === 9.5 && point.y === 0.5));
    expect('rounded Track preserves its endpoints', points[0].x === 0 && points.at(-1).y === 10);
    expect('physical segments use the same samples as rendering', resolveTrackSegments(track).length === points.length - 1);
    track.setNodeCornerRadius('n1', 0);
    expect('zero node override keeps a sharp corner with an overall radius', buildTrackLayerRuns(track)[0].points.length === 3);
    track.cornerRadius = 4;
    expect('node override survives changes to the overall radius', track.nodeCornerRadius('n1') === 0);
    expect('clone retains overall and per-node radii', track.clone().cornerRadius === 4 && track.clone().nodeCornerRadius('n1') === 0);
    const saved = track.toJSON();
    expect('Track serializes both radius levels', saved.cr === 4 && saved.ncr.n1 === 0);
    const state = track.captureState();
    track.setNodeCornerRadius('n1', 3);
    track.applyState(state);
    expect('snapshot restores the node override', track.nodeCornerRadius('n1') === 0);
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

for (const bulge of [-1, -0.25, 0.25, 1]) {
    const { arcFromBulge, closestPointOnArcEdge } = await import('../src/shapes/arc-edge.js');
    const start = { x: 0, y: 0 };
    const end = { x: 10, y: 0 };
    const track = new Track({ points: [start, end], edgeBulges: { e0: bulge }, width: 0.4 });
    const arc = arcFromBulge(start, end, bulge);
    const points = resolveTrackEdgePaths(track).get('e0');
    expect(`bulge ${bulge}: path includes exact endpoints`, points[0].x === start.x && points[0].y === start.y
        && points.at(-1).x === end.x && points.at(-1).y === end.y);
    expect(`bulge ${bulge}: samples lie on the circle`, points.every(point =>
        Math.abs(Math.hypot(point.x - arc.cx, point.y - arc.cy) - arc.radius) < 1e-9));
    expect(`bulge ${bulge}: serialization and cloning retain curvature`, track.toJSON().bg.e0 === bulge
        && track.clone().edges.get('e0').bulge === bulge);
    const splitPoint = closestPointOnArcEdge(arc.bulgePoint, start, end, bulge);
    const split = track.splitEdge('e0', splitPoint);
    expect(`bulge ${bulge}: split retains width`, track.getEdgeWidth(split.edge1Id) === 0.4
        && track.getEdgeWidth(split.edge2Id) === 0.4);
    expect(`bulge ${bulge}: split retains the original circle`, [...track.edges.values()].every(edge => {
        const half = arcFromBulge(track.nodes.get(edge.from), track.nodes.get(edge.to), edge.bulge);
        return half && Math.hypot(half.cx - arc.cx, half.cy - arc.cy) < 1e-9
            && Math.abs(half.radius - arc.radius) < 1e-9;
    }));
}

if (failures) process.exitCode = 1;