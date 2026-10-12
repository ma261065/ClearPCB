/**
 * The select tool: what a primary press does and what hovering shows.
 *
 * A press runs SELECT_PRESS_PHASES in priority order and stops at the first that
 * handles it: the shared selection interaction (anchors, rotation, overlap cycling),
 * Ctrl/Cmd shape toggling, an active box selection, continuing the current selection,
 * then selecting what is under the pointer (tracks and vias before shapes, text and
 * components, since smaller targets win).
 */
import { PAD_TIP } from './pad-tool.js';
import { canonicalTrack } from './track-commands.js';
import { getBoardShapeNodeFocus, getBoardShapeSegmentFocus } from './board-shape-state.js';
import { hitTestBoardOutline, selectBoardOutline, showBoardOutlineProperties } from './board-outline-resize.js';
import { showBoardShapeProperties } from './board-shape-properties.js';
import { hitTestBoardShape, selectBoardShape } from './board-shapes.js';
import { hitTestBoardShapeVertex, startBoardShapeDrag, getBoardShapeDrag } from './board-shape-drag.js';
import { armBoxSelect, beginGroupDrag, clearBoxSelection, hasBoxSelection, maybeStartBoxSelect, toggleBoxShapeSelection } from './box-select.js';
import { beginComponentDrag, hitTestComponent, hoverComponent } from './component-selection.js';
import { showFillProperties, startFillEditAt } from './copper-fill-edit.js';
import { hitTestFill } from './copper-fill-selection.js';
import { updateVertexDragCrosshair } from './cursor-state.js';
import { hideNetTooltip } from './net-tooltip.js';
import { scheduleHoverUpdate, hoverOverlapHitCount } from './pcb-hover.js';
import { hitTestText } from './pcb-text-render.js';
import { beginTextDrag } from './pcb-text-selection.js';
import { beginRefTextDrag, hitTestReferenceText, selectRefText } from './ref-text-selection.js';
import { beginSelectionInteraction, getSelectionInteraction, selectionInteractionCursor } from './selection-interaction.js';
import { getPcbSelection } from './selection-registry.js';
import { commitCollinearCleanup } from './track-edits.js';
import { getVertexDrag, setSegmentClickEdgeId, setVertexDragDownScreen, startVertexDrag } from './track-drag.js';
import { startViaDrag } from './terminal-drag.js';
import { clearTrackSelection, getSelectedTrack, getSelectedVia, hitTestTrack, selectTrackOrVia, getTrackEdit } from './track-select.js';
import { setHoverHighlight } from './copper-halos.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */
/** @typedef {import('../../core/pcb-board-shapes.js').BoardShape} BoardShape */

/**
 * @typedef {object} SelectPress
 * @property {MouseEvent} e
 * @property {{x: number, y: number}} worldPos
 * @property {boolean} additiveSelection - Ctrl/Cmd held
 * @property {any} selectedGroupHit - the box-selected group member under the pointer, if any
 */

/** @typedef {(app: unknown, press: SelectPress) => boolean|void} SelectPressPhase */

/**
 * A primary press with the select tool.
 * @param {PcbEditor} app
 * @param {MouseEvent} e
 * @param {{x: number, y: number}} worldPos
 * @param {unknown} selectedGroupHit
 * @param {readonly SelectPressPhase[]} [phases]
 */
export function pressSelectTool(app, e, worldPos, selectedGroupHit, phases = SELECT_PRESS_PHASES) {
    /** @type {SelectPress} */
    const press = { e, worldPos, additiveSelection: e.ctrlKey || e.metaKey, selectedGroupHit };
    phases.some(phase => phase(app, press));
}

/**
 * Pointer movement with the select tool: a pending marquee owns it, otherwise hover.
 * @param {PcbEditor} app
 * @param {MouseEvent} e
 */
export function hoverSelectTool(app, e) {
    // Hover hit-testing is O(N) over every pad, track and text, so it is coalesced to
    // one pass per animation frame to keep up with the cursor on complex boards.
    if (!maybeStartBoxSelect(app, e, app.screenToWorld(e))) scheduleHoverUpdate(app, e);
}

/** Hand the press to the shared adapter controller (anchors, rotation, overlap cycling). */
/**
 * @param {PcbEditor} app
 * @type {SelectPressPhase}
 */
function pressSelectionInteraction(app, press) {
    const { e, worldPos, additiveSelection } = press;
    const svg = app.viewport?.svg;
    if (!svg) return false;
    // Rectangle, arc, and circle selection is owned by the shared
    // adapter controller. Other PCB entities stay on their legacy
    // paths until their adapters implement the same contract.
    if (beginSelectionInteraction(app, worldPos, additiveSelection, e.shiftKey)) {
        setHoverHighlight(app, null);
        hoverComponent(app, null);
        hideNetTooltip(app);
        if (getSelectionInteraction(app)) svg.style.cursor = selectionInteractionCursor(app);
        return true;
    }
    return false;
}

/** Ctrl/Cmd-click toggles a board shape in the multi-selection. */
/**
 * @param {PcbEditor} app
 * @type {SelectPressPhase}
 */
function pressToggleShape(app, press) {
    const { worldPos, additiveSelection } = press;
    // Ctrl/Cmd-click mirrors the schematic editor's additive
    // selection. Promote the current single shape first, then
    // toggle the clicked shape in the marquee selection set.
    if (additiveSelection) {
        const shapeHit = hitTestBoardShape(app, worldPos);
        if (shapeHit) {
            const hasMultiSelection = hasBoxSelection(app);
            const previousShape = getPcbSelection(app, 'shape')[0] || null;
            if (!hasMultiSelection && previousShape?.id === shapeHit.id) {
                selectBoardShape(app, null);
                return true;
            }
            if (!hasMultiSelection && previousShape && previousShape.id !== shapeHit.id) {
                toggleBoxShapeSelection(app, previousShape);
            }
            selectBoardShape(app, null);
            toggleBoxShapeSelection(app, shapeHit);
            hideNetTooltip(app);
            return true;
        }
    }
    return false;
}

/** Edit or drag an active box selection, or drop it when the press misses it. */
/**
 * @param {PcbEditor} app
 * @type {SelectPressPhase}
 */
function pressBoxSelection(app, press) {
    const { worldPos, selectedGroupHit } = press;
    const svg = app.viewport?.svg;
    if (!svg) return false;
    // Box-selection group drag: clicking on any member of an
    // active multi-selection moves the whole group together.
    // Clicking elsewhere drops the multi-selection and falls
    // through to normal single-object selection below.
    if (hasBoxSelection(app)) {
        // Match schematic behavior: an anchor belonging to a
        // marquee-selected shape edits only that shape, rather
        // than moving the entire marquee selection.
        const shapeWithHandle = getPcbSelection(app, 'shape').find(
            (/** @type {BoardShape} */ shape) => hitTestBoardShapeVertex(app, shape, worldPos) != null,
        );
        if (shapeWithHandle && startBoardShapeDrag(app, shapeWithHandle, worldPos)) {
            selectBoardShape(app, shapeWithHandle);
            setHoverHighlight(app, null);
            hoverComponent(app, null);
            hideNetTooltip(app);
            svg.style.cursor = 'grabbing';
            return true;
        }
        if (selectedGroupHit) {
            // Clear the hover halo before dragging: hover updates
            // are suppressed during a drag, so a leftover hover X
            // (e.g. on a hole/via) would otherwise sit at the
            // original position the whole drag.
            setHoverHighlight(app, null);
            hoverComponent(app, null);
            beginGroupDrag(app, worldPos);
            hideNetTooltip(app);
            svg.style.cursor = 'grabbing';
            return true;
        }
        clearBoxSelection(app);
    }
    return false;
}

/** Continue dragging the selected fill, track, via or shape; otherwise release it. */
/**
 * @param {PcbEditor} app
 * @type {SelectPressPhase}
 */
function pressCurrentSelection(app, press) {
    const { e, worldPos } = press;
    const svg = app.viewport?.svg;
    if (!svg) return false;
    // Continue interacting with an already-selected fill: grab a
    // vertex or drag the whole region without re-clicking.
    const selectedFill = getPcbSelection(app, 'fill')[0] || null;
    if (selectedFill) {
        if (startFillEditAt(app, selectedFill, worldPos)) {
            setHoverHighlight(app, null);
            hideNetTooltip(app);
            svg.style.cursor = 'grabbing';
            return true;
        }
    }
    // Any other click drops the current fill selection (it may be
    // re-selected below if the click lands on a fill region).
    app.selectFill(null);
    selectBoardShape(app, null);

    // If a track is already selected, try to start a vertex
    // drag on it before doing anything else — this lets the
    // user grab a node or bend a segment without re-clicking.
    const selectedTrack = getSelectedTrack(app);
    if (selectedTrack) {
        if (startVertexDrag(app, selectedTrack, worldPos)) {
            // A pure click (no drag) on a segment of the already-
            // selected track refines the selection down to just
            // that segment on mouse-up. Node grabs and drags are
            // unaffected.
            const vertexDrag = getVertexDrag(app);
            setSegmentClickEdgeId(app, vertexDrag?.mode === 'segment' ? vertexDrag.edgeId : null);
            // Clear any lingering hover halo so it doesn't sit
            // at the original position while the drag is live
            // (hover updates are suppressed during a drag).
            setHoverHighlight(app, null);
            hideNetTooltip(app);
            setVertexDragDownScreen(app, { x: e.clientX, y: e.clientY });
            updateVertexDragCrosshair(app);
            svg.style.cursor = 'grabbing';
            return true;
        }
    }
    // Same for a selected via: clicking on the via begins a
    // drag without losing the selection.
    const selectedVia = getSelectedVia(app);
    if (selectedVia) {
        if (startViaDrag(app, selectedVia, worldPos)) {
            setHoverHighlight(app, null);
            hideNetTooltip(app);
            svg.style.cursor = 'grabbing';
            return true;
        }
    }
    // Same for a selected free-standing board shape.
    const selectedShape = getPcbSelection(app, 'shape')[0] || null;
    if (selectedShape) {
        const selectedHit = hitTestBoardShape(app, worldPos);
        const onHandle = hitTestBoardShapeVertex(app, selectedShape, worldPos) != null;
        if (onHandle || (selectedHit && selectedHit.id === selectedShape.id)) {
            if (startBoardShapeDrag(app, selectedShape, worldPos)) {
                setHoverHighlight(app, null);
                hideNetTooltip(app);
                svg.style.cursor = 'grabbing';
                return true;
            }
        }
    }

    // The click isn't continuing a drag of the current
    // selection, so the selected track (if any) is about to be
    // deselected or replaced. Tidy away any redundant collinear
    // waypoints first — e.g. a node added by double-click but
    // never moved is collinear by definition and is removed here.
    if (selectedTrack) {
        commitCollinearCleanup(app, selectedTrack);
    }
    return false;
}

/** Select (and start dragging) the topmost target under the pointer, or arm a box select. */
/**
 * @param {PcbEditor} app
 * @type {SelectPressPhase}
 */
function pressNewTarget(app, press) {
    const { e, worldPos } = press;
    const svg = app.viewport?.svg;
    if (!svg) return false;
    const trackHit = hitTestTrack(app, worldPos);
    if (trackHit) {
        hoverComponent(app, null);
        app.selectComponent(null);
        selectBoardOutline(app, false);
        selectTrackOrVia(app, trackHit);
        // Fresh whole-track selection — not a segment-refine click.
        setSegmentClickEdgeId(app, null);
        // Begin a drag immediately so click-and-drag works in
        // one motion (no separate select-then-drag click).
        if (trackHit.type === 'via') {
            if (startViaDrag(app, trackHit.via, worldPos)) {
                hideNetTooltip(app);
                svg.style.cursor = 'grabbing';
            }
        } else if (trackHit.type === 'track') {
            if (startVertexDrag(app, trackHit.track, worldPos, { allowMidpointInsert: false })) {
                hideNetTooltip(app);
                setVertexDragDownScreen(app, { x: e.clientX, y: e.clientY });
                updateVertexDragCrosshair(app);
                svg.style.cursor = 'grabbing';
            }
        }
        return;
    }

    // Anything else clears any track selection first.
    clearTrackSelection(app);

    const shapeHit = hitTestBoardShape(app, worldPos);
    if (shapeHit) {
        app.selectComponent(null);
        selectBoardOutline(app, false);
        app.selectText(null);
        selectRefText(app, null);
        app.selectFill(null);
        selectBoardShape(app, shapeHit);
        showBoardShapeProperties(app, shapeHit);
        if (startBoardShapeDrag(app, shapeHit, worldPos)) {
            hideNetTooltip(app);
            svg.style.cursor = 'grabbing';
        }
        return;
    }
    selectBoardShape(app, null);
    const textHit = hitTestText(app, worldPos);
    if (textHit) {
        app.selectComponent(null);
        selectBoardOutline(app, false);
        app.selectText(textHit);
        app.showTextProperties(textHit);
        beginTextDrag(app, textHit, worldPos);
        svg.style.cursor = 'grabbing';
        return;
    }
    app.selectText(null);

    // Reference-designator text hit-test. The label sits on the
    // silkscreen above/around the body and can be dragged/rotated
    // independently of the component, so test it before the body.
    const refHit = hitTestReferenceText(app, worldPos);
    if (refHit) {
        app.selectComponent(null);
        selectBoardOutline(app, false);
        selectRefText(app, refHit);
        const dragging = beginRefTextDrag(app, refHit, worldPos);
        app.showRefProperties(refHit);
        svg.style.cursor = dragging ? 'grabbing' : 'default';
        return;
    }
    selectRefText(app, null);

    const hit = /** @type {string|null} */ (hitTestComponent(app, worldPos));
    if (hit) {
        app.selectComponent(hit);
        selectBoardOutline(app, false);
        app.showComponentProperties(hit);
        if (beginComponentDrag(app, hit, worldPos)) svg.style.cursor = 'grabbing';
    } else if (hitTestBoardOutline(app, worldPos)) {
        app.selectComponent(null);
        app.selectFill(null);
        selectBoardOutline(app, true);
        showBoardOutlineProperties(app);
    } else if (hitTestFill(app, worldPos)) {
        const fillHit = hitTestFill(app, worldPos);
        app.selectComponent(null);
        selectBoardOutline(app, false);
        app.selectFill(fillHit);
        showFillProperties(app, fillHit);
    } else {
        app.selectComponent(null);
        selectBoardOutline(app, false);
        app.selectFill(null);
        app.clearProperties();
        // Empty canvas: arm a box-select. The marquee only
        // materialises once the pointer crosses the drag
        // threshold (see the mousemove handler).
        armBoxSelect(app, { x: e.clientX, y: e.clientY }, worldPos);
    }
    return true;
}

/**
 * The status-bar tip for the select tool, from what is selected or under the pointer.
 * @param {PcbEditor} app
 * @returns {string}
 */
export function selectToolTip(app) {
    const selection = getPcbSelection(app);
    if (selection.length > 0 && getPcbSelection(app, 'component').length === selection.length) {
        return 'Tip: SPACE to rotate, X for horizontal flip, Y for vertical flip';
    }
    if (selection.length === 1 && getPcbSelection(app, 'reftext').length === 1) return 'Tip: Use SPACE to rotate text';
    if (getPcbSelection(app, 'pad').length === 1) return PAD_TIP;
    if (hoverOverlapHitCount(app) > 1) return 'Tip: Shift+Click to cycle overlapping objects; Ctrl+Click for multi-selection';
    const shape = getPcbSelection(app, 'shape');
    const track = getPcbSelection(app, 'track');
    const refinable = selection.length === 1
        && !['vertex', 'segment'].includes(getBoardShapeDrag(app)?.mode)
        && !getVertexDrag(app)
        && ((shape.length === 1 && ['line', 'rect', 'polygon'].includes(shape[0]?.kind)
            && getBoardShapeSegmentFocus(app)?.shapeId !== shape[0]?.id
            && getBoardShapeNodeFocus(app)?.shapeId !== shape[0]?.id)
            || (track.length === 1 && getTrackEdit(app)?.track !== canonicalTrack(app, track[0])));
    return refinable ? 'Tip: Click again to select a segment or node' : '';
}

/** The press phases in priority order; each returns true when it handled the press. */
export const SELECT_PRESS_PHASES = Object.freeze([
    pressSelectionInteraction, pressToggleShape, pressBoxSelection, pressCurrentSelection, pressNewTarget,
]);
