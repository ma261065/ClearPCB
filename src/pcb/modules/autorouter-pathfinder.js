import { routeAllPathfinder } from './autorouter.js';

/**
 * Negotiated-congestion (Pathfinder) autorouter entrypoint.
 */
export async function routeWithPathfinderRouter(input, options = {}) {
    return routeAllPathfinder(input, options);
}
