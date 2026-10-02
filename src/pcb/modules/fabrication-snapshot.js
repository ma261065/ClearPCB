import { capturePcbGeometry } from '../../core/pcb-geometry-snapshot.js';
import { captureResolvedPlacement } from '../../core/pcb-placement-geometry.js';
import { buildFillContext } from './fill-context.js';
import { computeFillPolygons, loadClipper } from './copper-fill-geom.js';
import { panelSettings } from './panelization.js';
import { blocksPcbExport } from './pcb-interactions.js';
import { hasActivePropertyEditor } from './property-editors.js';
import { areDragOverlaysDeferred, isFillRefreshSuspended } from './refresh-state.js';
import { boardDimensions } from '../../shared/pcb/board-outline.js';

export function hasFabricationContent(app) {
    const entities = app.pcbDocument || app;
    return !!(app.placements?.size || entities.tracks?.length || entities.vias?.length
        || entities.pads?.length || entities.texts?.size
        || entities.boardShapes?.some(shape => !String(shape.layer).endsWith('-document')) || entities.copperFills?.length);
}

export async function prepareFabricationSnapshot(app, { computeFills = true } = {}) {
    if (areDragOverlaysDeferred(app) || isFillRefreshSuspended(app) || blocksPcbExport(app)
        || hasActivePropertyEditor(app, ['pad', 'via', 'track', 'boardShape'])) {
        throw new Error('Finish the current edit before exporting.');
    }
    const model = app.pcbDocument;
    const params = model ? model.designSettings.getRoutingParams() : { ...app.getRoutingParams?.() };
    const board = model ? { ...model.board }
        : boardDimensions(app);
    const panelization = model ? model.serializePanelization()
        : app.panelization ? panelSettings(app.panelization) : null;
    const placements = new Map([...app.placements].map(([id, placement]) => [id, captureResolvedPlacement(placement)]));
    const geometry = model ? model.captureGeometry() : capturePcbGeometry(app);
    const tracks = geometry.tracks.map(track => ({ ...track,
        getEdgeWidth: id => track.edges.get(id).width, getEdgeLayer: id => track.edges.get(id).layer }));
    const fills = geometry.fills.map(fill => ({ ...fill, _computed: null }));
    const snapshot = {
        params, netlist: structuredClone(app.netlist || []),
        panelization,
        placements, ...geometry, tracks, fills,
        boardX: app._boardX || 0, boardY: app._boardY || 0,
        boardWidth: board.width, boardHeight: board.height, boardRadius: board.radius,
    };
    if (computeFills) await prepareSnapshotFills(snapshot);
    return snapshot;
}

export async function prepareSnapshotFills(snapshot, onProgress = (done, total) => {}) {
    const { fills, params } = snapshot;
    if (!fills.length) return;
    const context = buildFillContext({ ...snapshot, texts: new Map(snapshot.texts.map(text => [text.id, text])),
        copperFills: fills, getRoutingParams: () => params,
        _boardWidth: snapshot.boardWidth, _boardHeight: snapshot.boardHeight, _boardRadius: snapshot.boardRadius });
    const clipper = await loadClipper();
    for (const [index, fill] of fills.entries()) {
        onProgress(index, fills.length);
        fill._computed = computeFillPolygons(fill, context, clipper);
    }
    onProgress(fills.length, fills.length);
}