import { buildFillContext } from './fill-context.js';
import { computeFillPolygonsInOrder, loadClipper } from './copper-fill-geom.js';
import { serializePcbText } from '../../core/pcb-text.js';
import { boardDimensions } from '../../shared/pcb/board-outline.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('./copper-fill-geom.js').FillContext & {tracks: Array<any>, fills: Array<any>}} SerializedFillInputs */
/** @typedef {{edges: Map<string, {width: number, layer: string}>}} SerializedTrackGeometry */

/**
 * Capture only pour inputs, never editor projections, SVG or rounded file data.
 * @param {PcbEditor} app
 */
export function captureFillInputs(app) {
    const model = app.pcbDocument;
    const context = buildFillContext({
        tracks: model.tracks, vias: model.vias, pads: model.pads,
        texts: model.texts, boardShapes: model.boardShapes, copperFills: model.copperFills,
        placements: app.placements, netlist: app.netlist,
        getRoutingParams: () => model.designSettings?.getRoutingParams() || app.getRoutingParams?.() || {},
        board: model.board || boardDimensions(app),
    });
    return {
        tracks: context.tracks.map(track => track.captureCopperGeometry()),
        fills: context.fills.map(fill => fill.captureCopperGeometry()),
        vias: context.vias.map(({ id, x, y, diameter, drill, net }) => ({ id, x, y, diameter, drill, net })),
        texts: context.texts.map(serializePcbText),
        // The pour engine uses an image's frame, not its potentially large raster artwork.
        boardShapes: context.boardShapes.filter(shape => shape.type !== 'fill').map(({ artwork, ...shape }) => structuredClone(shape)),
        pads: structuredClone(context.pads), holes: structuredClone(context.holes),
        board: structuredClone(context.board), params: { ...context.params },
    };
}

/** @param {SerializedTrackGeometry} track */
function reviveTrackGeometry(track) {
    return {
        ...track,
        /** @param {string} id */
        getEdgeWidth: id => /** @type {{width: number}} */ (track.edges.get(id)).width,
        /** @param {string} id */
        getEdgeLayer: id => /** @type {{layer: string}} */ (track.edges.get(id)).layer,
    };
}

/** @param {SerializedFillInputs} inputs */
export async function computeFillBatch(inputs) {
    const clipper = await loadClipper();
    const context = { ...inputs, tracks: inputs.tracks.map(reviveTrackGeometry) };
    return computeFillPolygonsInOrder(inputs.fills, context, clipper);
}
