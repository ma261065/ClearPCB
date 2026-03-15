/**
 * Drag commit and state cleanup.
 *
 * Called by mouse-states.js (handleDragEnd) and keyboard.js (Escape cancel)
 * when a drag interaction ends.  Each commit function creates undo commands
 * for the drag that just finished.
 *
 * clearDragState() resets all drag-related app fields back to idle.
 * UI cleanup (crosshairs, cursor, snap highlights) is the caller's
 * responsibility  the state machine or keyboard handler owns that.
 */

import { MoveShapesCommand, ModifyShapeCommand, DeleteShapesCommand, BatchCommand } from '../../core/CommandHistory.js';
import { reconcileWires, reconcileWiresWithUndo, refreshWireConnections, refreshNoConnectConnection, collapseRedundantWirePoints, buildWireDiffBatch } from './wire.js';
import { validateNetNameAtPoint } from './net-validation.js';
import { showAlert } from './modal.js';

/**
 * Compare two captured shape states for equality.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
export function areCapturedStatesEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

//  State reset 

/**
 * Reset all drag state. Callers handle UI cleanup.
 */
export function clearDragState(app) {
    if (app.drag?.shape) app.drag.shape.resetDragState();
    app.drag = null;
    app.pendingAnchorDrag = null;
}

//  Shared helpers 

/**
 * Build a complete before-state map for all wires: combine pre-drag
 * snapshots with current state of unchanged wires.
 * @param {object} app
 * @param {Map} preDragStates - Wire  state snapshots from drag start
 * @returns {Map}
 */
function buildBeforeAllWireStates(app, preDragStates) {
    const beforeAll = new Map(preDragStates);
    for (const s of app.shapes) {
        if (s.type === 'wire' && !beforeAll.has(s)) {
            beforeAll.set(s, s.captureState());
        }
    }
    return beforeAll;
}

/**
 * Capture label text states for all wires in the before-state map.
 * @param {object} app
 * @param {Map} beforeAll - Wire  state map
 * @returns {Map}
 */
function captureLabelTextStates(app, beforeAll) {
    const labelStates = new Map();
    for (const [w] of beforeAll) {
        if (w.labelText && app.shapes.includes(w.labelText)) {
            labelStates.set(w.labelText, w.labelText.captureState());
        }
    }
    return labelStates;
}

/**
 * Reconcile wires, refresh connections, and build the undo batch.
 * Shared by commitAnchorDrag and commitSegmentDrag.
 *
 * @param {object} app
 * @param {object[]} changedWires - Wires that were modified by the drag
 * @param {Map} beforeAll - Complete wire before-state map
 * @param {string} label - Undo command label
 * @param {Map} labelTextBefore - Label text before-states
 * @returns {BatchCommand|null}
 */
function reconcileAndBuildBatch(app, changedWires, beforeAll, label, labelTextBefore) {
    reconcileWires(app, changedWires);
    for (const w of changedWires) {
        if (app.shapes.includes(w)) refreshWireConnections(app, w);
    }
    return buildWireDiffBatch(app, beforeAll, label, [], labelTextBefore);
}

/**
 * Add NoConnect modify commands to a batch for shapes that moved.
 * @param {object} app
 * @param {BatchCommand} batch
 * @param {Array} ncLinks - Array of {nc, before} objects
 */
function addNoConnectCommands(app, batch, ncLinks) {
    if (!ncLinks) return;
    for (const link of ncLinks) {
        refreshNoConnectConnection(app, link.nc);
        const after = link.nc.captureState();
        if (!areCapturedStatesEqual(link.before, after)) {
            batch.add(new ModifyShapeCommand(app, link.nc, link.before, after));
        }
    }
}

/**
 * Push a batch to the undo stack if it has commands.
 * @param {object} app
 * @param {BatchCommand|null} batch
 */
function pushBatchIfNonEmpty(app, batch) {
    if (batch && batch.commands.length > 0) {
        app.history.record(batch);
    }
}

//  Anchor drag commit 

/**
 * Commit an anchor drag  wire merge, degenerate collapse, undo commands.
 *
 * @param {object} app
 * @param {object} dragShape - The shape being dragged
 * @param {object} beforeState - Shape state snapshot from drag start
 * @param {Map} [anchorWireStates] - T-junction linked wire before-states
 * @param {Array} [ncLinks] - NoConnect shapes that moved with anchor
 * @param {Map} [junctionBeforeWireStates] - Pre-junction-split wire states
 * @param {Map} [junctionBeforeLabelTextStates] - Pre-junction-split label states
 * @returns {boolean}
 */
export function commitAnchorDrag(app, dragShape, beforeState, anchorWireStates = null, ncLinks = null, junctionBeforeWireStates = null, junctionBeforeLabelTextStates = null) {
    if (!dragShape || !beforeState) return false;

    if (dragShape.type === 'net') {
        const check = validateNetNameAtPoint(
            app,
            { x: dragShape.x, y: dragShape.y },
            dragShape.net,
            dragShape.id
        );
        if (!check.ok) {
                showAlert(`Net conflict: this connected wire is already labeled "${check.conflictWith || ''}".`, { title: 'Net Conflict' });
            dragShape.applyState(beforeState);
            return false;
        }
    }

    if (dragShape.type === 'wire') {
        // Collapse redundant midpoints
        collapseRedundantWirePoints(app, dragShape);
        if (anchorWireStates) {
            for (const wire of anchorWireStates.keys()) {
                collapseRedundantWirePoints(app, wire);
            }
        }

        // Build before-state maps
        const preDragStates = junctionBeforeWireStates
            ? new Map(junctionBeforeWireStates)
            : (() => {
                const m = new Map();
                m.set(dragShape, beforeState);
                if (anchorWireStates) {
                    for (const [w, b] of anchorWireStates) m.set(w, b);
                }
                return m;
            })();

        const beforeAll = junctionBeforeWireStates
            ? preDragStates
            : buildBeforeAllWireStates(app, preDragStates);

        const labelTextBefore = junctionBeforeLabelTextStates
            ? new Map(junctionBeforeLabelTextStates)
            : captureLabelTextStates(app, beforeAll);

        // Reconcile and build undo
        const changedWires = [dragShape];
        if (anchorWireStates) {
            for (const wire of anchorWireStates.keys()) {
                if (app.shapes.includes(wire)) changedWires.push(wire);
            }
        }

        const batch = reconcileAndBuildBatch(app, changedWires, beforeAll, 'Move anchor', labelTextBefore);

        // Add NC commands
        const b = batch || new BatchCommand('Move anchor');
        addNoConnectCommands(app, b, ncLinks);
        pushBatchIfNonEmpty(app, batch || (b.commands.length > 0 ? b : null));

        // Select surviving dragged wire
        if (app.shapes.includes(dragShape)) {
            if (dragShape.edges.size > 0) dragShape.selected = true;
        }
        return true;
    }

    // Non-wire shape
    const wasRemoved = !app.shapes.includes(dragShape);
    const pts = dragShape.points;
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
        dragShape.applyState(beforeState);
        if (!app.shapes.includes(dragShape)) app.shapes.push(dragShape);
        app.history.execute(new DeleteShapesCommand(app, [dragShape]));
    } else {
        if (dragShape.type === 'noconnect') refreshNoConnectConnection(app, dragShape);
        const afterState = app._captureShapeState(dragShape);
        app._applyShapeState(dragShape, beforeState);
        app.history.execute(new ModifyShapeCommand(app, dragShape, beforeState, afterState));
        dragShape.selected = true;
    }
    return true;
}

//  Anchor drag resolution 

/**
 * Resolve anchor drag on mouseup: commit if moved, otherwise keep selected.
 *
 * @param {object} app
 * @param {object} dragShape
 * @param {object} beforeState
 * @param {boolean} didDrag
 * @param {Map} [anchorWireStates]
 * @param {Array} [ncLinks]
 * @param {Map} [junctionBeforeWireStates]
 * @param {Map} [junctionBeforeLabelTextStates]
 * @returns {boolean}
 */
export function resolveAnchorDragOnMouseUp(app, dragShape, beforeState, didDrag, anchorWireStates = null, ncLinks = null, junctionBeforeWireStates = null, junctionBeforeLabelTextStates = null) {
    if (!beforeState) return false;

    const hasLinkedWireChanges = !!(anchorWireStates && anchorWireStates.size > 0);
    if (didDrag || hasLinkedWireChanges) {
        commitAnchorDrag(app, dragShape, beforeState, anchorWireStates, ncLinks, junctionBeforeWireStates, junctionBeforeLabelTextStates);
        return true;
    }

    if (dragShape) dragShape.selected = true;
    return true;
}

//  Segment drag commit 

/**
 * Commit a wire-segment drag  collapse, reconcile, build undo batch.
 *
 * @param {object} app
 * @param {object} dragShape - The dragged wire
 * @param {Map} wireStates - Before-states for all affected wires
 * @param {Array} [ncLinks] - NoConnect shapes that moved
 * @param {object} [labelBefore] - Label text before-state
 * @returns {boolean}
 */
export function commitSegmentDrag(app, dragShape, wireStates, ncLinks = null, labelBefore = null) {
    if (!wireStates) return false;

    // Collapse redundant points
    for (const wire of wireStates.keys()) {
        collapseRedundantWirePoints(app, wire);
    }

    const beforeAll = buildBeforeAllWireStates(app, wireStates);
    const labelTextBefore = captureLabelTextStates(app, beforeAll);

    const changedWires = [...wireStates.keys()].filter(w => app.shapes.includes(w));
    const batch = reconcileAndBuildBatch(app, changedWires, beforeAll, 'Move wire segment', labelTextBefore);

    // Add NC + label commands
    const b = batch || new BatchCommand('Move wire segment');
    addNoConnectCommands(app, b, ncLinks);

    if (labelBefore && dragShape?.labelText) {
        const lt = dragShape.labelText;
        const after = lt.captureState();
        if (!areCapturedStatesEqual(labelBefore, after)) {
            b.add(new ModifyShapeCommand(app, lt, labelBefore, after));
        }
    }

    pushBatchIfNonEmpty(app, batch || (b.commands.length > 0 ? b : null));
    app.renderShapes(true);
    return true;
}

//  Segment drag revert 

/**
 * Revert temporary wire mutations when no drag movement occurred.
 *
 * @param {object} app
 * @param {Map} [wireStates] - Before-states to revert to
 * @returns {boolean}
 */
export function revertSegmentDragIfNoMove(app, wireStates) {
    if (!wireStates) return false;
    for (const [wire, state] of wireStates) {
        app._applyShapeState(wire, state);
    }
    return true;
}

//  Move drag commit 

/**
 * Commit a move drag  records MoveShapesCommand, reconciles wires,
 * and merges NoConnect updates into the undo entry.
 *
 * @param {object} app
 * @param {number} [totalDx]
 * @param {number} [totalDy]
 * @returns {boolean}
 */
export function commitMoveDrag(app, totalDx, totalDy) {
    const selectedShapes = app.selection.getSelection();
    const movedShapes = selectedShapes.filter(s => !s.locked);

    if (movedShapes.length === 0 || (totalDx === 0 && totalDy === 0)) return true;

    // Build moving component ID set
    const movingCompIds = new Set();
    for (const s of movedShapes) {
        if (s.definition) movingCompIds.add(s.id);
        if (s.type === 'wire') movingCompIds.add(s.id);
    }

    const itemsForCommand = movedShapes.filter(s =>
        !(s.parentComponent && movingCompIds.has(s.parentComponent.id)));

    // Revert movement so execute() can re-apply it
    for (const shape of itemsForCommand) {
        shape.move(-totalDx, -totalDy);
    }

    const command = new MoveShapesCommand(app, itemsForCommand, totalDx, totalDy);
    app.history.execute(command);

    // Post-move: reconcile wire overlaps
    const movedWires = movedShapes.filter(s => s.type === 'wire' && app.shapes.includes(s));
    if (movedWires.length > 0) {
        const reconcileBatch = reconcileWiresWithUndo(app, movedWires);
        if (reconcileBatch) {
            // Pop reconcile batch + MoveShapesCommand, combine into one
            app.history.popUndo(2);
            const combined = new BatchCommand('Move + wire cleanup');
            combined.add(command);
            for (const cmd of reconcileBatch.commands) combined.add(cmd);
            app.history.record(combined);
        }
    }

    // Post-move: refresh NoConnect connections
    const movedNCs = movedShapes.filter(s => s.type === 'noconnect');
    if (movedNCs.length > 0) {
        const ncCmds = [];
        for (const nc of movedNCs) {
            const beforeNC = app._captureShapeState(nc);
            refreshNoConnectConnection(app, nc);
            const afterNC = app._captureShapeState(nc);
            if (!areCapturedStatesEqual(beforeNC, afterNC)) {
                nc.applyState(beforeNC);
                ncCmds.push(new ModifyShapeCommand(app, nc, beforeNC, afterNC));
            }
        }
        if (ncCmds.length > 0) {
            const [top] = app.history.popUndo(1);
            const combined = top instanceof BatchCommand
                ? top
                : (() => { const b = new BatchCommand('Move + NC update'); b.add(top); return b; })();
            for (const cmd of ncCmds) combined.add(cmd);
            for (const cmd of ncCmds) cmd.execute();
            app.history.record(combined);
        }
    }

    return true;
}
