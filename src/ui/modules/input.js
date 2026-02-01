export function handleEscape(app) {
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
