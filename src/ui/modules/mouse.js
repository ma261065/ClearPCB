import { MoveShapesCommand, ModifyShapeCommand, BatchCommand } from '../../core/CommandHistory.js';
import { updateStickyWires, reconcileWiresWithUndo, updateSnapHighlight, resolveWireSnapPosition, renderGuideLines, computeAnchorCollinearSnap, computeSegmentDragSnap, computeStickyWireSnaps, applyOffGridNeighborSnap, collapseRedundantWirePoints, SNAP_SCREEN_PX, COLLINEAR_EPSILON, VERTEX_EPSILON, PIN_SNAP_TOL } from './wire.js';
import { pointsCollinear } from '../../core/geometry.js';
import { clearDragState, commitAnchorDrag, commitSegmentDrag } from './drag.js';
import { detectTJunction, showAnchorContextMenu, showSegmentContextMenu } from './context-menu.js';

// Re-export clearDragState so existing consumers (keyboard.js) don't break.
export { clearDragState } from './drag.js';

// Pre-allocated tool sets to avoid array creation in hot paths
const DRAWING_TOOLS = new Set(['line', 'rect', 'circle', 'polygon']);
const CLICK_TO_END_TOOLS = new Set(['rect', 'circle', 'arc']);

/** Pixel threshold to promote a pending anchor click into a drag. */
const DRAG_THRESHOLD_PX = 3;

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
 * Wire all mouse-event handlers (mousedown, mouseup, mousemove, click,
 * dblclick) to the SVG canvas. Handles selection, dragging, anchor
 * manipulation, box-select, and context menus.
 * @param {Object} app - The SchematicApp instance.
 */
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
                    // For single-edge wires, prefer segment drag over endpoint
                    // anchor drag when the endpoint is at a T-junction.  This
                    // ensures the whole wire moves instead of stretching.
                    if (shape.type === 'wire' && shape.edges.size <= 1 && shape.nodes.has(anchorId)) {
                        const pos = shape.nodes.get(anchorId);
                        let atJunction = false;
                        for (const other of app.shapes) {
                            if (other === shape || other.type !== 'wire') continue;
                            if (other.nodeAt(pos, VERTEX_EPSILON)) {
                                atJunction = true; break;
                            }
                        }
                        if (atJunction) break; // fall through to segment drag
                    }
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
                // only the clicked edge (neighbors rubber-band).
                if (hitShape.type === 'wire' && app.selection.getSelection().length === 1) {
                    const dragEdgeId = hitShape.hitTestEdge(worldPos, SNAP_SCREEN_PX / app.viewport.scale);
                    if (dragEdgeId) {
                        const edge = hitShape.edges.get(dragEdgeId);
                        app.isDragging = true;
                        app.dragMode = 'wire-segment';
                        app.dragShape = hitShape;
                        app.dragEdgeId = dragEdgeId;
                        app.dragStartWorldPos = { ...worldPos };
                        app.dragTotalDx = 0;
                        app.dragTotalDy = 0;
                        // Capture before-state of this wire + any T-junction wires.
                        app.dragWireStates = new Map();
                        app.dragWireStates.set(hitShape, app._captureShapeState(hitShape));

                        // If the edge endpoints are at pin-connected nodes,
                        // insert an intermediate node so the pin stays fixed
                        // and the dragged segment gets an L-bend.
                        // Before: pinNode ---dragEdge--- otherNode
                        // After:  pinNode ---bridgeEdge--- newNode ---dragEdge--- otherNode
                        {
                            const edge_ = hitShape.edges.get(dragEdgeId);
                            // Handle 'from' endpoint
                            if (hitShape.pinConnections.has(edge_.from)) {
                                const pinPos = hitShape.nodes.get(edge_.from);
                                const newId = hitShape.addNode(pinPos.x, pinPos.y);
                                hitShape.addEdge(edge_.from, newId);  // bridge edge
                                edge_.from = newId;                   // redirect dragged edge
                            }
                            // Handle 'to' endpoint
                            const edge2_ = hitShape.edges.get(dragEdgeId);
                            if (edge2_ && hitShape.pinConnections.has(edge2_.to)) {
                                const pinPos = hitShape.nodes.get(edge2_.to);
                                const newId = hitShape.addNode(pinPos.x, pinPos.y);
                                hitShape.addEdge(edge2_.to, newId);   // bridge edge
                                edge2_.to = newId;                    // redirect dragged edge
                            }
                        }

                        // Determine axis lock AFTER bridge insertion so edge count is final.
                        // H segments move only vertically, V only horizontally.
                        // Single-edge wires (no bridges added) allow free movement.
                        {
                            const edgeLock = hitShape.edges.get(dragEdgeId);
                            if (hitShape.edges.size > 1 && edgeLock) {
                                const pA = hitShape.nodes.get(edgeLock.from), pB = hitShape.nodes.get(edgeLock.to);
                                const sDx = Math.abs(pB.x - pA.x), sDy = Math.abs(pB.y - pA.y);
                                if (sDy < COLLINEAR_EPSILON && sDx > COLLINEAR_EPSILON) app.dragSegAxis = 'vertical';
                                else if (sDx < COLLINEAR_EPSILON && sDy > COLLINEAR_EPSILON) app.dragSegAxis = 'horizontal';
                                else app.dragSegAxis = null;
                            } else {
                                app.dragSegAxis = null;
                            }
                        }

                        // Store post-insertion working state so the drag math uses correct state.
                        app.dragWireWorkingState = app._captureShapeState(hitShape);
                        // Record which nodes on OTHER wires coincide with this
                        // wire's nodes at drag start, so we only move those.
                        app.dragTJunctionLinks = [];
                        for (const [nid, pos] of hitShape.nodes) {
                            for (const other of app.shapes) {
                                if (other === hitShape || other.type !== 'wire') continue;
                                const otherNid = other.nodeAt(pos, VERTEX_EPSILON);
                                if (otherNid) {
                                    app.dragTJunctionLinks.push({ wireNodeId: nid, otherWire: other, otherNodeId: otherNid });
                                    if (!app.dragWireStates.has(other)) {
                                        app.dragWireStates.set(other, app._captureShapeState(other));
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
        if (movedDist > DRAG_THRESHOLD_PX) return; // dragged — was a pan, don't finish

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
                if (anchorId && !anchorId.startsWith('mid')) {
                    // For wire graph nodes, check if the node can be deleted
                    let canDeletePoint = false;
                    if (shape.type === 'wire') {
                        canDeletePoint = shape.nodes.has(anchorId) && shape.edges.size > 1;
                    } else {
                        const minPoints = shape.type === 'polygon' ? 4 : 3;
                        canDeletePoint = typeof shape.deleteAnchor === 'function' &&
                                         shape.points && shape.points.length >= minPoints;
                    }
                    const junctionInfo = detectTJunction(app, shape, anchorId);
                    // At a junction, only show "Delete junction" — "Delete point" is ambiguous
                    if (junctionInfo && shape.type === 'wire') canDeletePoint = false;
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
                const nid = wire.nodeAt(worldPos, junctionTol);
                if (!nid) continue;
                const junctionInfo = detectTJunction(app, wire, nid);
                if (junctionInfo) {
                    // Select the wire so anchors become visible
                    app.selection.clearSelection();
                    app.selection.select(wire, false);
                    wire.selected = true;
                    app.renderShapes(true);
                    const canDelete = false; // junction — only show "Delete junction"
                    showAnchorContextMenu(app, wire, nid, e.clientX, e.clientY, canDelete, junctionInfo);
                    e.preventDefault();
                    return;
                }
            }
        }

        // Wire segment right-click context menu (select tool)
        if (app.currentTool === 'select') {
            const segTolerance = SNAP_SCREEN_PX / app.viewport.scale;
            for (const shape of app.shapes) {
                if (shape.locked || shape.type !== 'wire') continue;
                const edgeId = shape.hitTestEdge(worldPos, segTolerance);
                if (edgeId) {
                    if (!shape.selected) {
                        app.selection.clearSelection();
                        app.selection.select(shape, false);
                        shape.selected = true;
                        app.renderShapes(true);
                    }
                    showSegmentContextMenu(app, shape, edgeId, e.clientX, e.clientY);
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
                updateSnapHighlight(app, resolveWireSnapPosition(app, worldPos, { pinTolerance: 0.5 }));
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
                if (moved >= DRAG_THRESHOLD_PX) {
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
                    if (shape.type === 'wire' && shape.nodes.has(anchorId)) {
                        const pos = shape.nodes.get(anchorId);
                        for (const other of app.shapes) {
                            if (other === shape || other.type !== 'wire') continue;
                            const otherNid = other.nodeAt(pos, VERTEX_EPSILON);
                            if (otherNid) {
                                app.dragAnchorTJLinks.push({ otherWire: other, otherNodeId: otherNid });
                                if (!app.dragAnchorWireStates.has(other)) {
                                    app.dragAnchorWireStates.set(other, app._captureShapeState(other));
                                }
                            }
                        }
                    }
                    // If the dragged node is connected to a pin, record it so
                    // resolveWireSnapPosition can exclude that pin during drag
                    // (prevents the node from snapping back to the same pin).
                    app.dragAnchorExcludePin = null;
                    if (shape.type === 'wire' && shape.pinConnections.has(anchorId)) {
                        const conn = shape.pinConnections.get(anchorId);
                        app.dragAnchorExcludePin = {
                            component: { id: conn.componentId },
                            pin: { number: conn.pinNumber }
                        };
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

                // T-junction following: when a moved wire had nodes
                // shared with other (non-selected) wires, move those nodes too
                const movedWires = sel.filter(s => s.type === 'wire');
                if (movedWires.length > 0) {
                    const selSet = new Set(sel);
                    for (const mw of movedWires) {
                        for (const pos of mw.nodes.values()) {
                            const prevX = pos.x - dx;
                            const prevY = pos.y - dy;
                            for (const shape of app.shapes) {
                                if (selSet.has(shape) || shape.type !== 'wire') continue;
                                for (const sp of shape.nodes.values()) {
                                    if (Math.abs(sp.x - prevX) < VERTEX_EPSILON && Math.abs(sp.y - prevY) < VERTEX_EPSILON) {
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
            // Pin/wire snap only for leaf-node anchors (degree 1).
            let anchorGuides = [];
            if (app.dragShape.type === 'wire') {
                const isLeaf = app.dragShape.nodes.has(app.dragAnchorId) && app.dragShape.degree(app.dragAnchorId) <= 1;

                // Leaf nodes try pin/wire snap first
                let snappedToTarget = false;
                if (isLeaf) {
                    const snap = resolveWireSnapPosition(app, worldPos, {
                        excludeNode: { wire: app.dragShape, nodeId: app.dragAnchorId },
                        excludePin: app.dragAnchorExcludePin || null,
                        pinTolerance: PIN_SNAP_TOL
                    });
                    anchorPos = { x: snap.x, y: snap.y };
                    snappedToTarget = snap.snapType === 'pin' || snap.snapType === 'endpoint' || snap.snapType === 'segment';
                    if (snappedToTarget) updateSnapHighlight(app, snap);
                }

                // If no pin/wire/endpoint snap (or non-leaf node), use off-grid
                // neighbor snap + collinear/H-V alignment
                if (!snappedToTarget) {
                    updateSnapHighlight(app, null);
                    const neighbors = app.dragShape.neighborNodes(app.dragAnchorId)
                        .map(nid => app.dragShape.nodes.get(nid))
                        .filter(Boolean);
                    applyOffGridNeighborSnap(worldPos, anchorPos, neighbors, app.viewport.gridSize || 1.0);
                    const result = computeAnchorCollinearSnap(app, app.dragShape, app.dragAnchorId, anchorPos);
                    anchorPos = result.anchorPos;
                    anchorGuides = result.guides;
                }
            }

            // Update crosshairs to track the anchor position
            app._updateCrosshair(anchorPos);

            // Compute collinear snap for T-junction-linked wires, merge with main guides
            if (app.dragAnchorTJLinks && app.dragAnchorTJLinks.length > 0) {
                for (const link of app.dragAnchorTJLinks) {
                    const tjResult = computeAnchorCollinearSnap(
                        app, link.otherWire, link.otherNodeId, anchorPos
                    );
                    if (tjResult.anchorPos.x !== anchorPos.x || tjResult.anchorPos.y !== anchorPos.y) {
                        anchorPos = tjResult.anchorPos;
                    }
                    anchorGuides = anchorGuides.concat(tjResult.guides);
                }
            }
            renderGuideLines(app, anchorGuides);

            const newAnchorId = app.dragShape.moveAnchor(app.dragAnchorId, anchorPos.x, anchorPos.y);
            if (newAnchorId && newAnchorId !== app.dragAnchorId) {
                app.dragAnchorId = newAnchorId;
            }
            // Move T-junction linked nodes on other wires
            if (app.dragAnchorTJLinks) {
                for (const link of app.dragAnchorTJLinks) {
                    const p = link.otherWire.nodes.get(link.otherNodeId);
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
            const dragEdgeId = app.dragEdgeId;

            const mouseDelta = {
                x: worldPos.x - app.dragStartWorldPos.x,
                y: worldPos.y - app.dragStartWorldPos.y
            };
            // Lock to perpendicular axis for orthogonal segments
            if (app.dragSegAxis === 'vertical') mouseDelta.x = 0;
            else if (app.dragSegAxis === 'horizontal') mouseDelta.y = 0;
            // Use the 'from' node of the dragged edge as the reference for grid snapping.
            const origState = app.dragWireWorkingState || app.dragWireStates.get(wire);
            const origEdge = origState.edges[dragEdgeId];
            const refPt = origEdge ? origState.nodes[origEdge.from] : null;
            if (!refPt) { /* edge was removed — bail */ }
            else {
            const target = {
                x: refPt.x + mouseDelta.x,
                y: refPt.y + mouseDelta.y
            };
            // Grid snap, then augment with snap lines from off-grid neighbors
            const tJunctionWires = new Set();
            if (app.dragTJunctionLinks) {
                for (const link of app.dragTJunctionLinks) tJunctionWires.add(link.otherWire);
            }
            const { snappedTarget, guides: segGuides, highlight: segHighlight } =
                computeSegmentDragSnap(app, wire, dragEdgeId, origState, target, app.dragSegAxis, tJunctionWires);
            updateSnapHighlight(app, segHighlight);

            // Also compute collinear guides for T-junction-linked wires.
            let allSegGuides = segGuides;
            if (app.dragTJunctionLinks) {
                const edge = wire.edges.get(dragEdgeId);
                for (const link of app.dragTJunctionLinks) {
                    // Only follow if this linked node is one of the edge's endpoints
                    if (!edge) continue;
                    const fromPos = wire.nodes.get(edge.from);
                    const toPos = wire.nodes.get(edge.to);
                    if (link.wireNodeId !== edge.from && link.wireNodeId !== edge.to) continue;
                    const ow = link.otherWire;
                    const otherPos = ow.nodes.get(link.otherNodeId);
                    if (!otherPos || !fromPos) continue;
                    const tjPos = {
                        x: otherPos.x + (snappedTarget.x - fromPos.x),
                        y: otherPos.y + (snappedTarget.y - fromPos.y)
                    };
                    const tjResult = computeAnchorCollinearSnap(app, ow, link.otherNodeId, tjPos);
                    if (tjResult.guides.length > 0) {
                        allSegGuides = allSegGuides.concat(tjResult.guides);
                    }
                }
            }
            renderGuideLines(app, allSegGuides);

            // Compute delta from current position of the from-node
            const curFromPos = wire.nodes.get(origEdge.from);
            const dx = snappedTarget.x - (curFromPos ? curFromPos.x : refPt.x);
            const dy = snappedTarget.y - (curFromPos ? curFromPos.y : refPt.y);

            if (dx !== 0 || dy !== 0) {
                app.didDrag = true;
                app.dragTotalDx += dx;
                app.dragTotalDy += dy;

                // Move both endpoints of the dragged edge
                const edge = wire.edges.get(dragEdgeId);
                if (edge) {
                    const nodesToMove = new Set([edge.from, edge.to]);
                    // Expand to collinear neighbors: if an adjacent edge is collinear
                    // with the dragged edge, include its other endpoint too
                    const expandCollinear = (nodeId) => {
                        for (const inc of wire.incidentEdges(nodeId)) {
                            if (inc.edgeId === dragEdgeId || nodesToMove.has(inc.otherNode)) continue;
                            const a = origState.nodes[inc.otherNode];
                            const b = origState.nodes[nodeId];
                            const fromOrig = origState.nodes[edge.from];
                            const toOrig = origState.nodes[edge.to];
                            if (!a || !b || !fromOrig || !toOrig) continue;
                            if (pointsCollinear(a, b, fromOrig) && pointsCollinear(a, b, toOrig)) {
                                nodesToMove.add(inc.otherNode);
                            }
                        }
                    };
                    expandCollinear(edge.from);
                    expandCollinear(edge.to);

                    // Don't move pin-connected nodes (they were already split on drag start)
                    for (const nid of nodesToMove) {
                        if (wire.pinConnections.has(nid)) continue;
                        const p = wire.nodes.get(nid);
                        if (p) { p.x += dx; p.y += dy; }
                    }
                    wire.invalidate();
                }

                // Move T-junction nodes on other wires using pre-recorded links
                if (app.dragTJunctionLinks && edge) {
                    const movedNodes = new Set();
                    // Collect which of our nodes actually moved
                    const edgeNow = wire.edges.get(dragEdgeId);
                    if (edgeNow) { movedNodes.add(edgeNow.from); movedNodes.add(edgeNow.to); }
                    for (const link of app.dragTJunctionLinks) {
                        if (movedNodes.has(link.wireNodeId)) {
                            const sp = link.otherWire.nodes.get(link.otherNodeId);
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
            } // end of refPt null check
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
                }
            } else if (app.dragMode === 'wire-segment' && app.dragWireStates) {
                if (app.didDrag) {
                    commitSegmentDrag(app);
                } else {
                    // No movement — undo bridge insertions from mousedown
                    for (const [wire, state] of app.dragWireStates) {
                        app._applyShapeState(wire, state);
                    }
                }
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
            // Clear any pending anchor drag left over from the second mousedown
            // of the dblclick — otherwise the stale state causes the text label
            // to follow the mouse after the value dialog closes.
            app.pendingAnchorDrag = null;
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
