export function handleEscape(app) {
    if (app.isDrawing) {
        if (app.currentTool === 'wire') {
            app._cancelWireDrawing();
        } else {
            app._cancelDrawing();
        }
    }
    if (app.placingComponent) {
        app._cancelComponentPlacement();
    }
    if (app.componentPicker.isOpen) {
        app.componentPicker.close();
    }
    if (app.dragMode === 'box') {
        app._removeBoxSelectElement();
        app.isDragging = false;
        app.dragMode = null;
        app.boxSelectStart = null;
    }
    if (app.currentTool !== 'select') {
        app._onToolSelected('select');
    } else {
        app.selection.clearSelection();
        app.renderShapes(true);
    }
}

export function setupEventBusListeners(app) {
    app.eventBus.on('component:selected', (def) => {
        app._onComponentDefinitionSelected(def);
    });
}

export function onToolSelected(app, tool) {
    app._cancelDrawing();

    if (tool !== 'component' && app.placingComponent) {
        app._cancelComponentPlacement();
    }

    if (tool !== 'component' && app.componentPicker.isOpen) {
        app.componentPicker.close();
    }

    app.currentTool = tool;

    if (tool === 'component') {
        if (!app.componentPicker.isOpen) {
            app.componentPicker.open();
        }
        const searchInput = app.componentPicker.element.querySelector('.cp-search-input');
        if (searchInput) {
            searchInput.focus();
        }
    }

    const svg = app.viewport.svg;
    app._setToolCursor(tool, svg);

    app._setActiveToolButton?.(tool);
    app._updateShapePanelOptions(app.selection.getSelection(), tool);
}

export function onComponentPickerClosed(app) {
    if (app.currentTool === 'component') {
        app._onToolSelected('select');
    }
}

export function onOptionsChanged(app, options) {
    app.toolOptions = { ...app.toolOptions, ...options };
}

export function updateSelectableItems(app) {
    const items = [...app.shapes, ...app.components];
    app.selection.setShapes(items);
}

export function generateReference(app, definition) {
    let prefix = definition.defaultReference || 'U?';
    prefix = prefix.replace(/[0-9?]+$/, '');

    let maxNum = 0;
    for (const comp of app.components) {
        if (comp.reference.startsWith(prefix)) {
            const num = parseInt(comp.reference.slice(prefix.length)) || 0;
            maxNum = Math.max(maxNum, num);
        }
    }

    return `${prefix}${maxNum + 1}`;
}

export function getSelectedComponents(app) {
    return [];
}

export function renderComponents(app) {
    for (const comp of app.components) {
        if (comp.element) {
            const transform = comp._buildTransform();
            if (transform) {
                comp.element.setAttribute('transform', transform);
            }
        }
    }
}

export function setupCallbacks(app) {
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
        if (app.ui.zoomLevel) {
            app.ui.zoomLevel.textContent = `${zoomPercent}%`;
        }

        const bounds = view.bounds;
        const v = app.viewport;
        const widthDisplay = v.formatValue(bounds.maxX - bounds.minX, 1);
        const heightDisplay = v.formatValue(bounds.maxY - bounds.minY, 1);
        const unitLabel = v.units === 'inch' ? '"' : ` ${v.units}`;
        if (app.ui.viewportInfo) {
            app.ui.viewportInfo.textContent = `${widthDisplay} × ${heightDisplay}${unitLabel}`;
        }

        app.renderShapes(true);
    };
}

export function updateUndoRedoButtons(app) {
    if (app.ui.undoBtn) {
        app.ui.undoBtn.disabled = !app.history.canUndo();
        app.ui.undoBtn.style.opacity = app.history.canUndo() ? '1' : '0.4';
    }
    if (app.ui.redoBtn) {
        app.ui.redoBtn.disabled = !app.history.canRedo();
        app.ui.redoBtn.style.opacity = app.history.canRedo() ? '1' : '0.4';
    }
}

export function makeHelpPanelDraggable() {
    const panel = document.querySelector('.help-panel');
    if (!panel) return;
    const header = panel.querySelector('h3') || panel;

    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    header.addEventListener('mousedown', (e) => {
        isDragging = true;
        const rect = panel.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        header.style.cursor = 'grabbing';
        e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const x = e.clientX - offsetX;
        const y = e.clientY - offsetY;

        const maxX = window.innerWidth - panel.offsetWidth;
        const maxY = window.innerHeight - panel.offsetHeight;

        panel.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
        panel.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    });

    window.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            header.style.cursor = 'grab';
        }
    });
}
