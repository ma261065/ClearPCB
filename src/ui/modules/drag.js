/**
 * Drag commit and cleanup helpers.
 *
 * Extracted from mouse.js so drag-related undo logic is in one place.
 * clearDragState is the public reset function (also used by keyboard.js).
 * commitAnchorDrag / commitSegmentDrag handle undo-command creation when
 * the user finishes an anchor or segment drag.
 */

import { ModifyShapeCommand, DeleteShapesCommand } from '../../core/CommandHistory.js';
import { updateSnapHighlight, reconcileWires, refreshWireConnections, collapseRedundantWirePoints, buildWireDiffBatch } from './wire.js';

/**
 * Reset all drag-related state on the app.
 * Call AFTER any undo-commit logic has been performed.
 */
export function clearDragState(app, { clearDidDrag = false, resetCursor = false } = {}) {
    app.isDragging = false;
    app.dragMode = null;
    app.dragStart = null;
    app.dragAnchorId = null;
    if (app.dragShape) {
        app.dragShape.resetDragState();
    }
    app.dragShape = null;
    app.dragShapesBefore = null;
    app.dragWireAnchorOriginal = null;
    app.dragEdgeId = null;
    app.dragSegAxis = null;
    app.dragWireStates = null;
    app.dragWireWorkingState = null;
    app.dragAnchorTJLinks = null;
    app.dragAnchorWireStates = null;
    app.pendingAnchorDrag = null;
    app.dragTotalDx = 0;
    app.dragTotalDy = 0;
    // Clear any snap highlight left from anchor/segment drag
    updateSnapHighlight(app, null);
    // Remove collinear guides if present
    if (app._collinearGuides) {
        for (const line of app._collinearGuides) line.remove();
        app._collinearGuides = null;
    }
    // Hide crosshairs (shown during anchor drag)
    app._hideCrosshair();
    // Defensive: ensure box select rect is always removed
    app._removeBoxSelectElement();
    app.boxSelectStart = null;
    if (clearDidDrag) app.didDrag = false;
    if (resetCursor) app.viewport.svg.style.cursor = '';
}

/**
 * Commit an active anchor drag — handles wire merge, degenerate collapse,
 * and undo command creation.  Returns true if a commit was performed.
 */
export function commitAnchorDrag(app) {
    if (!app.dragShape || !app.dragShapesBefore) return false;

    if (app.dragShape.type === 'wire') {
        // Final cleanup: collapse redundant collinear midpoints
        collapseRedundantWirePoints(app, app.dragShape);
        if (app.dragAnchorWireStates) {
            for (const wire of app.dragAnchorWireStates.keys()) {
                collapseRedundantWirePoints(app, wire);
            }
        }

        // Build complete before-state map.
        // Dragged wire + TJ-linked wires: captured at drag start.
        // All other wires: capture now (unchanged by the drag).
        const beforeAll = new Map();
        beforeAll.set(app.dragShape, app.dragShapesBefore);
        if (app.dragAnchorWireStates) {
            for (const [w, b] of app.dragAnchorWireStates) beforeAll.set(w, b);
        }
        for (const s of app.shapes) {
            if (s.type === 'wire' && !beforeAll.has(s)) {
                beforeAll.set(s, s.captureState());
            }
        }

        // Run unified reconciliation (overlap, merge, collapse, junctions)
        const changedWires = [app.dragShape];
        if (app.dragAnchorWireStates) {
            for (const wire of app.dragAnchorWireStates.keys()) {
                if (app.shapes.includes(wire)) changedWires.push(wire);
            }
        }
        reconcileWires(app, changedWires);

        // Refresh pin connections for surviving changed wires
        for (const w of changedWires) {
            if (app.shapes.includes(w)) refreshWireConnections(app, w);
        }

        // Build undo batch by diffing pre-drag vs post-reconcile
        const batch = buildWireDiffBatch(app, beforeAll, 'Move anchor');
        if (batch) app.history.execute(batch);

        // Select surviving dragged wire if not degenerate
        if (app.shapes.includes(app.dragShape)) {
            const degenerate = app.dragShape.edges.size === 0;
            if (!degenerate) app.dragShape.selected = true;
        }
        return true;
    }

    // Non-wire shape: simple modify/delete command
    const wasRemoved = !app.shapes.includes(app.dragShape);
    const pts = app.dragShape.points;
    let degenerate = false;
    if (!wasRemoved && pts) {
        if (pts.length >= 2) {
            degenerate = pts.every(p =>
                Math.abs(p.x - pts[0].x) < 1e-6 && Math.abs(p.y - pts[0].y) < 1e-6);
        } else if (pts.length < 2) {
            degenerate = true;
        }
    }
    if (wasRemoved || degenerate) {
        app.dragShape.applyState(app.dragShapesBefore);
        if (!app.shapes.includes(app.dragShape)) app.shapes.push(app.dragShape);
        app.history.execute(new DeleteShapesCommand(app, [app.dragShape]));
    } else {
        const afterState = app._captureShapeState(app.dragShape);
        app._applyShapeState(app.dragShape, app.dragShapesBefore);
        app.history.execute(new ModifyShapeCommand(app, app.dragShape, app.dragShapesBefore, afterState));
        app.dragShape.selected = true;
    }
    return true;
}

/**
 * Commit an active wire-segment drag — collapses redundant points,
 * merges/joins with other wires, and builds the undo batch.
 */
export function commitSegmentDrag(app) {
    // Collapse zero-length segments and redundant collinear midpoints
    for (const wire of app.dragWireStates.keys()) {
        collapseRedundantWirePoints(app, wire);
    }

    // Build complete before-state map.
    // Dragged wires: captured at drag start (in app.dragWireStates).
    // All other wires: capture now (unchanged by the drag).
    const beforeAll = new Map(app.dragWireStates);
    for (const s of app.shapes) {
        if (s.type === 'wire' && !beforeAll.has(s)) {
            beforeAll.set(s, s.captureState());
        }
    }

    // Run unified reconciliation on all dragged wires
    const changedWires = [...app.dragWireStates.keys()].filter(w => app.shapes.includes(w));
    reconcileWires(app, changedWires);

    // Refresh pin connections for surviving changed wires
    for (const w of changedWires) {
        if (app.shapes.includes(w)) refreshWireConnections(app, w);
    }

    // Build undo batch by diffing pre-drag vs post-reconcile
    const batch = buildWireDiffBatch(app, beforeAll, 'Move wire segment');
    if (batch) app.history.execute(batch);
    app.renderShapes(true);
}
