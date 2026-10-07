import { getPropertyEditor } from './property-editors.js';
import { isPictureCopperRefreshPending, setPictureCopperRefreshPending, refreshBoardView } from './refresh-state.js';
import { forgetBoardShapeClearance, getBoardShapeClearance, refreshBoardShapeClearance } from './clearance-overlay.js';
import { getBoardShapeDrag } from './board-shapes.js';
import { isRotationHandleDragActive } from './rotation-handle.js';
import { refreshSelectedDrcMarker, scheduleDrc } from './drc-state.js';
const pendingRefreshes = new WeakMap();
const activeHolds = new WeakMap();
const shapeClearanceRefreshes = new WeakMap();

function shapeClearanceRefreshState(app) {
    let state = shapeClearanceRefreshes.get(app);
    if (!state) shapeClearanceRefreshes.set(app, state = {
        pendingShapeClearances: null,
        deferredShapeCopperCuts: false,
    });
    return state;
}

/** The shape-clearance debounce state, for tests. */
export function pictureRefreshState(app) {
    return shapeClearanceRefreshState(app);
}

export function isShapeClearancePending(app, shape) {
    return shapeClearanceRefreshState(app).pendingShapeClearances?.has(shape?.id) || false;
}

export function deferShapeCopperCuts(app) {
    shapeClearanceRefreshState(app).deferredShapeCopperCuts = true;
}

export function areShapeCopperCutsDeferred(app) {
    return !!shapeClearanceRefreshState(app).deferredShapeCopperCuts;
}

export function setShapeCopperCutsDeferred(app, deferred) {
    shapeClearanceRefreshState(app).deferredShapeCopperCuts = !!deferred;
}

export function shouldDeferShapeClearance(app, shape) {
    return isPictureCopperRefreshPending(app) && isShapeClearancePending(app, shape)
        && (shape.kind === 'image' || typeof shape.content === 'string');
}

function refreshEditedClearances(app) {
    const state = shapeClearanceRefreshState(app);
    const shapes = state.pendingShapeClearances;
    state.pendingShapeClearances = null;
    for (const shape of shapes?.values() || []) {
        if (app.boardShapes?.includes(shape) || app.texts?.get(shape.id) === shape) {
            refreshBoardShapeClearance(app, shape);
        } else {
            const cached = getBoardShapeClearance(app, shape.id);
            for (const element of cached?.elements || []) element.parentNode?.removeChild(element);
            forgetBoardShapeClearance(app, shape.id);
        }
    }
}

function flushCopperCuts(app) {
    const state = shapeClearanceRefreshState(app);
    if (!state.deferredShapeCopperCuts) return;
    state.deferredShapeCopperCuts = false;
    app.updateCopperCuts?.();
}

/**
 * Hold picture-copper refreshes while a Properties number field is held (its
 * spinner pressed or an Arrow key held): a field's `hold` hooks
 * (shared/ui/property-fields.js). The refresh owed meanwhile runs on release.
 * @returns {{begin: () => void, end: () => void}}
 */
export function pictureRefreshHold(app) {
    const end = () => {
        if (activeHolds.get(app) !== end) return;
        activeHolds.delete(app);
        if (isPictureCopperRefreshPending(app)) schedulePictureCopperRefresh(app);
    };
    return {
        begin() {
            activeHolds.get(app)?.();
            const timer = pendingRefreshes.get(app);
            if (timer !== undefined) clearTimeout(timer);
            pendingRefreshes.delete(app);
            activeHolds.set(app, end);
        },
        end,
    };
}


export function cancelPictureCopperRefresh(app) {
    const timer = pendingRefreshes.get(app);
    if (timer !== undefined) clearTimeout(timer);
    pendingRefreshes.delete(app);
    setPictureCopperRefreshPending(app, false);
    flushCopperCuts(app);
    refreshEditedClearances(app);
}

export function schedulePictureCopperRefresh(app, shape = null) {
    refreshSelectedDrcMarker(app);
    const timer = pendingRefreshes.get(app);
    if (timer !== undefined) clearTimeout(timer);
    pendingRefreshes.delete(app);
    setPictureCopperRefreshPending(app, true);
    if (shape) {
        const state = shapeClearanceRefreshState(app);
        state.pendingShapeClearances ??= new Map();
        state.pendingShapeClearances.set(shape.id, shape);
    }
    if (shouldDeferShapeClearance(app, shape)) {
        const cached = getBoardShapeClearance(app, shape.id);
        for (const element of cached?.elements || []) {
            element.parentNode?.removeChild(element);
        }
    }
    if (activeHolds.has(app) || isRotationHandleDragActive(app) || getPropertyEditor(app, 'boardShape')?.active
        || ['vertex', 'segment'].includes(getBoardShapeDrag(app)?.mode)) return;
    pendingRefreshes.set(app, setTimeout(() => {
        pendingRefreshes.delete(app);
        setPictureCopperRefreshPending(app, false);
        flushCopperCuts(app);
        refreshEditedClearances(app);
        if (app.refreshFills?.() !== true) {
            app.updateRatsnest?.({ skipFillRefresh: true });
            scheduleDrc(app);
        }
        refreshBoardView(app);
    }, 100));
}