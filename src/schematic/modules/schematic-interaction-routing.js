import { SCHEMATIC_INTERACTIONS } from './schematic-interactions.js';
import { cancelDragGesture, cancelOverlapCyclePress, cancelPendingAnchorDrag } from './drag.js';
import { cancelWireDrawing } from './wire.js';

/**
 * Cancel handler for each interaction in schematic-interactions.js — the
 * counterpart of pcb/modules/pcb-interaction-routing.js. A handler restores what its
 * interaction changed and returns false only when it had nothing to cancel.
 * test-schematic-interactions checks every table entry has one.
 * @type {Record<string, (app: any) => (boolean|void)>}
 */
const HANDLERS = {
    textEdit: app => { app.endTextEdit(false); },
    _overlapCyclePress: cancelOverlapCyclePress,
    drag: cancelDragGesture,
    pendingAnchorDrag: cancelPendingAnchorDrag,
    isDrawing: app => {
        if (app.currentTool === 'wire') cancelWireDrawing(app);
        else app.cancelDrawing();
    },
    pastingClipboard: app => { app.cancelPaste(); },
    placingComponent: app => { app.cancelComponentPlacement(); },
};

const ORDER = Object.freeze(SCHEMATIC_INTERACTIONS.map(entry => entry.key));

/** Pointer gestures: Undo/Redo cancels these and then still steps history. */
export const SCHEMATIC_POINTER_GESTURES = Object.freeze(ORDER.filter(key =>
    ['_overlapCyclePress', 'drag', 'pendingAnchorDrag'].includes(key)));

/** Gestures Undo/Redo only cancels: inline text, paste and component placement. */
export const SCHEMATIC_MODAL_GESTURES = Object.freeze(SCHEMATIC_INTERACTIONS
    .filter(entry => entry.category === 'gesture' && !SCHEMATIC_POINTER_GESTURES.includes(entry.key))
    .map(entry => entry.key));

/** Table keys that have a cancel handler, in priority order (for tests). */
export const SCHEMATIC_CANCEL_ROUTES = Object.freeze(ORDER.filter(key => HANDLERS[key]));

/**
 * Cancel the highest-priority active interaction among `keys`.
 * @param {any} app
 * @param {readonly string[]} [keys] - Defaults to every interaction.
 * @returns {string|null} The cancelled interaction's key.
 */
export function cancelSchematicInteraction(app, keys = ORDER) {
    for (const key of ORDER) {
        if (!keys.includes(key) || !app[key]) continue;
        if (HANDLERS[key](app) !== false) return key;
    }
    return null;
}

/**
 * Cancel every active interaction except `keep`, in priority order.
 * @param {any} app
 * @param {readonly string[]} [keep]
 * @returns {string[]} The cancelled keys.
 */
export function cancelSchematicInteractions(app, keep = []) {
    const cancelled = [];
    for (const key of ORDER) {
        if (keep.includes(key) || !app[key]) continue;
        if (HANDLERS[key](app) !== false) cancelled.push(key);
    }
    return cancelled;
}

/** Restore an active pointer edit before Escape, history, a tool switch or a load. */
export function cancelSchematicPointerInteraction(app) {
    return cancelSchematicInteraction(app, SCHEMATIC_POINTER_GESTURES) !== null;
}
