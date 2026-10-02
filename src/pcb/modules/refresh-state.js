/**
 * Owner of each PCB editor's derived-refresh status.
 *
 * fill-refresh.js writes the copper-pour status and picture-refresh.js the deferred
 * picture-copper refresh; other modules only read them. Paste restores the pour flag
 * it found when it started. (DRC status is owned by drc-presentation.js.)
 * Import-free: drc.js reads the pour status inside the DRC worker.
 */

/** @type {WeakMap<object, {fillPending: boolean, fillScheduled: boolean, fillError: any, pictureCopperPending: boolean}>} */
const states = new WeakMap();
const stateFor = app => {
    let state = states.get(app);
    if (!state) {
        state = { fillPending: false, fillScheduled: false, fillError: null, pictureCopperPending: false };
        states.set(app, state);
    }
    return state;
};

/** Copper pours are awaiting a successful recompute. */
export const isFillRefreshPending = app => states.get(app)?.fillPending ?? false;
export const setFillRefreshPending = (app, pending) => { stateFor(app).fillPending = !!pending; };

/** A pour recompute is queued for the next animation frame. */
export const isFillRefreshScheduled = app => states.get(app)?.fillScheduled ?? false;
export const setFillRefreshScheduled = (app, scheduled) => { stateFor(app).fillScheduled = !!scheduled; };

/** The last pour recompute failure, retained until a refresh succeeds. */
export const fillRefreshError = app => states.get(app)?.fillError ?? null;
export const setFillRefreshError = (app, error) => { stateFor(app).fillError = error ?? null; };

/** Picture copper edits are batching their clearance/pour refresh. */
export const isPictureCopperRefreshPending = app => states.get(app)?.pictureCopperPending ?? false;
export const setPictureCopperRefreshPending = (app, pending) => { stateFor(app).pictureCopperPending = !!pending; };

const IDLE = Object.freeze({ fillPending: false, fillScheduled: false, fillError: null, pictureCopperPending: false });

/**
 * Read-only view of every status above in one lookup, for predicates that test several.
 * @returns {Readonly<{fillPending: boolean, fillScheduled: boolean, fillError: any, pictureCopperPending: boolean}>}
 */
export const refreshStatus = app => states.get(app) ?? IDLE;
