const pendingRefreshes = new WeakMap();
const activeHolds = new WeakMap();

function refreshEditedClearances(app) {
    const shapes = app._pendingShapeClearances;
    app._pendingShapeClearances = null;
    for (const shape of shapes?.values() || []) {
        if (app.boardShapes?.includes(shape) || app.texts?.get(shape.id) === shape) {
            app._refreshBoardShapeClearance?.(shape);
        } else {
            const cached = app._boardShapeClearanceCache?.get(shape.id);
            for (const element of cached?.elements || []) element.parentNode?.removeChild(element);
            app._boardShapeClearanceCache?.delete(shape.id);
        }
    }
}

function flushCopperCuts(app) {
    if (!app._deferredShapeCopperCuts) return;
    app._deferredShapeCopperCuts = false;
    app._updateCopperCuts?.();
    app._scheduleRemovalHatchRender?.();
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
            if (app._pictureCopperRefreshPending) schedulePictureCopperRefresh(app);
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
    app._pictureCopperRefreshPending = false;
    flushCopperCuts(app);
    refreshEditedClearances(app);
}

export function schedulePictureCopperRefresh(app, shape = null) {
    const timer = pendingRefreshes.get(app);
    if (timer !== undefined) clearTimeout(timer);
    pendingRefreshes.delete(app);
    app._pictureCopperRefreshPending = true;
    if (shape) {
        app._pendingShapeClearances ??= new Map();
        app._pendingShapeClearances.set(shape.id, shape);
    }
    const cached = app._boardShapeClearanceCache?.get(shape?.id);
    for (const element of cached?.elements || []) {
        element.parentNode?.removeChild(element);
    }
    if (activeHolds.has(app) || app._rotationHandleDrag || ['vertex', 'segment'].includes(app._shapeDrag?.mode)) return;
    pendingRefreshes.set(app, setTimeout(() => {
        pendingRefreshes.delete(app);
        app._pictureCopperRefreshPending = false;
        flushCopperCuts(app);
        refreshEditedClearances(app);
        if (app._refreshFills?.() !== true) {
            app._updateRatsnest?.({ skipFillRefresh: true });
            if (app._drcShouldRun?.()) app._scheduleDRC?.();
        }
        app._board3d?.refresh?.();
    }, 100));
}