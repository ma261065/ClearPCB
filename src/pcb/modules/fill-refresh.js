import { computeFillPolygonsInOrder, isClipperReady, loadClipper } from './copper-fill-geom.js';
import { captureFillInputs } from './fill-worker-geometry.js';
import { createFillWorker } from './fill-worker-client.js';
import { getComputedFill, setComputedFill } from './computed-fill-cache.js';
import { renderCopperFill } from './copper-fill-render.js';
import { getPcbSelection, isPcbSelected } from './selection-registry.js';
import { renderPcbSelectionAnchors } from './selection-anchors.js';
import { reconcileRatsnest } from './track-draw.js';
import { installCopperRegionContact, validateCopperRegionContact } from './track-contact-geometry.js';
import { areDragOverlaysDeferred, isFillRefreshPending, isFillRefreshSuspended, isPictureCopperRefreshPending, onEditSettled, refreshStatus, setFillRefreshError, setFillRefreshPending, setFillRefreshScheduled, refreshBoardView } from './refresh-state.js';
import { isEditorActive } from './pcb-editor-api.js';
import { buildFillContext } from './fill-context.js';
import { scheduleDrc } from './drc-state.js';
import { invalidateDrcRefresh } from './drc-refresh.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../core/PcbDocument.js').PcbDocument} PcbDocument */
/** @typedef {import('../../shapes/copper-fill.js').CopperFill} CopperFill */
/** @typedef {import('./copper-fill-geom.js').FillRegion} FillRegion */
/** @typedef {{revision:number, frame:object|null, waiting:boolean, owed:boolean, worker:any, failed:boolean}} FillRefreshState */
/** @typedef {{terminal?: boolean}} DisposeFillRefreshOptions */

/** @type {WeakMap<PcbEditor, FillRefreshState>} */
const states = new WeakMap();
const disposedApps = new WeakSet();
/** @param {PcbEditor} app */
function stateFor(app) {
    let state = states.get(app);
    if (!state) {
        state = { revision: 0, frame: null, waiting: false, owed: false, worker: null, failed: false };
        states.set(app, state);
    }
    return state;
}
/** @param {PcbEditor} app @returns {CopperFill[]} */
const fillsFor = app => /** @type {CopperFill[]} */ (app.pcbDocument.copperFills || []);
/** @param {PcbEditor} app */
const deferred = app => {
    const status = refreshStatus(app);
    return status.pictureCopperPending || status.overlaysDeferred || status.fillSuspended || app.isSectionEditing?.();
};

/** @param {PcbEditor} app @param {string} message @param {any} error */
function reportFailure(app, message, error) {
    setFillRefreshError(app, error);
    console.error(message, error);
    app.setStatus?.(`${message} ${error instanceof Error ? error.message : String(error)}`);
}

/** @param {FillRefreshState} state */
function stopWaiting(state) {
    state.waiting = false;
}

const resumeQueued = new WeakSet();
/**
 * Check a waiting refresh once the current task (a drop and its command, say) has finished.
 * @param {PcbEditor} app
 */
function queueResume(app) {
    if (resumeQueued.has(app)) return;
    resumeQueued.add(app);
    queueMicrotask(() => {
        resumeQueued.delete(app);
        resumeFillRefresh(app);
    });
}
onEditSettled(queueResume);

/**
 * Hold an owed recompute until nothing defers it: whatever ends last notes the edit
 * settled (refresh-state.js) and the recompute runs then. Nothing polls.
 * @param {PcbEditor} app
 * @param {FillRefreshState} state
 */
function waitUntilSettled(app, state) {
    state.owed = true;
    state.waiting = true;
    setFillRefreshPending(app, true);
    queueResume(app);
}

/** Run a recompute that was waiting, if nothing holds it back any more.
 * @param {PcbEditor} app
 */
export function resumeFillRefresh(app) {
    const state = states.get(app);
    if (!state?.waiting || state.frame !== null || disposedApps.has(app)) return;
    if (!isFillRefreshPending(app)) { stopWaiting(state); return; }
    if (!isEditorActive(app) || deferred(app)) return;
    stopWaiting(state);
    scheduleFillRefresh(app);
}

/**
 * Invalidate pending results without inventing a revision on the mutable PCB model.
 * @param {PcbEditor} app
 */
export function invalidateFillRefresh(app) {
    const state = states.get(app);
    if (!state) return;
    state.revision++;
    state.worker?.invalidate();
    if (state.owed || state.frame !== null) waitUntilSettled(app, state);
}

/**
 * Cancel callbacks and terminate the worker; activation may create a fresh service.
 * @param {PcbEditor} app
 * @param {DisposeFillRefreshOptions} [options]
 */
export function disposeFillRefresh(app, options = {}) {
    const state = states.get(app);
    if (options.terminal) disposedApps.add(app);
    if (!state) return;
    if (state.owed || state.frame !== null) setFillRefreshPending(app, true);
    state.worker?.dispose();
    stopWaiting(state);
    states.delete(app);
    setFillRefreshScheduled(app, false);
}

/** @param {PcbEditor} app */
function cancelScheduled(app) {
    const state = stateFor(app);
    state.revision++;
    state.worker?.dispose();
    state.worker = null;
    state.owed = false;
    state.frame = null;
    stopWaiting(state);
    setFillRefreshScheduled(app, false);
    return state;
}

/** @param {PcbEditor} app @param {FillRefreshState} state @param {number} revision @param {PcbDocument} model @param {CopperFill[]} fills */
function current(app, state, revision, model, fills) {
    const loaded = fillsFor(app);
    return states.get(app) === state && state.revision === revision
        && app.pcbDocument === model && loaded.length === fills.length
        && loaded.every((fill, index) => fill === fills[index]);
}

/**
 * Publish the whole batch before any render or connectivity observer sees it.
 * @param {PcbEditor} app
 * @param {CopperFill[]} fills
 * @param {FillRegion[][]} results
 * @param {any[][]} [contacts]
 */
export function adoptFillResults(app, fills, results, contacts) {
    if (contacts) results.forEach((regions, index) => regions.forEach((region, regionIndex) =>
        validateCopperRegionContact(region, contacts[index]?.[regionIndex])));
    const previous = fills.map(getComputedFill);
    const groups = /** @type {Map<string, SVGGElement|null|undefined>} */ (new Map(['top-fill', 'bottom-fill'].map(id => [id, app.getLayerGroup(id)])));
    const staged = new Map([...groups].map(([id, group]) => [id, /** @type {SVGGElement|undefined} */ (group?.cloneNode(false))]));
    const previousChildren = new Map([...groups].map(([id, group]) => [id, [...(group?.children || [])]]));
    try {
        for (const [index, fill] of fills.entries()) setComputedFill(fill, results[index]);
        for (const fill of fills) renderCopperFill(fill, id => /** @type {SVGGElement} */ (staged.get(id)), {
            selected: isPcbSelected(app, 'fill', fill),
        });
    } catch (error) {
        fills.forEach((fill, index) => setComputedFill(fill, previous[index]));
        throw error;
    }
    try {
        clearFillGroups(app);
        for (const [id, group] of groups) {
            const source = staged.get(id);
            while (source?.firstChild && group) group.appendChild(source.firstChild);
        }
    } catch (error) {
        fills.forEach((fill, index) => setComputedFill(fill, previous[index]));
        for (const [id, group] of groups) {
            while (group?.firstChild) group.firstChild.remove();
            if (group) for (const child of /** @type {Element[]} */ (previousChildren.get(id))) group.appendChild(child);
        }
        throw error;
    }
    if (contacts) results.forEach((regions, index) => regions.forEach((region, regionIndex) =>
        installCopperRegionContact(region, contacts[index][regionIndex])));
    setFillRefreshPending(app, false);
    setFillRefreshError(app, null);
    if (getPcbSelection(app, 'fill').length) renderPcbSelectionAnchors(app);
    reconcileRatsnest(app, { skipFillRefresh: true });
    scheduleDrc(app);
    refreshBoardView(app);
}

/**
 * Command callers retain synchronous computation and the existing true/undefined contract.
 * @param {PcbEditor} app
 * @returns {true|undefined}
 */
export function recomputeFillsNow(app) {
    invalidateDrcRefresh(app);
    const state = cancelScheduled(app);
    if (areDragOverlaysDeferred(app) || isFillRefreshSuspended(app)) {
        waitUntilSettled(app, state);
        return;
    }
    const fills = fillsFor(app);
    setFillRefreshPending(app, false);
    if (!fills.length) { clearFillGroups(app); return; }
    if (!isClipperReady()) {
        state.owed = true;
        setFillRefreshPending(app, true);
        const revision = state.revision, model = app.pcbDocument;
        loadClipper().then(() => {
            if (current(app, state, revision, model, fills)) recomputeFillsNow(app);
        }).catch(/** @param {any} error */ error => {
            if (!current(app, state, revision, model, fills)) return;
            reportFailure(app, 'Failed to load copper-fill geometry:', error);
            setFillRefreshPending(app, true);
        });
        return;
    }
    let results;
    try {
        const context = buildFillContext(app);
        results = computeFillPolygonsInOrder(fills, context);
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

/**
 * True when this request owns the eventual connectivity reconciliation.
 * @param {PcbEditor} app
 */
export function scheduleFillRefresh(app) {
    if (disposedApps.has(app)) return false;
    const state = stateFor(app);
    state.revision++;
    state.worker?.invalidate();
    if (!isEditorActive(app) || deferred(app)) {
        waitUntilSettled(app, state);
        return !!isPictureCopperRefreshPending(app);
    }
    stopWaiting(state);
    if (!fillsFor(app).length) {
        state.owed = false;
        setFillRefreshPending(app, false);
        clearFillGroups(app);
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
        stopWaiting(state);
        if (!isEditorActive(app) || deferred(app)) { waitUntilSettled(app, state); return; }
        if (typeof Worker !== 'function' || state.failed) { recomputeFillsNow(app); return; }
        const fills = [...fillsFor(app)];
        if (!fills.length) { state.owed = false; setFillRefreshPending(app, false); clearFillGroups(app); return; }
        const revision = state.revision, model = app.pcbDocument;
        let inputs;
        try { inputs = captureFillInputs(app); }
        catch (error) {
            reportFailure(app, 'Failed to capture copper-fill inputs; retaining settled pours:', error);
            setFillRefreshPending(app, true);
            return;
        }
        state.worker ||= createFillWorker();
        setFillRefreshPending(app, true);
        state.worker.build(inputs).then(/** @param {{results: FillRegion[][], contacts: any[][][]}|null} batch */ batch => {
            if (!current(app, state, revision, model, fills)) {
                if (states.get(app) === state && state.revision === revision) {
                    if (app.pcbDocument === model && fillsFor(app).length) scheduleFillRefresh(app);
                    else { state.owed = false; setFillRefreshPending(app, false); }
                }
                return;
            }
            if (deferred(app) || !isEditorActive(app)) { waitUntilSettled(app, state); return; }
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
        }, /** @param {any} error */ error => {
            if (states.get(app) !== state) return;
            if (!state.failed) reportFailure(app, 'Copper-fill worker failed; using synchronous refresh:', error);
            state.failed = true;
            state.worker?.dispose();
            state.worker = null;
            if (current(app, state, revision, model, fills)) {
                if (deferred(app) || !isEditorActive(app)) waitUntilSettled(app, state);
                else recomputeFillsNow(app);
            }
        });
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
    return typeof Worker === 'function' && !state.failed || isClipperReady();
}

/** @param {PcbEditor} app */
export function rerenderFills(app) {
    if (areDragOverlaysDeferred(app)) return;
    if (!app.copperFills || app.copperFills.length === 0) return;
    for (const fill of app.copperFills) {
        renderCopperFill(fill, (id) => app.getLayerGroup(id), {
            selected: isPcbSelected(app, 'fill', fill),
        });
    }
}

/** @param {PcbEditor} app */
export function clearFillGroups(app) {
    const groups = app.existingLayerGroups();
    for (const gid of ['top-fill', 'bottom-fill']) {
        const g = groups.get(gid);
        if (g) while (g.firstChild) g.firstChild.remove();
    }
}
