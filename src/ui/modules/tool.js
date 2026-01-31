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
