const STORAGE_KEY = 'clearpcb_tool_options';

export function loadToolOptions() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            return JSON.parse(stored);
        }
    } catch (e) {
        console.warn('Failed to load tool options:', e);
    }
    return null;
}

export function saveToolOptions(options) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
    } catch (e) {
        console.warn('Failed to save tool options:', e);
    }
}

export function onToolSelected(app, tool) {
    app._cancelDrawing();
    
    // Update current tool first so that listeners (like ribbon) 
    // see the new tool state when selection is cleared
    app.currentTool = tool;
    
    // Clear selection when switching tools so that property panel inputs 
    // control default tool options (new shapes) rather than editing existing selection.
    if (tool !== 'select') {
        app.selection.clearSelection();
    }

    if (tool !== 'component' && app.placingComponent) {
        app._cancelComponentPlacement();
    }

    if (tool !== 'component' && app.componentPicker.isOpen) {
        app.componentPicker.close();
    }

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
    app._updatePropertiesPanel(app.selection.getSelection());
}

export function onComponentPickerClosed(app) {
    if (app.currentTool === 'component') {
        app._onToolSelected('select');
    }
}

export function onOptionsChanged(app, options) {
    app.toolOptions = { ...app.toolOptions, ...options };
    saveToolOptions(app.toolOptions);
}
