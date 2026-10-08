import { runDRC } from './drc.js';
import { captureDrcInputs } from './drc-worker-inputs.js';
import { createDrcWorker } from './drc-worker-client.js';
import { getComputedFill } from './computed-fill-cache.js';
import { fillRefreshError, isFillRefreshPending, onEditSettled, refreshStatus } from './refresh-state.js';
import { isEditorActive } from './pcb-editor-api.js';
import { collectDrcRatlines, drcShouldRun, isDrcDisposed, peekDrcPresentation, storedDrcRatlines } from './drc-state.js';

const states = new WeakMap();
const stateFor = app => {
    if (!states.has(app)) states.set(app, { revision: 0, frame: null, waiting: false, owed: false, worker: null, failed: false });
    return states.get(app);
};
const visible = app => isEditorActive(app) && !isDrcDisposed(app) && drcShouldRun(app);
const deferred = app => {
    const status = refreshStatus(app);
    if (status.overlaysDeferred || status.fillSuspended) return true;
    return status.pictureCopperPending || status.fillScheduled || (status.fillPending && !status.fillError)
        || app.isSectionEditing?.();
};
const rulesFor = app => ({ clearance: app.getRoutingParams().clearance, minAnnularRing: 0.05,
    ratlines: collectDrcRatlines(app) });
const stopWaiting = state => { state.waiting = false; };
function pending(app) {
    const presentation = peekDrcPresentation(app);
    if (presentation && !presentation.pending) {
        presentation.pending = true;
        presentation.updateStatus(null, true);
    }
}
const resumeQueued = new WeakSet();
/**
 * Check a waiting check once the current task (a drop and its command, say) has finished.
 * @param {any} app
 */
function queueResume(app) {
    if (resumeQueued.has(app)) return;
    resumeQueued.add(app);
    queueMicrotask(() => {
        resumeQueued.delete(app);
        resumeDrcRefresh(app);
    });
}
onEditSettled(queueResume);

/**
 * Hold an owed check until nothing defers it: whatever ends last (an edit, or the pour
 * recompute it waits for) notes the edit settled (refresh-state.js). Nothing polls.
 */
function waitUntilSettled(app, state) {
    state.owed = true;
    state.waiting = true;
    pending(app);
    queueResume(app);
}

/** Run a check that was waiting, if nothing holds it back any more.
 * @param {any} app
 */
export function resumeDrcRefresh(app) {
    const state = states.get(app);
    if (!state?.waiting || state.frame !== null) return;
    if (!state.owed) { stopWaiting(state); return; }
    if (!visible(app) || deferred(app)) return;
    stopWaiting(state);
    scheduleDrcRefresh(app);
}
function report(app, error) {
    console.error('[DRC] check failed', error);
    app.setStatus?.(`DRC check failed: ${error instanceof Error ? error.message : String(error)}`);
    const presentation = peekDrcPresentation(app);
    if (!presentation) return;
    presentation.error = error;
    presentation.pending = true;
    presentation.updateStatus(null, true);
}
export function invalidateDrcRefresh(app) {
    const state = states.get(app);
    if (!state) return;
    state.revision++;
    state.worker?.invalidate();
    if (state.owed || state.frame !== null) waitUntilSettled(app, state);
}
export function disposeDrcRefresh(app) {
    const state = states.get(app);
    if (!state) return;
    state.worker?.dispose();
    stopWaiting(state);
    states.delete(app);
}
function accept(app, state, result) {
    state.owed = false;
    stopWaiting(state);
    const presentation = peekDrcPresentation(app);
    if (!presentation) return;
    presentation.pending = false;
    presentation.error = null;
    presentation.adoptResult(result);
}

/** Direct callers and unavailable/failed worker transports retain synchronous evaluation. */
export function runDrcNow(app) {
    if (isDrcDisposed(app)) return;
    const state = stateFor(app);
    state.revision++;
    state.worker?.dispose();
    state.worker = null;
    state.frame = null;
    stopWaiting(state);
    if (deferred(app)) { waitUntilSettled(app, state); return; }
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
        ratlines: storedDrcRatlines(app), fillPending: isFillRefreshPending(app), fillError: fillRefreshError(app) };
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
    if (isDrcDisposed(app)) return;
    const state = stateFor(app);
    state.revision++;
    state.worker?.invalidate();
    state.owed = true;
    if (!visible(app)) return;
    pending(app);
    if (deferred(app)) { waitUntilSettled(app, state); return; }
    stopWaiting(state);
    if (state.frame !== null) return;
    const token = {};
    state.frame = token;
    requestAnimationFrame(() => {
        if (states.get(app) !== state || state.frame !== token) return;
        state.frame = null;
        if (!visible(app)) return;
        if (deferred(app)) { waitUntilSettled(app, state); return; }
        if (state.failed || typeof Worker === 'undefined') { runDrcNow(app); return; }
        const revision = state.revision;
        let inputs, saved;
        try { saved = ownership(app); inputs = captureDrcInputs(app, rulesFor(app)); }
        catch (error) { state.owed = false; report(app, error); return; }
        state.worker ||= createDrcWorker();
        const valid = () => {
            if (states.get(app) !== state || state.revision !== revision || isDrcDisposed(app)) return false;
            try { return unchanged(app, saved); }
            catch (error) { state.owed = false; report(app, error); return false; }
        };
        state.worker.build(inputs).then(result => {
            if (!valid()) {
                if (states.get(app) === state && state.revision === revision) {
                    state.owed = false;
                    state.worker?.dispose();
                    state.worker = null;
                    if ((app.pcbDocument || app) === saved.model) waitUntilSettled(app, state);
                }
                return;
            }
            if (!result) return;
            if (!visible(app) || deferred(app)) { waitUntilSettled(app, state); return; }
            try { accept(app, state, result); }
            catch (error) { report(app, error); }
        }).catch(error => {
            if (!valid()) return;
            report(app, error);
            state.failed = true;
            if (!visible(app) || deferred(app)) { waitUntilSettled(app, state); return; }
            runDrcNow(app);
        });
    });
}
