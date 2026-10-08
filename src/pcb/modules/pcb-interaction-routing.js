import { PCB_INTERACTIONS, getPcbInteraction } from './pcb-interactions.js';
import { updateBoardOutlineResize, endBoardOutlineResize } from './board-outline-resize.js';
import { updateSelectionInteraction, selectionInteractionCursor, finishSelectionInteraction, showPcbSelectionProperties } from './selection-interaction.js';
import { scheduleGroupDrag, cancelGroupDrag, endGroupDrag, finishBoxSelect, getGroupDrag, refreshBoxSelectionHighlights } from './box-select.js';
import { getBoardShapeDrag, handleBoardShapeDrag, endBoardShapeDrag, updateShapeDrawPreview } from './board-shapes.js';
import { updateVertexDrag, updateViaDrag, cancelVertexDrag, cancelViaDrag, finishVertexDrag, finishViaDrag, getVertexDrag, getVertexDragDownScreen, setVertexDragDownScreen, getSegmentClickEdgeId, setSegmentClickEdgeId } from './track-drag.js';
import { getTrackDraw, updateTrackDraw } from './track-draw.js';
import { getFillDraw, updateFillDraw } from './copper-fill-draw.js';
import { getSelectedTrack, getSelectedVia, clearTrackSelection, selectTrackOrVia, selectTrackSegment } from './track-select.js';
import { scheduleComponentDragUpdate, endComponentDrag } from './component-selection.js';
import { handleTextDrag, endTextDrag } from './pcb-text-selection.js';
import { handleRefDrag, endRefDrag } from './ref-text-selection.js';
import { clearCursorCrosshair, updateCursorCrosshair, updateVertexDragCrosshair } from './cursor-state.js';
import { updatePcbPaste } from './pcb-paste.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {{x:number,y:number}} Point */
/** @typedef {{move?: (app: PcbEditor, event: MouseEvent) => (boolean|void), release?: (app: PcbEditor, worldPos: Point|null) => (string|void), wrapped?: boolean, cancel?: (app: PcbEditor) => void}} InteractionHandler */

/** A release handler's outcome: the release is fully handled, so stop. */
const RELEASE_CONSUMED = 'consumed';
/** A release handler's outcome: the selection interaction finished, so skip the drags it wraps. */
const WRAPPER_FINISHED = 'wrapper-finished';

/** @param {PcbEditor} app */
const resetViewportCursor = (app) => {
    if (app.viewport) app.viewport.svg.style.cursor = 'default';
};

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
 * @type {Record<string, InteractionHandler>}
 */
const HANDLERS = {
    _boardOutlineResize: {
        /** @param {PcbEditor} app */
        move: (app, e) => { updateBoardOutlineResize(app, app.screenToWorld(e)); },
        /** @param {PcbEditor} app */
        release: (app, worldPos) => {
            // board-outline-resize.js defaults this parameter to null, so checkJs infers null-only there.
            if (worldPos) updateBoardOutlineResize(app, worldPos);
            endBoardOutlineResize(app);
            resetViewportCursor(app);
            return RELEASE_CONSUMED;
        },
    },
    _pasteDrop: {
        /** @param {PcbEditor} app */
        move: (app, e) => { updatePcbPaste(app, app.screenToWorld(e)); },
    },
    _pcbSelectionInteraction: {
        /** @param {PcbEditor} app */
        move: (app, e) => {
            if (!updateSelectionInteraction(app, app.screenToWorld(e))) return false;
            if (app.viewport) app.viewport.svg.style.cursor = selectionInteractionCursor(app);
        },
        // Finishing may also leave a midpoint anchor floating (still active) for the next click.
        /** @param {PcbEditor} app */
        release: (app, worldPos) => {
            // selection-interaction.js defaults this parameter to null, so checkJs infers null-only there.
            if (!finishSelectionInteraction(app, true, /** @type {null} */ (/** @type {unknown} */ (worldPos)))) return;
            clearCursorCrosshair(app);
            resetViewportCursor(app);
            return WRAPPER_FINISHED;
        },
        /** @param {PcbEditor} app */
        cancel: app => { finishSelectionInteraction(app, false); },
    },
    _drag: {
        /** @param {PcbEditor} app */
        move: (app, e) => { scheduleComponentDragUpdate(app, e); },
        /** @param {PcbEditor} app */
        release: app => { endComponentDrag(app); },
        /** @param {PcbEditor} app */
        cancel: app => { endComponentDrag(app, false); },
    },
    _groupDrag: {
        /** @param {PcbEditor} app */
        move: (app, e) => { scheduleGroupDrag(app, app.screenToWorld(e)); },
        /** @param {PcbEditor} app */
        release: app => {
            endGroupDrag(app);
            resetViewportCursor(app);
        },
        /** @param {PcbEditor} app */
        cancel: app => { if (getGroupDrag(app)?.posePreview) cancelGroupDrag(app); },
    },
    _textDrag: {
        /** @param {PcbEditor} app */
        move: (app, e) => { handleTextDrag(app, e); },
        /** @param {PcbEditor} app */
        release: app => { endTextDrag(app); },
        /** @param {PcbEditor} app */
        cancel: app => { endTextDrag(app, false); },
    },
    _shapeDrag: {
        /** @param {PcbEditor} app */
        move: (app, e) => {
            const worldPos = app.screenToWorld(e);
            const draggingVertex = getBoardShapeDrag(app)?.mode === 'vertex';
            handleBoardShapeDrag(app, worldPos);
            if (draggingVertex) updateCursorCrosshair(app, worldPos);
            refreshBoxSelectionHighlights(app);
        },
        /** @param {PcbEditor} app */
        release: app => {
            endBoardShapeDrag(app, true);
            clearCursorCrosshair(app);
            refreshBoxSelectionHighlights(app);
            resetViewportCursor(app);
        },
        wrapped: true,
        /** @param {PcbEditor} app */
        cancel: app => { endBoardShapeDrag(app, false); },
    },
    _refDrag: {
        /** @param {PcbEditor} app */
        move: (app, e) => { handleRefDrag(app, e); },
        /** @param {PcbEditor} app */
        release: app => { endRefDrag(app); },
        /** @param {PcbEditor} app */
        cancel: app => { endRefDrag(app, false); },
    },
    _vertexDrag: {
        /** @param {PcbEditor} app */
        move: (app, e) => {
            // Preserve click-to-refine selection without treating a drag as a click.
            const down = getVertexDragDownScreen(app);
            const drag = getVertexDrag(app);
            if (down && drag && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 3) drag.userDragged = true;
            updateVertexDrag(app, app.screenToWorld(e));
            updateVertexDragCrosshair(app);
        },
        // A segment press released without dragging refines the selection to that segment.
        /** @param {PcbEditor} app */
        release: app => {
            setVertexDragDownScreen(app, null);
            const segmentEdgeId = getSegmentClickEdgeId(app);
            const drag = getVertexDrag(app);
            const segmentClick = drag?.mode === 'segment' && !drag.userDragged && segmentEdgeId;
            finishVertexDrag(app);
            app.viewport?.hideCrosshair();
            resetViewportCursor(app);
            const track = getSelectedTrack(app);
            if (track) {
                clearTrackSelection(app);
                if (segmentClick && track.edges?.has(segmentEdgeId)) {
                    selectTrackSegment(app, track, segmentEdgeId);
                } else {
                    selectTrackOrVia(app, { type: 'track', track });
                }
            }
            setSegmentClickEdgeId(app, null);
        },
        wrapped: true,
        /** @param {PcbEditor} app */
        cancel: app => { cancelVertexDrag(app); },
    },
    _viaDrag: {
        /** @param {PcbEditor} app */
        move: (app, e) => { updateViaDrag(app, app.screenToWorld(e)); },
        /** @param {PcbEditor} app */
        release: app => {
            finishViaDrag(app);
            resetViewportCursor(app);
            // Reselect to refresh the halo on the moved via.
            const via = getSelectedVia(app);
            if (via) {
                clearTrackSelection(app);
                selectTrackOrVia(app, { type: 'via', via });
            }
        },
        /** @param {PcbEditor} app */
        cancel: app => { cancelViaDrag(app); },
    },
    _trackDraw: {
        /** @param {PcbEditor} app */
        move: (app, e) => {
            updateTrackDraw(app, app.screenToWorld(e));
            const snap = getTrackDraw(app)?.snap;
            if (snap) updateCursorCrosshair(app, { x: snap.x, y: snap.y });
        },
    },
    _fillDraw: {
        /** @param {PcbEditor} app */
        move: (app, e) => {
            updateFillDraw(app, app.screenToWorld(e));
            const snap = getFillDraw(app)?.snap;
            if (snap) updateCursorCrosshair(app, { x: snap.x, y: snap.y });
        },
    },
    _shapeDraw: {
        /** @param {PcbEditor} app */
        move: (app, e) => {
            updateShapeDrawPreview(app, app.screenToWorld(e));
            updateCursorCrosshair(app, app.screenToWorld(e));
        },
    },
};

const registered = new Set(PCB_INTERACTIONS.map(entry => entry.key));
for (const key of Object.keys(HANDLERS)) {
    if (!registered.has(key)) throw new Error(`PCB interaction handler ${key} is not in PCB_INTERACTIONS.`);
}

/** @param {'move'|'release'|'cancel'} kind */
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
 * @param {Record<string, InteractionHandler>} h
 * @returns {(app: PcbEditor, event: MouseEvent) => boolean} Whether an interaction consumed the move.
 */
export function createPointerMoveDispatch(h) {
    return (app, e) => {
        if (getPcbInteraction(app, '_boardOutlineResize') && /** @type {(app: PcbEditor, event: MouseEvent) => (boolean|void)} */ (h._boardOutlineResize.move)(app, e) !== false) return true;
        if (getPcbInteraction(app, '_pasteDrop') && /** @type {(app: PcbEditor, event: MouseEvent) => (boolean|void)} */ (h._pasteDrop.move)(app, e) !== false) return true;
        if (getPcbInteraction(app, '_pcbSelectionInteraction') && /** @type {(app: PcbEditor, event: MouseEvent) => (boolean|void)} */ (h._pcbSelectionInteraction.move)(app, e) !== false) return true;
        if (getPcbInteraction(app, '_drag') && /** @type {(app: PcbEditor, event: MouseEvent) => (boolean|void)} */ (h._drag.move)(app, e) !== false) return true;
        if (getPcbInteraction(app, '_groupDrag') && /** @type {(app: PcbEditor, event: MouseEvent) => (boolean|void)} */ (h._groupDrag.move)(app, e) !== false) return true;
        if (getPcbInteraction(app, '_textDrag') && /** @type {(app: PcbEditor, event: MouseEvent) => (boolean|void)} */ (h._textDrag.move)(app, e) !== false) return true;
        if (getPcbInteraction(app, '_shapeDrag') && /** @type {(app: PcbEditor, event: MouseEvent) => (boolean|void)} */ (h._shapeDrag.move)(app, e) !== false) return true;
        if (getPcbInteraction(app, '_refDrag') && /** @type {(app: PcbEditor, event: MouseEvent) => (boolean|void)} */ (h._refDrag.move)(app, e) !== false) return true;
        if (getPcbInteraction(app, '_vertexDrag') && /** @type {(app: PcbEditor, event: MouseEvent) => (boolean|void)} */ (h._vertexDrag.move)(app, e) !== false) return true;
        if (getPcbInteraction(app, '_viaDrag') && /** @type {(app: PcbEditor, event: MouseEvent) => (boolean|void)} */ (h._viaDrag.move)(app, e) !== false) return true;
        if (getPcbInteraction(app, '_trackDraw') && /** @type {(app: PcbEditor, event: MouseEvent) => (boolean|void)} */ (h._trackDraw.move)(app, e) !== false) return true;
        if (getPcbInteraction(app, '_fillDraw') && /** @type {(app: PcbEditor, event: MouseEvent) => (boolean|void)} */ (h._fillDraw.move)(app, e) !== false) return true;
        if (getPcbInteraction(app, '_shapeDraw') && /** @type {(app: PcbEditor, event: MouseEvent) => (boolean|void)} */ (h._shapeDraw.move)(app, e) !== false) return true;
        return false;
    };
}

/** Route a pointer move to the highest-priority active interaction. */
export const dispatchPcbPointerMove = createPointerMoveDispatch(HANDLERS);

/**
 * Build the cancel and primary-release routines over a handler table, in PCB_INTERACTIONS
 * order. Tests pass recording handlers to check order and arguments.
 * @param {Record<string, InteractionHandler>} h
 * @param {(app: PcbEditor) => void} finishMarquee Runs after the gestures on a release.
 */
export function createPointerGestureFinishers(h, finishMarquee = app => {
    if (finishBoxSelect(app)) showPcbSelectionProperties(app);
}) {
    /** @param {'release'|'cancel'} kind */
    const keysWith = kind => PCB_INTERACTIONS.filter(entry => h[entry.key]?.[kind]).map(entry => entry.key);
    const cancelKeys = keysWith('cancel');
    const releaseKeys = keysWith('release');
    return {
        /**
         * Cancel the selection gesture and any pointer drag it wraps, in priority order.
         * @param {PcbEditor} app
         */
        cancel(app) {
            for (const key of cancelKeys) {
                if (getPcbInteraction(app, key)) /** @type {(app: PcbEditor) => void} */ (h[key].cancel)(app);
            }
        },
        /**
         * Finish the gestures a primary-button release ends, in table order, then any marquee.
         * The board-outline resize consumes its release. A finished selection interaction has
         * already ended (or, for a floating midpoint anchor, kept) the drag it wraps, so wrapped
         * drags are skipped after it. Other drags are mutually exclusive, and a marquee never
         * runs alongside one, so their relative order does not matter.
         * @param {PcbEditor} app
         * @param {Point|null} worldPos
         */
        release(app, worldPos) {
            let wrapperFinished = false;
            for (const key of releaseKeys) {
                if (!getPcbInteraction(app, key)) continue;
                const handler = h[key];
                if (wrapperFinished && handler.wrapped) continue;
                const outcome = /** @type {(app: PcbEditor, worldPos: Point|null) => (string|void)} */ (handler.release)(app, worldPos);
                if (outcome === RELEASE_CONSUMED) return;
                if (outcome === WRAPPER_FINISHED) wrapperFinished = true;
            }
            finishMarquee(app);
        },
    };
}

/** Outcomes a release handler can return (see createPointerGestureFinishers). */
export const PCB_RELEASE_OUTCOMES = Object.freeze({ consumed: RELEASE_CONSUMED, wrapperFinished: WRAPPER_FINISHED });

const finishers = createPointerGestureFinishers(HANDLERS);

/**
 * Cancel the selection gesture and any pointer drag it wraps, in priority order.
 * @param {PcbEditor} app
 */
export function cancelPcbPointerGestures(app) {
    finishers.cancel(app);
}

/**
 * Finish the gestures a primary-button release ends; see createPointerGestureFinishers.
 * @param {PcbEditor} app
 * @param {{x: number, y: number}|null} worldPos
 */
export function releasePcbPointerGestures(app, worldPos) {
    finishers.release(app, worldPos);
}
