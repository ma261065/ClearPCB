/**
 * Binds change listeners for grid size, grid style, units, show-grid,
 * snap-to-grid dropdowns/checkboxes, and zoom/fit/reset buttons.
 * @param {object} app - Application state.
 */
export function serializeGridSettings(viewport) {
    if (!viewport) return undefined;
    return {
        gridSize: viewport.gridSize,
        gridStyle: viewport.gridStyle,
        units: viewport.units,
        gridVisible: viewport.gridVisible,
        snapToGrid: viewport.snapToGrid,
    };
}

export function restoreGridSettings(app, settings) {
    if (!settings || !app.viewport) return;
    const viewport = app.viewport;
    if (['mm', 'inch', 'mil'].includes(settings.units)) viewport.setUnits(settings.units);
    if (Number.isFinite(settings.gridSize) && settings.gridSize > 0 && settings.gridSize <= 1000) {
        viewport.setGridSize(settings.gridSize);
    }
    if (settings.gridStyle === 'lines' || settings.gridStyle === 'dots') viewport.setGridStyle(settings.gridStyle);
    if (typeof settings.gridVisible === 'boolean') viewport.setGridVisible(settings.gridVisible);
    if (typeof settings.snapToGrid === 'boolean') viewport.snapToGrid = settings.snapToGrid;
    if (!viewport.gridVisible) viewport.snapToGrid = false;
    const ui = app.ui || {};
    if (ui.units) ui.units.value = viewport.units;
    if (ui.gridStyle) ui.gridStyle.value = viewport.gridStyle;
    if (ui.showGrid) ui.showGrid.checked = viewport.gridVisible;
    if (ui.snapToGrid) {
        ui.snapToGrid.checked = viewport.snapToGrid;
        ui.snapToGrid.disabled = !viewport.gridVisible;
    }
    if (ui.gridSize) updateGridDropdown(app, true);
}

export function bindViewportControls(app) {
    app.ui.gridSize.addEventListener('change', (e) => {
        app.viewport.setGridSize(parseFloat(e.target.value));
        app.fileManager.setDirty(true);
    });

    app.ui.gridStyle.addEventListener('change', (e) => {
        app.viewport.setGridStyle(e.target.value);
        app.fileManager.setDirty(true);
    });

    app.ui.units.addEventListener('change', (e) => {
        app.viewport.setUnits(e.target.value);
        app._updateGridDropdown();
        app.fileManager.setDirty(true);
    });

    // Sync initial snap-to-grid disabled state
    if (!app.ui.showGrid.checked) {
        app.ui.snapToGrid.disabled = true;
    }

    app.ui.showGrid.addEventListener('change', (e) => {
        const gridOn = e.target.checked;
        app.viewport.setGridVisible(gridOn);
        // Disable snap-to-grid when grid is off
        app.ui.snapToGrid.disabled = !gridOn;
        if (!gridOn) {
            app.ui.snapToGrid.checked = false;
            app.viewport.snapToGrid = false;
        }
        app.fileManager.setDirty(true);
    });

    app.ui.snapToGrid.addEventListener('change', (e) => {
        app.viewport.snapToGrid = e.target.checked;
        app.fileManager.setDirty(true);
    });

    document.getElementById('zoomFit').addEventListener('click', () => {
        app._fitToContent();
    });

    document.getElementById('zoomIn').addEventListener('click', () => {
        app.viewport.zoomIn();
    });

    document.getElementById('zoomOut').addEventListener('click', () => {
        app.viewport.zoomOut();
    });

    document.getElementById('resetView').addEventListener('click', () => {
        app.viewport.resetView();
    });
}

/**
 * Rebuilds the grid-size `<select>` options for the current unit system
 * and selects the closest match to the current grid size.
 * @param {object} app - Application state.
 */
export function updateGridDropdown(app, preserveSize = false) {
    const options = app.viewport.getGridOptions();
    const currentValue = app.viewport.gridSize;

    app.ui.gridSize.innerHTML = '';

    for (const opt of options) {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        app.ui.gridSize.appendChild(option);
    }

    let closestIdx = 0;
    let closestDiff = Infinity;
    for (let i = 0; i < options.length; i++) {
        const diff = Math.abs(options[i].value - currentValue);
        if (diff < closestDiff) {
            closestDiff = diff;
            closestIdx = i;
        }
    }
    if (preserveSize && closestDiff > 1e-9) {
        const option = document.createElement('option');
        option.value = String(currentValue);
        option.textContent = `${Number(currentValue.toFixed(6))} mm`;
        app.ui.gridSize.appendChild(option);
        app.ui.gridSize.value = String(currentValue);
        return;
    }
    app.ui.gridSize.selectedIndex = closestIdx;

    if (!preserveSize) app.viewport.setGridSize(options[closestIdx].value);
}

/**
 * Computes the bounding box of all shapes and components and calls
 * `viewport.fitToBounds` to zoom/pan to fit them with padding.
 * @param {object} app - Application state.
 */
export function fitToContent(app) {
    // Always fit to content (shapes + components), paper is just a guide
    if (app.shapes.length === 0 && app.components.length === 0) {
        app.viewport.resetView();
        return;
    }

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const shape of app.shapes) {
        const b = shape.getBounds();
        minX = Math.min(minX, b.minX);
        minY = Math.min(minY, b.minY);
        maxX = Math.max(maxX, b.maxX);
        maxY = Math.max(maxY, b.maxY);
    }

    for (const comp of app.components) {
        const b = comp.getBounds();
        if (!b) continue;
        minX = Math.min(minX, b.minX);
        minY = Math.min(minY, b.minY);
        maxX = Math.max(maxX, b.maxX);
        maxY = Math.max(maxY, b.maxY);
    }

    app.viewport.fitToBounds(minX, minY, maxX, maxY, 10);
}
