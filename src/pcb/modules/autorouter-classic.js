import { routeAll } from './autorouter.js';

/**
 * Classic A* + rip-up autorouter entrypoint.
 */
export async function routeWithClassicRouter(input, options = {}) {
    return routeAll(input, options);
}
