/**
 * Mouse event binding for the PCB canvas, like schematic/modules/mouse.js.
 *
 * Presses go to the active tool (pressPcbTool in pcb-tools.js), moves to the active
 * interaction (pcb-interaction-routing.js) or the tool's hover, and a primary release
 * anywhere in the window finishes the active gesture (releasePcbPointerGestures).
 *
 * Right-click flow (browser order: mousedown -> mouseup -> contextmenu):
 *   mousedown button=2  -> start pan; remember where, and whether a drawing was open
 *   mouseup button=2    -> end pan; a stationary release finishes the open drawing,
 *                          a moved one suppresses the browser context menu that follows
 *   contextmenu         -> select tool: track, shape, pour or component context menu
 *
 * Leaving the canvas never ends a pan or drag: the svg stops getting moves, and the
 * window-level mouseup ends the gesture wherever the button is released.
 */

import { isEditorActive } from './pcb-editor-api.js';
import { endPcbPaste, isPcbPasteActive } from './pcb-paste.js';
import { placeFloatingSelectionInteraction } from './selection-interaction.js';
import { beginBoardOutlineResize, hitTestBoardOutlineHandle } from './board-outline-resize.js';
import { getPcbSelection } from './selection-registry.js';
import {
    getShapeDraw, hitTestBoardShape, hitTestBoardShapeVertex, finishPolygonDraw, finishLineDraw,
    finishShapeDrawAtPoint, showBoardShapeContextMenu, dismissBoardShapeContextMenu,
} from './board-shapes.js';
import { hasBoxSelection, pointInBoxSelection } from './box-select.js';
import { hitTestPcbSelectionAnchor } from './selection-anchors.js';
import { activeTextInlineEdit, startTextInlineEdit, endTextInlineEdit } from './text-inline-edit.js';
import { hitTestText } from './pcb-text-render.js';
import { toggleDebugTooltipPin, updateDebugTooltip } from './debug-tooltip.js';
import { syncToolBlockIndicator, updateCursorForTool } from './tool-lifecycle.js';
import { PCB_PLACEMENT_TOOLS, followPcbTool, hoverPcbTool, pressPcbTool } from './pcb-tools.js';
import { dispatchPcbPointerMove, releasePcbPointerGestures } from './pcb-interaction-routing.js';
import { getTrackDraw, addTrackWaypoint, finishTrackDraw } from './track-draw.js';
import { getFillDraw, finishFillDraw, finishFillDrawAtPoint } from './copper-fill-draw.js';
import { settleFillGeometryPreview, showFillContextMenu } from './copper-fill-edit.js';
import { hitTestTrack, hitTestLockedTrack, showTrackContextMenu } from './track-select.js';
import { showLockedLayerBubble } from './layers.js';
import { isUnmodifiedPrimaryDoublePress } from '../../shared/ui/inline-edit-activation.js';
import { hasAny3DModel } from '../../components/model3d-source.js';
import { hitTestComponent, showComponent3DMenu } from './component-selection.js';
import { hitTestFill } from './copper-fill-selection.js';
import { tryEditReferenceAt } from './ref-text-selection.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */

/** Screen movement (px) below which a press and release count as a click, not a drag. */
const CLICK_SLOP_PX = 4;

const gestureStates = new WeakMap();

/**
 * Screen positions of the presses a later release is measured against, per editor.
 * rightPan: a right-button pan; trackLeft: the primary press that started a track;
 * trackRight/fillRight/shapeRight: a right press while that drawing was open.
 * @param {PcbEditor} app
 */
function gestures(app) {
    let state = gestureStates.get(app);
    if (!state) {
        gestureStates.set(app, state = {
            rightPan: null, trackLeft: null, trackRight: null, fillRight: null, shapeRight: null,
            suppressContextMenu: false,
        });
    }
    return state;
}

const screenPoint = e => ({ x: e.clientX, y: e.clientY });

/** Take a recorded press (clearing it) and say whether the release moved past the click slop. */
function takeMoved(state, key, e) {
    const down = state[key];
    state[key] = null;
    return Math.hypot(e.clientX - down.x, e.clientY - down.y) >= CLICK_SLOP_PX;
}

/**
 * Wire the PCB canvas's mouse events (once, at viewport setup).
 * @param {PcbEditor} app
 */
export function bindPcbMouseEvents(app) {
    const svg = app.viewport.svg;
    if (!svg) return;
    svg.addEventListener('mousedown', e => onMouseDown(app, e));
    svg.addEventListener('mousemove', e => onMouseMove(app, e));
    svg.addEventListener('mouseleave', () => syncToolBlockIndicator(app, null));
    svg.addEventListener('dblclick', e => onDoubleClick(app, e));
    // Some pointer sequences (e.g. when the two clicks land on different child elements
    // within the layer-group hierarchy) never fire a `dblclick`; catch those through
    // `click` with `detail === 2`.
    svg.addEventListener('click', (e) => {
        if (!isEditorActive(app) || e.detail !== 2) return;
        if (activeTextInlineEdit(app)) return;
        editOrExplainAt(app, e);
    });
    // Window level, so a release anywhere ends the gesture (as in the schematic editor).
    window.addEventListener('mouseup', e => onMouseUp(app, e));
    window.addEventListener('contextmenu', (e) => {
        const state = gestures(app);
        if (!isEditorActive(app) || !state.suppressContextMenu) return;
        state.suppressContextMenu = false;
        e.preventDefault();
        e.stopImmediatePropagation();
    }, { capture: true });
    svg.addEventListener('contextmenu', e => onContextMenu(app, e));
    // SchematicApp's ribbon handler only catches the first `.ribbon` (the schematic's).
    document.getElementById('ribbonPCB')?.addEventListener('contextmenu', e => e.preventDefault());
}

/** @param {PcbEditor} app */
function onMouseDown(app, e) {
    if (!isEditorActive(app)) return;
    // A live pour outline from Properties settles before any gesture saves the
    // overlay deferral (the field's blur only follows this press).
    settleFillGeometryPreview(app);
    const svg = app.viewport.svg;
    app.viewport.onInteractionStart?.('pointer');
    app.viewport.shiftHeld = e.shiftKey;
    // Freshly pasted entities are glued to the cursor; the first
    // left-click drops them at their current position.
    if (isPcbPasteActive(app) && e.button === 0) {
        e.preventDefault();
        endPcbPaste(app);
        return;
    }
    // Midpoint and context-menu split/conversion previews drop on the next click.
    if (e.button === 0 && placeFloatingSelectionInteraction(app)) {
        app.viewport.hideCrosshair();
        svg.style.cursor = 'default';
        return;
    }
    const worldPos = e.button === 0 && app.currentTool === 'select'
        ? app.screenToWorld(e)
        : null;
    if (worldPos && beginBoardOutlineResize(app, worldPos)) {
        e.preventDefault();
        svg.style.cursor = hitTestBoardOutlineHandle(app, worldPos)?.cursor || 'nesw-resize';
        return;
    }
    const textEdit = activeTextInlineEdit(app);
    const selectedBoardShapeAnchor = worldPos && getPcbSelection(app, 'shape').some(
        (shape) => hitTestBoardShapeVertex(app, shape, worldPos) != null,
    );
    const selectedGroupHit = worldPos && hasBoxSelection(app)
        && pointInBoxSelection(app, worldPos);
    const selectedTextAnchor = worldPos && textEdit
        ? hitTestPcbSelectionAnchor(app, worldPos, ['text'])
        : null;
    const rotatingEditedText = selectedTextAnchor?.anchor?.symbol === 'rotate'
        && selectedTextAnchor.adapter?.object?.id === textEdit?.text?.id;
    // Rotating the text being edited keeps the edit, so keep focus in its input. Letting
    // the press blur it would refocus it while the button is held, and the drag would then
    // extend the input's selection and move the caret to the end.
    if (rotatingEditedText && e.button === 0) e.preventDefault();
    // Switch the ribbon back to Home on a canvas click — but not while drawing a track
    // or using another Properties-tab tool (its spinners must stay visible), not while
    // inline-editing text (the Properties tab hosts its size/rotation spinners), not when
    // pressing a selected anchor or group, and not on a right-button press (that starts a
    // pan; dragging the board must not switch tabs, e.g. closing the Design tab's live DRC).
    if (!getTrackDraw(app) && !textEdit && !PCB_PLACEMENT_TOOLS.has(app.currentTool)
        && !selectedBoardShapeAnchor && !selectedGroupHit
        && e.button !== 2 && !e.ctrlKey && !e.metaKey) {
        const activeTab = app.ribbon?.querySelector('.ribbon-tab.active');
        if (activeTab instanceof HTMLElement && activeTab.dataset?.tab !== 'pcb-home') {
            app.setActiveRibbonTab?.('pcb-home');
        }
    }
    // Inline text edit: any left-click on the canvas commits the current edit (right-click
    // is reserved for pan and must not commit). If the text tool is active, its press
    // handler then places a new text.
    if (textEdit && e.button === 0 && !rotatingEditedText) {
        if (endTextInlineEdit(app, true) === false) return;
    }
    if (worldPos && isUnmodifiedPrimaryDoublePress(e)) {
        const textHit = hitTestText(app, worldPos);
        if (textHit) {
            e.preventDefault();
            app.selectText(textHit);
            startTextInlineEdit(app, textHit, worldPos);
            return;
        }
        if (tryEditReferenceAt(app, worldPos)) {
            e.preventDefault();
            return;
        }
    }
    // A right press while drawing defers the finish decision to mouseup: a pan (drag)
    // must not finish. The pan below starts immediately either way.
    if (e.button === 2) {
        const state = gestures(app);
        if (getTrackDraw(app)) state.trackRight = screenPoint(e);
        if (getFillDraw(app)) state.fillRight = screenPoint(e);
        if (getShapeDraw(app)) state.shapeRight = screenPoint(e);
        if (toggleDebugTooltipPin(app)) return;
    }
    const isPanButton = e.button === 1 || e.button === 2;
    const isPanTool = app.currentTool === 'pan' && e.button === 0;
    if (isPanButton || isPanTool) {
        e.preventDefault();
        if (e.button === 2) gestures(app).rightPan = screenPoint(e);
        app.viewport.startPan(e.clientX, e.clientY);
        return;
    }
    if (e.button !== 0) return;
    const startingTrack = app.currentTool === 'track' && !getTrackDraw(app);
    pressPcbTool(app, e, worldPos, selectedGroupHit);
    // Remember the press that started a track, so its release can choose between click
    // mode (released in place: keep drawing) and drag mode (released away: finish).
    if (startingTrack && getTrackDraw(app)) gestures(app).trackLeft = screenPoint(e);
}

/** @param {PcbEditor} app */
function onMouseMove(app, e) {
    if (!isEditorActive(app)) return;
    app.viewport.shiftHeld = e.shiftKey;
    // Before any press, show when the active tool's layer is locked or hidden.
    syncToolBlockIndicator(app, e);
    if (app.viewport.isPanning) {
        app.viewport.updatePan(e.clientX, e.clientY);
        // Keep tool crosshairs anchored under the cursor while panning.
        followPcbTool(app, app.screenToWorld(e));
    } else if (dispatchPcbPointerMove(app, e)) {
        // An in-progress interaction consumed the move; see pcb-interactions.js.
    } else {
        hoverPcbTool(app, e);
    }
    app.viewport.trackMouse(e);
    updateDebugTooltip(app, e);
}

/** @param {PcbEditor} app */
function onDoubleClick(app, e) {
    if (!isEditorActive(app)) return;
    if (getTrackDraw(app)) {
        e.preventDefault();
        finishTrackDraw(app);
        return;
    }
    if (getFillDraw(app)) {
        e.preventDefault();
        finishFillDraw(app);
        return;
    }
    const shapeDraw = getShapeDraw(app);
    if (shapeDraw?.kind === 'polygon') {
        e.preventDefault();
        finishPolygonDraw(app);
        return;
    }
    if (shapeDraw?.kind === 'line') {
        e.preventDefault();
        finishLineDraw(app);
        return;
    }
    if (activeTextInlineEdit(app)) return;
    // Double-click track-node insertion is handled on mousedown (e.detail === 2):
    // starting a vertex drag on the second click suppresses the `dblclick` event.
    editOrExplainAt(app, e);
}

/**
 * Double-click: edit a text or reference in place, or explain why a locked track or via
 * cannot be selected.
 * @param {PcbEditor} app
 */
function editOrExplainAt(app, e) {
    const worldPos = app.screenToWorld(e);
    const textHit = hitTestText(app, worldPos);
    if (textHit) {
        e.preventDefault();
        app.selectText(textHit);
        startTextInlineEdit(app, textHit, worldPos);
        return;
    }
    if (app.currentTool === 'select' && tryEditReferenceAt(app, worldPos)) {
        e.preventDefault();
        return;
    }
    // Double-clicking a locked track/via is the natural "why can't I
    // select this?" gesture, so explain it with a speech bubble.
    const lockedHit = hitTestLockedTrack(app, worldPos);
    if (lockedHit) {
        e.preventDefault();
        showLockedLayerBubble(app, lockedHit.layerId, { x: e.clientX, y: e.clientY });
    }
}

/** @param {PcbEditor} app */
function onMouseUp(app, e) {
    if (!isEditorActive(app)) return;
    const state = gestures(app);
    if (e.button === 2 && state.rightPan && takeMoved(state, 'rightPan', e)) {
        // The release of a right-drag pan must not open the browser context menu.
        state.suppressContextMenu = true;
        setTimeout(() => { state.suppressContextMenu = false; }, 0);
    }
    if (app.viewport.isPanning) {
        app.viewport.endPan();
        // Restore the tool's own cursor (endPan resets it to grab/default).
        updateCursorForTool(app);
    }
    // Right/middle releases only end a pan: an armed or active anchor drag stays.
    if (e.button === 0) releasePcbPointerGestures(app, app.screenToWorld(e));
    // Releasing the press that started a track away from it is "drag mode": the release
    // is the end point. Released roughly in place, the next click sets the end point.
    if (e.button === 0 && getTrackDraw(app) && state.trackLeft && takeMoved(state, 'trackLeft', e)) {
        finishTrackAtSnap(app);
    }
    if (e.button !== 2) return;
    // A stationary right-click finishes the open drawing; a right-drag only pans.
    if (getTrackDraw(app) && state.trackRight && !takeMoved(state, 'trackRight', e)) {
        finishTrackAtSnap(app);
    }
    if (getFillDraw(app) && state.fillRight && !takeMoved(state, 'fillRight', e)) {
        finishFillDrawAtPoint(app, app.screenToWorld(e));
    }
    if (getShapeDraw(app) && state.shapeRight && !takeMoved(state, 'shapeRight', e)) {
        finishShapeDrawAtPoint(app, app.screenToWorld(e));
    }
}

/**
 * Commit a final waypoint at the current snap, then finish the track.
 * @param {PcbEditor} app
 */
function finishTrackAtSnap(app) {
    const snap = getTrackDraw(app).snap;
    if (snap) addTrackWaypoint(app, { x: snap.x, y: snap.y });
    if (getTrackDraw(app)) finishTrackDraw(app);
}

/**
 * Select tool: the context menu of the pour anchor, track, shape, pour or 3D component under the pointer.
 * @param {PcbEditor} app
 */
function onContextMenu(app, e) {
    e.preventDefault();
    dismissBoardShapeContextMenu();
    // Never while drawing a track: right-click finishes the draw in that mode.
    if (!isEditorActive(app)) return;
    if (app.currentTool !== 'select' || getTrackDraw(app)) return;
    const worldPos = app.screenToWorld(e);
    // A right-click that started a pan must not leave the viewport panning behind the menu.
    const endPan = () => { if (app.viewport.isPanning) app.viewport.endPan(); };
    const fillAnchor = hitTestPcbSelectionAnchor(app, worldPos, ['fill']);
    if (fillAnchor) {
        endPan();
        showFillContextMenu(app, fillAnchor.adapter.object, e.clientX, e.clientY, worldPos);
        return;
    }
    const hit = hitTestTrack(app, worldPos);
    if (hit) {
        endPan();
        showTrackContextMenu(app, hit, e.clientX, e.clientY, worldPos);
        return;
    }
    const shape = hitTestBoardShape(app, worldPos);
    if (shape) {
        endPan();
        showBoardShapeContextMenu(app, shape, e.clientX, e.clientY, worldPos);
        return;
    }
    const fill = hitTestFill(app, worldPos);
    if (fill) {
        endPan();
        showFillContextMenu(app, fill, e.clientX, e.clientY, worldPos);
        return;
    }
    const compId = /** @type {string|null} */ (hitTestComponent(app, worldPos));
    const placement = compId ? app.placements.get(compId) : null;
    if (compId && hasAny3DModel(placement)) {
        endPan();
        showComponent3DMenu(app, compId, e.clientX, e.clientY);
    }
}
