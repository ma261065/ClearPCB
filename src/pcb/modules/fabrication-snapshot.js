import { capturePcbGeometry } from '../../core/pcb-geometry-snapshot.js';
import { captureResolvedPlacement } from '../../core/pcb-placement-geometry.js';
import { buildFillContext } from './fill-context.js';
import { computeFillPolygonsInOrder, loadClipper } from './copper-fill-geom.js';
import { panelSettings } from './panelization.js';
import { blocksPcbExport } from './pcb-interactions.js';
import { hasActivePropertyEditor } from './property-editors.js';
import { areDragOverlaysDeferred, isFillRefreshSuspended } from './refresh-state.js';
import { boardDimensions } from '../../shared/pcb/board-outline.js';
import { flushSettledChanges } from '../../shared/ui/settled-input.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {{id: string}} SnapshotText */
/** @typedef {import('../../shapes/copper-fill.js').CopperFill & {_computed: unknown}} SnapshotFill */
/** @typedef {{texts: SnapshotText[], fills: SnapshotFill[], params: object, boardWidth: number, boardHeight: number, boardRadius: number}} FabricationSnapshot */

/** @param {PcbEditor} app */
export function hasFabricationContent(app) {
    const entities = app.pcbDocument;
    return !!(app.placements?.size || entities.tracks?.length || entities.vias?.length
        || entities.pads?.length || entities.texts?.size
        || entities.boardShapes?.some(shape => !String(shape.layer).endsWith('-document')) || entities.copperFills?.length);
}

/** @param {PcbEditor} app */
export async function prepareFabricationSnapshot(app, { computeFills = true } = {}) {
    flushSettledChanges();
    if (areDragOverlaysDeferred(app) || isFillRefreshSuspended(app) || blocksPcbExport(app)
        || hasActivePropertyEditor(app, ['pad', 'via', 'track', 'boardShape'])) {
        throw new Error('Finish the current edit before exporting.');
    }
    const model = app.pcbDocument;
    const params = model ? model.designSettings.getRoutingParams() : { ...app.getRoutingParams() };
    const board = model ? { ...model.board }
        : boardDimensions(app);
    const panelization = model ? model.serializePanelization()
        : app.panelization ? panelSettings(app.panelization) : null;
    const placements = new Map([...app.placements].map(([id, placement]) => [id, captureResolvedPlacement(placement)]));
    const geometry = model ? model.captureGeometry() : capturePcbGeometry(app);
    const tracks = geometry.tracks.map(track => ({ ...track,
        getEdgeWidth: /** @param {string} id */ id => track.edges.get(id).width,
        getEdgeLayer: /** @param {string} id */ id => track.edges.get(id).layer }));
    const fills = geometry.fills.map(fill => ({ ...fill, _computed: null }));
    const snapshot = {
        params, netlist: structuredClone(app.netlist || []),
        panelization,
        placements, ...geometry, tracks, fills,
        boardX: 0, boardY: 0,
        boardWidth: board.width, boardHeight: board.height, boardRadius: board.radius,
    };
    if (computeFills) await prepareSnapshotFills(snapshot);
    return snapshot;
}

/**
 * @param {FabricationSnapshot} snapshot
 * @param {(done: number, total: number) => void} [onProgress]
 */
export async function prepareSnapshotFills(snapshot, onProgress = (done, total) => {}) {
    const { fills, params } = snapshot;
    if (!fills.length) return;
    const context = buildFillContext({ ...snapshot, texts: new Map(snapshot.texts.map(text => [text.id, text])),
        copperFills: fills, getRoutingParams: () => params,
        board: { width: snapshot.boardWidth, height: snapshot.boardHeight, radius: snapshot.boardRadius } });
    const clipper = await loadClipper();
    const results = computeFillPolygonsInOrder(fills, context, clipper, onProgress);
    fills.forEach((fill, index) => { fill._computed = results[index]; });
    onProgress(fills.length, fills.length);
}