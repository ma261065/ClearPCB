import { PCB_INTERACTIONS } from './pcb-interactions.js';
import { updateBoardOutlineResize } from './board-outline-resize.js';
import { updateSelectionInteraction, selectionInteractionCursor, finishSelectionInteraction } from './selection-interaction.js';
import { scheduleGroupDrag, cancelGroupDrag, refreshBoxSelectionHighlights } from './box-select.js';
import { handleBoardShapeDrag, endBoardShapeDrag, updateShapeDrawPreview } from './board-shapes.js';
import { updateVertexDrag, updateViaDrag, cancelVertexDrag, cancelViaDrag } from './track-drag.js';
import { updateTrackDraw } from './track-draw.js';
import { updateFillDraw } from './copper-fill-draw.js';
import { endFillEdit } from './copper-fill-edit.js';

/**
 * Handlers for the interactions in pcb-interactions.js, keyed by editor field.
 *
 * move(app, event)  Pointer-move routing; return false to let a later entry handle it.
 * cancel(app)       Pose-preview cancellation, run by cancelPcbPointerGestures.
 *
 * Paste, board-outline resize and inline text are cancelled by their own explicit
 * steps in edit-lifecycle.js; rotation handles are finished with their previews.
 * @type {Record<string, {move?: (app: any, event: MouseEvent) => (boolean|void), cancel?: (app: any) => void}>}
 */
const HANDLERS = {
    _boardOutlineResize: {
        move: (app, e) => { updateBoardOutlineResize(app, app._screenToWorld(e)); },
    },
    _pasteDrop: {
        move: (app, e) => { app._updatePasteDrop(app._screenToWorld(e)); },
    },
    _pcbSelectionInteraction: {
        move: (app, e) => {
            if (!updateSelectionInteraction(app, app._screenToWorld(e))) return false;
            app.viewport.svg.style.cursor = selectionInteractionCursor(app);
        },
        cancel: app => { finishSelectionInteraction(app, false); },
    },
    _drag: {
        move: (app, e) => { app._scheduleDragUpdate(e); },
        cancel: app => { app._endDrag(false); },
    },
    _groupDrag: {
        move: (app, e) => { scheduleGroupDrag(app, app._screenToWorld(e)); },
        cancel: app => { if (app._groupDrag.posePreview) cancelGroupDrag(app); },
    },
    _textDrag: {
        move: (app, e) => { app._handleTextDrag(e); },
        cancel: app => { app._endTextDrag(false); },
    },
    _shapeDrag: {
        move: (app, e) => {
            const worldPos = app._screenToWorld(e);
            const draggingVertex = app._shapeDrag.mode === 'vertex';
            handleBoardShapeDrag(app, worldPos);
            if (draggingVertex) app._updateCursorCrosshair(worldPos);
            refreshBoxSelectionHighlights(app);
        },
        cancel: app => { endBoardShapeDrag(app, false); },
    },
    _refDrag: {
        move: (app, e) => { app._handleRefDrag(e); },
        cancel: app => { app._endRefDrag(false); },
    },
    _vertexDrag: {
        move: (app, e) => {
            // Preserve click-to-refine selection without treating a drag as a click.
            const down = app._vertexDragDownScreen;
            if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) app._vertexDrag.userDragged = true;
            updateVertexDrag(app, app._screenToWorld(e));
            app._updateVertexDragCrosshair();
        },
        cancel: app => { cancelVertexDrag(app); },
    },
    _viaDrag: {
        move: (app, e) => { updateViaDrag(app, app._screenToWorld(e)); },
        cancel: app => { cancelViaDrag(app); },
    },
    _fillDrag: {
        move: (app, e) => { app._handleFillDrag(app._screenToWorld(e)); },
        cancel: app => { endFillEdit(app, false); },
    },
    _trackDraw: {
        move: (app, e) => {
            updateTrackDraw(app, app._screenToWorld(e));
            const snap = app._trackDraw?.snap;
            if (snap) app._updateCursorCrosshair({ x: snap.x, y: snap.y });
        },
    },
    _fillDraw: {
        move: (app, e) => {
            updateFillDraw(app, app._screenToWorld(e));
            const snap = app._fillDraw?.snap;
            if (snap) app._updateCursorCrosshair({ x: snap.x, y: snap.y });
        },
    },
    _shapeDraw: {
        move: (app, e) => {
            updateShapeDrawPreview(app, app._screenToWorld(e));
            app._updateCursorCrosshair(app._screenToWorld(e));
        },
    },
};

const registered = new Set(PCB_INTERACTIONS.map(entry => entry.key));
for (const key of Object.keys(HANDLERS)) {
    if (!registered.has(key)) throw new Error(`PCB interaction handler ${key} is not in PCB_INTERACTIONS.`);
}

const routeKeys = kind => Object.freeze(PCB_INTERACTIONS.filter(entry => HANDLERS[entry.key]?.[kind]).map(entry => entry.key));

/** Field order consumed by each routing phase, derived from PCB_INTERACTIONS. */
export const PCB_INTERACTION_ROUTES = Object.freeze({ move: routeKeys('move'), cancel: routeKeys('cancel') });

/**
 * Build the pointer-move dispatcher. Pointer moves are the hottest editor path, so this
 * is straight-line code with named field reads and one call site per handler; a
 * table-driven loop measured 2-3x slower (tools/bench-pointer-dispatch.mjs).
 * test-pcb-interaction-registry proves its order and coverage match
 * PCB_INTERACTION_ROUTES.move. That check is not run here: closures from this literal
 * share V8 type feedback, so probing with stub objects would slow the real dispatcher.
 * @param {Record<string, {move: (app: any, event: any) => (boolean|void)}>} h
 * @returns {(app: any, event: any) => boolean} Whether an interaction consumed the move.
 */
export function createPointerMoveDispatch(h) {
    return (app, e) => {
        if (app._boardOutlineResize && h._boardOutlineResize.move(app, e) !== false) return true;
        if (app._pasteDrop && h._pasteDrop.move(app, e) !== false) return true;
        if (app._pcbSelectionInteraction && h._pcbSelectionInteraction.move(app, e) !== false) return true;
        if (app._drag && h._drag.move(app, e) !== false) return true;
        if (app._groupDrag && h._groupDrag.move(app, e) !== false) return true;
        if (app._textDrag && h._textDrag.move(app, e) !== false) return true;
        if (app._shapeDrag && h._shapeDrag.move(app, e) !== false) return true;
        if (app._refDrag && h._refDrag.move(app, e) !== false) return true;
        if (app._vertexDrag && h._vertexDrag.move(app, e) !== false) return true;
        if (app._viaDrag && h._viaDrag.move(app, e) !== false) return true;
        if (app._fillDrag && h._fillDrag.move(app, e) !== false) return true;
        if (app._trackDraw && h._trackDraw.move(app, e) !== false) return true;
        if (app._fillDraw && h._fillDraw.move(app, e) !== false) return true;
        if (app._shapeDraw && h._shapeDraw.move(app, e) !== false) return true;
        return false;
    };
}

/** Route a pointer move to the highest-priority active interaction. */
export const dispatchPcbPointerMove = createPointerMoveDispatch(HANDLERS);

/** Cancel the selection gesture and any pointer drag it wraps, in priority order. */
export function cancelPcbPointerGestures(app) {
    for (const key of PCB_INTERACTION_ROUTES.cancel) {
        if (app[key]) HANDLERS[key].cancel(app);
    }
}
