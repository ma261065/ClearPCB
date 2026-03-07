/**
 * Interaction state helpers.
 *
 * Phase-1 extraction: centralize anchor-drag transition state so
 * mouse-event handlers do not directly mutate pending/active anchor fields.
 */

import {
    clearDragState,
    commitMoveDrag,
    commitSegmentDrag,
    resolveAnchorDragOnMouseUp,
    revertSegmentDragIfNoMove
} from './drag.js';
import { ModifyShapeCommand } from '../../core/CommandHistory.js';
import { collapseRedundantWirePoints } from './wire.js';

/** @param {object} app */
export function getPendingAnchorDrag(app) {
    return app.pendingAnchorDrag || null;
}

/** @param {object} app */
export function clearPendingAnchorDrag(app) {
    app.pendingAnchorDrag = null;
}

/**
 * @param {object} app
 * @param {object} pending
 */
export function setPendingAnchorDrag(app, pending) {
    app.pendingAnchorDrag = pending;
}

/**
 * @param {object} app
 * @returns {object|null}
 */
export function consumePendingAnchorDrag(app) {
    const pending = app.pendingAnchorDrag || null;
    app.pendingAnchorDrag = null;
    return pending;
}

/**
 * Promote a pending-anchor interaction into an active anchor drag session.
 *
 * @param {object} app
 * @param {{
 *  shape: any,
 *  anchorId: string,
 *  startSnapped: {x:number,y:number},
 *  screenPos: {x:number,y:number},
 *  preInsertState?: object
 * }} params
 */
export function beginAnchorDragSession(app, params) {
    const { shape, anchorId, startSnapped, screenPos, preInsertState } = params;

    app.isDragging = true;
    app.dragMode = 'anchor';
    app.dragStart = { ...startSnapped };
    app.dragStartScreen = { ...screenPos };
    app.dragAnchorId = anchorId;
    app.dragShape = shape;
    app.dragWireAnchorOriginal = null;
    app.dragShapesBefore = preInsertState || app._captureShapeState(shape);
}

/**
 * Promote to an active wire-segment drag session.
 *
 * @param {object} app
 * @param {{
 *  shape: any,
 *  dragEdgeId: string,
 *  worldPos: {x:number,y:number},
 *  beforeState: object
 * }} params
 */
export function beginWireSegmentDragSession(app, params) {
    const { shape, dragEdgeId, worldPos, beforeState } = params;

    app.isDragging = true;
    app.dragMode = 'wire-segment';
    app.dragShape = shape;
    app.dragEdgeId = dragEdgeId;
    app.dragStartWorldPos = { ...worldPos };
    app.dragTotalDx = 0;
    app.dragTotalDy = 0;
    app.dragWireStates = new Map();
    app.dragWireStates.set(shape, beforeState);
}

/**
 * Promote to an active move-drag session.
 *
 * @param {object} app
 * @param {{
 *  worldPos: {x:number,y:number},
 *  dragObjectStartPos: {x:number,y:number}
 * }} params
 */
export function beginMoveDragSession(app, params) {
    const { worldPos, dragObjectStartPos } = params;

    app.isDragging = true;
    app.dragMode = 'move';
    app.dragObjectStartPos = { ...dragObjectStartPos };
    app.dragStart = { ...dragObjectStartPos };
    app.dragLastSnapped = { ...dragObjectStartPos };
    app.dragTotalDx = 0;
    app.dragTotalDy = 0;
    app.dragStartWorldPos = { ...worldPos };
}

/**
 * Promote to an active box-select drag session.
 *
 * @param {object} app
 * @param {{x:number,y:number}} worldPos
 * @param {boolean} [additive=false]
 */
export function beginBoxSelectSession(app, worldPos, additive = false) {
    app.isDragging = true;
    app.dragMode = 'box';
    app.boxSelectStart = { ...worldPos };
    app.boxSelectAdditive = !!additive;
    app.selection.captureBoxSelectBase();
    app._createBoxSelectElement();
}

/**
 * End an active box-select drag session.
 *
 * @param {object} app
 */
export function endBoxSelectSession(app) {
    app.isDragging = false;
    app.dragMode = null;
    app.boxSelectStart = null;
    app.boxSelectAdditive = false;
}

/**
 * Handle box-select mouseup behavior.
 *
 * @param {object} app
 * @param {{x:number,y:number}} worldPos
 * @returns {boolean} True when box-select mouseup path was handled.
 */
export function handleBoxSelectMouseUp(app, worldPos) {
    if (!(app.isDragging && app.dragMode === 'box' && app.boxSelectStart)) return false;

    const bounds = app._getBoxSelectBounds(worldPos);
    app._removeBoxSelectElement();

    if (app.didDrag) {
        // Selection is already correct from live syncBoxSelection;
        // just fire the notification for properties panel / ribbon
        app.selection.syncBoxSelection(bounds, !!app.boxSelectAdditive, 'contain');
        app.selection._notifySelectionChanged();
        app.renderShapes(true);
    }

    endBoxSelectSession(app);
    return true;
}

/**
 * Finalize a drag interaction by clearing drag state and re-rendering.
 *
 * @param {object} app
 * @param {{refreshTextEdit?: boolean}} [options]
 */
export function finalizeDragInteraction(app, options = {}) {
    const { refreshTextEdit = false } = options;
    clearDragState(app);
    app.renderShapes(true);
    if (refreshTextEdit && app.textEdit) {
        app._updateTextEditOverlay?.();
    }
}

/**
 * Commit a pending midpoint insertion if drag never promoted it.
 *
 * @param {object} app
 * @returns {boolean} True when pending midpoint state was present.
 */
export function commitPendingMidpointAfterDrag(app) {
    const pendingAfterDrag = getPendingAnchorDrag(app);
    if (!pendingAfterDrag?.preInsertState) return false;

    const { shape, preInsertState } = pendingAfterDrag;
    // Collapse collinear midpoints (e.g. midpoint inserted on straight segment)
    if (shape.type === 'wire') collapseRedundantWirePoints(app, shape);
    const afterState = app._captureShapeState(shape);

    // Only commit if the shape actually changed
    if (JSON.stringify(preInsertState) !== JSON.stringify(afterState)) {
        app._applyShapeState(shape, preInsertState);
        const command = new ModifyShapeCommand(app, shape, preInsertState, afterState);
        app.history.execute(command);
    }
    shape.selected = true;
    return true;
}

/**
 * Handle non-box drag mouseup behavior and finalize drag state.
 *
 * @param {object} app
 * @returns {boolean} True when an active drag was handled.
 */
export function handleActiveDragMouseUp(app) {
    if (!app.isDragging) return false;

    // Handle move undo (dragShape is only set for anchor drags, not move drags)
    if (app.didDrag && app.dragMode === 'move') {
        commitMoveDrag(app);
    } else if (app.dragMode === 'wire-segment' && app.dragWireStates) {
        if (app.didDrag) {
            commitSegmentDrag(app);
        } else {
            // No movement — undo bridge insertions from mousedown
            revertSegmentDragIfNoMove(app);
        }
    } else if (app.dragShape) {
        resolveAnchorDragOnMouseUp(app);
    }

    // Commit pending midpoint insert if it wasn't dragged
    commitPendingMidpointAfterDrag(app);

    // Clear all drag state. NOTE: didDrag is NOT cleared here — the click
    // event fires after mouseup and needs it to skip click-selection.
    finalizeDragInteraction(app, { refreshTextEdit: true });
    return true;
}

/**
 * Handle drawing-tool completion rules on left-button mouseup.
 *
 * @param {object} app
 * @param {{x:number,y:number}} snapped
 * @param {Set<string>} clickToEndTools
 * @returns {boolean} True when a drawing action was finalized.
 */
export function handleDrawingToolMouseUp(app, snapped, clickToEndTools) {
    if (app.currentTool === 'line') {
        // Line continues until double-click, right-click, or Escape
        return false;
    }
    if (app.currentTool === 'polygon') {
        // Polygon continues until double-click or Escape
        return false;
    }
    if (app.currentTool === 'wire') {
        // Wire continues until Enter is pressed
        return false;
    }
    if (clickToEndTools.has(app.currentTool)) {
        // These tools now use Click-Move-Click, so do NOT finish on mouseup
        return false;
    }
    if (app.isDrawing) {
        app._finishDrawing(snapped);
        return true;
    }
    return false;
}

/**
 * Handle right-click mouseup drawing completion rules.
 *
 * @param {object} app
 * @param {{x:number,y:number}} worldPos
 * @param {{x:number,y:number}} snapped
 * @returns {boolean} True when a matching drawing tool was finished.
 */
export function handleRightClickDrawingMouseUp(app, worldPos, snapped) {
    if (app.currentTool === 'wire' && app.isDrawing && app.wirePoints.length >= 1) {
        app._finishWireDrawing(app.drawCurrent || worldPos);
        return true;
    }
    if (app.currentTool === 'arc' && app.isDrawing && app.arcEndpoint) {
        app._updateDrawing(worldPos);
        app._finishDrawing(worldPos);
        return true;
    }
    if (app.currentTool === 'line' && app.isDrawing && app.linePoints && app.linePoints.length >= 2) {
        app._addLinePoint(snapped);
        app._finishLine();
        return true;
    }
    if (app.currentTool === 'polygon' && app.isDrawing) {
        app._addPolygonPoint(snapped);
        app._finishPolygon();
        return true;
    }
    return false;
}

/**
 * True when event should perform additive selection.
 * Ctrl/Cmd are additive; Shift is intentionally excluded.
 *
 * @param {MouseEvent|PointerEvent|KeyboardEvent} event
 * @returns {boolean}
 */
export function isAdditiveSelectionModifier(event) {
    return !!(event?.ctrlKey || event?.metaKey);
}

/**
 * True when event should cycle overlapping shape selection.
 *
 * @param {MouseEvent|PointerEvent|KeyboardEvent} event
 * @returns {boolean}
 */
export function isCycleSelectionModifier(event) {
    return !!(event?.shiftKey && !event?.ctrlKey && !event?.metaKey);
}
