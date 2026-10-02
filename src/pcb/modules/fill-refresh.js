import { computeFillPolygons, isClipperReady, loadClipper } from './copper-fill-geom.js';
import { captureFillInputs } from './fill-worker-geometry.js';
import { createFillWorker } from './fill-worker-client.js';
import { getComputedFill, setComputedFill } from './computed-fill-cache.js';
import { renderCopperFill } from './copper-fill-render.js';
import { getPcbSelection, isPcbSelected } from './selection-registry.js';
import { renderPcbSelectionAnchors } from './selection-anchors.js';
import { reconcileRatsnest } from './track-draw.js';
import { installCopperRegionContact, validateCopperRegionContact } from './track-contact-geometry.js';
import { areDragOverlaysDeferred, isFillRefreshPending, isFillRefreshSuspended, isPictureCopperRefreshPending, refreshStatus, setFillRefreshError, setFillRefreshPending, setFillRefreshScheduled, refreshBoardView } from './refresh-state.js';
import { isEditorActive } from './pcb-editor-api.js';

const states = new WeakMap();
function stateFor(app) {
    let state = states.get(app);
    if (!state) {
        state = { revision: 0, frame: null, retry: null, owed: false, worker: null, failed: false };
        states.set(app, state);
    }
    return state;
}
const fillsFor = app => (app.pcbDocument || app).copperFills || [];
const deferred = app => {
    const status = refreshStatus(app);
    return status.pictureCopperPending || status.overlaysDeferred || status.fillSuspended || app.isSectionEditing?.();
};

function reportFailure(app, message, error) {
    setFillRefreshError(app, error);
    console.error(message, error);
    app.setStatus?.(`${message} ${error instanceof Error ? error.message : String(error)}`);
}

function clearRetry(state) {
    if (state.retry !== null) clearTimeout(state.retry);
    state.retry = null;
}

function retryWhenSettled(app, state) {
    state.owed = true;
    setFillRefreshPending(app, true);
    if (state.retry !== null || !isEditorActive(app) || app._fillRefreshDisposed) return;
    state.retry = setTimeout(() => {
        state.retry = null;
        if (states.get(app) !== state || !isFillRefreshPending(app)) return;
        if (deferred(app)) retryWhenSettled(app, state);
        else scheduleFillRefresh(app);
    }, 50);
    state.retry?.unref?.();
}

/** Invalidate pending results without inventing a revision on the mutable PCB model. */
export function invalidateFillRefresh(app) {
    const state = states.get(app);
    if (!state) return;
    state.revision++;
    state.worker?.invalidate();
    if (state.owed || state.frame !== null) retryWhenSettled(app, state);
}

/** Cancel callbacks and terminate the worker; activation may create a fresh service. */
export function disposeFillRefresh(app) {
    const state = states.get(app);
    if (!state) return;
    if (state.owed || state.frame !== null) setFillRefreshPending(app, true);
    state.worker?.dispose();
    clearRetry(state);
    states.delete(app);
    setFillRefreshScheduled(app, false);
}

function cancelScheduled(app) {
    const state = stateFor(app);
    state.revision++;
    state.worker?.dispose();
    state.worker = null;
    state.owed = false;
    state.frame = null;
    clearRetry(state);
    setFillRefreshScheduled(app, false);
    return state;
}

function current(app, state, revision, model, fills) {
    const loaded = fillsFor(app);
    return states.get(app) === state && state.revision === revision
        && (app.pcbDocument || app) === model && loaded.length === fills.length
        && loaded.every((fill, index) => fill === fills[index]);
}

/** Publish the whole batch before any render or connectivity observer sees it. */
export function adoptFillResults(app, fills, results, contacts) {
    if (contacts) results.forEach((regions, index) => regions.forEach((region, regionIndex) =>
        validateCopperRegionContact(region, contacts[index]?.[regionIndex])));
    const previous = fills.map(getComputedFill);
    const groups = new Map(['top-fill', 'bottom-fill'].map(id => [id, app.getLayerGroup(id)]));
    const staged = new Map([...groups].map(([id, group]) => [id, group?.cloneNode(false)]));
    const previousChildren = new Map([...groups].map(([id, group]) => [id, [...(group?.children || [])]]));
    try {
        for (const [index, fill] of fills.entries()) setComputedFill(fill, results[index]);
        for (const fill of fills) renderCopperFill(fill, id => staged.get(id), {
            selected: isPcbSelected(app, 'fill', fill),
        });
    } catch (error) {
        fills.forEach((fill, index) => setComputedFill(fill, previous[index]));
        throw error;
    }
    try {
        app._clearFillGroups();
        for (const [id, group] of groups) {
            const source = staged.get(id);
            while (source?.firstChild) group.appendChild(source.firstChild);
        }
    } catch (error) {
        fills.forEach((fill, index) => setComputedFill(fill, previous[index]));
        for (const [id, group] of groups) {
            while (group?.firstChild) group.firstChild.remove();
            for (const child of previousChildren.get(id)) group.appendChild(child);
        }
        throw error;
    }
    if (contacts) results.forEach((regions, index) => regions.forEach((region, regionIndex) =>
        installCopperRegionContact(region, contacts[index][regionIndex])));
    setFillRefreshPending(app, false);
    setFillRefreshError(app, null);
    if (getPcbSelection(app, 'fill').length) renderPcbSelectionAnchors(app);
    reconcileRatsnest(app, { skipFillRefresh: true });
    app._scheduleDRC?.();
    refreshBoardView(app);
}

/** Command callers retain synchronous computation and the existing true/undefined contract. */
export function recomputeFillsNow(app) {
    const state = cancelScheduled(app);
    if (areDragOverlaysDeferred(app) || isFillRefreshSuspended(app)) {
        retryWhenSettled(app, state);
        return;
    }
    const fills = fillsFor(app);
    setFillRefreshPending(app, false);
    if (!fills.length) { app._clearFillGroups(); return; }
    if (!isClipperReady()) {
        state.owed = true;
        setFillRefreshPending(app, true);
        const revision = state.revision, model = app.pcbDocument || app;
        loadClipper().then(() => {
            if (current(app, state, revision, model, fills)) app._recomputeFillsNow();
        }).catch(error => {
            if (!current(app, state, revision, model, fills)) return;
            reportFailure(app, 'Failed to load copper-fill geometry:', error);
            setFillRefreshPending(app, true);
        });
        return;
    }
    let results;
    try {
        const context = app._fillContext();
        results = fills.map(fill => computeFillPolygons(fill, context));
    } catch (error) {
        reportFailure(app, 'Failed to compute copper fills; retaining settled pours:', error);
        setFillRefreshPending(app, true);
        return;
    }
    try { adoptFillResults(app, fills, results); }
    catch (error) {
        reportFailure(app, 'Failed to display copper fills:', error);
        setFillRefreshPending(app, true);
        return;
    }
    return true;
}

/** True when this request owns the eventual connectivity reconciliation. */
export function scheduleFillRefresh(app) {
    if (app._fillRefreshDisposed) return false;
    const state = stateFor(app);
    state.revision++;
    state.worker?.invalidate();
    if (!isEditorActive(app) || deferred(app)) {
        retryWhenSettled(app, state);
        return !!isPictureCopperRefreshPending(app);
    }
    clearRetry(state);
    if (!fillsFor(app).length) {
        state.owed = false;
        setFillRefreshPending(app, false);
        app._clearFillGroups();
        return false;
    }
    state.owed = true;
    setFillRefreshPending(app, true);
    if (state.frame !== null) return typeof Worker === 'function' && !state.failed || isClipperReady();
    const frame = {};
    state.frame = frame;
    setFillRefreshScheduled(app, true);
    const run = () => {
        if (states.get(app) !== state || state.frame !== frame) return;
        state.frame = null;
        setFillRefreshScheduled(app, false);
        clearRetry(state);
        if (!isEditorActive(app) || deferred(app)) { retryWhenSettled(app, state); return; }
        if (typeof Worker !== 'function' || state.failed) { app._recomputeFillsNow(); return; }
        const fills = [...fillsFor(app)];
        if (!fills.length) { state.owed = false; setFillRefreshPending(app, false); app._clearFillGroups(); return; }
        const revision = state.revision, model = app.pcbDocument || app;
        let inputs;
        try { inputs = captureFillInputs(app); }
        catch (error) {
            reportFailure(app, 'Failed to capture copper-fill inputs; retaining settled pours:', error);
            setFillRefreshPending(app, true);
            return;
        }
        state.worker ||= createFillWorker();
        setFillRefreshPending(app, true);
        state.worker.build(inputs).then(batch => {
            if (!current(app, state, revision, model, fills)) {
                if (states.get(app) === state && state.revision === revision) {
                    if ((app.pcbDocument || app) === model && fillsFor(app).length) scheduleFillRefresh(app);
                    else { state.owed = false; setFillRefreshPending(app, false); }
                }
                return;
            }
            if (deferred(app) || !isEditorActive(app)) { retryWhenSettled(app, state); return; }
            if (batch) {
                try {
                    adoptFillResults(app, fills, batch.results, batch.contacts);
                    state.owed = false;
                    setFillRefreshPending(app, false);
                } catch (error) {
                    reportFailure(app, 'Failed to display copper fills:', error);
                    setFillRefreshPending(app, true);
                }
            }
        }, error => {
            if (states.get(app) !== state) return;
            if (!state.failed) reportFailure(app, 'Copper-fill worker failed; using synchronous refresh:', error);
            state.failed = true;
            state.worker?.dispose();
            state.worker = null;
            if (current(app, state, revision, model, fills)) {
                if (deferred(app) || !isEditorActive(app)) retryWhenSettled(app, state);
                else app._recomputeFillsNow();
            }
        });
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
    return typeof Worker === 'function' && !state.failed || isClipperReady();
}
