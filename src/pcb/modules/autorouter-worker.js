import { routeAll } from './autorouter.js';

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
        const result = await routeAll(msg.routeInput, {
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
            onNetRipped: (netName) => {
                self.postMessage({ type: 'netRipped', netName });
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
