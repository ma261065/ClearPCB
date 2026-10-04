import { getPropertyEditor } from './property-editors.js';
import { isPictureCopperRefreshPending, setPictureCopperRefreshPending, refreshBoardView } from './refresh-state.js';
import { forgetBoardShapeClearance, getBoardShapeClearance } from './clearance-overlay.js';
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

export function bindPictureRefreshHold(app, input, host = window) {
    if (!input) return;
    const begin = (event) => {
        const pointer = event.type === 'pointerdown';
        if (pointer ? event.button !== 0 : !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        if (event.repeat) return;
        activeHolds.get(app)?.();
        const release = (endEvent) => {
            if (endEvent && endEvent.type !== 'blur') {
                if (pointer ? endEvent.pointerId !== event.pointerId : endEvent.key !== event.key) return;
            }
            for (const name of endings) host.removeEventListener(name, release, true);
            activeHolds.delete(app);
            if (isPictureCopperRefreshPending(app)) schedulePictureCopperRefresh(app);
        };
        const endings = pointer ? ['pointerup', 'pointercancel', 'blur'] : ['keyup', 'blur'];
        activeHolds.set(app, release);
        const timer = pendingRefreshes.get(app);
        if (timer !== undefined) clearTimeout(timer);
        pendingRefreshes.delete(app);
        for (const name of endings) host.addEventListener(name, release, true);
    };
    input.addEventListener('pointerdown', begin);
    input.addEventListener('keydown', begin);
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
    app.refreshSelectedDRCMarker?.();
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
    if (activeHolds.has(app) || app._rotationHandleDrag || getPropertyEditor(app, 'boardShape')?.active
        || ['vertex', 'segment'].includes(app._shapeDrag?.mode)) return;
    pendingRefreshes.set(app, setTimeout(() => {
        pendingRefreshes.delete(app);
        setPictureCopperRefreshPending(app, false);
        flushCopperCuts(app);
        refreshEditedClearances(app);
        if (app.refreshFills?.() !== true) {
            app.updateRatsnest?.({ skipFillRefresh: true });
            app._scheduleDRC?.();
        }
        refreshBoardView(app);
    }, 100));
}