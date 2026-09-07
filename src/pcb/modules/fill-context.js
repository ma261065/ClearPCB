import { resolveCopperPads } from './copper-model.js';
import { resolvePlacementDrills } from './board-geometry.js';

/** @returns {import('./copper-fill-geom.js').FillContext} */
export function buildFillContext(app) {
    const params = app._getRoutingParams?.() || {};
    return {
        tracks: app.tracks, vias: app.vias,
        texts: [...app.texts.values()], fills: [...app.copperFills],
        pads: resolveCopperPads(app), boardShapes: app.boardShapes,
        holes: resolvePlacementDrills(app.placements).filter((hole) => !hole.plated),
        params: { clearance: Number.isFinite(params.clearance) ? params.clearance : 0.1 },
        board: app._boardWidth > 0 && app._boardHeight > 0
            ? { w: app._boardWidth, h: app._boardHeight, r: app._boardRadius || 0 } : null,
    };
}