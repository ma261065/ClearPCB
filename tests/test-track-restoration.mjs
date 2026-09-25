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

const { Track } = await import('../src/shapes/track.js');
const {
    canRestoreTrackToSourceBoardShape,
    convertBoardLineToTrack,
    restoreTrackToSourceBoardShape,
} = await import('../src/pcb/modules/board-shapes.js');

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
    const line = {
        id: 'pshape_converted',
        kind: 'line',
        layer: 'top-copper',
        lineWidth: 0.3,
        copperMode: 'add',
        net: '',
        points: [{ x: 0, y: 1 }, { x: 6, y: 1 }],
    };
    const app = appFor(null);
    app.tracks = [];
    app.boardShapes = [line];
    const properties = { innerHTML: '' };
    let propertiesTitle = 'Line';
    let activeTab = null;
    app._pcbPropsItems = () => properties;
    app._setPcbPropsTitle = title => { propertiesTitle = title; };
    app._setActiveRibbonTab = tab => { activeTab = tab; };
    const track = convertBoardLineToTrack(app, line, 'N');
    expect('a property-assigned Line converts to a Track', !!track && app.tracks[0] === track);
    expect('conversion immediately shows Track properties without reselection', propertiesTitle === 'Track'
        && properties.innerHTML.includes('id="pcbPropTrackNet"')
        && properties.innerHTML.includes('id="pcbPropTrackWidth"')
        && activeTab === 'pcb-properties');
    delete app._pcbPropsItems;
    expect('a converted Line Track remains restorable', canRestoreTrackToSourceBoardShape(track));
    expect('clearing a converted Line Track restores the Line', restoreTrackToSourceBoardShape(app, track));
    expect('restored converted Line keeps its original id', app.boardShapes[0]?.id === line.id);
}

{
    const sourceBoardShape = {
        id: 'pshape_edited',
        kind: 'line',
        layer: 'top-copper',
        lineWidth: 0.2,
        copperMode: 'add',
        net: '',
        points: [{ x: 0, y: 0 }, { x: 4, y: 0 }],
    };
    const track = new Track({
        net: 'N',
        layer: 'top-copper',
        width: 0.2,
        points: [{ x: 0, y: 0 }, { x: 2, y: 1 }, { x: 4, y: 0 }],
        sourceBoardShape,
    });
    const app = appFor(track);
    expect('an edited source-derived simple Track can restore', canRestoreTrackToSourceBoardShape(track));
    expect('edited source-derived Track restoration succeeds', restoreTrackToSourceBoardShape(app, track));
    expect('edited source-derived restoration keeps its edited points',
        app.boardShapes[0]?.points?.length === 3 && app.boardShapes[0]?.points[1]?.y === 1);
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

{
    const line = { id: 'geometry-roundtrip', kind: 'line', layer: 'top-copper', lineWidth: 0.3,
        copperMode: 'add', points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }],
        segmentWidths: { 1: 0.6 }, segmentBulges: { 0: -0.4 }, cornerRadius: 2, nodeCornerRadii: { 1: 0.7 } };
    const app = appFor(null);
    app.tracks = [];
    app.boardShapes = [line];
    const track = convertBoardLineToTrack(app, line, 'N');
    expect('Line conversion carries widths and bulges', track.getEdgeWidth('e1') === 0.6 && track.edges.get('e0').bulge === -0.4);
    expect('Line conversion carries both radius levels', track.cornerRadius === 2 && track.nodeCornerRadius('n1') === 0.7);
    track.setEdgeAttr('e0', 'bulge', 0.5);
    restoreTrackToSourceBoardShape(app, track);
    const restored = app.boardShapes[0];
    expect('restoration uses edited bulges rather than the source snapshot', restored.segmentBulges[0] === 0.5);
    expect('restoration carries widths and radii', restored.segmentWidths[1] === 0.6
        && restored.cornerRadius === 2 && restored.nodeCornerRadii[1] === 0.7);
}

{
    const track = new Track({ graphNodes: { n0: { x: 0, y: 0 }, n1: { x: 8, y: 0 } },
        graphEdges: { e0: { from: 'n1', to: 'n0', bulge: 0.4 } } });
    const app = appFor(track);
    restoreTrackToSourceBoardShape(app, track);
    expect('reversed traversal reverses the bulge sign', app.boardShapes[0].segmentBulges[0] === -0.4);
}

if (failures) process.exitCode = 1;