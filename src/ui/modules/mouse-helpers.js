import {
    clearPendingAnchorDrag,
    isAdditiveSelectionModifier,
    isCycleSelectionModifier,
    setPendingAnchorDrag
} from './interaction-state.js';

/**
 * Compute screen, world, and grid-snapped positions from a mouse event.
 */
export function getEventPositions(e, viewport) {
    const rect = viewport._getCachedRect();
    const screenPos = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
    };
    const worldPos = viewport.screenToWorld(screenPos);
    viewport.shiftHeld = e.shiftKey;
    const snapped = viewport.getSnappedPosition(worldPos);
    return { screenPos, worldPos, snapped };
}

/**
 * Consume one-shot click suppression flags.
 * Returns true when click handling should stop.
 */
export function shouldSkipSelectClick(app) {
    if (app.skipClickSelection) {
        app.skipClickSelection = false;
        return true;
    }

    if (app.didDrag) {
        app.didDrag = false;
        return true;
    }

    return false;
}

/**
 * Consume right-click start state and determine whether it was a click (not drag).
 */
export function consumeRightClickAsClick(app, event, dragThresholdPx) {
    const start = app._rightClickStart;
    app._rightClickStart = null;
    if (!start) {
        return false;
    }

    const movedDist = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    return movedDist <= dragThresholdPx;
}

/**
 * Collect selected component/wire IDs that own dependent geometry/text.
 */
export function collectMovingComponentIds(selection) {
    const movingCompIds = new Set();
    for (const shape of selection) {
        if (shape.definition) movingCompIds.add(shape.id);
        if (shape.type === 'wire') movingCompIds.add(shape.id);
    }
    return movingCompIds;
}

/**
 * Get a reusable Set scratch buffer stored on app.
 */
export function getReusableSet(app, key) {
    let scratch = app[key];
    if (!scratch) {
        scratch = new Set();
        app[key] = scratch;
    } else {
        scratch.clear();
    }
    return scratch;
}

/**
 * Get a reusable point-like scratch object stored on app.
 */
export function getReusablePoint(app, key) {
    let point = app[key];
    if (!point) {
        point = { x: 0, y: 0 };
        app[key] = point;
    }
    return point;
}

/**
 * Return current endpoint node IDs for the active dragged wire segment.
 */
export function getDraggedSegmentEndpointNodeIds(wire, dragEdgeId, reuseSet) {
    const movedNodes = reuseSet || new Set();
    if (reuseSet) {
        movedNodes.clear();
    }

    const edgeNow = wire.edges.get(dragEdgeId);
    if (edgeNow) {
        movedNodes.add(edgeNow.from);
        movedNodes.add(edgeNow.to);
    }
    return movedNodes;
}

/**
 * Switch away from the file ribbon tab when interaction resumes on canvas.
 */
export function activateHomeTabIfFileTabOpen(app) {
    const activeTab = document.querySelector('.ribbon-tab.active');
    if (activeTab instanceof HTMLElement && activeTab.dataset?.tab === 'file') {
        app._setActiveRibbonTab?.('home');
    }
}

/**
 * Select only the provided shape and render immediately.
 */
export function selectOnlyShapeAndRender(app, shape) {
    app.selection.clearSelection();
    app.selection.select(shape, false);
    app.renderShapes(true);
}

/**
 * Ensure a context-menu target shape is selected and rendered.
 */
export function selectContextTargetShape(app, shape) {
    if (!shape.selected) {
        selectOnlyShapeAndRender(app, shape);
    }
    shape.selected = true;
}

/**
 * Return next shape in overlap cycle stack for a world position.
 */
export function getNextCycleHitShape(app, worldPos) {
    const originalTolerance = app.selection.tolerance;
    app.selection.tolerance = 2.0;
    const hits = app.selection.hitTest(worldPos, true);
    app.selection.tolerance = originalTolerance;

    if (!hits || hits.length === 0) {
        return null;
    }

    const selectedIndex = hits.findIndex(shape => shape.selected);
    const nextIndex = (selectedIndex + 1) % hits.length;
    return hits[nextIndex];
}

/**
 * Click-to-add tools (line/polygon): start drawing on first click,
 * append a point on subsequent clicks.
 */
export function handlePointAppendingToolMouseDown(app, snapped, appendPoint) {
    if (!app.isDrawing) {
        app._startDrawing(snapped);
        return;
    }
    appendPoint(snapped);
}

/**
 * Start/finish tools (rect/circle/default fallback): first click starts,
 * next click finishes at snapped position.
 */
export function handleStartFinishToolMouseDown(app, snapped) {
    if (!app.isDrawing) {
        app._startDrawing(snapped);
        return;
    }
    app._finishDrawing(snapped);
}

/**
 * True when midpoint-anchor drag should immediately insert an editable point.
 */
export function canQueueMidpointAnchorDrag(shape, anchorId) {
    if (!anchorId?.startsWith('mid')) {
        return false;
    }
    return shape.type === 'line' || shape.type === 'polygon' || shape.type === 'wire';
}

/**
 * Queue deferred anchor drag metadata used by mousemove promotion.
 */
export function queuePendingAnchorDrag(app, params) {
    const { shape, anchorId, screenPos, snapped, preInsertState } = params;
    const pending = {
        shape,
        anchorId,
        screenPos: { ...screenPos },
        snapped: { ...snapped }
    };

    if (preInsertState) {
        pending.preInsertState = preInsertState;
    }

    setPendingAnchorDrag(app, pending);
}

/**
 * Update paste/component placement previews during mouse move.
 */
export function updatePlacementPreviewsOnMouseMove(app, snapped) {
    if (app.pastingClipboard) {
        app._updatePastePreview(snapped);
    }
    if (app.placingComponent) {
        app._updateComponentPreview(snapped);
    }
}

/**
 * Update drawing preview while an active drawing session is in progress.
 */
export function updateDrawingPreviewOnMouseMove(app, worldPos, snapped, drawingTools) {
    if (!app.isDrawing) {
        return;
    }

    if (app.currentTool === 'arc') {
        app._updateDrawing(app.arcEndpoint ? worldPos : snapped);
        return;
    }

    if (drawingTools.has(app.currentTool)) {
        app._updateDrawing(snapped);
    }
}

/**
 * Handle Shift-based overlap cycling selection.
 * Returns true when the event was handled and should stop further processing.
 */
export function handleCycleSelectionMouseDown(app, event, worldPos) {
    if (!isCycleSelectionModifier(event)) {
        return false;
    }

    const nextShape = getNextCycleHitShape(app, worldPos);
    if (nextShape) {
        selectOnlyShapeAndRender(app, nextShape);
    }

    app.skipClickSelection = true;
    return true;
}

/**
 * Handle Ctrl/Cmd additive selection toggling.
 * Returns true when a hit-shape toggle was applied.
 */
export function handleAdditiveSelectionMouseDown(app, event, hitShape) {
    if (!hitShape || !isAdditiveSelectionModifier(event)) {
        return false;
    }

    app.selection.toggle(hitShape);
    app.renderShapes(true);
    app.skipClickSelection = true;
    return true;
}

/**
 * Handle select-tool click behavior, including text-edit blur and selection.
 */
export function handleSelectToolClick(app, worldPos, event) {
    const hit = app.selection.hitTest(worldPos);

    if (app.textEdit) {
        if (!hit || hit !== app.textEdit.shape) {
            app._endTextEdit(true);
        }
    }

    app.selection.handleClick(worldPos, isAdditiveSelectionModifier(event));
    app.renderShapes(true);
}

/**
 * Handle select-tool double-click behavior.
 * Returns true when the event was handled.
 */
export function handleSelectToolDoubleClick(app, worldPos, screenPos) {
    const hit = app.selection.hitTest(worldPos);

    if (hit && hit.supportsInlineEdit) {
        app.selection.select(hit, false);
        app.renderShapes(true);
        clearPendingAnchorDrag(app);
        app._startTextEdit(hit);
        app._setTextEditCaretFromScreen(screenPos);
        return true;
    }

    if (!hit) {
        app.viewport._onTitleBlockDblClick(worldPos);
        return true;
    }

    return false;
}
