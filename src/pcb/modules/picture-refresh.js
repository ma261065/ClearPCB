import { getPropertyEditor } from './property-editors.js';
import { isPictureCopperRefreshPending, setPictureCopperRefreshPending, refreshBoardView } from './refresh-state.js';
import { forgetBoardShapeClearance, getBoardShapeClearance } from './clearance-overlay.js';
import { getBoardShapeDrag } from './board-shapes.js';
import { isRotationHandleDragActive } from './rotation-handle.js';
import { refreshSelectedDrcMarker, scheduleDrc } from './drc-state.js';
const pendingRefreshes = new WeakMap();
const activeHolds = new WeakMap();

export function shouldDeferShapeClearance(app, shape) {
    return isPictureCopperRefreshPending(app) && app._pendingShapeClearances?.has(shape?.id)
        && (shape.kind === 'image' || typeof shape.content === 'string');
}

function refreshEditedClearances(app) {
    const shapes = app._pendingShapeClearances;
    app._pendingShapeClearances = null;
    for (const shape of shapes?.values() || []) {
        if (app.boardShapes?.includes(shape) || app.texts?.get(shape.id) === shape) {
            app._refreshBoardShapeClearance?.(shape);
        } else {
            const cached = getBoardShapeClearance(app, shape.id);
            for (const element of cached?.elements || []) element.parentNode?.removeChild(element);
            forgetBoardShapeClearance(app, shape.id);
        }
    }
}

function flushCopperCuts(app) {
    if (!app._deferredShapeCopperCuts) return;
    app._deferredShapeCopperCuts = false;
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
        app._pendingShapeClearances ??= new Map();
        app._pendingShapeClearances.set(shape.id, shape);
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