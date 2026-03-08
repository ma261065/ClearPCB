/**
 * Drag commit and cleanup helpers.
 *
 * Extracted from mouse.js so drag-related undo logic is in one place.
 * clearDragState is the public reset function (also used by keyboard.js).
 * commitAnchorDrag / commitSegmentDrag handle undo-command creation when
 * the user finishes an anchor or segment drag.
 */

import { MoveShapesCommand, ModifyShapeCommand, DeleteShapesCommand, BatchCommand } from '../../core/CommandHistory.js';
import { updateSnapHighlight, reconcileWires, reconcileWiresWithUndo, refreshWireConnections, refreshNoConnectConnection, collapseRedundantWirePoints, buildWireDiffBatch } from './wire.js';

/**
 * Compare two captured states for semantic equality.
 * @param {any} beforeState
 * @param {any} afterState
 * @returns {boolean}
 */
export function areCapturedStatesEqual(beforeState, afterState) {
    return JSON.stringify(beforeState) === JSON.stringify(afterState);
}

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
    app.dragAnchorExcludePin = null;
    app.dragAnchorNCLinks = null;
    app.dragJunctionBeforeWireStates = null;
    app.dragJunctionBeforeLabelTextStates = null;
    app.dragSegmentNCLinks = null;
    app.dragSegmentLabelBefore = null;
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
        const beforeAll = app.dragJunctionBeforeWireStates
            ? new Map(app.dragJunctionBeforeWireStates)
            : new Map();

        if (!app.dragJunctionBeforeWireStates) {
            beforeAll.set(app.dragShape, app.dragShapesBefore);
            if (app.dragAnchorWireStates) {
                for (const [w, b] of app.dragAnchorWireStates) beforeAll.set(w, b);
            }
            for (const s of app.shapes) {
                if (s.type === 'wire' && !beforeAll.has(s)) {
                    beforeAll.set(s, s.captureState());
                }
            }
        }

        // Capture label text states before reconciliation
        const labelTextBefore = app.dragJunctionBeforeLabelTextStates
            ? new Map(app.dragJunctionBeforeLabelTextStates)
            : new Map();

        if (!app.dragJunctionBeforeLabelTextStates) {
            for (const [w] of beforeAll) {
                if (w.labelText && app.shapes.includes(w.labelText)) {
                    labelTextBefore.set(w.labelText, w.labelText.captureState());
                }
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

        // Refresh NoConnect shapes that moved with this anchor
        if (app.dragAnchorNCLinks) {
            for (const link of app.dragAnchorNCLinks) refreshNoConnectConnection(app, link.nc);
        }

        // Build undo batch by diffing pre-drag vs post-reconcile (pure snapshot)
        const batch = buildWireDiffBatch(app, beforeAll, 'Move anchor', [], labelTextBefore);

        // Add ModifyShapeCommands for NoConnect shapes that moved with the anchor
        if (app.dragAnchorNCLinks) {
            const b = batch || new BatchCommand('Move anchor');
            for (const link of app.dragAnchorNCLinks) {
                const after = link.nc.captureState();
                if (!areCapturedStatesEqual(link.before, after)) {
                    b.add(new ModifyShapeCommand(app, link.nc, link.before, after));
                }
            }
            if (!batch && b.commands.length > 0) {
                app.history.undoStack.push(b);
                app.history.redoStack = [];
                app.history._notifyChanged();
            }
        }

        if (batch) {
            app.history.undoStack.push(batch);
            app.history.redoStack = [];
            app.history._notifyChanged();
        }

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
        // Refresh noconnect pin connection after drag
        if (app.dragShape.type === 'noconnect') {
            refreshNoConnectConnection(app, app.dragShape);
        }
        const afterState = app._captureShapeState(app.dragShape);
        app._applyShapeState(app.dragShape, app.dragShapesBefore);
        app.history.execute(new ModifyShapeCommand(app, app.dragShape, app.dragShapesBefore, afterState));
        app.dragShape.selected = true;
    }
    return true;
}

/**
 * Resolve anchor drag end state: commit if movement occurred (or linked-wire
 * changes exist), otherwise keep the dragged shape selected.
 *
 * @param {object} app
 * @returns {boolean} True when anchor drag state was handled.
 */
export function resolveAnchorDragOnMouseUp(app) {
    if (app.dragMode !== 'anchor' || !app.dragShapesBefore) return false;

    const hasLinkedWireChanges = !!(app.dragAnchorWireStates && app.dragAnchorWireStates.size > 0);
    if (app.didDrag || hasLinkedWireChanges) {
        // Commit anchor drag: either user moved or junction was deleted
        commitAnchorDrag(app);
        return true;
    }

    // Anchor drag was initiated but no movement occurred - keep shape selected
    if (app.dragShape) {
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

    // Capture label text states before reconciliation
    const labelTextBefore = new Map();
    for (const [w] of beforeAll) {
        if (w.labelText && app.shapes.includes(w.labelText)) {
            labelTextBefore.set(w.labelText, w.labelText.captureState());
        }
    }

    // Run unified reconciliation on all dragged wires
    const changedWires = [...app.dragWireStates.keys()].filter(w => app.shapes.includes(w));
    reconcileWires(app, changedWires);

    // Refresh pin connections for surviving changed wires
    for (const w of changedWires) {
        if (app.shapes.includes(w)) refreshWireConnections(app, w);
    }

    // Refresh NoConnect shapes that moved with a segment drag
    if (app.dragSegmentNCLinks) {
        for (const link of app.dragSegmentNCLinks) refreshNoConnectConnection(app, link.nc);
    }

    // Build undo batch by diffing pre-drag vs post-reconcile (pure snapshot)
    const batch = buildWireDiffBatch(app, beforeAll, 'Move wire segment', [], labelTextBefore);

    // Add ModifyShapeCommands for NoConnect shapes that moved with the segment
    const b = batch || new BatchCommand('Move wire segment');
    if (app.dragSegmentNCLinks) {
        for (const link of app.dragSegmentNCLinks) {
            const after = link.nc.captureState();
            if (!areCapturedStatesEqual(link.before, after)) {
                b.add(new ModifyShapeCommand(app, link.nc, link.before, after));
            }
        }
    }

    // Add ModifyShapeCommand for wire label text that moved with the segment
    if (app.dragSegmentLabelBefore && app.dragShape?.labelText) {
        const lt = app.dragShape.labelText;
        const after = lt.captureState();
        const before = app.dragSegmentLabelBefore;
        if (!areCapturedStatesEqual(before, after)) {
            b.add(new ModifyShapeCommand(app, lt, before, after));
        }
    }

    const finalBatch = batch || (b.commands.length > 0 ? b : null);
    if (finalBatch) {
        app.history.undoStack.push(finalBatch);
        app.history.redoStack = [];
        app.history._notifyChanged();
    }
    app.renderShapes(true);
}

/**
 * Revert temporary wire mutations made at segment-drag start when no drag
 * movement actually occurred.
 *
 * @param {object} app
 * @returns {boolean} True when revert path was evaluated.
 */
export function revertSegmentDragIfNoMove(app) {
    if (!app.dragWireStates) return false;
    for (const [wire, state] of app.dragWireStates) {
        app._applyShapeState(wire, state);
    }
    return true;
}

/**
 * Commit an active move drag — records move undo, reconciles moved wires,
 * and merges NoConnect pin-connection updates into the same undo entry.
 *
 * @param {object} app
 * @returns {boolean} True when commit path was evaluated.
 */
export function commitMoveDrag(app) {
    const selectedShapes = app.selection.getSelection();
    const movedShapes = selectedShapes.filter(s => !s.locked);

    if (movedShapes.length > 0 && (app.dragTotalDx !== 0 || app.dragTotalDy !== 0)) {
        // Build set of moving component IDs to avoid double-reverting field texts
        const movingCompIds = new Set();
        for (const s of movedShapes) {
            if (s.definition) movingCompIds.add(s.id);
            if (s.type === 'wire') movingCompIds.add(s.id);
        }

        const itemsForCommand = movedShapes.filter(s =>
            !(s.parentComponent && movingCompIds.has(s.parentComponent.id)));

        for (const shape of itemsForCommand) {
            shape.move(-app.dragTotalDx, -app.dragTotalDy);
        }

        const command = new MoveShapesCommand(app, itemsForCommand, app.dragTotalDx, app.dragTotalDy);
        app.history.execute(command);

        // Post-move: reconcile wire overlaps, merges, and junctions
        const movedWires = movedShapes.filter(s => s.type === 'wire' && app.shapes.includes(s));
        if (movedWires.length > 0) {
            const reconcileBatch = reconcileWiresWithUndo(app, movedWires);
            if (reconcileBatch) {
                // Combine MoveShapesCommand + reconcile into a single undo entry
                app.history.undoStack.pop(); // pop reconcile batch
                app.history.undoStack.pop(); // pop MoveShapesCommand
                const combined = new BatchCommand('Move + wire cleanup');
                combined.add(command);
                for (const cmd of reconcileBatch.commands) combined.add(cmd);
                app.history.undoStack.push(combined);
                app.history.redoStack = [];
                app.history._notifyChanged();
            }
        }

        // Post-move: refresh pin connections for moved noconnect shapes
        // and record the pinConnection change as undo-able commands.
        const movedNCs = movedShapes.filter(s => s.type === 'noconnect');
        if (movedNCs.length > 0) {
            const ncCmds = [];
            for (const nc of movedNCs) {
                const beforeNC = app._captureShapeState(nc);
                refreshNoConnectConnection(app, nc);
                const afterNC = app._captureShapeState(nc);
                if (!areCapturedStatesEqual(beforeNC, afterNC)) {
                    nc.applyState(beforeNC); // revert so execute() applies it
                    ncCmds.push(new ModifyShapeCommand(app, nc, beforeNC, afterNC));
                }
            }

            if (ncCmds.length > 0) {
                // Merge into the top undo entry (MoveShapesCommand or combined batch)
                const top = app.history.undoStack.pop();
                const combined = top instanceof BatchCommand
                    ? top
                    : (() => { const b = new BatchCommand('Move + NC update'); b.add(top); return b; })();
                for (const cmd of ncCmds) combined.add(cmd);
                app.history.undoStack.push(combined);
                // Re-execute the NC commands so the state is applied
                for (const cmd of ncCmds) cmd.execute();
                app.history.redoStack = [];
                app.history._notifyChanged();
            }
        }
    }

    updateSnapHighlight(app, null);
    return true;
}
