import { MoveShapesCommand, ModifyShapeCommand } from '../../core/CommandHistory.js';

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
    app.pendingAnchorDrag = null;
    app.dragTotalDx = 0;
    app.dragTotalDy = 0;
    // Defensive: ensure box select rect is always removed
    app._removeBoxSelectElement();
    app.boxSelectStart = null;
    if (clearDidDrag) app.didDrag = false;
    if (resetCursor) app.viewport.svg.style.cursor = '';
}

/**
 * Show a lightweight context menu for anchor point operations.
 */
function showAnchorContextMenu(app, shape, anchorId, clientX, clientY) {
    // Remove any existing anchor context menu
    dismissAnchorContextMenu();

    const menu = document.createElement('div');
    menu.className = 'anchor-context-menu';
    menu.style.cssText = `
        position: fixed; left: ${clientX}px; top: ${clientY}px; z-index: 10000;
        background: #2b2b2b; border: 1px solid #555; border-radius: 4px;
        padding: 2px 0; box-shadow: 0 2px 8px rgba(0,0,0,0.4); min-width: 120px;
    `;

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
            app.renderShapes(true);
        }
    });
    menu.appendChild(item);
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

export function bindMouseEvents(app) {
    const svg = app.viewport.svg;

    svg.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (app.viewport.isPanning) return;

        const activeTab = document.querySelector('.ribbon-tab.active');
        if (activeTab?.dataset?.tab === 'file') {
            app._setActiveRibbonTab?.('home');
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
                    if (anchorId.startsWith('mid') && (shape.type === 'line' || shape.type === 'polygon')) {
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
            app._createBoxSelectElement();
            e.preventDefault();
            return;
        } else if (app.currentTool === 'wire') {
            if (!app.isDrawing) {
                const snapPin = app._findNearbyPin(worldPos);
                const startData = snapPin ?
                    { x: snapPin.worldPos.x, y: snapPin.worldPos.y, snapPin: snapPin } :
                    { ...app.viewport.getSnappedPosition(worldPos), snapPin: null };
                app._startWireDrawing(startData);
            } else {
                if (app.lastSnappedData) {
                    const lastPoint = app.wirePoints[app.wirePoints.length - 1];

                    if (app.wireAutoCorner && !app._pointsMatch(lastPoint, app.wireAutoCorner)) {
                        app._addWireWaypoint({ point: app.wireAutoCorner, snapPin: null });
                    }

                    app._addWireWaypoint({
                        point: app.drawCurrent,
                        snapPin: app.lastSnappedData.snapPin || null
                    });

                    if (app.lastSnappedData.snapPin && app.wirePoints.length >= 2) {
                        app._finishWireDrawing(app.lastSnappedData);
                    }
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
        const { worldPos, snapped } = getEventPositions(e, app.viewport);

        if (app.currentTool === 'wire' && app.isDrawing && app.wirePoints.length >= 2) {
            app._finishWireDrawing(worldPos);
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
                if (anchorId && anchorId.startsWith('p') && typeof shape.deleteAnchor === 'function') {
                    // Only show delete if shape has enough points to allow removal
                    const minPoints = shape.type === 'polygon' ? 4 : 3;
                    if (shape.points && shape.points.length >= minPoints) {
                        showAnchorContextMenu(app, shape, anchorId, e.clientX, e.clientY);
                        e.preventDefault();
                        return;
                    }
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
            const snapPin = app._findNearbyPin(worldPos);
            if (snapPin && snapPin !== app.wireSnapPin) {
                if (app.wireSnapPin) {
                    app._unhighlightPin();
                }
                app.wireSnapPin = snapPin;
                app._highlightPin(snapPin);
            } else if (!snapPin && app.wireSnapPin) {
                app._unhighlightPin();
            }

            if (app.isDrawing) {
                app._updateWireDrawing(worldPos);
                app._showCrosshair();
                app._updateCrosshair(snapped, screenPos);
            } else {
                app._showCrosshair();
                app._updateCrosshair(snapped, screenPos);
            }
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
            
            // Calculate actual movement from object's last snapped position
            const dx = snappedTarget.x - app.dragLastSnapped.x;
            const dy = snappedTarget.y - app.dragLastSnapped.y;

            if (dx !== 0 || dy !== 0) {
                app.didDrag = true;
                app.dragTotalDx += dx;
                app.dragTotalDy += dy;

                const sel = app.selection.getSelection();
                // Build set of component IDs being moved, so we can skip
                // their field texts (component.move already handles them)
                const movingCompIds = new Set();
                for (const s of sel) {
                    if (s.definition) movingCompIds.add(s.id);  // is a Component
                }

                for (const shape of sel) {
                    if (shape.locked) continue;
                    // Skip field text if its parent component is also being moved
                    if (shape.parentComponent && movingCompIds.has(shape.parentComponent.id)) continue;
                    shape.move(dx, dy);
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
            if (snapMode === 'axis') {
                anchorPos = app._getWireAnchorSnappedPosition(app.dragShape, app.dragAnchorId, worldPos);
            } else if (snapMode === 'none') {
                anchorPos = worldPos;
            } else {
                anchorPos = snapped;
            }
            const newAnchorId = app.dragShape.moveAnchor(app.dragAnchorId, anchorPos.x, anchorPos.y);
            if (newAnchorId && newAnchorId !== app.dragAnchorId) {
                app.dragAnchorId = newAnchorId;
            }
            app.renderShapes(false);
            if (app.textEdit) {
                app._updateTextEditOverlay?.();
            }
            app.fileManager.setDirty(true);
        } else if (app.dragMode === 'box' && app.boxSelectStart) {
            app.didDrag = true;
            app._updateBoxSelectElement(worldPos);
            // Live selection feedback during drag
            const bounds = app._getBoxSelectBounds(worldPos);
            app.selection.handleBoxSelect(bounds, e.shiftKey, 'contain');
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
                app.selection.handleBoxSelect(bounds, e.shiftKey, 'contain');
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
            } else if (app.dragShape) {
                if (app.didDrag && app.dragMode === 'anchor' && app.dragShapesBefore) {
                    const afterState = app._captureShapeState(app.dragShape);
                    app._applyShapeState(app.dragShape, app.dragShapesBefore);
                    const command = new ModifyShapeCommand(app, app.dragShape, app.dragShapesBefore, afterState);
                    app.history.execute(command);
                    
                    // Keep the shape selected after anchor drag completes
                    app.dragShape.selected = true;
                } else if (app.dragMode === 'anchor' && !app.didDrag) {
                    // Anchor drag was initiated but no movement occurred - keep shape selected
                    if (app.dragShape) {
                        app.dragShape.selected = true;
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
        if (app.currentTool === 'line' && app.isDrawing) {
            app._finishLine();
            return;
        }

        if (app.currentTool === 'polygon' && app.isDrawing) {
            app._finishPolygon();
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
