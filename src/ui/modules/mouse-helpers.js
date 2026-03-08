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
