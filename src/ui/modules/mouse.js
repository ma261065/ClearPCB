import { updateStickyWires, updateSnapHighlight, resolveWireSnapPosition, renderGuideLines, computeAnchorCollinearSnap, computeSegmentDragSnap, computeStickyWireSnaps, applyOffGridNeighborSnap, buildCollinearChain, SNAP_SCREEN_PX, COLLINEAR_EPSILON, VERTEX_EPSILON, PIN_SNAP_TOL } from './wire.js';
import { commitAnchorDrag } from './drag.js';
import { detectTJunction, showAnchorContextMenu, showSegmentContextMenu } from './context-menu.js';
import { updateToolGhost } from './tool.js';
import {
    beginBoxSelectSession,
    beginMoveDragSession,
    beginWireSegmentDragSession,
    clearPendingAnchorDrag,
    clearPendingAnchorDragIfIdle,
    finalizeDragInteraction,
    handleActiveDragMouseUp,
    handleDrawingToolMouseUp,
    handleBoxSelectMouseUp,
    handleRightClickDrawingMouseUp,
    isAdditiveSelectionModifier,
    isCycleSelectionModifier,
    promotePendingAnchorDragSession,
    setPendingAnchorDrag
} from './interaction-state.js';

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
 * Click-to-add tools (line/polygon): start drawing on first click,
 * append a point on subsequent clicks.
 */
function handlePointAppendingToolMouseDown(app, snapped, appendPoint) {
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
function handleStartFinishToolMouseDown(app, snapped) {
    if (!app.isDrawing) {
        app._startDrawing(snapped);
        return;
    }
    app._finishDrawing(snapped);
}

function handleAnchorContextMenu(app, worldPos, clientX, clientY) {
    const selectedShapes = app.selection.getSelection();
    for (const shape of selectedShapes) {
        if (shape.locked) continue;
        const anchorId = shape.hitTestAnchor(worldPos, app.viewport.scale);
        if (anchorId && !anchorId.startsWith('mid')) {
            let canDeletePoint = false;
            if (shape.type === 'wire') {
                canDeletePoint = shape.nodes.has(anchorId) && shape.edges.size > 1;
            } else {
                const minPoints = shape.type === 'polygon' ? 4 : 3;
                canDeletePoint = typeof shape.deleteAnchor === 'function' &&
                    shape.points && shape.points.length >= minPoints;
            }
            const junctionInfo = detectTJunction(app, shape, anchorId);
            if (junctionInfo && shape.type === 'wire') canDeletePoint = false;
            if (canDeletePoint || junctionInfo) {
                showAnchorContextMenu(app, shape, anchorId, clientX, clientY, canDeletePoint, junctionInfo);
                return true;
            }
        }
    }

    const junctionTol = Math.max(0.5, 3 / app.viewport.scale);
    for (const wire of app.shapes) {
        if (wire.type !== 'wire' || wire.locked) continue;
        const nid = wire.nodeAt(worldPos, junctionTol);
        if (!nid) continue;
        const junctionInfo = detectTJunction(app, wire, nid);
        if (junctionInfo) {
            app.selection.clearSelection();
            app.selection.select(wire, false);
            wire.selected = true;
            app.renderShapes(true);
            const canDelete = false;
            showAnchorContextMenu(app, wire, nid, clientX, clientY, canDelete, junctionInfo);
            return true;
        }
    }

    return false;
}

function handleSegmentContextMenu(app, worldPos, clientX, clientY) {
    const segTolerance = SNAP_SCREEN_PX / app.viewport.scale;
    for (const shape of app.shapes) {
        if (shape.locked || shape.type !== 'wire') continue;
        const edgeId = shape.hitTestEdge(worldPos, segTolerance);
        if (!edgeId) continue;

        if (!shape.selected) {
            app.selection.clearSelection();
            app.selection.select(shape, false);
            shape.selected = true;
            app.renderShapes(true);
        }
        showSegmentContextMenu(app, shape, edgeId, clientX, clientY);
        return true;
    }
    return false;
}

function handleSelectContextMenu(app, worldPos, clientX, clientY) {
    if (handleAnchorContextMenu(app, worldPos, clientX, clientY)) return true;
    return handleSegmentContextMenu(app, worldPos, clientX, clientY);
}

function handleMoveDragMouseMove(app, worldPos) {
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

    // Pin-aware snap for solo noconnect moves: allow landing on off-grid pins
    const sel = app.selection.getSelection();
    const soloNoConnect = sel.length === 1 && sel[0].type === 'noconnect' ? sel[0] : null;
    if (soloNoConnect) {
        const snap = resolveWireSnapPosition(app, targetPos, { pinTolerance: PIN_SNAP_TOL });
        snappedTarget.x = snap.x;
        snappedTarget.y = snap.y;
        updateSnapHighlight(app, snap);
    }

    // Build set of parent IDs being moved (components + wires that own field texts)
    const movingCompIds = new Set();
    for (const s of sel) {
        if (s.definition) movingCompIds.add(s.id);
        if (s.type === 'wire') movingCompIds.add(s.id);
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
}

function handleAnchorDragMouseMove(app, worldPos, snapped) {
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

    // NoConnect anchor drag: pin-aware snap so it can land on off-grid pins
    if (app.dragShape.type === 'noconnect') {
        const snap = resolveWireSnapPosition(app, worldPos, { pinTolerance: PIN_SNAP_TOL });
        anchorPos = { x: snap.x, y: snap.y };
        updateSnapHighlight(app, snap);
    }

    // Wire anchor drag: single snap resolver, same as wire drawing
    // Pin/wire snap only for leaf-node anchors (degree 1).
    let anchorGuides = [];
    if (app.dragShape.type === 'wire') {
        const isLeaf = app.dragShape.nodes.has(app.dragAnchorId) && app.dragShape.degree(app.dragAnchorId) <= 1;

        // Once the anchor leaves the snap zone of the excluded pin,
        // clear the exclusion so the pin can be re-approached.
        if (app.dragAnchorExcludePin?.worldPos) {
            const ep = app.dragAnchorExcludePin.worldPos;
            if (Math.hypot(worldPos.x - ep.x, worldPos.y - ep.y) > PIN_SNAP_TOL) {
                app.dragAnchorExcludePin = null;
            }
        }

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
    // Move NoConnect shapes linked to the dragged anchor
    if (app.dragAnchorNCLinks) {
        for (const link of app.dragAnchorNCLinks) {
            link.nc.x = anchorPos.x;
            link.nc.y = anchorPos.y;
            link.nc.invalidate();
        }
    }
    app.renderShapes(false);
    if (app.textEdit) {
        app._updateTextEditOverlay?.();
    }
    app.fileManager.setDirty(true);
}

function handleWireSegmentDragMouseMove(app, worldPos) {
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
    if (!refPt) {
        return; // edge was removed — bail
    }

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
            const nodesToMove = buildCollinearChain(wire, dragEdgeId, origState);

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

        // Move NoConnect shapes linked to moved segment endpoints
        if (app.dragSegmentNCLinks && edge) {
            const movedNodes = new Set();
            const edgeNow = wire.edges.get(dragEdgeId);
            if (edgeNow) { movedNodes.add(edgeNow.from); movedNodes.add(edgeNow.to); }
            for (const link of app.dragSegmentNCLinks) {
                if (movedNodes.has(link.wireNodeId)) {
                    link.nc.x += dx;
                    link.nc.y += dy;
                    link.nc.invalidate();
                }
            }
        }

        // Move wire label text with the segment drag
        if (wire.labelText) {
            wire.labelText.x += dx;
            wire.labelText.y += dy;
            wire.labelText.invalidate();
        }

        app.renderShapes(false);
        app.fileManager.setDirty(true);
    }
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
        if (activeTab instanceof HTMLElement && activeTab.dataset?.tab === 'file') {
            app._setActiveRibbonTab?.('home');
        }

        // Commit active click-to-place anchor drag on the confirming click
        if (app.isDragging && app.dragMode === 'anchor' && app.dragShapesBefore &&
            (app.didDrag || (app.dragAnchorWireStates && app.dragAnchorWireStates.size > 0))) {
            commitAnchorDrag(app);
            finalizeDragInteraction(app);
            app.didDrag = true;   // prevent click handler from re-selecting
            e.preventDefault();
            return;
        }

        app.didDrag = false;
        
        clearPendingAnchorDragIfIdle(app);

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
                        setPendingAnchorDrag(app, {
                            shape,
                            anchorId: newAnchorId || anchorId,
                            screenPos: { ...screenPos },
                            snapped: { ...snapped },
                            preInsertState: beforeState
                        });
                    } else {
                        // Defer anchor drag until the mouse actually moves
                        setPendingAnchorDrag(app, {
                            shape,
                            anchorId,
                            screenPos: { ...screenPos },
                            snapped: { ...snapped }
                        });
                    }
                    e.preventDefault();
                    return;
                }
            }
            let hitShape = app.selection.hitTest(worldPos);

            // Shift+Click: Cycle through overlapping shapes
            // Note: Ctrl is reserved for Multi-Select (Additive)
            if (isCycleSelectionModifier(e)) {
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
                const additive = isAdditiveSelectionModifier(e);
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
                        beginWireSegmentDragSession(app, {
                            shape: hitShape,
                            dragEdgeId,
                            worldPos,
                            beforeState: app._captureShapeState(hitShape)
                        });

                        // If the edge endpoints are at pin-connected nodes,
                        // insert an intermediate node so the pin stays fixed
                        // and the dragged segment gets an L-bend.
                        // Before: pinNode ---dragEdge--- otherNode
                        // After:  pinNode ---bridgeEdge--- newNode ---dragEdge--- otherNode
                        const preBridgeEdgeCount = hitShape.edges.size;
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
                        // Single-edge wires (before bridges) allow free movement.
                        {
                            const edgeLock = hitShape.edges.get(dragEdgeId);
                            if (preBridgeEdgeCount > 1 && edgeLock) {
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
                        // Record NoConnect shapes at segment endpoints
                        // so they move with the wire during segment drag.
                        app.dragSegmentNCLinks = [];
                        for (const [nid, pos] of hitShape.nodes) {
                            for (const s of app.shapes) {
                                if (s.type !== 'noconnect') continue;
                                if (Math.hypot(s.x - pos.x, s.y - pos.y) < VERTEX_EPSILON) {
                                    app.dragSegmentNCLinks.push({ wireNodeId: nid, nc: s, before: s.captureState() });
                                }
                            }
                        }
                        // Capture label text before-state for undo
                        app.dragSegmentLabelBefore = hitShape.labelText
                            ? app._captureShapeState(hitShape.labelText)
                            : null;
                        app.viewport.svg.style.cursor = 'move';
                        e.preventDefault();
                        return;
                    }
                }

                // Store the actual unsnapped position of the first selected shape
                const firstShape = app.selection.getSelection()[0];
                const dragObjectStartPos = firstShape
                    ? firstShape.getPosition()
                    : { ...snapped };

                beginMoveDragSession(app, {
                    worldPos,
                    dragObjectStartPos
                });
                app.viewport.svg.style.cursor = 'move';
                app.renderShapes(true);
                e.preventDefault();
                return;
            }

            const additiveBox = isAdditiveSelectionModifier(e);
            beginBoxSelectSession(app, worldPos, additiveBox);
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
            handlePointAppendingToolMouseDown(app, snapped, point => app._addLinePoint(point));
        } else if (app.currentTool === 'polygon') {
            handlePointAppendingToolMouseDown(app, snapped, point => app._addPolygonPoint(point));
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
            handleStartFinishToolMouseDown(app, snapped);
        } else if (app.currentTool === 'noconnect' || app.currentTool === 'netlabel') {
            // Pin-aware snap: pin > wire endpoint/segment > grid
            const resolved = resolveWireSnapPosition(app, worldPos, { pinTolerance: PIN_SNAP_TOL });
            app._drawSnapResult = resolved;
            const pos = { x: resolved.x, y: resolved.y };
            if (!app.isDrawing) {
                app._startDrawing(pos);
            } else {
                app._finishDrawing(pos);
            }
            // Keep placement ghost synced immediately (e.g. NET index updates
            // after placing a netlabel even before the next mousemove).
            updateToolGhost(app, pos);
        } else {
            // Default fallback for any other tools in future
            handleStartFinishToolMouseDown(app, snapped);
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

        if (!handleRightClickDrawingMouseUp(app, worldPos, snapped)) {
            return; // No matching tool — skip preventDefault and cursor reset
        }
        app._setToolCursor(app.currentTool, app.viewport.svg);
        e.preventDefault();
    });

    svg.addEventListener('contextmenu', (e) => {
        const { screenPos, worldPos } = getEventPositions(e, app.viewport);

        if (app.currentTool === 'select' && handleSelectContextMenu(app, worldPos, e.clientX, e.clientY)) {
            e.preventDefault();
            return;
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

        // Highlight pins / wire endpoints for noconnect and netlabel tools
        if (app.currentTool === 'noconnect' || app.currentTool === 'netlabel') {
            if (!app.isDrawing) {
                const resolved = resolveWireSnapPosition(app, worldPos, { pinTolerance: PIN_SNAP_TOL });
                updateSnapHighlight(app, resolved);
                updateToolGhost(app, { x: resolved.x, y: resolved.y });
            }
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
            promotePendingAnchorDragSession(app, screenPos, {
                dragThresholdPx: DRAG_THRESHOLD_PX,
                vertexEpsilon: VERTEX_EPSILON
            });
            if (!app.isDragging) return;
        }
        if (app.viewport.isPanning) return;

        if (app.dragMode === 'move') {
            handleMoveDragMouseMove(app, worldPos);
        } else if (app.dragMode === 'anchor' && app.dragShape) {
            handleAnchorDragMouseMove(app, worldPos, snapped);
        } else if (app.dragMode === 'wire-segment' && app.dragShape) {
            handleWireSegmentDragMouseMove(app, worldPos);
        } else if (app.dragMode === 'box' && app.boxSelectStart) {
            app.didDrag = true;
            app._updateBoxSelectElement(worldPos);
            // Diff-based live selection: only invalidates shapes whose state changed
            const bounds = app._getBoxSelectBounds(worldPos);
            app.selection.syncBoxSelection(bounds, !!app.boxSelectAdditive, 'contain');
            app.renderShapes(false);
        }
    });

    // Listen on window so mouseup is caught even if mouse leaves the SVG
    window.addEventListener('mouseup', (e) => {
        if (e.button !== 0) return;

        const { worldPos, snapped } = getEventPositions(e, app.viewport);

        if (handleBoxSelectMouseUp(app, worldPos)) {
            return;
        }

        // Always ensure proper cleanup, even during mode 2 click-to-end interaction
        handleActiveDragMouseUp(app);

        if (app.viewport.isPanning) return;

        handleDrawingToolMouseUp(app, snapped, CLICK_TO_END_TOOLS);
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

            app.selection.handleClick(worldPos, isAdditiveSelectionModifier(e));
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
            clearPendingAnchorDrag(app);
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
