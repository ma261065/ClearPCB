import { routeWithMazeRouter } from './autorouter-maze.js';
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

    // ── PERF DIAG ──
    const t0 = performance.now();
    self.__yieldStats = { count: 0, totalMs: 0 };
    console.log('[autorouter-worker] start ' + JSON.stringify({
        origin: self.location.origin,
        href: self.location.href,
    }));
    // ── /PERF DIAG ──

    try {
        const routerMode = msg.routerMode === 'pathfinder' ? 'pathfinder' : 'maze';
        const router = routerMode === 'pathfinder' ? routeWithPathfinderRouter : routeWithMazeRouter;
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

        // ── PERF DIAG ──
        const elapsed = performance.now() - t0;
        const ys = self.__yieldStats || { count: 0, totalMs: 0 };
        console.log('[autorouter-worker] done ' + JSON.stringify({
            elapsedMs: Math.round(elapsed),
            yieldCount: ys.count,
            yieldTotalMs: Math.round(ys.totalMs),
            yieldAvgUs: ys.count ? Math.round((ys.totalMs * 1000) / ys.count) : 0,
            computeMs: Math.round(elapsed - ys.totalMs),
        }));
        // ── /PERF DIAG ──
    } catch (err) {
        const message = err && err.message ? err.message : String(err);
        self.postMessage({ type: 'error', error: message });
    } finally {
        running = false;
        activeCancelToken = null;
    }
});
