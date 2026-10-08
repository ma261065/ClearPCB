import { resolveCopperPads } from './copper-model.js';
import { resolvePlacementDrills } from '../../shared/pcb/board-geometry.js';
import { boardBoundary, boardDimensions } from '../../shared/pcb/board-outline.js';
/** @typedef {import('./pcb-editor-api.js').PcbBoard} PcbBoard */
/** @typedef {ReturnType<import('../../core/PcbDesignSettings.js').PcbDesignSettings['getRoutingParams']>} RoutingParams */
/**
 * What a pour computation reads: the board's collections, its routing rules and its
 * outline. The editor is one; a worker snapshot (captureFillInputs) is another.
 * @typedef {PcbBoard & {getRoutingParams?: () => Partial<RoutingParams>, board?: object, pcbDocument?: object}} FillBoard
 */

/**
 * @param {FillBoard} app
 * @returns {import('./copper-fill-geom.js').FillContext}
 */
export function buildFillContext(app) {
    const params = /** @type {Partial<RoutingParams>} */ (app.getRoutingParams?.() || {});
    const dimensions = boardDimensions(app);
    return {
        tracks: app.tracks, vias: app.vias,
        texts: [...app.texts.values()], fills: [...app.copperFills],
        pads: resolveCopperPads(app), boardShapes: app.boardShapes,
        holes: resolvePlacementDrills(app.placements).filter((hole) => !hole.plated),
        params: { clearance: Number.isFinite(params.clearance) ? params.clearance : 0.1 },
        board: dimensions.width > 0 && dimensions.height > 0
            ? boardBoundary(app) : null,
    };
}