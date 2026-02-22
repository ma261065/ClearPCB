import { updateViewportCulling } from './shape-management.js';

export function setupCallbacks(app) {
    // Event bus listeners (component picker)
    app.eventBus.on('component:selected', (def) => {
        app._onComponentDefinitionSelected(def);
    });
    app.eventBus.on('component:pickerClosed', () => {
        app._onComponentPickerClosed();
    });

    let lastStatusUpdate = 0;
    let lastHoverUpdate = 0;
    const STATUS_THROTTLE = 50;
    const HOVER_THROTTLE = 30;

    app.viewport.onMouseMove = (world, snapped) => {
        if (app.isDrawing) {
            if (app.currentTool === 'wire') {
                const wireSnapped = app._getWireSnappedPosition(world);
                app._updateDrawing(wireSnapped);
                app._updateCrosshair(wireSnapped);
            } else {
                app._updateDrawing(snapped);
                app._updateCrosshair(snapped);
            }
        }

        if (app.pastingClipboard && app.pastePreviewGroup) {
            app._updatePastePreview(snapped);
        }

        if (app.placingComponent && app.componentPreview) {
            app._updateComponentPreview(snapped);
        }

        let now = performance.now();
        if (now - lastHoverUpdate > HOVER_THROTTLE) {
            lastHoverUpdate = now;

            if (!app.viewport.isPanning && !app.isDragging && app.currentTool === 'select') {
                const hit = app.selection.hitTest(world);
                const hoveredChanged = app.selection.setHovered(hit);

                let cursor = 'default';
                const selectedShapes = app.selection.getSelection();
                for (const shape of selectedShapes) {
                    const anchorId = shape.hitTestAnchor(world, app.viewport.scale);
                    if (anchorId) {
                        const anchors = shape.getAnchors();
                        const anchor = anchors.find(a => a.id === anchorId);
                        cursor = anchor?.cursor || 'crosshair';
                        break;
                    }
                }

                if (cursor === 'default' && hit && hit.selected) {
                    cursor = 'move';
                } else if (cursor === 'default' && hit) {
                    cursor = 'pointer';
                }

                app.viewport.svg.style.cursor = cursor;

                if (hoveredChanged) {
                    app.renderShapes();
                }
            }
        }

        now = performance.now();
        if (now - lastStatusUpdate > STATUS_THROTTLE) {
            lastStatusUpdate = now;
            const v = app.viewport;
            const unitLabel = v.units === 'inch' ? '"' : ` ${v.units}`;
            if (app.ui.cursorPos) {
                app.ui.cursorPos.textContent = `${v.formatValue(world.x)}, ${v.formatValue(world.y)}${unitLabel}`;
            }
            if (app.ui.gridSnap) {
                app.ui.gridSnap.textContent = `${v.formatValue(snapped.x)}, ${v.formatValue(snapped.y)}${unitLabel}`;
            }
        }
    };

    app.viewport.onViewChanged = (view) => {
        const zoomPercent = Math.round(app.viewport.zoom * 100);
        if (app.ui.zoomPercent) {
            app.ui.zoomPercent.textContent = `${zoomPercent}%`;
        }

        const bounds = view.bounds;
        const v = app.viewport;
        const widthDisplay = v.formatValue(bounds.maxX - bounds.minX, 1);
        const heightDisplay = v.formatValue(bounds.maxY - bounds.minY, 1);
        const unitLabel = v.units === 'inch' ? '"' : ` ${v.units}`;
        if (app.ui.viewportInfo) {
            app.ui.viewportInfo.textContent = `${widthDisplay} × ${heightDisplay}${unitLabel}`;
        }

        // Cull off-screen elements before rendering (so renderShapes can skip them)
        updateViewportCulling(app);

        // Only force full re-render when zoom/scale changed (stroke widths, anchors depend on scale).
        // On pan-only, shapes don't need any update since SVG viewBox handles translation.
        if (view.scaleChanged) {
            app.renderShapes(true);
        }
        app._updateTextEditOverlay?.();
    };

    // Throttled culling during pan (fired by Viewport rAF)
    app.viewport.onViewportCull = () => {
        updateViewportCulling(app);
    };
}
