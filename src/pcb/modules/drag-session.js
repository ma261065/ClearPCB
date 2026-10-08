/**
 * The derived-state side of a pointer drag (or a live preview that behaves like one).
 *
 * While a drag runs, the expensive derived overlays (pour recompute, clearance halos,
 * and optionally the 2D/3D board view) are deferred: their per-frame state is
 * invisible, and redoing them on every move is the main cost on large boards. Ratlines
 * stay live, but only for the nets the drag moves: ratlines join copper of one net
 * only, and copper without a net draws none, so other nets cannot change. A drag whose
 * copper is only recomputed on the drop (a pour) names no nets.
 *
 * Every drag uses the same three steps:
 *   const session = beginDragSession(app, { nets, suspendBoardView });  // on press
 *   refreshDragRatlines(app, session);                                   // after each move
 *   releaseDragSession(app, session);                                    // on drop or cancel
 * Release restores exactly what begin found, so drags nest inside other previews, and
 * releasing twice is harmless. The drop's own command (or the cancel path) then
 * refreshes everything the drag deferred; caches derived from the moved objects are
 * invalidated by the commands that move them (ModifyFillCommand drops a moved pour's
 * computed copper, for instance).
 */
import { areDragOverlaysDeferred, isBoardViewRefreshSuspended, setBoardViewRefreshSuspended, setDragOverlaysDeferred } from './refresh-state.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */

/**
 * @typedef {object} DragSession
 * @property {Set<string>|null} nets - nets whose ratlines follow the drag; null for none
 * @property {boolean} previousOverlaysDeferred
 * @property {boolean|null} previousBoardViewSuspended - null when the board view was left live
 * @property {boolean} released
 */

/**
 * The named nets of the copper a drag moves.
 * @param {Iterable<{net?: string}|null|undefined>} copper
 */
export function copperNets(copper) {
    return new Set([...copper].map(item => item?.net || '').filter(Boolean));
}

/**
 * Start deferring derived overlays for a drag.
 * @param {PcbEditor} app
 * @param {{nets?: Iterable<string>|null, suspendBoardView?: boolean}} [options]
 * @returns {DragSession}
 */
export function beginDragSession(app, { nets = null, suspendBoardView = false } = {}) {
    const named = nets ? new Set([...nets].filter(Boolean)) : null;
    const session = {
        nets: named?.size ? named : null,
        previousOverlaysDeferred: !!areDragOverlaysDeferred(app),
        previousBoardViewSuspended: suspendBoardView ? !!isBoardViewRefreshSuspended(app) : null,
        released: false,
    };
    setDragOverlaysDeferred(app, true);
    if (suspendBoardView) setBoardViewRefreshSuspended(app, true);
    return session;
}

/**
 * After a move: redraw the ratlines of the nets the drag moves, and no others.
 * @param {PcbEditor} app
 * @param {DragSession|null|undefined} session
 */
export function refreshDragRatlines(app, session) {
    if (session?.nets && !session.released) app.updateRatsnest?.({ nets: session.nets });
}

/**
 * Hand back the overlay deferral (and board-view suspension) the drag found. Returns
 * whether this call released it.
 * @param {PcbEditor} app
 * @param {DragSession|null|undefined} session
 */
export function releaseDragSession(app, session) {
    if (!session || session.released) return false;
    session.released = true;
    setDragOverlaysDeferred(app, session.previousOverlaysDeferred);
    if (session.previousBoardViewSuspended !== null) setBoardViewRefreshSuspended(app, session.previousBoardViewSuspended);
    return true;
}
