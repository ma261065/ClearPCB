import { isClipperReady } from './copper-fill-geom.js';

/** True when the scheduled pour pass will also reconcile the ratsnest. */
export function scheduleFillRefresh(app) {
    if (app._pictureCopperRefreshPending) return true;
    if (app._deferDragOverlays || app._suspendFillRefresh) {
        app._fillRefreshPending = true;
        return false;
    }
    if (!app.copperFills?.length) {
        app._clearFillGroups();
        return false;
    }
    if (app._fillRefreshScheduled) return isClipperReady();
    app._fillRefreshScheduled = true;
    const run = () => {
        app._fillRefreshScheduled = false;
        if (app._pictureCopperRefreshPending) return;
        app._recomputeFillsNow();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
    return isClipperReady();
}