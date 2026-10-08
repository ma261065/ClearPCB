import { routeWithMazeRouter } from './autorouter-maze.js';
import { routeWithPathfinderRouter } from './autorouter-pathfinder.js';

/** @typedef {import('./autorouter-common.js').CancelToken} CancelToken */
/** @typedef {{x:number,y:number,[key:string]:unknown}} Point */

/** @type {CancelToken|null} */
let activeCancelToken = null;
let running = false;

self.addEventListener('message', async (event) => {
    const msg = event.data || {};

    if (msg.type === 'cancel') {
        if (activeCancelToken) activeCancelToken.cancelled = true;
        return;
    }

    if (msg.type !== 'start' || running) return;

    running = true;
    activeCancelToken = { cancelled: false };

    try {
        const routerMode = msg.routerMode === 'pathfinder' ? 'pathfinder' : 'maze';
        const router = routerMode === 'pathfinder' ? routeWithPathfinderRouter : routeWithMazeRouter;
        const result = await router(msg.routeInput, {
            cancelToken: activeCancelToken,
            /** @param {number} done @param {number} total @param {string} net @param {Record<string, unknown>} [meta] */
            onProgress: (done, total, net, meta = {}) => {
                self.postMessage({ type: 'progress', done, total, net, meta });
            },
            /** @param {unknown[]} netTracks */
            onNetRouted: (netTracks) => {
                self.postMessage({ type: 'netRouted', netTracks });
            },
            /** @param {unknown} conn */
            onNetFailed: (conn) => {
                self.postMessage({ type: 'netFailed', conn });
            },
            /** @param {string} connId */
            onConnRipped: (connId) => {
                self.postMessage({ type: 'connRipped', connId });
            },
            /** @param {string} netName @param {number} pendingConnections */
            onNetPendingChanged: (netName, pendingConnections) => {
                self.postMessage({ type: 'netPendingChanged', netName, pendingConnections });
            },
            /** @param {Point} from @param {Point} to */
            onTrying: (from, to) => {
                self.postMessage({ type: 'trying', from, to });
            },
        });

        self.postMessage({
            type: 'done',
            cancelled: !!activeCancelToken.cancelled,
            result,
        });
    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        self.postMessage({ type: 'error', error: message });
    } finally {
        running = false;
        activeCancelToken = null;
    }
});
