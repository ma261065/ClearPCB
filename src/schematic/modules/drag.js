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

import { MoveShapesCommand, ModifyShapeCommand, DeleteShapesCommand, AddShapeCommand, BatchCommand } from './commands.js';
import { reconcileWires, reconcileWiresWithUndo, refreshWireConnections, refreshNoConnectConnection, collapseRedundantWirePoints, buildWireDiffBatch } from './wire-reconcile.js';
import { updateSnapHighlight } from './wire.js';
import { validateNetNameAtPoint } from './net-validation.js';
import { connectNetToWires, disconnectNetFromWires, connectComponentPinsToWires } from './shape-management.js';
import { joinShapes } from '../../shapes/shape-join.js';
import { clearAxisGlow } from '../../shapes/axis-glow.js';
import { BULGE_EPS } from '../../shapes/arc-edge.js';
import { appendArcToLineCommand } from './context-menu.js';
import { refreshComponentPose } from './schematic-view.js';
import { applyShapeState, captureShapeState } from './selection.js';
import { setShapeNodeFocus, setShapeSegmentFocus } from './shape-focus.js';
import { isSchematicLocked } from '../../shapes/lock-owner.js';
import { getSchematicInteraction, setSchematicInteraction } from './schematic-interactions.js';
import { setDidSchematicDrag } from './draw-states.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../core/SchematicDocument.js').SchematicShape} SchematicShape */
/** @typedef {import('../../shapes/shape.js').Shape} Shape */
/** @typedef {SchematicShape} Wire */
/** @typedef {SchematicShape} Net */
/** @typedef {import('../../shapes/text.js').Text} Text */
/** @typedef {SchematicShape} NoConnect */
/** @typedef {import('../../core/CommandHistory.js').Command} Command */
/** @typedef {{x: number, y: number}} Point */
/** @typedef {any} ShapeState */
/** @typedef {{shape: SchematicShape, anchorId: string}} ShapeJoinTarget */
/** @typedef {{nc: NoConnect, before: ShapeState}} NoConnectLink */

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
 * @param {SchematicEditor} app
 * @returns {any}
 */
export function getSchematicDrag(app) {
    return getSchematicInteraction(app, 'drag');
}

/**
 * @param {SchematicEditor} app
 * @param {any} drag
 */
export function setSchematicDrag(app, drag) {
    setSchematicInteraction(app, 'drag', drag);
}

/** @param {SchematicEditor} app */
export function getPendingAnchorDrag(app) {
    return getSchematicInteraction(app, 'pendingAnchorDrag');
}

/**
 * @param {SchematicEditor} app
 * @param {any} pending
 */
export function setPendingAnchorDrag(app, pending) {
    setSchematicInteraction(app, 'pendingAnchorDrag', pending);
}

/** @param {SchematicEditor} app */
export function clearPendingAnchorDrag(app) {
    setPendingAnchorDrag(app, null);
}

/**
 * Reset all drag state. Callers handle UI cleanup.
 * @param {SchematicEditor} app
 */
export function clearDragState(app) {
    clearAxisGlow(app);
    const drag = getSchematicDrag(app);
    if (drag?.shape) drag.shape.resetDragState();
    setSchematicDrag(app, null);
    clearPendingAnchorDrag(app);
}

/*
 * Cancel handlers for the pointer gestures in schematic-interactions.js
 * (overlapCyclePress, drag, pendingAnchorDrag). Each restores the authored entities
 * its gesture edited in place and returns false when it had nothing to cancel.
 * schematic-interaction-routing.js runs them in the table's priority order. They are
 * function declarations so modules in an import cycle with this one can use them.
 */

/**
 * Cancel an anchor, segment or move drag or a box selection, restoring what it moved.
 * @param {SchematicEditor} app
 */
export function cancelDragGesture(app) {
    const state = app.interactionState;
    if (state === 'anchorDrag' || state === 'segmentDrag') {
        if (state === 'anchorDrag') {
            cancelSchematicShapeConversion(app);
            cancelSchematicPathSplit(app);
        }
        if (getSchematicDrag(app)?.beforeState && (state === 'anchorDrag' || getSchematicDrag(app).shape?.type === 'polyline')) {
            applyShapeState(app, getSchematicDrag(app).shape, getSchematicDrag(app).beforeState);
        }
        for (const [wire, beforeState] of getSchematicDrag(app)?.wireStates || []) {
            applyShapeState(app, wire, beforeState);
        }
        const shape = getSchematicDrag(app)?.shape;
        clearDragState(app);
        setDidSchematicDrag(app, false);
        app.viewport.svg.style.cursor = '';
        app.hideCrosshair();
        app.interactionState = 'idle';
        app.selection.keepSelected(shape);
        app.renderShapes(true);
        return true;
    }
    if (state === 'moveDrag' || state === 'boxSelect') {
        if (state === 'moveDrag') {
            restoreMoveDragStates(app);
            updateSnapHighlight(app, null);
        }
        clearDragState(app);
        setDidSchematicDrag(app, false);
        app.removeBoxSelectElement();
        app.viewport.svg.style.cursor = '';
        app.interactionState = 'idle';
        app.renderShapes(true);
        return true;
    }
    return false;
}

/**
 * Cancel a pending (pre-threshold) anchor drag or midpoint split.
 * @param {SchematicEditor} app
 */
export function cancelPendingAnchorDrag(app) {
    const { shape, preInsertState } = getPendingAnchorDrag(app);
    if (preInsertState) applyShapeState(app, shape, preInsertState);
    app.selection.keepSelected(shape);
    clearPendingAnchorDrag(app);
    app.viewport.svg.style.cursor = '';
    app.renderShapes(true);
    return true;
}

/**
 * Snapshot everything a move drag can change before its first movement: the moved
 * selection, the field and label texts that travel with it, and every wire (sticky
 * wires and junction propagation edit them). Cancelling restores these.
 * @param {SchematicEditor} app
 * @param {SchematicShape[]} selection
 * @returns {Map<SchematicShape, ShapeState>}
 */
export function captureMoveDragStates(app, selection) {
    const moved = new Set(selection);
    /** @type {Map<SchematicShape, ShapeState>} */
    const states = new Map();
    for (const item of selection) states.set(item, item.captureState());
    for (const shape of app.shapes) {
        if (states.has(shape)) continue;
        if (shape.type === 'wire' || (shape.parentComponent && moved.has(shape.parentComponent))) {
            states.set(shape, shape.captureState());
        }
    }
    return states;
}

/**
 * Undo a cancelled move drag's live changes from its snapshot, with one redraw.
 * @param {SchematicEditor} app
 */
function restoreMoveDragStates(app) {
    const states = getSchematicDrag(app)?.restoreStates;
    if (!states) return;
    for (const [entity, state] of states) {
        entity.applyState(state);
        if (/** @type {any} */ (entity).definition) refreshComponentPose(entity);
    }
    getSchematicDrag(app).restoreStates = null;
}

/** @param {SchematicEditor} app */
export function cancelSchematicPathSplit(app) {
    if (!getSchematicDrag(app)?.pathSplit) return false;
    const remainder = getSchematicDrag(app).splitRemainder;
    if (remainder && app.shapes.includes(remainder)) app.commandRemoveShape(remainder);
    getSchematicDrag(app).splitRemainder = null;
    return true;
}

/** @param {SchematicEditor} app */
export function cancelSchematicShapeConversion(app) {
    const conversion = getSchematicDrag(app)?.conversion;
    if (!conversion) return false;
    conversion.command.undo();
    getSchematicDrag(app).shape = conversion.original;
    getSchematicDrag(app).beforeState = conversion.original.captureState();
    getSchematicDrag(app).conversion = null;
    app.selection.select(conversion.original, false);
    app.updatePropertiesPanel?.(app.selection.getSelection());
    return true;
}

//  Shared helpers 

/**
 * Build a complete before-state map for all wires: combine pre-drag
 * snapshots with current state of unchanged wires.
 * @param {SchematicEditor} app
 * @param {Map<Wire, ShapeState>} preDragStates - Wire  state snapshots from drag start
 * @returns {Map<Wire, ShapeState>}
 */
function buildBeforeAllWireStates(app, preDragStates) {
    const beforeAll = new Map(preDragStates);
    for (const s of app.shapes) {
        if (s.type === 'wire' && !beforeAll.has(s)) {
            const wire = /** @type {Wire} */ (s);
            beforeAll.set(wire, wire.captureState());
        }
    }
    return beforeAll;
}

/**
 * Capture label text states for all wires in the before-state map.
 * @param {SchematicEditor} app
 * @param {Map<Wire, ShapeState>} beforeAll - Wire  state map
 * @returns {Map<Text, ShapeState>}
 */
function captureLabelTextStates(app, beforeAll) {
    /** @type {Map<Text, ShapeState>} */
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
 * @param {SchematicEditor} app
 * @param {Wire[]} changedWires - Wires that were modified by the drag
 * @param {Map<Wire, ShapeState>} beforeAll - Complete wire before-state map
 * @param {string} label - Undo command label
 * @param {Map<Text, ShapeState>} labelTextBefore - Label text before-states
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
 * @param {SchematicEditor} app
 * @param {BatchCommand} batch
 * @param {NoConnectLink[]|null} ncLinks - Array of {nc, before} objects
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
 * @param {SchematicEditor} app
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
 * @param {SchematicEditor} app
 * @param {SchematicShape} dragShape - The shape being dragged
 * @param {ShapeState} beforeState - Shape state snapshot from drag start
 * @param {Map<Wire, ShapeState>|null} [anchorWireStates] - T-junction linked wire before-states
 * @param {NoConnectLink[]|null} [ncLinks] - NoConnect shapes that moved with anchor
 * @param {Map<Wire, ShapeState>|null} [junctionBeforeWireStates] - Pre-junction-split wire states
 * @param {Map<Text, ShapeState>|null} [junctionBeforeLabelTextStates] - Pre-junction-split label states
 * @returns {boolean}
 */
export function commitAnchorDrag(app, dragShape, beforeState, anchorWireStates = null, ncLinks = null, junctionBeforeWireStates = null, junctionBeforeLabelTextStates = null) {
    if (!dragShape || !beforeState) return false;

    if (getSchematicDrag(app)?.conversion && getSchematicDrag(app).shape === dragShape) {
        const { command } = getSchematicDrag(app).conversion;
        getSchematicDrag(app).conversion = null;
        command.undo();
        const selectedShape = dragShape.type === 'arc' && Math.abs(dragShape.bulge) < BULGE_EPS
            ? appendArcToLineCommand(app, command, dragShape) : dragShape;
        app.history.execute(command);
        app.selection.select(selectedShape, false);
        setShapeNodeFocus(app, null);
        setShapeSegmentFocus(app, null);
        app.updatePropertiesPanel?.(app.selection.getSelection());
        return true;
    }

    if (getSchematicDrag(app)?.pathSplit && getSchematicDrag(app).shape === dragShape) {
        const after = dragShape.captureState();
        const remainder = getSchematicDrag(app).splitRemainder;
        cancelSchematicPathSplit(app);
        dragShape.applyState(beforeState);
        const batch = new BatchCommand('Split shape');
        batch.add(new ModifyShapeCommand(app, dragShape, beforeState, after));
        if (remainder) batch.add(new AddShapeCommand(app, remainder));
        app.history.execute(batch);
        app.fileManager?.setDirty?.(true);
        app.updatePropertiesPanel?.(app.selection.getSelection());
        return true;
    }

    if (dragShape.type === 'arc' && Math.abs(dragShape.bulge) < BULGE_EPS) {
        const after = dragShape.captureState();
        dragShape.applyState(beforeState);
        const batch = new BatchCommand('Convert arc to line');
        const line = appendArcToLineCommand(app, batch, dragShape, /** @type {import('./context-menu.js').ArcLineState} */ (after));
        app.history.execute(batch);
        app.selection.select(line, false);
        setShapeNodeFocus(app, null);
        setShapeSegmentFocus(app, null);
        app.updatePropertiesPanel?.(app.selection.getSelection());
        return true;
    }

    if (dragShape.type === 'net') {
        const check = validateNetNameAtPoint(
            app,
            { x: dragShape.x, y: dragShape.y },
            dragShape.net,
            dragShape.id
        );
        if (!check.ok) {
                app.alert(`Net conflict: this connected wire is already labeled "${check.conflictWith || ''}".`, { title: 'Net Conflict' });
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
                m.set(/** @type {Wire} */ (dragShape), beforeState);
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
        /** @type {Wire[]} */
        const changedWires = [/** @type {Wire} */ (dragShape)];
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

        // Post-commit check: refresh all wire connections, then check if
        // any wire now has two or more Net shapes with different names.
        for (const w of app.shapes) {
            if (w.type === 'wire') refreshWireConnections(app, w);
        }
        for (const w of app.shapes) {
            if (w.type !== 'wire') continue;
            const netNames = new Set();
            for (const [, conn] of w.pinConnections) {
                const ns = app.shapes.find(s => s.id === conn.componentId && s.type === 'net');
                if (ns?.net) netNames.add(ns.net);
            }
            if (netNames.size > 1) {
                const sorted = [...netNames].sort();
                app.alert?.(
                    `Cannot merge wire segments with different net names: "${sorted[0]}" and "${sorted[1]}".`,
                    { title: 'Net Conflict' }
                );
                app.history.undo();
                app.history.redoStack.pop();
                app.history._notifyChanged();
                app.renderShapes(true);
                return false;
            }
        }

        // Select surviving dragged wire
        if (app.shapes.includes(dragShape)) {
            if (dragShape.edges.size > 0) app.selection.keepSelected(dragShape);
        }
        return true;
    }

    // Non-wire shape
    const wasRemoved = !app.shapes.includes(dragShape);
    let degenerate = false;
    if (!wasRemoved) {
        if (dragShape.nodes && dragShape.edges) {
            // Check if an open polyline's endpoints now coincide → close it
            // (must check BEFORE cleanGraph, which would merge the co-located nodes)
            if (!dragShape.closed && !dragShape.type?.startsWith('wire')) {
                const leaves = dragShape.getLeafNodes();
                if (leaves.length === 2) {
                    const p1 = dragShape.nodes.get(leaves[0]);
                    const p2 = dragShape.nodes.get(leaves[1]);
                    if (p1 && p2 && Math.hypot(p1.x - p2.x, p1.y - p2.y) < 0.15) {
                        dragShape.addEdge(leaves[0], leaves[1]);
                        dragShape.closed = true;
                        if (dragShape.fillAlpha === 0) dragShape.fillAlpha = 0.3;
                    }
                }
            }

            // Graph-based shape: clean up collinear/zero-length edges
            dragShape.cleanGraph();
            degenerate = dragShape.edges.size === 0;

            if (!degenerate) {
                // Check if a closed shape collapsed to an open line
                if (dragShape.closed) {
                    const hasClosingLoop = dragShape.getLeafNodes().length === 0;
                    if (!hasClosingLoop) {
                        dragShape.closed = false;
                        dragShape.isRect = false;
                        dragShape.fill = false;
                    }
                }

                // Polygon→Rect promotion
                if (!dragShape.isRect && typeof dragShape.isAxisAlignedRect === 'function' && dragShape.isAxisAlignedRect()) {
                    dragShape.isRect = true;
                }
            }
        } else if (dragShape.points) {
            const pts = dragShape.points;
            if (pts.length >= 2) {
                degenerate = pts.every(/** @param {Point} p */ p =>
                    Math.abs(p.x - pts[0].x) < 1e-6 && Math.abs(p.y - pts[0].y) < 1e-6);
            } else if (pts.length < 2) {
                degenerate = true;
            }
        }
    }

    if (wasRemoved || degenerate) {
        dragShape.applyState(beforeState);
        if (!app.shapes.includes(dragShape)) app.shapes.push(dragShape);
        app.history.execute(new DeleteShapesCommand(app, [/** @type {Shape} */ (dragShape)]));
    } else {
        if (dragShape.type === 'noconnect') refreshNoConnectConnection(app, dragShape);
        const afterState = captureShapeState(app, /** @type {Shape} */ (dragShape));
        applyShapeState(app, /** @type {Shape} */ (dragShape), beforeState);
        app.history.execute(new ModifyShapeCommand(app, /** @type {Shape} */ (dragShape), beforeState, afterState));
        if (dragShape.type === 'net') {
            // After the command has placed the net at its new position,
            // disconnect from old wire and reconnect at new position
            disconnectNetFromWires(app, /** @type {Net} */ (dragShape));
            connectNetToWires(app, /** @type {Net} */ (dragShape));
        }
        app.selection.keepSelected(dragShape);
    }
    app.updatePropertiesPanel?.(app.selection?.getSelection?.() || []);
    return true;
}

//  Anchor drag resolution 

/**
 * Commit an endpoint join. Builds a single merged Polyline and replaces the
 * original shape or shapes as one undoable batch.
 *
 * Pure-geometry merge lives in shapes/shape-join.js so the PCB editor can
 * reuse it; this function only handles the schematic command/selection glue.
 *
 * @param {SchematicEditor} app
 * @param {SchematicShape} dragShape - The shape being dragged.
 * @param {string} dragAnchorId - The dragged endpoint anchor.
 * @param {ShapeJoinTarget} joinTarget - The shape/anchor dropped onto.
 * @param {ShapeState} beforeState - Pre-drag captured state of dragShape.
 * @returns {boolean}
 */
export function commitShapeJoin(app, dragShape, dragAnchorId, joinTarget, beforeState) {
    const merged = joinShapes(dragShape, dragAnchorId, joinTarget.shape, joinTarget.anchorId);
    if (!merged) {
        // Not actually joinable — fall back to a normal anchor move.
        return resolveAnchorDragOnMouseUp(app, dragShape, beforeState, true);
    }

    // Restore the dragged shape to its pre-drag geometry so that undo brings
    // back the two originals exactly as they were before the drag.
    if (beforeState) applyShapeState(app, /** @type {Shape} */ (dragShape), beforeState);

    const batch = new BatchCommand('Join shapes');
    const originals = joinTarget.shape === dragShape
        ? [dragShape]
        : [dragShape, joinTarget.shape];
    batch.add(new DeleteShapesCommand(app, originals));
    batch.add(new AddShapeCommand(app, merged));
    app.history.execute(batch);

    // Select the merged result.
    app.selection.select(merged);
    app.updatePropertiesPanel?.(app.selection?.getSelection?.() || []);
    app.renderShapes(true);
    return true;
}

/**
 * Resolve anchor drag on mouseup: commit if moved, otherwise keep selected.
 *
 * @param {SchematicEditor} app
 * @param {SchematicShape} dragShape
 * @param {ShapeState} beforeState
 * @param {boolean} didDrag
 * @param {Map<Wire, ShapeState>|null} [anchorWireStates]
 * @param {NoConnectLink[]|null} [ncLinks]
 * @param {Map<Wire, ShapeState>|null} [junctionBeforeWireStates]
 * @param {Map<Text, ShapeState>|null} [junctionBeforeLabelTextStates]
 * @returns {boolean}
 */
export function resolveAnchorDragOnMouseUp(app, dragShape, beforeState, didDrag, anchorWireStates = null, ncLinks = null, junctionBeforeWireStates = null, junctionBeforeLabelTextStates = null) {
    if (!beforeState) return false;

    const hasLinkedWireChanges = !!(anchorWireStates && anchorWireStates.size > 0);
    if (didDrag || hasLinkedWireChanges) {
        commitAnchorDrag(app, dragShape, beforeState, anchorWireStates, ncLinks, junctionBeforeWireStates, junctionBeforeLabelTextStates);
        return true;
    }

    app.selection.keepSelected(dragShape);
    return true;
}

//  Segment drag commit 

/**
 * Commit a wire-segment drag  collapse, reconcile, build undo batch.
 *
 * @param {SchematicEditor} app
 * @param {Wire} dragShape - The dragged wire
 * @param {Map<Wire, ShapeState>} wireStates - Before-states for all affected wires
 * @param {NoConnectLink[]|null} [ncLinks] - NoConnect shapes that moved
 * @param {ShapeState|null} [labelBefore] - Label text before-state
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

    // Post-commit check: net conflict
    for (const w of app.shapes) {
        if (w.type === 'wire') refreshWireConnections(app, w);
    }
    for (const w of app.shapes) {
        if (w.type !== 'wire') continue;
        const netNames = new Set();
        for (const [, conn] of w.pinConnections) {
            const ns = app.shapes.find(s => s.id === conn.componentId && s.type === 'net');
            if (ns?.net) netNames.add(ns.net);
        }
        if (netNames.size > 1) {
            const sorted = [...netNames].sort();
            app.alert?.(
                `Cannot merge wire segments with different net names: "${sorted[0]}" and "${sorted[1]}".`,
                { title: 'Net Conflict' }
            );
            app.history.undo();
            app.history.redoStack.pop();

            for (const rw of app.shapes) {
                if (rw.type === 'wire') refreshWireConnections(app, rw);
            }

            app.history._notifyChanged();
            app.renderShapes(true);
            return false;
        }
    }

    app.renderShapes(true);
    return true;
}

//  Segment drag revert 

/**
 * Revert temporary wire mutations when no drag movement occurred.
 *
 * @param {SchematicEditor} app
 * @param {Map<SchematicShape, ShapeState>|null} [wireStates] - Before-states to revert to
 * @returns {boolean}
 */
export function revertSegmentDragIfNoMove(app, wireStates) {
    if (!wireStates) return false;
    for (const [wire, state] of wireStates) {
        applyShapeState(app, /** @type {Shape} */ (wire), state);
    }
    return true;
}

//  Move drag commit 

/**
 * Commit a move drag  records MoveShapesCommand, reconciles wires,
 * and merges NoConnect updates into the undo entry.
 *
 * @param {SchematicEditor} app
 * @param {number} totalDx
 * @param {number} totalDy
 * @returns {boolean}
 */
export function commitMoveDrag(app, totalDx, totalDy) {
    const selectedShapes = app.selection.getSelection();
    const movedShapes = selectedShapes.filter(s => !isSchematicLocked(s));

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
        if (shape.definition) refreshComponentPose(shape);
    }

    const command = new MoveShapesCommand(app, itemsForCommand, totalDx, totalDy);
    app.history.execute(command);

    // Post-move: reconcile wire overlaps
    const movedWires = /** @type {Wire[]} */ (movedShapes.filter(s => s.type === 'wire' && app.shapes.includes(s)));
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
            const beforeNC = captureShapeState(app, /** @type {Shape} */ (nc));
            refreshNoConnectConnection(app, nc);
            const afterNC = captureShapeState(app, /** @type {Shape} */ (nc));
            if (!areCapturedStatesEqual(beforeNC, afterNC)) {
                /** @type {Shape} */ (nc).applyState(beforeNC);
                ncCmds.push(new ModifyShapeCommand(app, /** @type {Shape} */ (nc), beforeNC, afterNC));
            }
        }
        if (ncCmds.length > 0) {
            const [top] = app.history.popUndo(1);
            const combined = top instanceof BatchCommand
                ? top
                : (() => { const b = new BatchCommand('Move + NC update'); b.add(/** @type {Command} */ (top)); return b; })();
            for (const cmd of ncCmds) combined.add(cmd);
            for (const cmd of ncCmds) cmd.execute();
            app.history.record(combined);
        }
    }

    // Capture wire states before net reconnect side-effects so undo can
    // restore any split-edge/pinConnection mutations from reconnect logic.
    const wireStatesBefore = new Map();
    for (const w of app.shapes) {
        if (w.type === 'wire') wireStatesBefore.set(w.id, w.captureState());
    }

    // Post-move: reconnect moved Net shapes to wires at new positions
    const movedNets = movedShapes.filter(s => s.type === 'net');
    for (const netShape of movedNets) {
        disconnectNetFromWires(app, /** @type {Net} */ (netShape));
        connectNetToWires(app, /** @type {Net} */ (netShape));
    }

    // Post-move: like Net labels, if a moved component pin lands on a wire
    // segment interior, split the edge so the pin can connect at that point.
    const movedComponents = movedShapes.filter(s => s.definition && s.symbol?.pins);
    for (const comp of movedComponents) {
        connectComponentPinsToWires(app, comp);
    }

    // Post-move: refresh wire connections and capture state changes for undo
    for (const w of app.shapes) {
        if (w.type === 'wire') refreshWireConnections(app, w);
    }
    // Add wire state changes to the undo batch
    const wireModCmds = [];
    for (const w of app.shapes) {
        if (w.type !== 'wire') continue;
        const before = wireStatesBefore.get(w.id);
        if (!before) continue;
        const after = w.captureState();
        if (!areCapturedStatesEqual(before, after)) {
            w.applyState(before);
            wireModCmds.push(new ModifyShapeCommand(app, w, before, after));
        }
    }
    if (wireModCmds.length > 0) {
        const [top] = app.history.popUndo(1);
        const combined = top instanceof BatchCommand
            ? top
            : (() => { const b = new BatchCommand('Move + wire connections'); b.add(/** @type {Command} */ (top)); return b; })();
        for (const cmd of wireModCmds) combined.add(cmd);
        for (const cmd of wireModCmds) cmd.execute();
        app.history.record(combined);
    }

    // Post-move: check for net conflicts
    for (const w of app.shapes) {
        if (w.type !== 'wire') continue;
        const netNames = new Set();
        for (const [, conn] of w.pinConnections) {
            const ns = app.shapes.find(s => s.id === conn.componentId && s.type === 'net');
            if (ns?.net) netNames.add(ns.net);
        }
        if (netNames.size > 1) {
            const sorted = [...netNames].sort();
            app.alert?.(
                `Cannot merge wire segments with different net names: "${sorted[0]}" and "${sorted[1]}".`,
                { title: 'Net Conflict' }
            );
            app.history.undo();
            app.history.redoStack.pop();
            app.history._notifyChanged();
            app.renderShapes(true);
            return false;
        }
    }

    return true;
}
