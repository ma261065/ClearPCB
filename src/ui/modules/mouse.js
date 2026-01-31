import { MoveShapesCommand, ModifyShapeCommand } from '../../core/CommandHistory.js';

export function bindMouseEvents(app) {
    const svg = app.viewport.svg;

    svg.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        if (app.viewport.isPanning) return;

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
                    app.isDragging = true;
                    app.dragMode = 'anchor';
                    app.dragStart = { ...snapped };
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
                    e.preventDefault();
                    return;
                }
            }

            const hitShape = app.selection.hitTest(worldPos);

            if (hitShape) {
                const additive = e.shiftKey || e.ctrlKey || e.metaKey;
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
                app.dragStart = { ...snapped };
                app.dragTotalDx = 0;
                app.dragTotalDy = 0;
                app.viewport.svg.style.cursor = 'move';
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
        } else {
            app._startDrawing(snapped);
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

        if (app.currentTool !== 'select') {
            app._showCrosshair();
            app._updateCrosshair(snapped, screenPos);
        }

        if (!app.isDragging) return;
        if (app.viewport.isPanning) return;

        if (app.dragMode === 'move') {
            const dx = snapped.x - app.dragStart.x;
            const dy = snapped.y - app.dragStart.y;

            if (dx !== 0 || dy !== 0) {
                app.didDrag = true;
                app.dragTotalDx += dx;
                app.dragTotalDy += dy;

                for (const shape of app.selection.getSelection()) {
                    if (!shape.locked) {
                        shape.move(dx, dy);
                    }
                }
                app.dragStart = { ...snapped };
                app.renderShapes(true);
                app.fileManager.setDirty(true);
            }
        } else if (app.dragMode === 'anchor' && app.dragShape) {
            app.didDrag = true;
            const anchorPos = app.dragShape.type === 'wire'
                ? app._getWireAnchorSnappedPosition(app.dragShape, app.dragAnchorId, worldPos)
                : snapped;
            const newAnchorId = app.dragShape.moveAnchor(app.dragAnchorId, anchorPos.x, anchorPos.y);
            if (newAnchorId && newAnchorId !== app.dragAnchorId) {
                app.dragAnchorId = newAnchorId;
            }
            app.renderShapes(true);
            app.fileManager.setDirty(true);
        } else if (app.dragMode === 'box' && app.boxSelectStart) {
            app.didDrag = true;
            app._updateBoxSelectElement(worldPos);
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
                    const command = new MoveShapesCommand(app, selectedShapes, app.dragTotalDx, app.dragTotalDy);
                    app.history.execute(command);
                }
            } else if (app.didDrag && app.dragMode === 'anchor' && app.dragShape && app.dragShapesBefore) {
                const afterState = app._captureShapeState(app.dragShape);
                app._applyShapeState(app.dragShape, app.dragShapesBefore);
                const command = new ModifyShapeCommand(app, app.dragShape, app.dragShapesBefore, afterState);
                app.history.execute(command);
            }

            app.isDragging = false;
            app.dragMode = null;
            app.dragStart = null;
            app.dragAnchorId = null;
            app.dragShape = null;
            app.dragShapesBefore = null;
            app.dragWireAnchorOriginal = null;
        }

        if (app.viewport.isPanning) return;

        if (app.currentTool === 'polygon') {
            // Polygon continues until double-click or Escape
        } else if (app.currentTool === 'wire') {
            // Wire continues until Enter is pressed
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
            app.selection.handleClick(worldPos, e.shiftKey || e.ctrlKey || e.metaKey);
            app.renderShapes(true);
        }
    });

    svg.addEventListener('dblclick', (e) => {
        if (app.currentTool === 'polygon' && app.isDrawing) {
            app._finishPolygon();
        }
    });
}
