/**
 * Owner of each PCB editor's derived-refresh status and refresh suspensions.
 *
 * fill-refresh.js writes the copper-pour status and picture-refresh.js the deferred
 * picture-copper refresh; other modules only read them. Paste restores the pour flag
 * it found when it started. (DRC status is owned by drc-presentation.js.)
 * Import-free: drc.js reads the pour status inside the DRC worker, and the fabrication
 * snapshot reads the suspensions inside the Gerber worker. State is keyed by the editor,
 * but any object reads as idle (a worker's board snapshot, a test's plain board), so the
 * functions here take `object` rather than the editor type.
 */

/** @typedef {{refresh?: () => void, closed?: boolean, hidden?: boolean, show?: () => void, hide?: () => void, view?: unknown, mode?: string, popWin?: Window|null, setView?: (mode: string) => void}} BoardViewPanel */
/** @type {WeakMap<object, {fillPending: boolean, fillScheduled: boolean, fillError: unknown, pictureCopperPending: boolean, overlaysDeferred: boolean, fillSuspended: boolean, boardViewSuspended: boolean, boardViewPanel?: BoardViewPanel|null, last2DSide?: 'top'|'bottom'}>} */
const states = new WeakMap();
/** @param {object} app */
const stateFor = app => {
    let state = states.get(app);
    if (!state) {
        state = { fillPending: false, fillScheduled: false, fillError: null, pictureCopperPending: false,
            overlaysDeferred: false, fillSuspended: false, boardViewSuspended: false };
        states.set(app, state);
    }
    return state;
};

// -- Settling ----------------------------------------------------------
// Pour and DRC refreshes that come due while an edit is under way (a drag, a draw, an
// inline text edit, a Properties preview, a paste, the autorouter, a batched picture
// refresh, or for DRC a pour recompute) wait for it to end. Everything that can hold
// them back calls noteEditSettled when it ends, and the waiting refreshes check again
// then; nothing polls. The flags below note it themselves when they drop; interaction
// slots (pcb-interactions.js), Properties previews and the autorouter call it.

/** @type {Array<(app: object) => void>} */
const settledListeners = [];

/**
 * Run `listener(app)` whenever something that can hold back a derived refresh ends.
 * @param {(app: object) => void} listener
 */
export function onEditSettled(listener) {
    settledListeners.push(listener);
}

/**
 * Something that could hold back a derived refresh has ended.
 * @param {object} app
 */
export function noteEditSettled(app) {
    for (const listener of settledListeners) listener(app);
}

/**
 * Set a flag; note the edit settled when one that holds refreshes back drops.
 * @param {object} app
 * @param {'fillPending'|'fillScheduled'|'pictureCopperPending'|'overlaysDeferred'|'fillSuspended'} key
 * @param {boolean} value
 */
function setFlag(app, key, value) {
    const state = stateFor(app);
    const was = state[key];
    state[key] = value;
    if (was && !value) noteEditSettled(app);
}

/** Copper pours are awaiting a successful recompute. */
/** @param {object} app */
export const isFillRefreshPending = app => states.get(app)?.fillPending ?? false;
/** @param {object} app @param {boolean} pending */
export const setFillRefreshPending = (app, pending) => setFlag(app, 'fillPending', !!pending);

/** A pour recompute is queued for the next animation frame. */
/** @param {object} app */
export const isFillRefreshScheduled = app => states.get(app)?.fillScheduled ?? false;
/** @param {object} app @param {boolean} scheduled */
export const setFillRefreshScheduled = (app, scheduled) => setFlag(app, 'fillScheduled', !!scheduled);

/** The last pour recompute failure, retained until a refresh succeeds. */
/** @param {object} app */
export const fillRefreshError = app => states.get(app)?.fillError ?? null;
/**
 * @param {object} app
 * @param {unknown} error
 */
export function setFillRefreshError(app, error) {
    const state = stateFor(app);
    const failedNow = !state.fillError && error != null;
    state.fillError = error ?? null;
    // DRC waits on a pending pour only until it has failed.
    if (failedNow) noteEditSettled(app);
}

/** Picture copper edits are batching their clearance/pour refresh. */
/** @param {object} app */
export const isPictureCopperRefreshPending = app => states.get(app)?.pictureCopperPending ?? false;
/** @param {object} app @param {boolean} pending */
export const setPictureCopperRefreshPending = (app, pending) => setFlag(app, 'pictureCopperPending', !!pending);

const IDLE = Object.freeze({ fillPending: false, fillScheduled: false, fillError: null, pictureCopperPending: false,
    overlaysDeferred: false, fillSuspended: false, boardViewSuspended: false });

/**
 * Read-only view of every status in one lookup, for predicates that test several.
 * @param {object} app
 * @returns {Readonly<{fillPending: boolean, fillScheduled: boolean, fillError: unknown, pictureCopperPending: boolean,
 *   overlaysDeferred: boolean, fillSuspended: boolean, boardViewSuspended: boolean}>}
 */
export const refreshStatus = app => states.get(app) ?? IDLE;

// -- Suspensions --------------------------------------------------------
// Gestures save the current value, set it, and restore the saved value when they
// finish (drags and live previews through drag-session.js). Raising overlay deferral or fill suspension notifies subscribers first,
// so pending pour/DRC work is invalidated before the suspended state is observed.

/** @type {{overlays: Array<(app: object) => void>, fill: Array<(app: object) => void>}} */
const suspensionListeners = { overlays: [], fill: [] };

/**
 * Run `listener(app)` whenever overlay deferral or fill suspension is raised.
 * @param {'overlays'|'fill'} kind
 * @param {(app: object) => void} listener
 */
export function onRefreshSuspended(kind, listener) {
    suspensionListeners[kind].push(listener);
}

/** Drag previews defer derived overlays (pours, clearance halos, DRC) until they finish. */
/** @param {object} app */
export const areDragOverlaysDeferred = app => states.get(app)?.overlaysDeferred ?? false;
/** @param {object} app @param {boolean} deferred */
export function setDragOverlaysDeferred(app, deferred) {
    const state = stateFor(app);
    if (deferred && !state.overlaysDeferred) for (const listener of suspensionListeners.overlays) listener(app);
    setFlag(app, 'overlaysDeferred', !!deferred);
}

/** Floating paste suspends pour recomputation. */
/** @param {object} app */
export const isFillRefreshSuspended = app => states.get(app)?.fillSuspended ?? false;
/** @param {object} app @param {boolean} suspended */
export function setFillRefreshSuspended(app, suspended) {
    const state = stateFor(app);
    if (suspended && !state.fillSuspended) for (const listener of suspensionListeners.fill) listener(app);
    setFlag(app, 'fillSuspended', !!suspended);
}

/** Gestures suspend refreshing the external 2D/3D board views. */
/** @param {object} app */
export const isBoardViewRefreshSuspended = app => states.get(app)?.boardViewSuspended ?? false;
/** @param {object} app @param {boolean} suspended */
export const setBoardViewRefreshSuspended = (app, suspended) => { stateFor(app).boardViewSuspended = !!suspended; };

/** @param {object} app */
export const getBoardViewPanel = app => stateFor(app).boardViewPanel;
/** @param {object} app @param {BoardViewPanel|null|undefined} panel */
export const setBoardViewPanel = (app, panel) => { stateFor(app).boardViewPanel = panel; };
/** @param {object} app @param {BoardViewPanel|null|undefined} panel */
export function clearBoardViewPanel(app, panel) {
    const state = stateFor(app);
    if (state.boardViewPanel === panel) state.boardViewPanel = null;
}
/** @param {object} app */
export const refreshBoardViewPanel = app => { getBoardViewPanel(app)?.refresh?.(); };
/** @param {object} app @param {'top'|'bottom'} side */
export const setLastBoard2DSide = (app, side) => { stateFor(app).last2DSide = side; };
/** @param {object} app @returns {'top'|'bottom'} */
export const getLastBoard2DSide = app => stateFor(app).last2DSide || 'top';

/** Ask an open 3D/2D board viewer to resync after a committed edit (no-op when none is open). */
/** @param {object} app */
export const refreshBoardView = app => { refreshBoardViewPanel(app); };
