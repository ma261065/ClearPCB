import { DrcPresentation } from './drc-presentation.js';
import { resolveDrcPairMarker } from './drc.js';
import { disposeDrcRefresh, scheduleDrcRefresh } from './drc-refresh.js';
import { clearBoxSelection } from './box-select.js';
import { clearSelectionInteractionUi } from './selection-interaction.js';
import { getPcbSelection } from './selection-registry.js';
import { isBoardOutlineSelected } from './board-outline-resize.js';
import { hasTrackEdit } from './track-select.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */

const emptyRatlines = Object.freeze([]);
const states = new WeakMap();

/** @param {PcbEditor} app */
const modelFor = app => app.pcbDocument;

/** @param {PcbEditor} app */
function stateFor(app) {
    let state = states.get(app);
    if (!state) {
        state = { presentation: null, ratlines: [], model: modelFor(app), disposed: false };
        states.set(app, state);
    }
    return state;
}

/**
 * Lazily create and return the editor's DRC presentation owner.
 * @param {PcbEditor} app
 */
export function getDrcPresentation(app) {
    const state = stateFor(app);
    if (!state.presentation) {
        state.presentation = new DrcPresentation({
            requestRefresh: () => scheduleDrc(app),
            collectRatlines: () => collectDrcRatlines(app),
            resolvePairMarker: violation => resolveDrcPairMarker(app, violation, app.getRoutingParams()),
            clearBoardSelection: () => {
                if (!getPcbSelection(app).length && !isBoardOutlineSelected(app) && !hasTrackEdit(app)) return;
                clearSelectionInteractionUi(app);
                clearBoxSelection(app);
                app.clearProperties?.();
            },
            getLayerGroup: (id, create = false) => create
                ? app.getLayerGroup(id) : app.existingLayerGroups().get(id) || null,
            getViewport: () => {
                const vp = app.viewport;
                return vp ? {
                    viewBox: vp.viewBox, svg: vp.svg, scale: vp.scale,
                    worldToScreen: vp.worldToScreen ? point => vp.worldToScreen(point) : null,
                    updateViewBox: () => vp._updateViewBox?.(),
                    notifyViewChanged: () => vp._notifyViewChanged?.(),
                } : null;
            },
        });
    }
    return state.presentation;
}

/**
 * Return the existing DRC presentation without creating one.
 * @param {PcbEditor} app
 */
export function peekDrcPresentation(app) {
    return states.get(app)?.presentation || null;
}

/** @param {PcbEditor} app */
export function initDrc(app) {
    return getDrcPresentation(app).initialize();
}

/** @param {PcbEditor} app */
export function disposeDrc(app) {
    const state = stateFor(app);
    state.disposed = true;
    disposeDrcRefresh(app);
    state.presentation?.dispose();
}

/** @param {PcbEditor} app */
export function isDrcDisposed(app) {
    return states.get(app)?.disposed === true;
}

/**
 * Whether a live check should run: only once initDrc has set the editor's DRC up.
 * @param {PcbEditor} app
 */
export function drcShouldRun(app) {
    return peekDrcPresentation(app)?.shouldRun() ?? false;
}

/** @param {PcbEditor} app */
export function scheduleDrc(app) {
    refreshSelectedDrcMarker(app);
    scheduleDrcRefresh(app);
}

/** @param {PcbEditor} app */
export function refreshSelectedDrcMarker(app) {
    peekDrcPresentation(app)?.scheduleMarkerRefresh();
}

/** @param {PcbEditor} app */
export function resetDrc(app) {
    disposeDrcRefresh(app);
    setDrcRatlines(app, []);
    const presentation = peekDrcPresentation(app);
    if (presentation) {
        presentation.error = null;
        presentation.pending = false;
    }
    scheduleDrc(app);
}

/** @param {PcbEditor} app */
export function setDrcRatlines(app, lines) {
    const state = stateFor(app);
    state.ratlines = lines;
    state.model = modelFor(app);
}

/** @param {PcbEditor} app */
export function storedDrcRatlines(app) {
    return states.get(app)?.ratlines || emptyRatlines;
}

/** @param {PcbEditor} app */
export function collectDrcRatlines(app) {
    const state = states.get(app);
    if (!state || state.model !== modelFor(app)) return [];
    return (state.ratlines || []).map(({ net, x1, y1, x2, y2 }) => ({
        net, x1: x1 === 0 ? 0 : x1, y1: y1 === 0 ? 0 : y1,
        x2: x2 === 0 ? 0 : x2, y2: y2 === 0 ? 0 : y2,
    }));
}

/** @param {PcbEditor} app */
export function clearDrcResults(app) {
    const presentation = peekDrcPresentation(app);
    if (!presentation) return;
    presentation.closePanel();
    presentation.selectedId = null;
    presentation.clearMarker();
    presentation.violations = [];
}
