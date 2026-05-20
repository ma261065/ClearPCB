import { routeWithClassicRouter } from './autorouter-classic.js';
import { routeWithPathfinderRouter } from './autorouter-pathfinder.js';

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
        const routerMode = msg.routerMode === 'pathfinder' ? 'pathfinder' : 'classic';
        const router = routerMode === 'pathfinder' ? routeWithPathfinderRouter : routeWithClassicRouter;
        const result = await router(msg.routeInput, {
            cancelToken: activeCancelToken,
            onProgress: (done, total, net, meta = {}) => {
                self.postMessage({ type: 'progress', done, total, net, meta });
            },
            onNetRouted: (netTraces) => {
                self.postMessage({ type: 'netRouted', netTraces });
            },
            onNetFailed: (conn) => {
                self.postMessage({ type: 'netFailed', conn });
            },
            onConnRipped: (connId) => {
                self.postMessage({ type: 'connRipped', connId });
            },
            onNetPendingChanged: (netName, pendingConnections) => {
                self.postMessage({ type: 'netPendingChanged', netName, pendingConnections });
            },
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
