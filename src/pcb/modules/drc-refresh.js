import { runDRC } from './drc.js';
import { captureDrcInputs } from './drc-worker-inputs.js';
import { createDrcWorker } from './drc-worker-client.js';
import { getComputedFill } from './computed-fill-cache.js';
import { fillRefreshError, isFillRefreshPending, refreshStatus } from './refresh-state.js';

const states = new WeakMap();
const stateFor = app => {
    if (!states.has(app)) states.set(app, { revision: 0, frame: null, retry: null, owed: false, worker: null, failed: false });
    return states.get(app);
};
const visible = app => app._active !== false && !app._drcDisposed && app._drcShouldRun();
const deferred = app => {
    const status = refreshStatus(app);
    if (status.overlaysDeferred || status.fillSuspended) return true;
    return status.pictureCopperPending || status.fillScheduled || (status.fillPending && !status.fillError)
        || app.isSectionEditing?.();
};
const rulesFor = app => ({ clearance: app.getRoutingParams().clearance, minAnnularRing: 0.05,
    ratlines: app._collectRatlines() });
const clearRetry = state => {
    if (state.retry !== null) clearTimeout(state.retry);
    state.retry = null;
};
function pending(app) {
    if (!app._drcPending) {
        app._drcPending = true;
        app._updateDRCStatus?.(null, true);
    }
}
function retry(app, state) {
    state.owed = true;
    pending(app);
    if (state.retry !== null || !visible(app)) return;
    state.retry = setTimeout(() => {
        state.retry = null;
        if (states.get(app) !== state || !state.owed || !visible(app)) return;
        if (deferred(app)) retry(app, state);
        else scheduleDrcRefresh(app);
    }, 100);
    state.retry?.unref?.();
}
function report(app, error) {
    app._drcError = error;
    app._drcPending = true;
    console.error('[DRC] check failed', error);
    app.setStatus?.(`DRC check failed: ${error instanceof Error ? error.message : String(error)}`);
    app._updateDRCStatus?.(null, true);
}
export function invalidateDrcRefresh(app) {
    const state = states.get(app);
    if (!state) return;
    state.revision++;
    state.worker?.invalidate();
    if (state.owed || state.frame !== null) retry(app, state);
}
export function disposeDrcRefresh(app) {
    const state = states.get(app);
    if (!state) return;
    state.worker?.dispose();
    clearRetry(state);
    states.delete(app);
    app._drcRaf = 0;
}
function accept(app, state, result) {
    state.owed = false;
    clearRetry(state);
    app._drcPending = false;
    app._drcError = null;
    app._adoptDRCResult(result);
}

/** Direct callers and unavailable/failed worker transports retain synchronous evaluation. */
export function runDrcNow(app) {
    if (app._drcDisposed) return;
    const state = stateFor(app);
    state.revision++;
    state.worker?.dispose();
    state.worker = null;
    state.frame = null;
    app._drcRaf = 0;
    clearRetry(state);
    if (deferred(app)) { retry(app, state); return; }
    state.owed = false;
    try { accept(app, state, runDRC(app, rulesFor(app))); }
    catch (error) { report(app, error); }
}

function ownership(app) {
    const model = app.pcbDocument || app;
    const lists = [model.tracks || [], model.vias || [], model.pads || [], model.boardShapes || [],
        [...(model.texts?.values() || [])], [...(app.placements?.values() || [])]];
    const fills = model.copperFills || (model.boardShapes || []).filter(shape => shape.type === 'fill');
    return { model, lists: lists.map(list => [...list]), fills: fills.map(getComputedFill),
        ratlines: app._drcRatlines, fillPending: isFillRefreshPending(app), fillError: fillRefreshError(app) };
}
function unchanged(app, saved) {
    const current = ownership(app);
    return current.model === saved.model && current.ratlines === saved.ratlines
        && current.fillPending === saved.fillPending && current.fillError === saved.fillError
        && current.lists.every((list, index) => list.length === saved.lists[index].length
            && list.every((item, offset) => item === saved.lists[index][offset]))
        && current.fills.length === saved.fills.length && current.fills.every((fill, index) => fill === saved.fills[index]);
}

export function scheduleDrcRefresh(app) {
    if (app._drcDisposed) return;
    const state = stateFor(app);
    state.revision++;
    state.worker?.invalidate();
    state.owed = true;
    if (!visible(app)) return;
    pending(app);
    if (deferred(app)) { retry(app, state); return; }
    clearRetry(state);
    if (state.frame !== null) return;
    const token = {};
    state.frame = token;
    app._drcRaf = requestAnimationFrame(() => {
        if (states.get(app) !== state || state.frame !== token) return;
        state.frame = null;
        app._drcRaf = 0;
        if (!visible(app)) return;
        if (deferred(app)) { retry(app, state); return; }
        if (state.failed || typeof Worker === 'undefined') { app._runDRCLive(); return; }
        const revision = state.revision;
        let inputs, saved;
        try { saved = ownership(app); inputs = captureDrcInputs(app, rulesFor(app)); }
        catch (error) { state.owed = false; report(app, error); return; }
        state.worker ||= createDrcWorker();
        const valid = () => {
            if (states.get(app) !== state || state.revision !== revision || app._drcDisposed) return false;
            try { return unchanged(app, saved); }
            catch (error) { state.owed = false; report(app, error); return false; }
        };
        state.worker.build(inputs).then(result => {
            if (!valid()) {
                if (states.get(app) === state && state.revision === revision) {
                    state.owed = false;
                    state.worker?.dispose();
                    state.worker = null;
                    if ((app.pcbDocument || app) === saved.model) retry(app, state);
                }
                return;
            }
            if (!result) return;
            if (!visible(app) || deferred(app)) { retry(app, state); return; }
            try { accept(app, state, result); }
            catch (error) { report(app, error); }
        }).catch(error => {
            if (!valid()) return;
            report(app, error);
            state.failed = true;
            if (!visible(app) || deferred(app)) { retry(app, state); return; }
            app._runDRCLive();
        });
    });
}
