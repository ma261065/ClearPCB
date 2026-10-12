import { SCHEMATIC_INTERACTIONS, schematicInteractionActive } from './schematic-interactions.js';
import { cancelDragGesture, cancelPendingAnchorDrag } from './drag.js';
import { cancelOverlapCyclePress } from './draw-states.js';
import { cancelWireDrawing } from './wire.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */

/**
 * Cancel handler for each interaction in schematic-interactions.js — the
 * counterpart of pcb/modules/pcb-interaction-routing.js. A handler restores what its
 * interaction changed and returns false only when it had nothing to cancel.
 * test-schematic-interactions checks every table entry has one.
 * @type {Record<string, (app: SchematicEditor) => (boolean|void)>}
 */
const HANDLERS = {
    /** @param {SchematicEditor} app */
    textEdit: app => { app.endTextEdit(false); },
    overlapCyclePress: cancelOverlapCyclePress,
    drag: cancelDragGesture,
    pendingAnchorDrag: cancelPendingAnchorDrag,
    /** @param {SchematicEditor} app */
    isDrawing: app => {
        if (app.currentTool === 'wire') cancelWireDrawing(app);
        else app.cancelDrawing();
    },
    /** @param {SchematicEditor} app */
    pastingClipboard: app => { app.cancelPaste(); },
    /** @param {SchematicEditor} app */
    placingComponent: app => { app.cancelComponentPlacement(); },
};

const ORDER = Object.freeze(SCHEMATIC_INTERACTIONS.map(entry => entry.key));

/** Pointer gestures: Undo/Redo cancels these and then still steps history. */
export const SCHEMATIC_POINTER_GESTURES = Object.freeze(ORDER.filter(key =>
    ['overlapCyclePress', 'drag', 'pendingAnchorDrag'].includes(key)));

/** Gestures Undo/Redo only cancels: inline text, paste and component placement. */
export const SCHEMATIC_MODAL_GESTURES = Object.freeze(SCHEMATIC_INTERACTIONS
    .filter(entry => entry.category === 'gesture' && !SCHEMATIC_POINTER_GESTURES.includes(entry.key))
    .map(entry => entry.key));

/** Table keys that have a cancel handler, in priority order (for tests). */
export const SCHEMATIC_CANCEL_ROUTES = Object.freeze(ORDER.filter(key => HANDLERS[key]));

/**
 * Cancel the highest-priority active interaction among `keys`.
 * @param {SchematicEditor} app
 * @param {readonly string[]} [keys] - Defaults to every interaction.
 * @returns {string|null} The cancelled interaction's key.
 */
export function cancelSchematicInteraction(app, keys = ORDER) {
    for (const key of ORDER) {
        if (!keys.includes(key) || !schematicInteractionActive(app, key)) continue;
        if (HANDLERS[key](app) !== false) return key;
    }
    return null;
}

/**
 * Cancel every active interaction except `keep`, in priority order.
 * @param {SchematicEditor} app
 * @param {readonly string[]} [keep]
 * @returns {string[]} The cancelled keys.
 */
export function cancelSchematicInteractions(app, keep = []) {
    const cancelled = [];
    for (const key of ORDER) {
        if (keep.includes(key) || !schematicInteractionActive(app, key)) continue;
        if (HANDLERS[key](app) !== false) cancelled.push(key);
    }
    return cancelled;
}

/**
 * Restore an active pointer edit before Escape, history, a tool switch or a load.
 * @param {SchematicEditor} app
 */
export function cancelSchematicPointerInteraction(app) {
    return cancelSchematicInteraction(app, SCHEMATIC_POINTER_GESTURES) !== null;
}
