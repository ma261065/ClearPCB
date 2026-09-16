import { serializeBoardShapes } from './board-shapes.js';
import { buildFillContext } from './fill-context.js';
import { computeFillPolygons, loadClipper } from './copper-fill-geom.js';

const placementFields = ['x', 'y', 'rotation', 'mirror', 'side', 'padOffsets', 'pasteOffsets', 'silks',
    'pads', 'name', 'reference', 'outline', 'refVisible', 'refDx', 'refDy', 'refRot', 'refSize', 'refStrokeWidth'];

export function hasFabricationContent(app) {
    return !!(app.placements?.size || app.tracks?.length || app.vias?.length || app.texts?.size
        || app.boardShapes?.some(shape => !String(shape.layer).endsWith('-document')) || app.copperFills?.length);
}

export async function prepareFabricationSnapshot(app) {
    if (app._deferDragOverlays || app._suspendFillRefresh || app._rotationHandleDrag || app._shapeDrag
        || app._vertexDrag || app._viaDrag) throw new Error('Finish the current edit before exporting.');
    const params = { ...app._getRoutingParams?.() };
    const placements = new Map([...app.placements].map(([id, placement]) => [id,
        structuredClone(Object.fromEntries(placementFields.map(key => [key, placement[key]]))),
    ]));
    const tracks = app.tracks.map(track => {
        const nodes = new Map([...track.nodes].map(([id, point]) => [id, { x: point.x, y: point.y }]));
        const edges = new Map([...track.edges].map(([id, edge]) => [id, { ...edge,
            width: track.getEdgeWidth(id), layer: track.getEdgeLayer(id),
        }]));
        return { id: track.id, net: track.net, width: track.width, layer: track.layer, nodes, edges,
            getEdgeWidth: id => edges.get(id).width, getEdgeLayer: id => edges.get(id).layer };
    });
    const fills = app.copperFills.map(fill => ({ id: fill.id, type: 'fill', layer: fill.layer, net: fill.net,
        outline: structuredClone(fill.outline), _computed: null }));
    const snapshot = {
        placements, tracks, vias: app.vias.map(via => ({ id: via.id, x: via.x, y: via.y,
            diameter: via.diameter, drill: via.drill, net: via.net })),
        texts: structuredClone([...app.texts.values()]), fills,
        boardShapes: serializeBoardShapes({ boardShapes: app.boardShapes.filter(shape => shape.type !== 'fill') }, { compactArtwork: false }),
        boardX: app._boardX || 0, boardY: app._boardY || 0,
        boardWidth: app._boardWidth, boardHeight: app._boardHeight, boardRadius: app._boardRadius,
    };
    const context = buildFillContext({ ...snapshot, texts: new Map(snapshot.texts.map(text => [text.id, text])),
        copperFills: fills, netlist: structuredClone(app.netlist || []), _getRoutingParams: () => params,
        _boardWidth: snapshot.boardWidth, _boardHeight: snapshot.boardHeight, _boardRadius: snapshot.boardRadius });
    if (fills.length) {
        const clipper = await loadClipper();
        for (const fill of fills) fill._computed = computeFillPolygons(fill, context, clipper);
    }
    return snapshot;
}