import { resolveCopperPads } from './copper-model.js';
import { resolvePlacementDrills } from '../../shared/pcb/board-geometry.js';
import { boardBoundary, boardDimensions } from '../../shared/pcb/board-outline.js';
/** @typedef {import('./pcb-editor-api.js').PcbBoard} PcbBoard */
/** @typedef {ReturnType<import('../../core/PcbDesignSettings.js').PcbDesignSettings['getRoutingParams']>} RoutingParams */
/**
 * What a pour computation reads: the board's collections, its routing rules and its
 * outline. The editor is one; a worker snapshot (captureFillInputs) is another.
 * @typedef {PcbBoard & {getRoutingParams?: () => Partial<RoutingParams>, board?: {width?: number, height?: number, radius?: number}, pcbDocument?: object}} FillBoard
 */

/**
 * @param {FillBoard} board
 * @returns {import('./copper-fill-geom.js').FillContext}
 */
export function buildFillContext(board) {
    const params = /** @type {Partial<RoutingParams>} */ (board.getRoutingParams?.() || {});
    const dimensions = boardDimensions(board);
    return {
        tracks: board.tracks || [], vias: board.vias || [],
        texts: [...(board.texts || new Map()).values()], fills: [...(board.copperFills || [])],
        pads: resolveCopperPads(board), boardShapes: board.boardShapes || [],
        holes: resolvePlacementDrills(board.placements || new Map()).filter((hole) => !hole.plated),
        params: { clearance: Number.isFinite(params.clearance) ? /** @type {number} */ (params.clearance) : 0.1 },
        board: dimensions.width > 0 && dimensions.height > 0
            ? boardBoundary(board) : null,
    };
}