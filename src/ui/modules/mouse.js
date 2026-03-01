import { MoveShapesCommand, ModifyShapeCommand, BatchCommand, AddShapeCommand, DeleteShapesCommand } from '../../core/CommandHistory.js';
import { Wire } from '../../shapes/wire.js';
import { updateStickyWires, processWireAnchorMerge, refreshWireConnections, updateSnapHighlight, resolveWireSnapPosition, renderGuideLines, computeAnchorCollinearSnap, computeSegmentDragSnap, computeStickyWireSnaps, applyOffGridNeighborSnap, isTJunctionPoint, cleanupOrphanedTJunctions, SNAP_SCREEN_PX, COLLINEAR_EPSILON, ANGLE_TOL } from './wire.js';

// Pre-allocated tool sets to avoid array creation in hot paths
const DRAWING_TOOLS = new Set(['line', 'rect', 'circle', 'polygon']);
const CLICK_TO_END_TOOLS = new Set(['rect', 'circle', 'arc']);

/**
 * Compute screen, world, and grid-snapped positions from a mouse event.
 */
function getEventPositions(e, viewport) {
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
    app.dragWireSegIndex = -1;
    app.dragSegAxis = null;
    app.dragWireStates = null;
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
function commitAnchorDrag(app) {
    if (!app.dragShape || !app.dragShapesBefore) return false;

    // After wire anchor drag: collapse duplicates, merge/join with other wires
    if (app.dragShape.type === 'wire') {
        processWireAnchorMerge(app, app.dragShape);
        refreshWireConnections(app, app.dragShape);
    }

    // Check if shape collapsed to a degenerate state (all points coincident)
    const pts = app.dragShape.points;
    let degenerate = false;
    if (pts && pts.length >= 2) {
        degenerate = pts.every(p =>
            Math.abs(p.x - pts[0].x) < 1e-6 &&
            Math.abs(p.y - pts[0].y) < 1e-6
        );
    } else if (pts && pts.length < 2) {
        degenerate = true;
    }

    // Build undo command(s) — includes T-junction linked wires if any
    const commands = [];
    if (degenerate) {
        app._applyShapeState(app.dragShape, app.dragShapesBefore);
        commands.push(new DeleteShapesCommand(app, [app.dragShape]));
    } else {
        const afterState = app._captureShapeState(app.dragShape);
        app._applyShapeState(app.dragShape, app.dragShapesBefore);
        commands.push(new ModifyShapeCommand(app, app.dragShape, app.dragShapesBefore, afterState));
    }
    if (app.dragAnchorWireStates) {
        for (const [wire, beforeState] of app.dragAnchorWireStates) {
            if (!app.shapes.includes(wire)) continue;
            const afterState = app._captureShapeState(wire);
            app._applyShapeState(wire, beforeState);
            commands.push(new ModifyShapeCommand(app, wire, beforeState, afterState));
        }
    }
    if (commands.length === 1) {
        app.history.execute(commands[0]);
    } else {
        const batch = new BatchCommand('Move anchor');
        for (const cmd of commands) batch.add(cmd);
        app.history.execute(batch);
    }
    if (!degenerate) app.dragShape.selected = true;
    return true;
}

/**
 * Detect whether an anchor point on a wire is at a T-junction.
 * Returns junction info or null if not a T-junction.
 *
 * Returned object:
 *   splitWire      – the wire with the collinear midpoint (to potentially unsplit)
 *   splitIdx       – index of that midpoint
 *   wireToDrag     – the wire whose endpoint should be attached to the cursor
 *                    (null when multiple connecting wires exist at a midpoint)
 *   dragAnchorId   – anchor id on wireToDrag (null when wireToDrag is null)
 *   shouldUnsplit  – true only if removing the connection leaves no other wires
 *                    still connected at the split point
 *   allConnecting  – array of { wire, end } for every wire with an endpoint here
 */
function detectTJunction(app, shape, anchorId) {
    if (shape.type !== 'wire') return null;
    const m = anchorId.match(/^p(\d+)$/);
    if (!m) return null;
    const anchorIdx = parseInt(m[1]);
    const pt = shape.points[anchorIdx];
    if (!pt) return null;

    const isEndpoint = anchorIdx === 0 || anchorIdx === shape.points.length - 1;

    if (isEndpoint) {
        // This wire's endpoint: look for another wire with a collinear midpoint here
        let splitWire = null, splitIdx = -1;
        for (const other of app.shapes) {
            if (other === shape || other.type !== 'wire') continue;
            for (let i = 1; i < other.points.length - 1; i++) {
                const op = other.points[i];
                if (Math.abs(op.x - pt.x) >= 0.15 || Math.abs(op.y - pt.y) >= 0.15) continue;
                // Check collinearity (junction-inserted midpoint)
                const a = other.points[i - 1], c = other.points[i + 1];
                const dx1 = op.x - a.x, dy1 = op.y - a.y;
                const dx2 = c.x - op.x, dy2 = c.y - op.y;
                const cross = Math.abs(dx1 * dy2 - dy1 * dx2);
                if (cross < ANGLE_TOL * Math.hypot(dx1, dy1) * Math.hypot(dx2, dy2) + 1e-9) {
                    splitWire = other;
                    splitIdx = i;
                    break;
                }
            }
            if (splitWire) break;
        }
        if (!splitWire) return null;

        // Count OTHER wires also connecting at this junction (excluding the
        // wire being detached and the split wire itself)
        const otherConnecting = [];
        for (const other of app.shapes) {
            if (other === shape || other === splitWire || other.type !== 'wire') continue;
            const end = other.endpointAt(pt, 0.15);
            if (end) otherConnecting.push({ wire: other, end });
        }

        return {
            splitWire, splitIdx,
            wireToDrag: shape, dragAnchorId: anchorId,
            shouldUnsplit: otherConnecting.length === 0,
            allConnecting: [
                { wire: shape, end: anchorIdx === 0 ? 'start' : 'end' },
                ...otherConnecting
            ]
        };
    } else {
        // Midpoint on the split wire: look for connecting wires' endpoints here
        const a = shape.points[anchorIdx - 1], b = pt, c = shape.points[anchorIdx + 1];
        const dx1 = b.x - a.x, dy1 = b.y - a.y;
        const dx2 = c.x - b.x, dy2 = c.y - b.y;
        const cross = Math.abs(dx1 * dy2 - dy1 * dx2);
        if (cross >= ANGLE_TOL * Math.hypot(dx1, dy1) * Math.hypot(dx2, dy2) + 1e-9) return null;

        // Find ALL wires with an endpoint at this junction
        const connecting = [];
        for (const other of app.shapes) {
            if (other === shape || other.type !== 'wire') continue;
            const end = other.endpointAt(pt, 0.15);
            if (end) connecting.push({ wire: other, end });
        }
        if (connecting.length === 0) return null;

        // Single connecting wire: drag it. Multiple: no drag (commit immediately).
        const single = connecting.length === 1;
        return {
            splitWire: shape, splitIdx: anchorIdx,
            wireToDrag: single ? connecting[0].wire : null,
            dragAnchorId: single
                ? (connecting[0].end === 'start' ? 'p0' : `p${connecting[0].wire.points.length - 1}`)
                : null,
            shouldUnsplit: true,
            allConnecting: connecting
        };
    }
}

/**
 * Delete a T-junction: remove the junction vertex from the split wire
 * (if no other wires remain connected), then attach the connecting wire's
 * endpoint to the mouse for dragging.  When multiple wires connect at
 * the junction, the unsplit is committed immediately with no drag.
 */
function deleteJunction(app, junctionInfo) {
    const { splitWire, splitIdx, wireToDrag, dragAnchorId, shouldUnsplit, allConnecting } = junctionInfo;

    if (wireToDrag) {
        // --- Single wire to detach (endpoint case, or midpoint with 1 connection) ---
        const dm = dragAnchorId.match(/^p(\d+)$/);
        const dragIdx = dm ? parseInt(dm[1]) : 0;
        const anchorPt = { x: wireToDrag.points[dragIdx].x, y: wireToDrag.points[dragIdx].y };

        const dragBefore = app._captureShapeState(wireToDrag);
        app.dragAnchorWireStates = new Map();

        if (shouldUnsplit) {
            // Last connection — remove the junction vertex
            const unsplitBefore = app._captureShapeState(splitWire);
            splitWire.points.splice(splitIdx, 1);
            const shifted = new Set();
            for (const j of splitWire.junctions) {
                if (j === splitIdx) continue;
                shifted.add(j > splitIdx ? j - 1 : j);
            }
            splitWire.junctions = shifted;
            splitWire.invalidate();
            app.dragAnchorWireStates.set(splitWire, unsplitBefore);
        }

        // Select the wire to drag
        app.selection.clearSelection();
        app.selection.select(wireToDrag, false);
        wireToDrag.selected = true;

        // Set up anchor drag state (click-to-place mode)
        app.isDragging = true;
        app.dragMode = 'anchor';
        app.dragAnchorId = dragAnchorId;
        app.dragShape = wireToDrag;
        app.dragShapesBefore = dragBefore;
        app.dragWireAnchorOriginal = { ...anchorPt };
        app.dragStart = { ...anchorPt };
        app.dragTotalDx = 0;
        app.dragTotalDy = 0;
        app.didDrag = false;
        app.dragAnchorTJLinks = [];

        app.renderShapes(true);
        app._showCrosshair();
        app._updateCrosshair(anchorPt);
        app.viewport.svg.style.cursor = 'move';
    } else {
        // --- Multiple connecting wires at a midpoint — commit immediately ---
        const batch = new BatchCommand('Delete junction');

        // Capture & unsplit
        const unsplitBefore = app._captureShapeState(splitWire);
        splitWire.points.splice(splitIdx, 1);
        const shifted = new Set();
        for (const j of splitWire.junctions) {
            if (j === splitIdx) continue;
            shifted.add(j > splitIdx ? j - 1 : j);
        }
        splitWire.junctions = shifted;
        splitWire.invalidate();

        const unsplitAfter = app._captureShapeState(splitWire);
        app._applyShapeState(splitWire, unsplitBefore);
        batch.add(new ModifyShapeCommand(app, splitWire, unsplitBefore, unsplitAfter));

        app.history.execute(batch);
        app.renderShapes(true);
    }
}

/**
 * Show a lightweight context menu for anchor point operations.
 */
function showAnchorContextMenu(app, shape, anchorId, clientX, clientY, canDeletePoint = true, junctionInfo = null) {
    // Remove any existing anchor context menu
    dismissAnchorContextMenu();

    const menu = document.createElement('div');
    menu.className = 'anchor-context-menu';
    menu.style.cssText = `
        position: fixed; left: ${clientX}px; top: ${clientY}px; z-index: 10000;
        background: #2b2b2b; border: 1px solid #555; border-radius: 4px;
        padding: 2px 0; box-shadow: 0 2px 8px rgba(0,0,0,0.4); min-width: 120px;
    `;

    if (canDeletePoint) {
        const item = document.createElement('div');
        item.textContent = 'Delete point';
        item.style.cssText = `
            padding: 6px 16px; color: #eee; cursor: pointer; font: 13px/1.4 system-ui, sans-serif;
            white-space: nowrap;
        `;
        item.addEventListener('mouseenter', () => item.style.background = '#3a3a3a');
        item.addEventListener('mouseleave', () => item.style.background = '');
        item.addEventListener('click', () => {
            dismissAnchorContextMenu();
            const beforeState = app._captureShapeState(shape);
            if (shape.deleteAnchor(anchorId)) {
                const afterState = app._captureShapeState(shape);
                app._applyShapeState(shape, beforeState);
                const command = new ModifyShapeCommand(app, shape, beforeState, afterState);
                app.history.execute(command);
                shape.selected = true;
                // Command's execute() already calls renderShapes(true)
            }
        });
        menu.appendChild(item);
    }

    if (junctionInfo) {
        const jItem = document.createElement('div');
        jItem.textContent = 'Delete junction';
        jItem.style.cssText = `
            padding: 6px 16px; color: #eee; cursor: pointer; font: 13px/1.4 system-ui, sans-serif;
            white-space: nowrap;
        `;
        jItem.addEventListener('mouseenter', () => jItem.style.background = '#3a3a3a');
        jItem.addEventListener('mouseleave', () => jItem.style.background = '');
        jItem.addEventListener('click', () => {
            dismissAnchorContextMenu();
            deleteJunction(app, junctionInfo);
        });
        menu.appendChild(jItem);
    }

    document.body.appendChild(menu);

    // Dismiss on any click or escape
    const dismiss = (e) => {
        if (!menu.contains(e.target)) dismissAnchorContextMenu();
    };
    const dismissOnKey = (e) => {
        if (e.key === 'Escape') dismissAnchorContextMenu();
    };
    // Use setTimeout so the current event doesn't immediately dismiss
    setTimeout(() => {
        document.addEventListener('mousedown', dismiss, { capture: true });
        document.addEventListener('keydown', dismissOnKey, { capture: true });
    }, 0);

    // Store cleanup references
    menu._dismissHandlers = { dismiss, dismissOnKey };
}

function dismissAnchorContextMenu() {
    const existing = document.querySelector('.anchor-context-menu');
    if (existing) {
        if (existing._dismissHandlers) {
            document.removeEventListener('mousedown', existing._dismissHandlers.dismiss, { capture: true });
            document.removeEventListener('keydown', existing._dismissHandlers.dismissOnKey, { capture: true });
        }
        existing.remove();
    }
}

/**
 * Show a context menu for wire segment operations (delete segment).
 */
function showSegmentContextMenu(app, wire, segIdx, clientX, clientY) {
    dismissAnchorContextMenu();

    const menu = document.createElement('div');
    menu.className = 'anchor-context-menu';
    menu.style.cssText = `
        position: fixed; left: ${clientX}px; top: ${clientY}px; z-index: 10000;
        background: #2b2b2b; border: 1px solid #555; border-radius: 4px;
        padding: 2px 0; box-shadow: 0 2px 8px rgba(0,0,0,0.4); min-width: 120px;
    `;

    const item = document.createElement('div');
    item.textContent = 'Delete segment';
    item.style.cssText = `
        padding: 6px 16px; color: #eee; cursor: pointer; font: 13px/1.4 system-ui, sans-serif;
        white-space: nowrap;
    `;
    item.addEventListener('mouseenter', () => item.style.background = '#3a3a3a');
    item.addEventListener('mouseleave', () => item.style.background = '');
    item.addEventListener('click', () => {
        dismissAnchorContextMenu();
        deleteWireSegment(app, wire, segIdx);
    });
    menu.appendChild(item);
    document.body.appendChild(menu);

    const dismiss = (e) => {
        if (!menu.contains(e.target)) dismissAnchorContextMenu();
    };
    const dismissOnKey = (e) => {
        if (e.key === 'Escape') dismissAnchorContextMenu();
    };
    setTimeout(() => {
        document.addEventListener('mousedown', dismiss, { capture: true });
        document.addEventListener('keydown', dismissOnKey, { capture: true });
    }, 0);
    menu._dismissHandlers = { dismiss, dismissOnKey };
}

/**
 * Delete a wire segment.  If the wire has only one segment, delete the
 * whole wire.  Otherwise split the wire into the left part (points
 * 0..segIdx) and the right part (points segIdx+1..end), keeping only
 * halves that have >= 2 points.
 */
function deleteWireSegment(app, wire, segIdx) {
    const batch = new BatchCommand('Delete segment');

    // Capture endpoints of the segment being deleted (for T-junction cleanup)
    const segPt1 = { x: wire.points[segIdx].x, y: wire.points[segIdx].y };
    const segPt2 = { x: wire.points[segIdx + 1].x, y: wire.points[segIdx + 1].y };

    // Remove original wire
    batch.add(new DeleteShapesCommand(app, [wire]));

    // Build left and right halves
    const leftPts  = wire.points.slice(0, segIdx + 1);
    const rightPts = wire.points.slice(segIdx + 1);

    if (leftPts.length >= 2) {
        const leftWire = new Wire({
            points: leftPts.map(p => ({ x: p.x, y: p.y })),
            color: wire.color || '#00cc66',
            lineWidth: wire.lineWidth || 0.25,
            connections: {
                start: wire.connections?.start ? { ...wire.connections.start } : null,
                end: null
            }
        });
        batch.add(new AddShapeCommand(app, leftWire));
    }

    if (rightPts.length >= 2) {
        const rightWire = new Wire({
            points: rightPts.map(p => ({ x: p.x, y: p.y })),
            color: wire.color || '#00cc66',
            lineWidth: wire.lineWidth || 0.25,
            connections: {
                start: null,
                end: wire.connections?.end ? { ...wire.connections.end } : null
            }
        });
        batch.add(new AddShapeCommand(app, rightWire));
    }

    // Clean up orphaned T-junction vertices on other wires.
    // A segment endpoint is "orphaned" when no half-wire survives to cover it.
    const orphanedPts = [];
    if (leftPts.length < 2) orphanedPts.push(segPt1);
    if (rightPts.length < 2) orphanedPts.push(segPt2);
    for (const { wire: w, beforeState, afterState } of cleanupOrphanedTJunctions(app, orphanedPts, [wire])) {
        batch.add(new ModifyShapeCommand(app, w, beforeState, afterState));
    }

    app.history.execute(batch);
}

export function bindMouseEvents(app) {
    const svg = app.viewport.svg;

    svg.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (app.viewport.isPanning) return;

        const activeTab = document.querySelector('.ribbon-tab.active');
        if (activeTab?.dataset?.tab === 'file') {
            app._setActiveRibbonTab?.('home');
        }

        // Commit active click-to-place anchor drag on the confirming click
        if (app.isDragging && app.dragMode === 'anchor' && app.dragShapesBefore &&
            (app.didDrag || (app.dragAnchorWireStates && app.dragAnchorWireStates.size > 0))) {
            commitAnchorDrag(app);
            clearDragState(app);
            app.renderShapes(true);
            app.didDrag = true;   // prevent click handler from re-selecting
            e.preventDefault();
            return;
        }

        app.didDrag = false;
        
        // Clear any pending anchor drag that might be lingering from previous interaction
        // This ensures we don't get confused by stale pending state
        if (app.pendingAnchorDrag && !app.isDragging) {
            app.pendingAnchorDrag = null;
        }

        const { screenPos, worldPos, snapped } = getEventPositions(e, app.viewport);

        if (app.pastingClipboard) {
            app._confirmPaste(snapped);
            e.preventDefault();
            return;
        }

        if (app.placingComponent) {
            app._placeComponent(snapped);
            e.preventDefault();
            return;
        }

        if (app.currentTool === 'select') {
            const selectedShapes = app.selection.getSelection();
            for (const shape of selectedShapes) {
                if (shape.locked) continue;
                const anchorId = shape.hitTestAnchor(worldPos, app.viewport.scale);
                if (anchorId) {
                    // For midpoint anchors, immediately insert the point
                    // so visual feedback (anchor square + move cursor) is instant
                    if (anchorId.startsWith('mid') && (shape.type === 'line' || shape.type === 'polygon' || shape.type === 'wire')) {
                        const beforeState = app._captureShapeState(shape);
                        const newAnchorId = shape.moveAnchor(anchorId, snapped.x, snapped.y);
                        app.renderShapes(true);
                        app.viewport.svg.style.cursor = 'move';
                        app.pendingAnchorDrag = {
                            shape,
                            anchorId: newAnchorId || anchorId,
                            screenPos: { ...screenPos },
                            snapped: { ...snapped },
                            preInsertState: beforeState
                        };
                    } else {
                        // Defer anchor drag until the mouse actually moves
                        app.pendingAnchorDrag = {
                            shape,
                            anchorId,
                            screenPos: { ...screenPos },
                            snapped: { ...snapped }
                        };
                    }
                    e.preventDefault();
                    return;
                }
            }
            let hitShape = app.selection.hitTest(worldPos);

            // Shift+Click: Cycle through overlapping shapes
            // Note: Ctrl is reserved for Multi-Select (Additive)
            if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
                 // Important: Use a larger tolerance for "cycling" to make it easier to grab things
                 // Temporarily boost tolerance
                 const originalTolerance = app.selection.tolerance;
                 app.selection.tolerance = 2.0; // Boost tolerance for finding overlapping stuff
                 
                 const hits = app.selection.hitTest(worldPos, true);
                 
                 // Restore tolerance
                 app.selection.tolerance = originalTolerance;

                 if (hits && hits.length > 0) {
                     // Try to find currently selected shape in the hit list
                     const selectedIndex = hits.findIndex(h => h.selected);
                     
                     // If something is selected in this stack, pick the next one
                     // If nothing is selected (selectedIndex = -1), pick the first one (index 0)
                     const nextIndex = (selectedIndex + 1) % hits.length;
                     
                     hitShape = hits[nextIndex];

                     // Explicitly clear selection first to be absolutely sure
                     app.selection.clearSelection();
                     
                     // Update selection immediately
                     app.selection.select(hitShape, false);
                     app.renderShapes(true);
                 }
                
                // Stop here - Disable dragging while holding Shift
                app.skipClickSelection = true;
                e.preventDefault();
                return;
            }

            if (hitShape) {
                const additive = e.ctrlKey || e.metaKey;
                if (additive) {
                    app.selection.toggle(hitShape);
                    app.renderShapes(true);
                    app.skipClickSelection = true;
                    e.preventDefault();
                    return;
                }
                if (!hitShape.selected) {
                    app.selection.select(hitShape, false);
                    app.renderShapes(true);
                }

                if (hitShape.locked) {
                    e.preventDefault();
                    return;
                }

                // Wire segment drag: when a single wire is clicked, drag
                // only the clicked segment (neighbors rubber-band).
                if (hitShape.type === 'wire' && app.selection.getSelection().length === 1) {
                    const segIdx = hitShape.hitTestSegment(worldPos, SNAP_SCREEN_PX / app.viewport.scale);
                    if (segIdx >= 0) {
                        app.isDragging = true;
                        app.dragMode = 'wire-segment';
                        app.dragShape = hitShape;
                        app.dragWireSegIndex = segIdx;
                        app.dragStartWorldPos = { ...worldPos };
                        app.dragTotalDx = 0;
                        app.dragTotalDy = 0;
                        // Determine axis lock: H segments move only vertically, V only horizontally.
                        // For simple 2-point wires (single segment), allow free movement.
                        if (hitShape.points.length > 2) {
                            const pA = hitShape.points[segIdx], pB = hitShape.points[segIdx + 1];
                            const sDx = Math.abs(pB.x - pA.x), sDy = Math.abs(pB.y - pA.y);
                            if (sDy < COLLINEAR_EPSILON && sDx > COLLINEAR_EPSILON) app.dragSegAxis = 'vertical';       // horizontal segment
                            else if (sDx < COLLINEAR_EPSILON && sDy > COLLINEAR_EPSILON) app.dragSegAxis = 'horizontal'; // vertical segment
                            else app.dragSegAxis = null;  // diagonal — free movement
                        } else {
                            app.dragSegAxis = null;  // 2-point wire — free movement
                        }
                        // Capture before-state of this wire + any T-junction wires
                        app.dragWireStates = new Map();
                        app.dragWireStates.set(hitShape, app._captureShapeState(hitShape));
                        // Record which points on OTHER wires coincide with this
                        // wire's points at drag start, so we only move those
                        // (prevents "capturing" unrelated junctions mid-drag).
                        app.dragTJunctionLinks = [];
                        for (let pi = 0; pi < hitShape.points.length; pi++) {
                            const pt = hitShape.points[pi];
                            for (const other of app.shapes) {
                                if (other === hitShape || other.type !== 'wire') continue;
                                for (let oi = 0; oi < other.points.length; oi++) {
                                    const op = other.points[oi];
                                    if (Math.abs(pt.x - op.x) < COLLINEAR_EPSILON && Math.abs(pt.y - op.y) < COLLINEAR_EPSILON) {
                                        app.dragTJunctionLinks.push({ wireIdx: pi, otherWire: other, otherIdx: oi });
                                        if (!app.dragWireStates.has(other)) {
                                            app.dragWireStates.set(other, app._captureShapeState(other));
                                        }
                                    }
                                }
                            }
                        }
                        app.viewport.svg.style.cursor = 'move';
                        e.preventDefault();
                        return;
                    }
                }

                app.isDragging = true;
                app.dragMode = 'move';
                // Store the actual unsnapped position of the first selected shape
                const firstShape = app.selection.getSelection()[0];
                if (firstShape) {
                    app.dragObjectStartPos = firstShape.getPosition();
                } else {
                    app.dragObjectStartPos = { ...snapped };
                }
                // Snap the *mouse* start to grid so drag deltas are grid-aligned,
                // but do NOT move the object to grid (avoids jump for off-grid items).
                app.dragStart = { ...app.dragObjectStartPos };
                app.dragLastSnapped = { ...app.dragObjectStartPos };
                app.dragTotalDx = 0;
                app.dragTotalDy = 0;
                app.dragStartWorldPos = { ...worldPos };
                app.viewport.svg.style.cursor = 'move';
                app.renderShapes(true);
                e.preventDefault();
                return;
            }

            app.isDragging = true;
            app.dragMode = 'box';
            app.boxSelectStart = { ...worldPos };
            app.selection.captureBoxSelectBase();
            app._createBoxSelectElement();
            e.preventDefault();
            return;
        } else if (app.currentTool === 'wire') {
            if (!app.isDrawing) {
                // Deselect everything so anchors are hidden while drawing
                for (const s of app.shapes) {
                    if (s.selected) { s.selected = false; s.invalidate(); }
                }
                for (const c of app.components) {
                    if (c.selected) { c.selected = false; c.invalidate(); }
                }
                app.selection.clearSelection();
                app.renderShapes(true);
                // Use the unified snap resolver — same logic as pre-draw hover
                const snap = resolveWireSnapPosition(app, worldPos, { pinTolerance: 0.5 });
                const startData = { x: snap.x, y: snap.y, snapPin: snap.snapPin || null };
                app._startWireDrawing(startData);
            } else if (app.drawCurrent) {
                // When finishing on a wire junction (segment T-junction), snap
                // the final endpoint to the junction position on the wire.
                let waypointPos = { x: app.drawCurrent.x, y: app.drawCurrent.y };
                if (app._wireJunctionDot && app._wireJunctionData) {
                    waypointPos = { x: app._wireJunctionData.x, y: app._wireJunctionData.y };
                    // Update drawCurrent so finishWireDrawing doesn't add a
                    // conflicting point from the old grid-snapped position
                    app.drawCurrent = { ...waypointPos };
                }
                // If there's an auto-corner (T-junction), add the corner
                // point first so the wire gets the L-shaped path.
                if (app.drawCorner) {
                    app._addWireWaypoint({
                        x: app.drawCorner.x, y: app.drawCorner.y, snapPin: null
                    });
                }
                app._addWireWaypoint({
                    ...waypointPos,
                    snapPin: app.lastSnappedData?.snapPin || null
                });
                // Auto-finish if clicked on a pin or a wire junction dot
                if (app.wirePoints.length >= 2 &&
                    (app.lastSnappedData?.snapPin || app._wireJunctionDot)) {
                    app._finishWireDrawing(app.lastSnappedData);
                }
            }
            e.preventDefault();
        } else if (app.currentTool === 'line') {
            if (!app.isDrawing) {
                app._startDrawing(snapped);
            } else {
                app._addLinePoint(snapped);
            }
        } else if (app.currentTool === 'polygon') {
            if (!app.isDrawing) {
                app._startDrawing(snapped);
            } else {
                app._addPolygonPoint(snapped);
            }
        } else if (app.currentTool === 'arc') {
            if (!app.isDrawing) {
                // Start arc: first endpoint
                app._startDrawing(snapped);
            } else if (!app.arcEndpoint) {
                // Second endpoint - show a straight line as initial preview
                app.arcEndpoint = { x: snapped.x, y: snapped.y };
                app.drawCurrent = { x: snapped.x, y: snapped.y };
                app._updateDrawing(app.drawCurrent);
            } else {
                // Third point (bulge) - finish arc on left click (unsnapped)
                app._updateDrawing(worldPos);
                app._finishDrawing(worldPos);
                app._setToolCursor(app.currentTool, app.viewport.svg);
            }
        } else if (app.currentTool === 'rect' || app.currentTool === 'circle') {
             if (!app.isDrawing) {
                 app._startDrawing(snapped);
             } else {
                 app._finishDrawing(snapped);
             }
        } else {
            // Default fallback for any other tools in future
             if (!app.isDrawing) {
                app._startDrawing(snapped);
             } else {
                 app._finishDrawing(snapped);
             }
        }
    });

    svg.addEventListener('mousedown', (e) => {
        if (e.button !== 2) return;
        // Record right-click start position to detect drag vs click on mouseup
        app._rightClickStart = { x: e.clientX, y: e.clientY };
    });

    svg.addEventListener('mouseup', (e) => {
        if (e.button !== 2) return;
        // Only finish drawing tools if we didn't drag (pan) during right-click
        const start = app._rightClickStart;
        app._rightClickStart = null;
        if (!start) return;
        const movedDist = Math.hypot(e.clientX - start.x, e.clientY - start.y);
        if (movedDist > 3) return; // dragged — was a pan, don't finish

        const { worldPos, snapped } = getEventPositions(e, app.viewport);

        if (app.currentTool === 'wire' && app.isDrawing && app.wirePoints.length >= 1) {
            app._finishWireDrawing(app.drawCurrent || worldPos);
        } else if (app.currentTool === 'arc' && app.isDrawing && app.arcEndpoint) {
            app._updateDrawing(worldPos);
            app._finishDrawing(worldPos);
        } else if (app.currentTool === 'line' && app.isDrawing && app.linePoints && app.linePoints.length >= 2) {
            app._addLinePoint(snapped);
            app._finishLine();
        } else if (app.currentTool === 'polygon' && app.isDrawing) {
            app._addPolygonPoint(snapped);
            app._finishPolygon();
        } else {
            return; // No matching tool — skip preventDefault and cursor reset
        }
        app._setToolCursor(app.currentTool, app.viewport.svg);
        e.preventDefault();
    });

    svg.addEventListener('contextmenu', (e) => {
        const { screenPos, worldPos } = getEventPositions(e, app.viewport);

        // Anchor right-click context menu (select tool, on point anchors)
        if (app.currentTool === 'select') {
            const selectedShapes = app.selection.getSelection();
            for (const shape of selectedShapes) {
                if (shape.locked) continue;
                const anchorId = shape.hitTestAnchor(worldPos, app.viewport.scale);
                if (anchorId && anchorId.startsWith('p')) {
                    const minPoints = shape.type === 'polygon' ? 4 : 3;
                    const canDeletePoint = typeof shape.deleteAnchor === 'function' &&
                                           shape.points && shape.points.length >= minPoints;
                    const junctionInfo = detectTJunction(app, shape, anchorId);
                    if (canDeletePoint || junctionInfo) {
                        showAnchorContextMenu(app, shape, anchorId, e.clientX, e.clientY, canDeletePoint, junctionInfo);
                        e.preventDefault();
                        return;
                    }
                }
            }

            // Junction right-click: if no selected shape matched, scan all
            // wires for a T-junction at this position so the user can
            // right-click a junction dot without pre-selecting a wire.
            // Use a tolerance that covers the visible junction dot radius.
            const junctionTol = Math.max(0.5, 3 / app.viewport.scale);
            for (const wire of app.shapes) {
                if (wire.type !== 'wire' || wire.locked) continue;
                for (let i = 0; i < wire.points.length; i++) {
                    const p = wire.points[i];
                    if (Math.abs(p.x - worldPos.x) > junctionTol || Math.abs(p.y - worldPos.y) > junctionTol) continue;
                    const anchorId = `p${i}`;
                    const junctionInfo = detectTJunction(app, wire, anchorId);
                    if (junctionInfo) {
                        // Select the wire so anchors become visible
                        app.selection.clearSelection();
                        app.selection.select(wire, false);
                        wire.selected = true;
                        app.renderShapes(true);
                        const minPoints = wire.points.length >= 3;
                        showAnchorContextMenu(app, wire, anchorId, e.clientX, e.clientY, minPoints, junctionInfo);
                        e.preventDefault();
                        return;
                    }
                }
            }
        }

        // Wire segment right-click context menu (select tool, single wire selected)
        if (app.currentTool === 'select') {
            const selectedShapes = app.selection.getSelection();
            for (const shape of selectedShapes) {
                if (shape.locked || shape.type !== 'wire') continue;
                const segTolerance = SNAP_SCREEN_PX / app.viewport.scale;
                const segIdx = shape.hitTestSegment(worldPos, segTolerance);
                if (segIdx >= 0) {
                    showSegmentContextMenu(app, shape, segIdx, e.clientX, e.clientY);
                    e.preventDefault();
                    return;
                }
            }
        }

        if (app.showComponentDebugTooltip !== false) {
            const hitComponent = app._findComponentAt?.(worldPos);
            if (hitComponent) {
                app._pinComponentCodeTooltip?.(hitComponent, screenPos);
            } else {
                app._updateComponentCodeTooltip?.(null, null, { forceHide: true });
            }
        }
        if (app.currentTool !== 'select') {
            app._setToolCursor(app.currentTool, app.viewport.svg);
        }
        e.preventDefault();
    });

    svg.addEventListener('mousemove', (e) => {
        const { screenPos, worldPos, snapped } = getEventPositions(e, app.viewport);

        if (app.showComponentDebugTooltip !== false && !app.isDragging && !app.viewport.isPanning && !app.placingComponent && !app._componentCodeTooltipPinned) {
            const hitComponent = app._findComponentAt?.(worldPos);
            app._updateComponentCodeTooltip?.(hitComponent, screenPos);
        } else {
            if (!app._componentCodeTooltipPinned) {
                app._updateComponentCodeTooltip?.(null, screenPos);
            }
        }

        // Always update paste/component preview if active.
        // This must happen before any tool-specific logic or returns.
        if (app.pastingClipboard) {
            app._updatePastePreview(snapped);
        }
        if (app.placingComponent) {
            app._updateComponentPreview(snapped);
        }

        if (app.currentTool === 'wire') {
            if (app.isDrawing) {
                app._updateWireDrawing(worldPos);
            } else {
                // Not drawing — highlight pins and wire endpoints/segments on hover
                // Uses the unified snap resolver for consistent priority logic
                const snap = resolveWireSnapPosition(app, worldPos, { pinTolerance: 0.5 });
                if (snap.snapType === 'pin') {
                    updateSnapHighlight(app, snap.snapPin);
                } else if (snap.snapType === 'endpoint' || snap.snapType === 'segment') {
                    updateSnapHighlight(app, { x: snap.x, y: snap.y, type: snap.snapType });
                } else {
                    updateSnapHighlight(app, null);
                }
            }
            app._showCrosshair();
            app._updateCrosshair(snapped, screenPos);
            return;
        }
        
        // Update drawing preview for arc (bulge point not grid-snapped) and other tools
        if (app.isDrawing) {
            if (app.currentTool === 'arc') {
                // For arc: first stage uses snapped, second stage (bulge) uses worldPos
                app._updateDrawing(app.arcEndpoint ? worldPos : snapped);
            } else if (DRAWING_TOOLS.has(app.currentTool)) {
                // For other tools, use snapped position
                app._updateDrawing(snapped);
            }
        }

        if (app.currentTool !== 'select') {
            app._showCrosshair();
            app._updateCrosshair(snapped, screenPos);
        }

        if (!app.isDragging) {
            // Start deferred anchor drag once movement exceeds threshold
            if (app.pendingAnchorDrag) {
                const dx = screenPos.x - app.pendingAnchorDrag.screenPos.x;
                const dy = screenPos.y - app.pendingAnchorDrag.screenPos.y;
                const moved = Math.hypot(dx, dy);
                if (moved >= 3) {
                    const { shape, anchorId, snapped: startSnapped, preInsertState } = app.pendingAnchorDrag;
                    app.pendingAnchorDrag = null;
                    app.isDragging = true;
                    app.dragMode = 'anchor';
                    app.dragStart = { ...startSnapped };
                    app.dragStartScreen = { ...screenPos };
                    app.dragAnchorId = anchorId;
                    app.dragShape = shape;
                    app.dragWireAnchorOriginal = null;
                    // For axis-snap anchors, capture the original anchor position
                    if (shape.getAnchorSnapMode(anchorId) === 'axis') {
                        const anchor = shape.getAnchors().find(a => a.id === anchorId);
                        if (anchor) {
                            app.dragWireAnchorOriginal = { x: anchor.x, y: anchor.y };
                        }
                    }
                    // Use pre-insert state if midpoint was already inserted on mousedown
                    app.dragShapesBefore = preInsertState || app._captureShapeState(shape);
                    // Record T-junction links: other wires with a coincident
                    // point at this anchor, so they move together during drag
                    app.dragAnchorTJLinks = [];
                    app.dragAnchorWireStates = new Map();
                    if (shape.type === 'wire') {
                        const m = anchorId.match(/^p(\d+)$/);
                        if (m) {
                            const pt = shape.points[parseInt(m[1])];
                            if (pt) {
                                for (const other of app.shapes) {
                                    if (other === shape || other.type !== 'wire') continue;
                                    for (let oi = 0; oi < other.points.length; oi++) {
                                        const op = other.points[oi];
                                        if (Math.abs(pt.x - op.x) < 0.15 && Math.abs(pt.y - op.y) < 0.15) {
                                            app.dragAnchorTJLinks.push({ otherWire: other, otherIdx: oi });
                                            if (!app.dragAnchorWireStates.has(other)) {
                                                app.dragAnchorWireStates.set(other, app._captureShapeState(other));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    // Show crosshairs during anchor drag to help with alignment
                    app._showCrosshair();
                    app._updateCrosshair(startSnapped);
                }
            }
            if (!app.isDragging) return;
        }
        if (app.viewport.isPanning) return;

        if (app.dragMode === 'move') {
            // Snap the absolute target position to grid so dragged items
            // land on grid points.  The object's off-grid starting position
            // is NOT adjusted on mousedown (no initial jump).
            const mouseDelta = {
                x: worldPos.x - app.dragStartWorldPos.x,
                y: worldPos.y - app.dragStartWorldPos.y
            };
            const targetPos = {
                x: app.dragObjectStartPos.x + mouseDelta.x,
                y: app.dragObjectStartPos.y + mouseDelta.y
            };
            const snappedTarget = app.viewport.getSnappedPosition(targetPos);

            // Build set of component IDs being moved (needed for nudge + sticky wires)
            const sel = app.selection.getSelection();
            const movingCompIds = new Set();
            for (const s of sel) {
                if (s.definition) movingCompIds.add(s.id);
            }

            // H/V snap for sticky wire segments: compute nudge + guides together
            let stickyGuides = [];
            if (movingCompIds.size > 0) {
                const proposedDx = snappedTarget.x - app.dragLastSnapped.x;
                const proposedDy = snappedTarget.y - app.dragLastSnapped.y;
                const stickySnap = computeStickyWireSnaps(app, movingCompIds, proposedDx, proposedDy);
                snappedTarget.x += stickySnap.adjustX;
                snappedTarget.y += stickySnap.adjustY;
                stickyGuides = stickySnap.guides;
            }

            // Calculate actual movement from object's last snapped position
            const dx = snappedTarget.x - app.dragLastSnapped.x;
            const dy = snappedTarget.y - app.dragLastSnapped.y;

            if (dx !== 0 || dy !== 0) {
                app.didDrag = true;
                app.dragTotalDx += dx;
                app.dragTotalDy += dy;

                for (const shape of sel) {
                    if (shape.locked) continue;
                    // Skip field text if its parent component is also being moved
                    if (shape.parentComponent && movingCompIds.has(shape.parentComponent.id)) continue;
                    shape.move(dx, dy);
                }
                // Sticky wires: update wire endpoints connected to moved components
                if (movingCompIds.size > 0) {
                    updateStickyWires(app);
                    renderGuideLines(app, stickyGuides);
                }

                // T-junction following: when a moved wire had junction points
                // shared with other (non-selected) wires, move those points too
                const movedWires = sel.filter(s => s.type === 'wire');
                if (movedWires.length > 0) {
                    const selSet = new Set(sel);
                    for (const mw of movedWires) {
                        for (const mp of mw.points) {
                            const prevX = mp.x - dx;
                            const prevY = mp.y - dy;
                            for (const shape of app.shapes) {
                                if (selSet.has(shape) || shape.type !== 'wire') continue;
                                for (const sp of shape.points) {
                                    if (Math.abs(sp.x - prevX) < COLLINEAR_EPSILON && Math.abs(sp.y - prevY) < COLLINEAR_EPSILON) {
                                        sp.x += dx;
                                        sp.y += dy;
                                        shape.invalidate();
                                    }
                                }
                            }
                        }
                    }
                }

                app.dragLastSnapped = { ...snappedTarget };
                app.renderShapes(false);
                if (app.textEdit) {
                    app._updateTextEditOverlay?.();
                }
                app.fileManager.setDirty(true);
            }
        } else if (app.dragMode === 'anchor' && app.dragShape) {
            app.didDrag = true;
            // Ensure shape stays selected and visible during anchor drag
            app.dragShape.selected = true;
            
            // For arc mid-anchor, use worldPos (not snapped). For everything else, use snapped.
            let anchorPos;
            const snapMode = app.dragShape.getAnchorSnapMode(app.dragAnchorId);
            if (snapMode === 'none') {
                anchorPos = worldPos;
            } else {
                anchorPos = snapped;
            }

            // Wire anchor drag: single snap resolver, same as wire drawing
            // Pin/wire snap only for endpoint anchors (T-junctions are only
            // created at endpoints, so midpoint snapping would be misleading).
            if (app.dragShape.type === 'wire') {
                const m = app.dragAnchorId.match(/^p(\d+)$/);
                const anchorIdx = m ? parseInt(m[1]) : -1;
                const isEndpoint = anchorIdx === 0 || anchorIdx === app.dragShape.points.length - 1;

                if (isEndpoint) {
                    const snap = resolveWireSnapPosition(app, worldPos, {
                        excludeWire: app.dragShape,
                        pinTolerance: 1.5
                    });
                    anchorPos = { x: snap.x, y: snap.y };

                    if (snap.snapType === 'pin') {
                        updateSnapHighlight(app, snap.snapPin);
                        renderGuideLines(app, []);
                    } else if (snap.snapType === 'endpoint' || snap.snapType === 'segment') {
                        updateSnapHighlight(app, { x: snap.x, y: snap.y, type: snap.snapType });
                        renderGuideLines(app, []);
                    } else {
                        updateSnapHighlight(app, null);
                        // Off-grid neighbor snap: invisible snap lines at each
                        // neighbor's coordinate so off-grid alignment is preserved.
                        const pts = app.dragShape.points;
                        const neighbors = [];
                        if (anchorIdx > 0) neighbors.push(pts[anchorIdx - 1]);
                        if (anchorIdx < pts.length - 1) neighbors.push(pts[anchorIdx + 1]);
                        applyOffGridNeighborSnap(worldPos, anchorPos, neighbors, app.viewport.gridSize || 1.0);
                        const result = computeAnchorCollinearSnap(app, app.dragShape, app.dragAnchorId, anchorPos);
                        anchorPos = result.anchorPos;
                        renderGuideLines(app, result.guides);
                    }
                } else {
                    // Midpoint anchor: collinear + H/V neighbor snap only, no wire/pin snap
                    updateSnapHighlight(app, null);
                    const pts = app.dragShape.points;
                    const neighbors = [];
                    if (anchorIdx > 0) neighbors.push(pts[anchorIdx - 1]);
                    if (anchorIdx < pts.length - 1) neighbors.push(pts[anchorIdx + 1]);
                    applyOffGridNeighborSnap(worldPos, anchorPos, neighbors, app.viewport.gridSize || 1.0);
                    const result = computeAnchorCollinearSnap(app, app.dragShape, app.dragAnchorId, anchorPos);
                    anchorPos = result.anchorPos;
                    renderGuideLines(app, result.guides);
                }
            }

            // Update crosshairs to track the anchor position
            app._updateCrosshair(anchorPos);

            const newAnchorId = app.dragShape.moveAnchor(app.dragAnchorId, anchorPos.x, anchorPos.y);
            if (newAnchorId && newAnchorId !== app.dragAnchorId) {
                app.dragAnchorId = newAnchorId;
            }
            // Move T-junction linked points on other wires
            if (app.dragAnchorTJLinks) {
                for (const link of app.dragAnchorTJLinks) {
                    const p = link.otherWire.points[link.otherIdx];
                    if (p) {
                        p.x = anchorPos.x;
                        p.y = anchorPos.y;
                        link.otherWire.invalidate();
                    }
                }
            }
            app.renderShapes(false);
            if (app.textEdit) {
                app._updateTextEditOverlay?.();
            }
            app.fileManager.setDirty(true);
        } else if (app.dragMode === 'wire-segment' && app.dragShape) {
            // Wire segment drag: move only the clicked segment's endpoints.
            // Neighboring segments rubber-band automatically.
            const wire = app.dragShape;
            const segIdx = app.dragWireSegIndex;

            const mouseDelta = {
                x: worldPos.x - app.dragStartWorldPos.x,
                y: worldPos.y - app.dragStartWorldPos.y
            };
            // Lock to perpendicular axis for orthogonal segments
            if (app.dragSegAxis === 'vertical') mouseDelta.x = 0;
            else if (app.dragSegAxis === 'horizontal') mouseDelta.y = 0;
            // Use the first endpoint as the reference for grid snapping
            const origState = app.dragWireStates.get(wire);
            const refPt = origState.points[segIdx];
            const target = {
                x: refPt.x + mouseDelta.x,
                y: refPt.y + mouseDelta.y
            };
            // Grid snap, then augment with snap lines from off-grid neighbors
            // and nearby pins so off-grid alignment is preserved.
            // Build set of T-junction-linked wires to exclude from highlight
            const tJunctionWires = new Set();
            if (app.dragTJunctionLinks) {
                for (const link of app.dragTJunctionLinks) tJunctionWires.add(link.otherWire);
            }
            const { snappedTarget, guides: segGuides, highlight: segHighlight } =
                computeSegmentDragSnap(app, wire, segIdx, origState, target, app.dragSegAxis, tJunctionWires);
            updateSnapHighlight(app, segHighlight);
            renderGuideLines(app, segGuides);

            const dx = snappedTarget.x - wire.points[segIdx].x;
            const dy = snappedTarget.y - wire.points[segIdx].y;

            if (dx !== 0 || dy !== 0) {
                app.didDrag = true;
                app.dragTotalDx += dx;
                app.dragTotalDy += dy;

                // Expand dragged region to include collinear neighbors.
                // When a T-junction splits a straight wire, the two resulting
                // segments are collinear — dragging one should move both so the
                // user sees the original straight line moving as a unit.
                let moveStart = segIdx;
                let moveEnd = segIdx + 1;
                const origPts = origState.points;

                // Expand backward: check if segment before moveStart is collinear
                while (moveStart > 0) {
                    const a = origPts[moveStart - 1], b = origPts[moveStart], c = origPts[moveEnd];
                    const dx1 = b.x - a.x, dy1 = b.y - a.y;
                    const dx2 = c.x - b.x, dy2 = c.y - b.y;
                    const len1 = Math.hypot(dx1, dy1), len2 = Math.hypot(dx2, dy2);
                    if (len1 < 1e-9 || len2 < 1e-9 || Math.abs(dx1 * dy2 - dy1 * dx2) / (len1 * len2) > ANGLE_TOL) break;
                    moveStart--;
                }
                // Expand forward: check if segment after moveEnd is collinear
                while (moveEnd < wire.points.length - 1) {
                    const a = origPts[moveStart], b = origPts[moveEnd], c = origPts[moveEnd + 1];
                    const dx1 = b.x - a.x, dy1 = b.y - a.y;
                    const dx2 = c.x - b.x, dy2 = c.y - b.y;
                    const len1 = Math.hypot(dx1, dy1), len2 = Math.hypot(dx2, dy2);
                    if (len1 < 1e-9 || len2 < 1e-9 || Math.abs(dx1 * dy2 - dy1 * dx2) / (len1 * len2) > ANGLE_TOL) break;
                    moveEnd++;
                }

                // Move all points in the expanded range
                for (let i = moveStart; i <= moveEnd; i++) {
                    wire.points[i].x += dx;
                    wire.points[i].y += dy;
                }
                wire.invalidate();

                // Move T-junction points on other wires using pre-recorded links
                if (app.dragTJunctionLinks) {
                    for (const link of app.dragTJunctionLinks) {
                        // Only follow if this wire point index is in the moved range
                        if (link.wireIdx >= moveStart && link.wireIdx <= moveEnd) {
                            const sp = link.otherWire.points[link.otherIdx];
                            if (sp) {
                                sp.x += dx;
                                sp.y += dy;
                                link.otherWire.invalidate();
                            }
                        }
                    }
                }

                app.renderShapes(false);
                app.fileManager.setDirty(true);
            }
        } else if (app.dragMode === 'box' && app.boxSelectStart) {
            app.didDrag = true;
            app._updateBoxSelectElement(worldPos);
            // Diff-based live selection: only invalidates shapes whose state changed
            const bounds = app._getBoxSelectBounds(worldPos);
            app.selection.syncBoxSelection(bounds, e.shiftKey, 'contain');
            app.renderShapes(false);
        }
    });

    // Listen on window so mouseup is caught even if mouse leaves the SVG
    window.addEventListener('mouseup', (e) => {
        if (e.button !== 0) return;

        const { worldPos, snapped } = getEventPositions(e, app.viewport);

        if (app.isDragging && app.dragMode === 'box' && app.boxSelectStart) {
            const bounds = app._getBoxSelectBounds(worldPos);
            app._removeBoxSelectElement();

            if (app.didDrag) {
                // Selection is already correct from live syncBoxSelection;
                // just fire the notification for properties panel / ribbon
                app.selection.syncBoxSelection(bounds, e.shiftKey, 'contain');
                app.selection._notifySelectionChanged();
                app.renderShapes(true);
            }

            app.isDragging = false;
            app.dragMode = null;
            app.boxSelectStart = null;
            return;
        }

        // Always ensure proper cleanup, even during mode 2 click-to-end interaction
        if (app.isDragging) {
            // Handle move undo (dragShape is only set for anchor drags, not move drags)
            if (app.didDrag && app.dragMode === 'move') {
                const selectedShapes = app.selection.getSelection();
                const movedShapes = selectedShapes.filter(s => !s.locked);
                if (movedShapes.length > 0 && (app.dragTotalDx !== 0 || app.dragTotalDy !== 0)) {
                    // Build set of moving component IDs to avoid double-reverting field texts
                    const movingCompIds = new Set();
                    for (const s of movedShapes) {
                        if (s.definition) movingCompIds.add(s.id);
                    }
                    const itemsForCommand = movedShapes.filter(s =>
                        !(s.parentComponent && movingCompIds.has(s.parentComponent.id)));
                    for (const shape of itemsForCommand) {
                        shape.move(-app.dragTotalDx, -app.dragTotalDy);
                    }
                    const command = new MoveShapesCommand(app, itemsForCommand, app.dragTotalDx, app.dragTotalDy);
                    app.history.execute(command);
                }
            } else if (app.didDrag && app.dragMode === 'wire-segment' && app.dragWireStates) {
                // Collapse zero-length segments and redundant collinear midpoints
                for (const wire of app.dragWireStates.keys()) {
                    // Remove adjacent duplicate points (zero-length segments)
                    for (let i = wire.points.length - 1; i > 0; i--) {
                        const a = wire.points[i], b = wire.points[i - 1];
                        if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) {
                            wire.points.splice(i, 1);
                            const shifted = new Set();
                            for (const j of wire.junctions) {
                                if (j === i) continue;
                                shifted.add(j > i ? j - 1 : j);
                            }
                            wire.junctions = shifted;
                        }
                    }
                    // Remove collinear midpoints, but keep T-junction vertices
                    // (where another wire connects at that point)
                    for (let i = wire.points.length - 2; i >= 1; i--) {
                        const a = wire.points[i - 1], b = wire.points[i], c = wire.points[i + 1];
                        const dx1 = b.x - a.x, dy1 = b.y - a.y;
                        const dx2 = c.x - b.x, dy2 = c.y - b.y;
                        const cross = Math.abs(dx1 * dy2 - dy1 * dx2);
                        if (cross >= ANGLE_TOL * Math.hypot(dx1, dy1) * Math.hypot(dx2, dy2) + 1e-9) continue;
                        // Keep if any other wire has a point here
                        let keep = false;
                        for (const other of app.shapes) {
                            if (other === wire || other.type !== 'wire') continue;
                            for (const p of other.points) {
                                if (Math.abs(p.x - b.x) < 0.15 && Math.abs(p.y - b.y) < 0.15) {
                                    keep = true; break;
                                }
                            }
                            if (keep) break;
                        }
                        if (keep) continue;
                        wire.points.splice(i, 1);
                        const shifted = new Set();
                        for (const j of wire.junctions) {
                            if (j === i) continue;
                            shifted.add(j > i ? j - 1 : j);
                        }
                        wire.junctions = shifted;
                    }
                    wire.invalidate();
                }

                // Refresh pin connections for all affected wires before capturing after-state
                for (const wire of app.dragWireStates.keys()) {
                    refreshWireConnections(app, wire);
                }

                // Endpoint-to-endpoint merge: if the dragged wire's endpoint
                // now coincides with another wire's endpoint and they are
                // collinear, merge them into one wire.
                const draggedWire = app.dragShape;
                if (draggedWire && draggedWire.type === 'wire' && app.shapes.includes(draggedWire)) {
                    processWireAnchorMerge(app, draggedWire);
                    // Remove any wires that were consumed by the merge
                    for (const wire of [...app.dragWireStates.keys()]) {
                        if (!app.shapes.includes(wire)) {
                            app.dragWireStates.delete(wire);
                        }
                    }
                }

                // Check for new T-junctions created by the drag
                // (e.g. dragging a wire's endpoint onto another wire's segment)
                if (draggedWire && draggedWire.type === 'wire' && app.shapes.includes(draggedWire)) {
                    const eps = [
                        { pt: draggedWire.points[0], end: 'start' },
                        { pt: draggedWire.points[draggedWire.points.length - 1], end: 'end' }
                    ];
                    for (const { pt, end } of eps) {
                        for (const other of app.shapes) {
                            if (other === draggedWire || other.type !== 'wire') continue;
                            // Skip if already at an endpoint (that would be a merge, not T-junction)
                            if (other.endpointAt(pt, 0.15)) continue;
                            const onSeg = other.pointOnSegment(pt, 0.15);
                            if (onSeg) {
                                // Capture before-state for the other wire if not already tracked
                                if (!app.dragWireStates.has(other)) {
                                    app.dragWireStates.set(other, app._captureShapeState(other));
                                }
                                const insertIdx = other.splitAt(pt);
                                other.junctions.add(insertIdx);
                                other.invalidate();
                            }
                        }
                    }
                }
                // Commit undo for all wires affected by segment drag
                const batch = new BatchCommand('Move wire segment');
                for (const [wire, beforeState] of app.dragWireStates) {
                    if (wire.points.length < 2) {
                        // Wire collapsed entirely — delete it
                        app._applyShapeState(wire, beforeState);
                        batch.add(new DeleteShapesCommand(app, [wire]));
                    } else {
                        const afterState = app._captureShapeState(wire);
                        app._applyShapeState(wire, beforeState);
                        const cmd = new ModifyShapeCommand(app, wire, beforeState, afterState);
                        batch.add(cmd);
                    }
                }
                app.history.execute(batch);
                app.renderShapes(true);
            } else if (app.dragShape) {
                if (app.dragMode === 'anchor' && app.dragShapesBefore) {
                    if (app.didDrag || (app.dragAnchorWireStates && app.dragAnchorWireStates.size > 0)) {
                        // Commit anchor drag: either user moved or junction was deleted
                        commitAnchorDrag(app);
                    } else {
                        // Anchor drag was initiated but no movement occurred - keep shape selected
                        if (app.dragShape) {
                            app.dragShape.selected = true;
                        }
                    }
                }
            }

            // Commit pending midpoint insert if it wasn't dragged
            if (app.pendingAnchorDrag?.preInsertState) {
                const { shape, preInsertState } = app.pendingAnchorDrag;
                const afterState = app._captureShapeState(shape);
                app._applyShapeState(shape, preInsertState);
                const command = new ModifyShapeCommand(app, shape, preInsertState, afterState);
                app.history.execute(command);
                shape.selected = true;
            }

            // Clear all drag state. NOTE: didDrag is NOT cleared here — the click
            // event fires after mouseup and needs it to skip click-selection.
            clearDragState(app);
            app.renderShapes(true);
            if (app.textEdit) {
                app._updateTextEditOverlay?.();
            }
        }

        if (app.viewport.isPanning) return;

        if (app.currentTool === 'line') {
            // Line continues until double-click, right-click, or Escape
        } else if (app.currentTool === 'polygon') {
            // Polygon continues until double-click or Escape
        } else if (app.currentTool === 'wire') {
            // Wire continues until Enter is pressed
        } else if (CLICK_TO_END_TOOLS.has(app.currentTool)) {
            // These tools now use Click-Move-Click, so do NOT finish on mouseup
        } else if (app.isDrawing) {
            app._finishDrawing(snapped);
        }
    });

    svg.addEventListener('click', (e) => {
        if (app.viewport.isPanning) return;

        if (app.skipClickSelection) {
            app.skipClickSelection = false;
            return;
        }

        if (app.didDrag) {
            app.didDrag = false;
            return;
        }

        const { worldPos } = getEventPositions(e, app.viewport);

        if (app.currentTool === 'select') {
            const hit = app.selection.hitTest(worldPos);

            if (app.textEdit) {
                if (!hit || hit !== app.textEdit.shape) {
                    app._endTextEdit(true);
                }
            }

            app.selection.handleClick(worldPos, e.shiftKey || e.ctrlKey || e.metaKey);
            app.renderShapes(true);
        }
    });

    svg.addEventListener('dblclick', (e) => {
        if (app.isDrawing) {
            if (app.currentTool === 'wire' && app.wirePoints.length >= 1) {
                app._finishWireDrawing(app.drawCurrent);
            } else if (app.currentTool === 'line') {
                app._finishLine();
            } else if (app.currentTool === 'polygon') {
                app._finishPolygon();
            } else if (app.drawCurrent) {
                app._finishDrawing(app.drawCurrent);
            }
            return;
        }

        if (app.currentTool !== 'select') return;

        const { screenPos, worldPos } = getEventPositions(e, app.viewport);
        const hit = app.selection.hitTest(worldPos);

        // Priority 1: shape inline edit (text shapes)
        if (hit && hit.supportsInlineEdit) {
            app.selection.select(hit, false);
            app.renderShapes(true);
            app._startTextEdit(hit);
            app._setTextEditCaretFromScreen(screenPos);
            return;
        }

        // Priority 2: title block cell in-place edit
        if (!hit) {
            app.viewport._onTitleBlockDblClick(worldPos);
        }
    });
}
