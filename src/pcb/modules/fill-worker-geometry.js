import { buildFillContext } from './fill-context.js';
import { computeFillPolygonsInOrder, loadClipper } from './copper-fill-geom.js';
import { serializePcbText } from '../../core/pcb-text.js';
import { boardDimensions } from '../../shared/pcb/board-outline.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */

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

export async function computeFillBatch(inputs) {
    const clipper = await loadClipper();
    const context = { ...inputs, tracks: inputs.tracks.map(track => ({
        ...track, getEdgeWidth: id => track.edges.get(id).width, getEdgeLayer: id => track.edges.get(id).layer,
    })) };
    return computeFillPolygonsInOrder(inputs.fills, context, clipper);
}
