import { MoveShapesCommand, ModifyShapeCommand } from '../../core/CommandHistory.js';

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

        const rect = svg.getBoundingClientRect();
        const screenPos = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
        const worldPos = app.viewport.screenToWorld(screenPos);
        const snapped = app.viewport.getSnappedPosition(worldPos);

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
                    // Defer anchor drag until the mouse actually moves
                    app.pendingAnchorDrag = {
                        shape,
                        anchorId,
                        screenPos: { ...screenPos },
                        snapped: { ...snapped }
                    };
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
                    // Handle different shape types (some use x/y, some use points, some use x1/y1)
                    if (typeof firstShape.x === 'number' && typeof firstShape.y === 'number') {
                        app.dragObjectStartPos = { x: firstShape.x, y: firstShape.y };
                    } else if (typeof firstShape.x1 === 'number' && typeof firstShape.y1 === 'number') {
                        app.dragObjectStartPos = { x: firstShape.x1, y: firstShape.y1 };
                    } else if (firstShape.points && firstShape.points.length > 0) {
                        app.dragObjectStartPos = { x: firstShape.points[0].x, y: firstShape.points[0].y };
                    } else {
                        app.dragObjectStartPos = { ...snapped };
                    }
                } else {
                    app.dragObjectStartPos = { ...snapped };
                }
                // Snap object's current position to current grid in case grid changed
                const objectSnapped = app.viewport.getSnappedPosition(app.dragObjectStartPos);
                // If object is off-grid, move it to grid before drag
                if (objectSnapped.x !== app.dragObjectStartPos.x || objectSnapped.y !== app.dragObjectStartPos.y) {
                    const adjX = objectSnapped.x - app.dragObjectStartPos.x;
                    const adjY = objectSnapped.y - app.dragObjectStartPos.y;
                    for (const shape of app.selection.getSelection()) {
                        if (!shape.locked) {
                            shape.move(adjX, adjY);
                        }
                    }
                    app.dragObjectStartPos = { ...objectSnapped };
                }
                // Initialize drag refs from the object's (now-snapped) position
                app.dragStart = { ...objectSnapped };
                app.dragLastSnapped = { ...objectSnapped };
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
                const rect = app.viewport.svg.getBoundingClientRect();
                const screenPos = {
                    x: e.clientX - rect.left,
                    y: e.clientY - rect.top
                };
                const worldPos = app.viewport.screenToWorld(screenPos);
                const gridSnapped = app.viewport.getSnappedPosition(worldPos);

                if (app.lastSnappedData) {
                    const lastPoint = app.wirePoints[app.wirePoints.length - 1];
                    const rawDx = Math.abs(worldPos.x - lastPoint.x);
                    const rawDy = Math.abs(worldPos.y - lastPoint.y);
                    const minMovement = 0.05;

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
        } else if (app.currentTool === 'line' || app.currentTool === 'rect' || app.currentTool === 'circle') {
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
        if (app.currentTool === 'wire' && app.isDrawing && app.wirePoints.length >= 2) {
            const rect = svg.getBoundingClientRect();
            const screenPos = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            const worldPos = app.viewport.screenToWorld(screenPos);
            app._finishWireDrawing(worldPos);
            app._setToolCursor(app.currentTool, app.viewport.svg);
            e.preventDefault();
        } else if (app.currentTool === 'arc' && app.isDrawing && app.arcEndpoint) {
            const rect = svg.getBoundingClientRect();
            const screenPos = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            const worldPos = app.viewport.screenToWorld(screenPos);
            // Use unsnapped position for arc bulge point and ensure preview state is current
            app._updateDrawing(worldPos);
            app._finishDrawing(worldPos);
            app._setToolCursor(app.currentTool, app.viewport.svg);
            e.preventDefault();
        } else if (app.currentTool === 'polygon' && app.isDrawing) {
            const rect = svg.getBoundingClientRect();
            const screenPos = {
                x: e.clientX - rect.left,
                y: e.clientY - rect.top
            };
            const worldPos = app.viewport.screenToWorld(screenPos);
            const snapped = app.viewport.getSnappedPosition(worldPos);
            app._addPolygonPoint(snapped);
            app._finishPolygon();
            app._setToolCursor(app.currentTool, app.viewport.svg);
            e.preventDefault();
        }
    });

    svg.addEventListener('contextmenu', (e) => {
        const rect = svg.getBoundingClientRect();
        const screenPos = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
        const worldPos = app.viewport.screenToWorld(screenPos);
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
        const rect = svg.getBoundingClientRect();
        const screenPos = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
        const worldPos = app.viewport.screenToWorld(screenPos);
        const snapped = app.viewport.getSnappedPosition(worldPos);

        if (!app.isDragging && !app.viewport.isPanning && !app.placingComponent && !app._componentCodeTooltipPinned && app.showComponentDebugTooltip !== false) {
            const hitComponent = app._findComponentAt?.(worldPos);
            app._updateComponentCodeTooltip?.(hitComponent, screenPos);
        } else {
            if (!app._componentCodeTooltipPinned) {
                app._updateComponentCodeTooltip?.(null, screenPos);
            }
        }

        // Always update component preview if we are placing one.
        // This must happen before any tool-specific logic or returns.
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
            } else if (['line', 'rect', 'circle', 'polygon'].includes(app.currentTool)) {
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
                    const { shape, anchorId, snapped: startSnapped } = app.pendingAnchorDrag;
                    app.pendingAnchorDrag = null;
                    app.isDragging = true;
                    app.dragMode = 'anchor';
                    app.dragStart = { ...startSnapped };
                    app.dragStartScreen = { ...screenPos };
                    app.dragAnchorId = anchorId;
                    app.dragShape = shape;
                    app.dragWireAnchorOriginal = null;
                    if (shape.type === 'wire') {
                        const match = anchorId.match(/point(\d+)/);
                        const idx = match ? parseInt(match[1]) : null;
                        if (idx !== null && idx >= 0 && idx < shape.points.length) {
                            const current = shape.points[idx];
                            app.dragWireAnchorOriginal = { x: current.x, y: current.y };
                        }
                    }
                    app.dragShapesBefore = app._captureShapeState(shape);
                }
            }
            if (!app.isDragging) return;
        }
        if (app.viewport.isPanning) return;

        if (app.dragMode === 'move') {
            // Calculate movement from mouse, then snap the object's position to current grid
            const mouseMovement = {
                x: worldPos.x - app.dragStartWorldPos.x,
                y: worldPos.y - app.dragStartWorldPos.y
            };
            
            // Apply movement to object's starting position and snap to current grid
            const targetPos = {
                x: app.dragObjectStartPos.x + mouseMovement.x,
                y: app.dragObjectStartPos.y + mouseMovement.y
            };
            const snappedTarget = app.viewport.getSnappedPosition(targetPos);
            
            // Calculate actual movement from object's last snapped position
            const dx = snappedTarget.x - app.dragLastSnapped.x;
            const dy = snappedTarget.y - app.dragLastSnapped.y;

            if (dx !== 0 || dy !== 0) {
                app.didDrag = true;
                app.dragTotalDx += dx;
                app.dragTotalDy += dy;

                for (const shape of app.selection.getSelection()) {
                    if (!shape.locked) {
                        if (shape.type === 'arc') {
                            shape._draggingMidTo = null;
                            shape._dragMidPoint = null;
                        }
                        shape.move(dx, dy);
                        if (shape.type === 'arc') {
                            shape._dragMoveOffset = { x: app.dragTotalDx, y: app.dragTotalDy };
                        }
                    }
                }
                app.dragLastSnapped = { ...snappedTarget };
                app.renderShapes(true);
                if (app.textEdit) {
                    app._updateTextEditOverlay?.();
                }
                app.fileManager.setDirty(true);
            }
        } else if (app.dragMode === 'anchor' && app.dragShape) {
            app.didDrag = true;
            // For arc mid-anchor, use worldPos (not snapped). For everything else, use snapped.
            let anchorPos;
            if (app.dragShape.type === 'wire') {
                anchorPos = app._getWireAnchorSnappedPosition(app.dragShape, app.dragAnchorId, worldPos);
            } else if (app.dragShape.type === 'arc' && app.dragAnchorId === 'mid') {
                anchorPos = worldPos; // No snapping for arc mid-anchor
            } else {
                anchorPos = snapped;
            }
            const newAnchorId = app.dragShape.moveAnchor(app.dragAnchorId, anchorPos.x, anchorPos.y);
            if (newAnchorId && newAnchorId !== app.dragAnchorId) {
                app.dragAnchorId = newAnchorId;
            }
            app.renderShapes(true);
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
            app.renderShapes(true);
        }
    });

    svg.addEventListener('mouseup', (e) => {
        if (e.button !== 0) return;

        const rect = svg.getBoundingClientRect();
        const screenPos = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
        const worldPos = app.viewport.screenToWorld(screenPos);
        const snapped = app.viewport.getSnappedPosition(worldPos);

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

        if (app.isDragging) {
            if (app.didDrag && app.dragMode === 'move') {
                const selectedShapes = app.selection.getSelection();
                if (selectedShapes.length > 0 && (app.dragTotalDx !== 0 || app.dragTotalDy !== 0)) {
                    for (const shape of selectedShapes) {
                        shape.move(-app.dragTotalDx, -app.dragTotalDy);
                    }
                    for (const shape of selectedShapes) {
                        if (shape.type === 'arc') {
                            shape._dragMoveOffset = null;
                        }
                    }
                    const command = new MoveShapesCommand(app, selectedShapes, app.dragTotalDx, app.dragTotalDy);
                    app.history.execute(command);
                    for (const shape of selectedShapes) {
                        if (shape.type === 'arc') {
                            shape._dragMoveOffset = null;
                        }
                    }
                }
            } else if (app.didDrag && app.dragMode === 'anchor' && app.dragShape && app.dragShapesBefore) {
                const afterState = app._captureShapeState(app.dragShape);
                app._applyShapeState(app.dragShape, app.dragShapesBefore);
                const command = new ModifyShapeCommand(app, app.dragShape, app.dragShapesBefore, afterState);
                app.history.execute(command);
                
                // Clear _dragMidPoint immediately (it's for endpoint drags)
                if (app.dragShape._dragMidPoint) {
                    app.dragShape._dragMidPoint = null;
                }
                // Note: Don't clear _draggingMidTo here - it will be cleared at the start of the next drag
            }

            app.isDragging = false;
            app.dragMode = null;
            app.dragStart = null;
            app.dragAnchorId = null;
            app.dragShape = null;
            app.dragShapesBefore = null;
            app.dragWireAnchorOriginal = null;
            app.pendingAnchorDrag = null;
            if (app.textEdit) {
                app._updateTextEditOverlay?.();
            }
        }

        if (app.viewport.isPanning) return;

        if (app.currentTool === 'polygon') {
            // Polygon continues until double-click or Escape
        } else if (app.currentTool === 'wire') {
            // Wire continues until Enter is pressed
        } else if (['line', 'rect', 'circle', 'arc'].includes(app.currentTool)) {
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

        const rect = svg.getBoundingClientRect();
        const screenPos = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
        const worldPos = app.viewport.screenToWorld(screenPos);

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
        if (app.currentTool === 'polygon' && app.isDrawing) {
            app._finishPolygon();
            return;
        }

        if (app.currentTool !== 'select') return;

        const rect = svg.getBoundingClientRect();
        const screenPos = {
            x: e.clientX - rect.left,
            y: e.clientY - rect.top
        };
        const worldPos = app.viewport.screenToWorld(screenPos);
        const hit = app.selection.hitTest(worldPos);

        if (hit && hit.type === 'text') {
            app.selection.select(hit, false);
            app.renderShapes(true);
            app._startTextEdit(hit);
            app._setTextEditCaretFromScreen(screenPos);
        }
    });
}
