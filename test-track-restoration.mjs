/** Headless regression tests for Track-to-Line restoration on Net clearing. */

globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById() { return null; },
    createElementNS() {
        return {
            setAttribute() {},
            remove() {},
            classList: { add() {} },
        };
    },
};

const { Track } = await import('./src/shapes/track.js');
const {
    canRestoreTrackToSourceBoardShape,
    restoreTrackToSourceBoardShape,
} = await import('./src/pcb/modules/board-shapes.js');

let failures = 0;

function expect(name, condition) {
    if (condition) {
        console.log(`PASS: ${name}`);
        return;
    }
    failures++;
    console.error(`FAIL: ${name}`);
}

function appFor(track) {
    const app = {
        tracks: [track],
        boardShapes: [],
        _shapeIdCounter: 1,
        _shapeElements: new Map(),
        _getLayerGroup() { return null; },
        history: { execute(command) { command.execute(); } },
    };
    return app;
}

{
    const track = new Track({
        net: 'N',
        layer: 'bottom-copper',
        width: 0.35,
        points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }],
    });
    const app = appFor(track);
    expect('a simple manual Track can restore to a Line', canRestoreTrackToSourceBoardShape(track));
    expect('manual Track restoration succeeds', restoreTrackToSourceBoardShape(app, track));
    const line = app.boardShapes[0];
    expect('restoration removes the Track', app.tracks.length === 0);
    expect('restoration creates a generic Line', line?.kind === 'line');
    expect('manual Line keeps layer and width', line?.layer === 'bottom-copper' && line?.lineWidth === 0.35);
    expect('manual Line has no net', line?.net === '');
}

{
    const sourceBoardShape = {
        id: 'pshape_source',
        kind: 'line',
        layer: 'top-copper',
        lineWidth: 0.25,
        copperMode: 'add',
        net: '',
        points: [{ x: 1, y: 2 }, { x: 3, y: 4 }],
    };
    const track = new Track({
        net: 'N',
        layer: 'top-copper',
        width: 0.25,
        points: sourceBoardShape.points,
        sourceBoardShape,
    });
    const app = appFor(track);
    expect('an unchanged source-derived Track can restore', canRestoreTrackToSourceBoardShape(track));
    expect('source-derived Track restoration succeeds', restoreTrackToSourceBoardShape(app, track));
    expect('source-derived restoration preserves original id and style',
        app.boardShapes[0]?.id === sourceBoardShape.id && app.boardShapes[0]?.lineWidth === 0.25);
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
    });
    expect('a branched Track remains a Track', !canRestoreTrackToSourceBoardShape(track));
}

{
    const track = new Track({ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] });
    track.padConnections.set('n0', { componentId: 'R1', pinNumber: '1' });
    expect('a pad-linked Track remains a Track', !canRestoreTrackToSourceBoardShape(track));
}

if (failures) process.exitCode = 1;