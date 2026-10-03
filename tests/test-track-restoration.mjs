/** Headless regression tests for Track-to-Line restoration on Net clearing. */
import { PcbDocument } from '../src/core/PcbDocument.js';

globalThis.window = { addEventListener() {} };
globalThis.document = {
    getElementById() { return null; },
    querySelector() { return null; },
    createElementNS() {
        const attributes = new Map();
        return {
            setAttribute(name, value) { attributes.set(name, String(value)); },
            getAttribute(name) { return attributes.get(name) ?? null; },
            removeAttribute(name) { attributes.delete(name); },
            appendChild() {},
            remove() {},
            classList: { add() {} },
        };
    },
};

const { Track } = await import('../src/shapes/track.js');
const { isTrackRectangleLoop, resolveTrackEdgePaths } = await import('../src/shapes/track-geometry.js');
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
    const pcbDocument = new PcbDocument();
    if (track) pcbDocument.tracks.push(track);
    const app = {
        pcbDocument,
        tracks: pcbDocument.tracks,
        boardShapes: pcbDocument.boardShapes,
        _shapeIdCounter: 1,
        _shapeElements: new Map(),
        getLayerGroup() { return null; },
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
    app.tracks.length = 0;
    app.boardShapes.push(line);
    const properties = { innerHTML: '' };
    let propertiesTitle = 'Line';
    let activeTab = null;
    app._pcbPropsItems = () => properties;
    app._setPcbPropsTitle = title => { propertiesTitle = title; };
    app._setActiveRibbonTab = tab => { activeTab = tab; };
    const track = convertBoardLineToTrack(app, line, 'N');
    expect('a property-assigned Line converts to a Track', !!track && app.tracks[0] === track);
    expect('conversion removes the Line from the canonical shape array',
        app.boardShapes === app.pcbDocument.boardShapes && app.boardShapes.length === 0);
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
    app.tracks.length = 0;
    app.boardShapes.push(line);
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
        graphEdges: { e0: { from: 'n1', to: 'n0' } }, edgeBulges: { e0: 0.4 } });
    const app = appFor(track);
    restoreTrackToSourceBoardShape(app, track);
    expect('reversed traversal reverses the bulge sign', app.boardShapes[0].segmentBulges[0] === -0.4);
}

{
    // Unfilled copper polygons are closed-loop routing intent; segment i stays edge e<i>.
    const polygon = { id: 'pshape_loop', kind: 'polygon', layer: 'top-copper', lineWidth: 0.2, filled: false,
        copperMode: 'add', net: '', points: [{ x: 0, y: 0 }, { x: 17, y: 29 }, { x: 28, y: 20 }, { x: 22, y: -2 }],
        nodeCornerRadii: { 1: 9.5 }, segmentBulges: { 3: 0.3 }, segmentWidths: { 0: 0.5 } };
    const app = appFor(null);
    app.boardShapes.push(polygon);
    const track = convertBoardLineToTrack(app, polygon, 'N');
    expect('an unfilled polygon converts to a Track', !!track && app.tracks[0] === track && app.boardShapes.length === 0);
    expect('the polygon Track is one closed loop', track.nodes.size === 4 && track.edges.size === 4
        && track.edges.get('e3').from === 'n3' && track.edges.get('e3').to === 'n0');
    expect('closing-edge bulge, segment width and node radius carry over', track.edges.get('e3').bulge === 0.3
        && track.getEdgeWidth('e0') === 0.5 && track.nodeCornerRadius('n1') === 9.5);
    expect('a converted polygon Track remains restorable', canRestoreTrackToSourceBoardShape(track));
    expect('clearing the net restores the polygon', restoreTrackToSourceBoardShape(app, track));
    const restored = app.boardShapes[0];
    expect('restored polygon keeps id, kind, order and outline style', restored?.id === polygon.id
        && restored.kind === 'polygon' && restored.filled === false
        && JSON.stringify(restored.points) === JSON.stringify(polygon.points));
    expect('restored polygon keeps radius, bulge and width per index', restored.nodeCornerRadii[1] === 9.5
        && restored.segmentBulges[3] === 0.3 && restored.segmentWidths[0] === 0.5);
}

{
    // A rounded rectangle stays a 4-node loop with its (clamped) corner radius; a
    // rectangular track loop rounds with the same circular corners as the rectangle.
    const rect = { id: 'pshape_rect', kind: 'rect', layer: 'bottom-copper', lineWidth: 0.3, filled: false,
        copperMode: 'add', net: '', cornerRadius: 50,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 0, y: 4 }] };
    const app = appFor(null);
    app.boardShapes.push(rect);
    const track = convertBoardLineToTrack(app, rect, 'N');
    expect('a rounded rectangle converts to a 4-node loop keeping its corner radius',
        track?.nodes.size === 4 && track.edges.size === 4 && track.cornerRadius === 2
        && isTrackRectangleLoop(track));
    const corner = resolveTrackEdgePaths(track).get('e0');
    expect('corners are quarter circles of the clamped radius', !!corner && corner.every(point =>
        point.x > 2 + 1e-9 || Math.abs(Math.hypot(point.x - 2, point.y - 2) - 2) < 1e-6)
        && corner.some(point => Math.abs(point.x - 2) < 1e-9 && Math.abs(point.y) < 1e-9));
    const quadraticTrack = new Track({ width: 0.3, layer: 'bottom-copper', cornerRadius: 2,
        graphNodes: { n0: { x: 0, y: 0 }, n1: { x: 10, y: 0 }, n2: { x: 10, y: 4 } },
        graphEdges: { e0: { from: 'n0', to: 'n1' }, e1: { from: 'n1', to: 'n2' } } });
    expect('open tracks keep quadratic corners', !isTrackRectangleLoop(quadraticTrack));
    restoreTrackToSourceBoardShape(app, track);
    const restored = app.boardShapes[0];
    expect('clearing the net restores the rounded rectangle', restored?.kind === 'rect'
        && restored.points.length === 4 && restored.cornerRadius === 2 && restored.id === rect.id
        && restored.layer === 'bottom-copper');
}

{
    const rect = { id: 'pshape_sharp', kind: 'rect', layer: 'top-copper', lineWidth: 0.3, filled: false,
        copperMode: 'add', net: '', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 0, y: 4 }] };
    const app = appFor(null);
    app.boardShapes.push(rect);
    const track = convertBoardLineToTrack(app, rect, 'N');
    expect('a sharp rectangle converts to a 4-node loop', track?.nodes.size === 4 && track.edges.size === 4);
    restoreTrackToSourceBoardShape(app, track);
    expect('an axis-aligned loop restores as a rectangle', app.boardShapes[0]?.kind === 'rect'
        && app.boardShapes[0].id === rect.id);
}

{
    for (const [name, shape] of [
        ['filled polygon', { kind: 'polygon', filled: true, layer: 'top-copper' }],
        ['silk polygon', { kind: 'polygon', filled: false, layer: 'top-silk' }],
        ['copper-removal polygon', { kind: 'polygon', filled: false, layer: 'top-copper', copperMode: 'remove-copper' }],
    ]) {
        const source = { id: name, lineWidth: 0.2, copperMode: 'add', net: '', ...shape,
            points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 5 }] };
        const app = appFor(null);
        app.boardShapes.push(source);
        expect(`a ${name} keeps its net as a shape`, convertBoardLineToTrack(app, source, 'N') === null
            && app.boardShapes[0] === source && app.tracks.length === 0);
    }
}

{
    const track = new Track({ graphNodes: { n0: { x: 0, y: 0 }, n1: { x: 5, y: 0 }, n2: { x: 0, y: 5 } },
        graphEdges: { e0: { from: 'n0', to: 'n1' }, e1: { from: 'n1', to: 'n2' }, e2: { from: 'n2', to: 'n0' } } });
    track.padConnections.set('n0', { componentId: 'R1', pinNumber: '1' });
    expect('a pad-linked loop remains a Track', !canRestoreTrackToSourceBoardShape(track));
}

if (failures) process.exitCode = 1;