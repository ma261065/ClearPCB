export function handleEscape(app) {
    if (app._suppressNextEscape) {
        app._suppressNextEscape = false;
        return;
    }
    if (app.textEdit) {
        app._endTextEdit(false);
        return;
    }
    if (app.isDrawing) {
        if (app.currentTool === 'wire') {
            app._cancelWireDrawing();
        } else {
            app._cancelDrawing();
        }
        return;
    }
    if (app.placingComponent) {
        app._cancelComponentPlacement();
        return;
    }
    if (app.componentPicker.isOpen) {
        app.componentPicker.close();
        return;
    }
    if (app.dragMode === 'box') {
        app._removeBoxSelectElement();
        app.isDragging = false;
        app.dragMode = null;
        app.boxSelectStart = null;
        return;
    }
    if (app.currentTool !== 'select') {
        app._onToolSelected('select');
    } else {
        app.selection.clearSelection();
        app.renderShapes(true);
    }
}
