import { PCB_INTERACTIONS } from './pcb-interactions.js';
import { updateBoardOutlineResize, endBoardOutlineResize } from './board-outline-resize.js';
import { updateSelectionInteraction, selectionInteractionCursor, finishSelectionInteraction, showPcbSelectionProperties } from './selection-interaction.js';
import { scheduleGroupDrag, cancelGroupDrag, endGroupDrag, finishBoxSelect, refreshBoxSelectionHighlights } from './box-select.js';
import { handleBoardShapeDrag, endBoardShapeDrag, updateShapeDrawPreview } from './board-shapes.js';
import { updateVertexDrag, updateViaDrag, cancelVertexDrag, cancelViaDrag, finishVertexDrag, finishViaDrag } from './track-drag.js';
import { updateTrackDraw } from './track-draw.js';
import { updateFillDraw } from './copper-fill-draw.js';
import { endFillEdit } from './copper-fill-edit.js';
import { getSelectedTrack, getSelectedVia, clearTrackSelection, selectTrackOrVia, selectTrackSegment } from './track-select.js';

/** A release handler's outcome: the release is fully handled, so stop. */
const RELEASE_CONSUMED = 'consumed';
/** A release handler's outcome: the selection interaction finished, so skip the drags it wraps. */
const WRAPPER_FINISHED = 'wrapper-finished';

/**
 * Handlers for the interactions in pcb-interactions.js, keyed by editor field.
 *
 * move(app, event)          Pointer-move routing; return false to let a later entry handle it.
 * release(app, worldPos)    Primary-button release, run by releasePcbPointerGestures.
 * wrapped                   The selection interaction can wrap this drag and finishes it itself.
 * cancel(app)               Pose-preview cancellation, run by cancelPcbPointerGestures.
 *
 * Paste, board-outline resize and inline text are cancelled by their own explicit
 * steps in edit-lifecycle.js; rotation handles are finished with their previews.
 * @type {Record<string, {move?: (app: any, event: MouseEvent) => (boolean|void), release?: (app: any, worldPos: {x: number, y: number}|null) => (string|void), wrapped?: boolean, cancel?: (app: any) => void}>}
 */
const HANDLERS = {
    _boardOutlineResize: {
        move: (app, e) => { updateBoardOutlineResize(app, app._screenToWorld(e)); },
        release: (app, worldPos) => {
            if (worldPos) updateBoardOutlineResize(app, worldPos);
            endBoardOutlineResize(app);
            app.viewport.svg.style.cursor = 'default';
            return RELEASE_CONSUMED;
        },
    },
    _pasteDrop: {
        move: (app, e) => { app._updatePasteDrop(app._screenToWorld(e)); },
    },
    _pcbSelectionInteraction: {
        move: (app, e) => {
            if (!updateSelectionInteraction(app, app._screenToWorld(e))) return false;
            app.viewport.svg.style.cursor = selectionInteractionCursor(app);
        },
        // Finishing may also leave a midpoint anchor floating (still active) for the next click.
        release: (app, worldPos) => {
            if (!finishSelectionInteraction(app, true, worldPos)) return;
            app._clearCursorCrosshair();
            app.viewport.svg.style.cursor = 'default';
            return WRAPPER_FINISHED;
        },
        cancel: app => { finishSelectionInteraction(app, false); },
    },
    _drag: {
        move: (app, e) => { app._scheduleDragUpdate(e); },
        release: app => { app._endDrag(); },
        cancel: app => { app._endDrag(false); },
    },
    _groupDrag: {
        move: (app, e) => { scheduleGroupDrag(app, app._screenToWorld(e)); },
        release: app => {
            endGroupDrag(app);
            app.viewport.svg.style.cursor = 'default';
        },
        cancel: app => { if (app._groupDrag.posePreview) cancelGroupDrag(app); },
    },
    _textDrag: {
        move: (app, e) => { app._handleTextDrag(e); },
        release: app => { app._endTextDrag(); },
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
        release: app => {
            endBoardShapeDrag(app, true);
            app._clearCursorCrosshair();
            refreshBoxSelectionHighlights(app);
            app.viewport.svg.style.cursor = 'default';
        },
        wrapped: true,
        cancel: app => { endBoardShapeDrag(app, false); },
    },
    _refDrag: {
        move: (app, e) => { app._handleRefDrag(e); },
        release: app => { app._endRefDrag(); },
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
        // A segment press released without dragging refines the selection to that segment.
        release: app => {
            app._vertexDragDownScreen = null;
            const segmentEdgeId = app._segmentClickEdgeId;
            const segmentClick = app._vertexDrag.mode === 'segment' && !app._vertexDrag.userDragged && segmentEdgeId;
            finishVertexDrag(app);
            app.viewport.hideCrosshair();
            app.viewport.svg.style.cursor = 'default';
            const track = getSelectedTrack(app);
            if (track) {
                clearTrackSelection(app);
                if (segmentClick && track.edges?.has(segmentEdgeId)) {
                    selectTrackSegment(app, track, segmentEdgeId);
                } else {
                    selectTrackOrVia(app, { type: 'track', track });
                }
            }
            app._segmentClickEdgeId = null;
        },
        wrapped: true,
        cancel: app => { cancelVertexDrag(app); },
    },
    _viaDrag: {
        move: (app, e) => { updateViaDrag(app, app._screenToWorld(e)); },
        release: app => {
            finishViaDrag(app);
            app.viewport.svg.style.cursor = 'default';
            // Reselect to refresh the halo on the moved via.
            const via = getSelectedVia(app);
            if (via) {
                clearTrackSelection(app);
                selectTrackOrVia(app, { type: 'via', via });
            }
        },
        cancel: app => { cancelViaDrag(app); },
    },
    _fillDrag: {
        move: (app, e) => { app._handleFillDrag(app._screenToWorld(e)); },
        release: app => {
            endFillEdit(app, true);
            app.viewport.svg.style.cursor = 'default';
        },
        wrapped: true,
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
export const PCB_INTERACTION_ROUTES = Object.freeze({
    move: routeKeys('move'), release: routeKeys('release'), cancel: routeKeys('cancel'),
});

/**
 * Build the pointer-move dispatcher. Pointer moves are the hottest editor path, so this
 * is straight-line code with named field reads and one call site per handler; a
 * table-driven loop measured 2-3x slower (tools/bench-pointer-dispatch.mjs).
 * test-pcb-interaction-registry proves its order and coverage match
 * PCB_INTERACTION_ROUTES.move. That check is not run here: closures from this literal
 * share V8 type feedback, so probing with stub objects would slow the real dispatcher.
 * @param {Record<string, {move?: (app: any, event: any) => (boolean|void)}>} h
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

/**
 * Finish the gestures a primary-button release ends, in table order, then any marquee.
 * The board-outline resize consumes its release. A finished selection interaction has
 * already ended (or, for a floating midpoint anchor, kept) the drag it wraps, so wrapped
 * drags are skipped after it. Other drags are mutually exclusive, and a marquee never
 * runs alongside one, so their relative order does not matter.
 * @param {any} app
 * @param {{x: number, y: number}|null} worldPos
 */
export function releasePcbPointerGestures(app, worldPos) {
    let wrapperFinished = false;
    for (const key of PCB_INTERACTION_ROUTES.release) {
        if (!app[key]) continue;
        const handler = HANDLERS[key];
        if (wrapperFinished && handler.wrapped) continue;
        const outcome = handler.release(app, worldPos);
        if (outcome === RELEASE_CONSUMED) return;
        if (outcome === WRAPPER_FINISHED) wrapperFinished = true;
    }
    if (finishBoxSelect(app)) showPcbSelectionProperties(app);
}
