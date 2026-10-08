/**
 * Copper paths are Tracks: Lines and unfilled Polygons/Rectangles in additive
 * copper enter the Track model with or without a net, keeping their geometry;
 * Fill turns a closed loop back into a filled board shape.
 */
import { PcbDocument } from '../../src/core/PcbDocument.js';
import { getShapeDraw } from '../../src/pcb/modules/board-shapes.js';
import { setPcbInteraction } from '../../src/pcb/modules/pcb-interactions.js';
import { installFakeDom } from './helpers/fake-dom.mjs';

installFakeDom();

const { Track } = await import('../../src/shapes/track.js');
const { isTrackRectangleLoop, resolveTrackEdgePaths } = await import('../../src/shapes/track-geometry.js');
const { isCopperPathShape, trackFromBoardShape } = await import('../../src/shared/pcb/copper-path-tracks.js');
const {
    addBoardShapeOrTrackCommand,
    canFillTrackLoop,
    finishLineDraw,
    finishShapeDraw,
    shapeDrawClick,
    copperPathReplacementCommands,
    fillTrackLoop,
    canMoveTrackToBoardLayer,
    moveTrackToBoardLayer,
    setTrackCopperMode,
} = await import('../../src/pcb/modules/board-shapes.js');
const { setShapeDefaults } = await import('../../src/pcb/modules/board-shape-state.js');

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
    return {
        pcbDocument,
        tracks: pcbDocument.tracks,
        boardShapes: pcbDocument.boardShapes,
        shapeIdCounter: 1,
        _shapeElements: new Map(),
        getLayerGroup() { return null; },
        history: { execute(command) { command.execute(); } },
    };
}

const triangle = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 5 }];

{
    const base = { lineWidth: 0.2, copperMode: 'add', net: '', layer: 'top-copper', filled: false };
    for (const [name, shape, expected] of [
        ['a netless copper line', { ...base, kind: 'line', points: triangle.slice(0, 2) }, true],
        ['a netted bottom-copper line', { ...base, kind: 'line', layer: 'bottom-copper', net: 'N', points: triangle.slice(0, 2) }, true],
        ['an unfilled polygon', { ...base, kind: 'polygon', points: triangle }, true],
        ['an unfilled rectangle', { ...base, kind: 'rect', points: [...triangle, { x: 5, y: 5 }] }, true],
        ['a filled polygon', { ...base, kind: 'polygon', filled: true, points: triangle }, false],
        ['a silk line', { ...base, kind: 'line', layer: 'top-silk', points: triangle.slice(0, 2) }, false],
        ['a copper-removal polygon', { ...base, kind: 'polygon', copperMode: 'remove-copper', points: triangle }, false],
        ['a circle', { ...base, kind: 'circle', x: 0, y: 0, radius: 2 }, false],
        ['a copper pour', { ...base, kind: 'polygon', type: 'fill', points: triangle }, false],
        ['a one-point line', { ...base, kind: 'line', points: [{ x: 0, y: 0 }] }, false],
    ]) expect(`${name} ${expected ? 'is' : 'is not'} a copper path`, isCopperPathShape(shape) === expected);
}

{
    const line = { id: 'geometry', kind: 'line', layer: 'top-copper', lineWidth: 0.3, copperMode: 'add', net: '',
        points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }],
        segmentWidths: { 1: 0.6 }, segmentBulges: { 0: -0.4 }, cornerRadius: 2, nodeCornerRadii: { 1: 0.7 } };
    const track = trackFromBoardShape(line);
    expect('a netless line becomes a netless track', track.net === '' && track.layer === 'top-copper' && track.width === 0.3);
    expect('widths and bulges carry over', track.getEdgeWidth('e1') === 0.6 && track.edges.get('e0').bulge === -0.4);
    expect('both radius levels carry over', track.cornerRadius === 2 && track.nodeCornerRadius('n1') === 0.7);
    expect('only the source shape identity is kept', JSON.stringify(track.sourceBoardShape) === '{"id":"geometry"}');
    const plated = trackFromBoardShape({ ...line, layer: 'hole', plated: true, net: 'N' });
    expect('a plated source keeps its plating', JSON.stringify(plated.sourceBoardShape) === '{"id":"geometry","plated":true}');
    const legacy = new Track({ points: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
        sourceBoardShape: { ...line, net: 'OLD', layer: 'hole', plated: true } });
    expect('a full shape copy from an older file is trimmed to id and plating',
        JSON.stringify(legacy.sourceBoardShape) === '{"id":"geometry","plated":true}'
        && JSON.stringify(legacy.toJSON().sbs) === '{"id":"geometry","plated":true}'
        && JSON.stringify(legacy.captureState().sourceBoardShape) === '{"id":"geometry","plated":true}');
    expect('an explicit net is used', trackFromBoardShape(line, ' VCC ').net === 'VCC');
}

{
    const polygon = { id: 'pshape_loop', kind: 'polygon', layer: 'top-copper', lineWidth: 0.2, filled: false,
        copperMode: 'add', net: '', points: [{ x: 0, y: 0 }, { x: 17, y: 29 }, { x: 28, y: 20 }, { x: 22, y: -2 }],
        nodeCornerRadii: { 1: 9.5 }, segmentBulges: { 3: 0.3 }, segmentWidths: { 0: 0.5 } };
    const track = trackFromBoardShape(polygon);
    expect('an unfilled polygon becomes one closed loop', track.nodes.size === 4 && track.edges.size === 4
        && track.edges.get('e3').from === 'n3' && track.edges.get('e3').to === 'n0');
    expect('closing-edge bulge, segment width and node radius carry over', track.edges.get('e3').bulge === 0.3
        && track.getEdgeWidth('e0') === 0.5 && track.nodeCornerRadius('n1') === 9.5);
}

{
    // A rounded rectangle stays a 4-node loop with its (clamped) corner radius; a
    // rectangular track loop rounds with the same circular corners as the rectangle.
    const rect = { id: 'pshape_rect', kind: 'rect', layer: 'bottom-copper', lineWidth: 0.3, filled: false,
        copperMode: 'add', net: '', cornerRadius: 50,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 0, y: 4 }] };
    const track = trackFromBoardShape(rect);
    expect('a rounded rectangle becomes a 4-node loop keeping its corner radius',
        track.nodes.size === 4 && track.edges.size === 4 && track.cornerRadius === 2 && isTrackRectangleLoop(track));
    const corner = resolveTrackEdgePaths(track).get('e0');
    expect('corners are quarter circles of the clamped radius', !!corner && corner.every(point =>
        point.x > 2 + 1e-9 || Math.abs(Math.hypot(point.x - 2, point.y - 2) - 2) < 1e-6)
        && corner.some(point => Math.abs(point.x - 2) < 1e-9 && Math.abs(point.y) < 1e-9));
    const open = new Track({ width: 0.3, layer: 'bottom-copper', cornerRadius: 2,
        graphNodes: { n0: { x: 0, y: 0 }, n1: { x: 10, y: 0 }, n2: { x: 10, y: 4 } },
        graphEdges: { e0: { from: 'n0', to: 'n1' }, e1: { from: 'n1', to: 'n2' } } });
    expect('open tracks keep quadratic corners', !isTrackRectangleLoop(open));
}

{
    const app = appFor(null);
    const silk = { id: 'silk', kind: 'line', layer: 'top-silk', lineWidth: 0.2, copperMode: 'add', net: '', points: triangle.slice(0, 2) };
    const copper = { ...silk, id: 'copper', layer: 'top-copper' };
    const asShape = addBoardShapeOrTrackCommand(app, silk);
    const asTrack = addBoardShapeOrTrackCommand(app, copper);
    asShape.command.execute();
    asTrack.command.execute();
    expect('adding a silk line adds a board shape', !asShape.track && app.boardShapes.includes(silk));
    expect('adding a copper line adds a track instead', asTrack.track && app.tracks.includes(asTrack.track)
        && !app.boardShapes.includes(copper));
}

{
    const filled = { id: 'pshape_filled', kind: 'polygon', layer: 'top-copper', lineWidth: 0.2, filled: true,
        copperMode: 'add', net: 'GND', points: triangle };
    const app = appFor(null);
    app.boardShapes.push(filled);
    expect('an edit that keeps the shape filled needs no replacement',
        copperPathReplacementCommands(app, filled, { ...filled, net: 'VCC' }) === null);
    const replacement = copperPathReplacementCommands(app, filled, { ...filled, filled: false });
    for (const command of replacement?.commands || []) command.execute();
    expect('unfilling a copper polygon replaces it with a closed track that keeps its net',
        app.boardShapes.length === 0 && app.tracks[0] === replacement?.track
        && replacement.track.net === 'GND' && replacement.track.edges.size === 3);
}

{
    // Fill turns a closed loop into a filled board shape that keeps its net and corners.
    const loop = new Track({ net: 'GND', width: 0.4, layer: 'top-copper', cornerRadius: 1,
        graphNodes: { n0: { x: 0, y: 0 }, n1: { x: 8, y: 0 }, n2: { x: 8, y: 5 }, n3: { x: 0, y: 5 } },
        graphEdges: { e0: { from: 'n0', to: 'n1' }, e1: { from: 'n1', to: 'n2' },
            e2: { from: 'n2', to: 'n3' }, e3: { from: 'n3', to: 'n0' } } });
    const app = appFor(loop);
    expect('a closed loop can be filled', canFillTrackLoop(loop));
    expect('filling a loop replaces the track', fillTrackLoop(app, loop) && app.tracks.length === 0);
    const shape = app.boardShapes[0];
    expect('the filled shape is a rectangle that keeps net, width and radius', shape?.filled === true
        && shape.kind === 'rect' && shape.net === 'GND' && shape.lineWidth === 0.4 && shape.cornerRadius === 1
        && shape.copperMode === 'add' && shape.layer === 'top-copper');
}

{
    const polygon = { id: 'pshape_source', kind: 'polygon', layer: 'top-copper', lineWidth: 0.2, filled: false,
        copperMode: 'add', net: '', points: [{ x: 0, y: 0 }, { x: 17, y: 29 }, { x: 28, y: 20 }, { x: 22, y: -2 }],
        nodeCornerRadii: { 1: 9.5 }, segmentBulges: { 3: 0.3 }, segmentWidths: { 0: 0.5 } };
    const track = trackFromBoardShape(polygon, 'N');
    const app = appFor(track);
    fillTrackLoop(app, track);
    const shape = app.boardShapes[0];
    expect('a filled polygon keeps its source id, point order and per-index metadata', shape?.id === polygon.id
        && shape.kind === 'polygon' && shape.filled && shape.net === 'N'
        && JSON.stringify(shape.points) === JSON.stringify(polygon.points)
        && shape.nodeCornerRadii[1] === 9.5 && shape.segmentBulges[3] === 0.3 && shape.segmentWidths[0] === 0.5);
}

{
    const reversed = new Track({ graphNodes: { n0: { x: 0, y: 0 }, n1: { x: 8, y: 0 }, n2: { x: 4, y: 6 } },
        graphEdges: { e0: { from: 'n1', to: 'n0' }, e1: { from: 'n1', to: 'n2' }, e2: { from: 'n2', to: 'n0' } },
        edgeBulges: { e0: 0.4 } });
    const app = appFor(reversed);
    fillTrackLoop(app, reversed);
    expect('reading a loop against an edge direction reverses its bulge sign', app.boardShapes[0]?.segmentBulges[0] === -0.4);
}

{
    const open = new Track({ points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 5 }] });
    const branched = new Track({
        graphNodes: { n0: { x: 0, y: 0 }, n1: { x: 5, y: 0 }, n2: { x: 10, y: 0 }, n3: { x: 5, y: 5 } },
        graphEdges: { e0: { from: 'n0', to: 'n1' }, e1: { from: 'n1', to: 'n2' }, e2: { from: 'n1', to: 'n3' } },
    });
    const padLinked = new Track({ graphNodes: { n0: { x: 0, y: 0 }, n1: { x: 5, y: 0 }, n2: { x: 0, y: 5 } },
        graphEdges: { e0: { from: 'n0', to: 'n1' }, e1: { from: 'n1', to: 'n2' }, e2: { from: 'n2', to: 'n0' } } });
    padLinked.padConnections.set('n0', { componentId: 'R1', pinNumber: '1' });
    for (const [name, track] of [['an open', open], ['a branched', branched], ['a pad-linked', padLinked]]) {
        expect(`${name} track cannot be filled`, !canFillTrackLoop(track) && !fillTrackLoop(appFor(track), track));
    }
}

{
    // Moving a track off copper turns it back into a plain board shape on that layer.
    const hole = { id: 'pshape_hole', kind: 'rect', layer: 'hole', lineWidth: 0.3, filled: false, plated: true,
        copperMode: 'add', net: '', points: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 3 }, { x: 0, y: 3 }] };
    const track = trackFromBoardShape({ ...hole, layer: 'top-copper' }, 'GND');
    const app = appFor(track);
    expect('a copper layer is not a board-shape move', !moveTrackToBoardLayer(app, track, 'bottom-copper') && app.tracks.length === 1);
    expect('a track can move back to the hole layer', canMoveTrackToBoardLayer(track)
        && moveTrackToBoardLayer(app, track, 'hole') && app.tracks.length === 0);
    const shape = app.boardShapes[0];
    expect('the hole comes back as the same unfilled, plated, netless rectangle', shape?.id === hole.id
        && shape.kind === 'rect' && shape.layer === 'hole' && shape.plated === true && shape.filled === false
        && shape.net === '' && shape.copperMode === 'add' && JSON.stringify(shape.points) === JSON.stringify(hole.points));

    const line = new Track({ net: 'N', width: 0.2, layer: 'bottom-copper', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }] });
    line.padConnections.set('n0', { componentId: 'R1', pinNumber: '1' });
    const lineApp = appFor(line);
    expect('a pad-linked line can move to silk', moveTrackToBoardLayer(lineApp, line, 'top-silk'));
    const silk = lineApp.boardShapes[0];
    expect('it becomes an unplated silk line with its points', silk?.kind === 'line' && silk.layer === 'top-silk'
        && silk.plated === false && silk.net === '' && silk.points.length === 3 && silk.lineWidth === 0.2);

    const slot = new Track({ width: 0.2, layer: 'top-copper', points: [{ x: 0, y: 0 }, { x: 4, y: 0 }] });
    const slotApp = appFor(slot);
    moveTrackToBoardLayer(slotApp, slot, 'hole');
    expect('a hole line gets the minimum slot width and stays unplated without a plated source',
        slotApp.boardShapes[0]?.lineWidth === 0.8 && slotApp.boardShapes[0].plated === false);

    const branched = new Track({
        graphNodes: { n0: { x: 0, y: 0 }, n1: { x: 5, y: 0 }, n2: { x: 10, y: 0 }, n3: { x: 5, y: 5 } },
        graphEdges: { e0: { from: 'n0', to: 'n1' }, e1: { from: 'n1', to: 'n2' }, e2: { from: 'n1', to: 'n3' } },
    });
    const mixed = new Track({ points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }] });
    mixed.setEdgeAttr([...mixed.edges.keys()][1], 'layer', 'bottom-copper');
    for (const [name, candidate] of [['a branched', branched], ['a two-layer', mixed]]) {
        const candidateApp = appFor(candidate);
        expect(`${name} track cannot move off copper`, !canMoveTrackToBoardLayer(candidate)
            && !moveTrackToBoardLayer(candidateApp, candidate, 'top-silk') && candidateApp.tracks.length === 1);
    }

    // Split or pasted tracks share one source shape; each must come back with its own id.
    const source = { id: 'pshape_92', kind: 'line', layer: 'top-copper', lineWidth: 0.2, copperMode: 'add', net: '',
        points: [{ x: 0, y: 0 }, { x: 4, y: 0 }] };
    const first = trackFromBoardShape(source), second = trackFromBoardShape({ ...source, points: [{ x: 0, y: 2 }, { x: 4, y: 2 }] });
    const sharedApp = appFor(first);
    sharedApp.tracks.push(second);
    sharedApp.shapeIdCounter = 93;
    moveTrackToBoardLayer(sharedApp, first, 'top-silk');
    moveTrackToBoardLayer(sharedApp, second, 'top-silk');
    const ids = sharedApp.boardShapes.map(shape => shape.id);
    expect('tracks sharing a source shape get distinct ids', ids[0] === 'pshape_92' && ids[1] === 'pshape_93'
        && new Set(ids).size === 2);

    // Removal modes add no copper: the track becomes an unfilled, netless shape on its own layer.
    for (const mode of ['remove-copper', 'remove-solder-mask', 'remove-copper-mask']) {
        const cut = new Track({ net: 'GND', width: 0.3, layer: 'bottom-copper',
            points: [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 3 }] });
        cut.padConnections.set('n0', { componentId: 'R1', pinNumber: '1' });
        const cutApp = appFor(cut);
        expect(`a track can use ${mode}`, setTrackCopperMode(cutApp, cut, mode) && cutApp.tracks.length === 0);
        const shape = cutApp.boardShapes[0];
        expect(`${mode} keeps the layer, width and path without a net`, shape?.copperMode === mode
            && shape.layer === 'bottom-copper' && shape.kind === 'line' && shape.filled === false
            && shape.lineWidth === 0.3 && shape.net === '' && shape.points.length === 3);
        expect(`${mode} is not a copper path, so it stays a shape`, !isCopperPathShape(shape));
        expect(`switching ${mode} back to add copper makes a track again`,
            isCopperPathShape({ ...shape, copperMode: 'add' }));
    }
    const kept = new Track({ points: [{ x: 0, y: 0 }, { x: 4, y: 0 }] });
    const keptApp = appFor(kept);
    expect('add copper leaves a track alone', !setTrackCopperMode(keptApp, kept, 'add') && keptApp.tracks.length === 1);
    const forked = new Track({
        graphNodes: { n0: { x: 0, y: 0 }, n1: { x: 5, y: 0 }, n2: { x: 10, y: 0 }, n3: { x: 5, y: 5 } },
        graphEdges: { e0: { from: 'n0', to: 'n1' }, e1: { from: 'n1', to: 'n2' }, e2: { from: 'n1', to: 'n3' } },
    });
    const forkedApp = appFor(forked);
    expect('a branched track cannot use a removal mode', !setTrackCopperMode(forkedApp, forked, 'remove-copper')
        && forkedApp.tracks.length === 1);
}

{
    // Drawing: a copper Line/Rectangle/Polygon is a Track from the start, with or without a net.
    for (const [name, kind, layer, filled, track] of [
        ['a netless copper line', 'line', 'top-copper', false, true],
        ['an unfilled copper rectangle', 'rect', 'bottom-copper', false, true],
        ['a filled copper rectangle', 'rect', 'top-copper', true, false],
        ['a silk line', 'line', 'top-silk', false, false],
    ]) {
        const app = appFor(null);
        Object.assign(app, { activeLayer: layer, viewport: { scale: 10, setCrosshair() {}, hideCrosshair() {} } });
        setShapeDefaults(app, { lineWidth: 0.25, filled, copperMode: 'add', net: '' });
        setPcbInteraction(app, '_shapeDraw', { kind, layer, points: kind === 'line'
            ? [{ x: 0, y: 0 }, { x: 10, y: 0 }] : [{ x: 0, y: 0 }, { x: 10, y: -6 }] });
        finishShapeDraw(app);
        expect(`drawing ${name} creates ${track ? 'a track' : 'a board shape'}`, track
            ? app.tracks.length === 1 && app.boardShapes.length === 0 && app.tracks[0].net === ''
                && app.tracks[0].layer === layer
            : app.tracks.length === 0 && app.boardShapes.length === 1);
    }
}

{
    // Files saved by earlier versions keep copper paths as board shapes; they load as Tracks.
    const data = new PcbDocument().serialize();
    data.boardShapes = [...(data.boardShapes || []),
        { id: 'legacy-line', kind: 'line', layer: 'top-copper', lineWidth: 0.3, filled: false, copperMode: 'add',
            plated: false, net: '', points: [{ x: 1, y: 1 }, { x: 9, y: 1 }] },
        { id: 'legacy-silk', kind: 'line', layer: 'top-silk', lineWidth: 0.3, filled: false, copperMode: 'add',
            plated: false, net: '', points: [{ x: 1, y: 2 }, { x: 9, y: 2 }] },
        { id: 'legacy-area', kind: 'polygon', layer: 'top-copper', lineWidth: 0.3, filled: true, copperMode: 'add',
            plated: false, net: 'GND', points: triangle }];
    const document = new PcbDocument();
    const prepared = PcbDocument.prepare(data);
    document.load(prepared.data, prepared);
    const migrated = document.tracks.find(track => track.sourceBoardShape?.id === 'legacy-line');
    expect('a saved copper line loads as a netless track', !!migrated && migrated.net === '' && migrated.width === 0.3
        && !document.boardShapes.some(shape => shape.id === 'legacy-line'));
    expect('saved silk lines and copper areas stay board shapes', ['legacy-silk', 'legacy-area']
        .every(id => document.boardShapes.some(shape => shape.id === id)));
    const resaved = document.serialize();
    expect('the migrated file saves the copper line as a track', !(resaved.boardShapes || []).some(shape => shape.id === 'legacy-line')
        && (resaved.tracks || []).length === 1);
}

{
    // Finishing a Line with a double-click: its second click repeats the last vertex
    // and must not add another, off-grid one.
    const app = appFor(null);
    Object.assign(app, { activeLayer: 'top-copper', currentTool: 'line',
        viewport: { scale: 10, gridSize: 1.27, snapToGrid: true, setCrosshair() {}, hideCrosshair() {} },
        snapToGrid(point) { return { x: Math.round(point.x / 1.27) * 1.27, y: Math.round(point.y / 1.27) * 1.27 }; },
        getLayerGroup() { return null; } });
    setShapeDefaults(app, { lineWidth: 0.25, filled: false, copperMode: 'add', net: '' });
    const vertices = [{ x: 50.8, y: -10.16 }, { x: 66.04, y: -10.16 }, { x: 66.04, y: -20.32 }];
    for (const point of vertices) shapeDrawClick(app, 'line', point);
    shapeDrawClick(app, 'line', { x: 66.04 + 0.05, y: -20.32 + 0.1 });
    expect('the second click of a double-click adds no vertex', getShapeDraw(app).points.length === 3);
    finishLineDraw(app);
    const track = app.tracks[0];
    expect('the finished line has exactly the clicked vertices', track?.nodes.size === 3
        && [...track.nodes.values()].every((point, index) =>
            Math.hypot(point.x - vertices[index].x, point.y - vertices[index].y) < 1e-6));
}

if (failures) process.exitCode = 1;
