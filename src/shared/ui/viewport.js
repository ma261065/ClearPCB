/** @typedef {import('../../core/Viewport.js').Viewport} Viewport */
/** @typedef {{gridSize?: unknown, gridStyle?: unknown, units?: unknown, gridVisible?: unknown, snapToGrid?: unknown}} GridSettings */
/** @typedef {{value: number, label: string, separatorBefore?: boolean}} GridOption */
/** @typedef {{minX: number, minY: number, maxX: number, maxY: number}} Bounds */
/** @typedef {{getBounds: () => Bounds}} BoundShape */
/** @typedef {{getBounds: () => Bounds|null}} BoundComponent */
/** @typedef {{setDirty: (dirty: boolean) => void}} DirtyFileManager */
/** @typedef {{gridSize?: HTMLSelectElement, gridStyle?: HTMLSelectElement, units?: HTMLSelectElement, showGrid?: HTMLInputElement, snapToGrid?: HTMLInputElement}} ViewportUiControls */
/** @typedef {{viewport: Viewport|null, ui?: unknown, fileManager?: DirtyFileManager, _ribbonRefresh?: () => void, refreshPcbRibbon?: () => void, updateGridDropdown?: () => void, fitToContent?: () => void, shapes?: BoundShape[], components?: BoundComponent[]}} SharedViewportApp */

/** Grid preferences to save with a document, or undefined without a viewport. */
/** @param {Viewport|null|undefined} viewport */
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

/**
 * @param {object} app
 * @param {GridSettings|null|undefined} settings
 */
export function restoreGridSettings(app, settings) {
    // Public callers are editor classes; this shared module only reads this narrow surface.
    const target = /** @type {SharedViewportApp} */ (app);
    if (!settings || !target.viewport) return;
    const viewport = target.viewport;
    const units = settings.units;
    if (units === 'mm' || units === 'inch') viewport.setUnits(units);
    const gridSize = settings.gridSize;
    if (typeof gridSize === 'number' && Number.isFinite(gridSize) && gridSize > 0 && gridSize <= 1000) {
        viewport.setGridSize(gridSize);
    }
    if (settings.gridStyle === 'lines' || settings.gridStyle === 'dots') viewport.setGridStyle(settings.gridStyle);
    if (typeof settings.gridVisible === 'boolean') viewport.setGridVisible(settings.gridVisible);
    if (typeof settings.snapToGrid === 'boolean') viewport.snapToGrid = settings.snapToGrid;
    if (!viewport.gridVisible) viewport.snapToGrid = false;
    syncGridSettings(target);
}

/** @param {object} app */
export function syncGridSettings(app) {
    // Public callers are editor classes; this shared module only reads this narrow surface.
    const target = /** @type {SharedViewportApp} */ (app);
    const viewport = target.viewport;
    if (!viewport) return;
    target._ribbonRefresh?.();
    target.refreshPcbRibbon?.();
    const ui = /** @type {ViewportUiControls} */ (target.ui || {});
    if (ui.units) ui.units.value = viewport.units;
    if (ui.gridStyle) ui.gridStyle.value = viewport.gridStyle;
    if (ui.showGrid) ui.showGrid.checked = viewport.gridVisible;
    if (ui.snapToGrid) {
        ui.snapToGrid.checked = viewport.snapToGrid && viewport.gridVisible;
        ui.snapToGrid.disabled = !viewport.gridVisible;
    }
    updateGridDropdown(target);
}

/**
 * Binds change listeners for grid size, grid style, units, show-grid,
 * snap-to-grid dropdowns/checkboxes, and zoom/fit/reset buttons.
 * @param {SharedViewportApp & {viewport: Viewport, ui: Required<ViewportUiControls>, fileManager: DirtyFileManager, updateGridDropdown: () => void, fitToContent: () => void}} app - Application state.
 */
export function bindViewportControls(app) {
    app.ui.gridSize.addEventListener('change', (e) => {
        app.viewport.setGridSize(parseFloat(/** @type {HTMLSelectElement} */ (e.target).value));
        app.fileManager.setDirty(true);
    });

    app.ui.gridStyle.addEventListener('change', (e) => {
        app.viewport.setGridStyle(/** @type {'lines'|'dots'} */ (/** @type {HTMLSelectElement} */ (e.target).value));
        app.fileManager.setDirty(true);
    });

    app.ui.units.addEventListener('change', (e) => {
        app.viewport.setUnits(/** @type {import('../../core/Viewport.js').ViewportUnit} */ (/** @type {HTMLSelectElement} */ (e.target).value));
        app.updateGridDropdown();
        app.fileManager.setDirty(true);
    });

    // Sync initial snap-to-grid disabled state
    if (!app.ui.showGrid.checked) {
        app.ui.snapToGrid.disabled = true;
    }

    app.ui.showGrid.addEventListener('change', (e) => {
        const gridOn = /** @type {HTMLInputElement} */ (e.target).checked;
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
        app.viewport.snapToGrid = /** @type {HTMLInputElement} */ (e.target).checked;
        app.fileManager.setDirty(true);
    });

    /** @type {HTMLElement} */ (document.getElementById('zoomFit')).addEventListener('click', () => {
        app.fitToContent();
    });

    /** @type {HTMLElement} */ (document.getElementById('zoomIn')).addEventListener('click', () => {
        app.viewport.zoomIn();
    });

    /** @type {HTMLElement} */ (document.getElementById('zoomOut')).addEventListener('click', () => {
        app.viewport.zoomOut();
    });

    /** @type {HTMLElement} */ (document.getElementById('resetView')).addEventListener('click', () => {
        app.viewport.resetView();
    });
}

/**
 * Selects the nearest fixed preset and rebuilds the grid dropdown when present.
 * @param {object} app - Application state.
 */
export function updateGridDropdown(app) {
    // Public callers are editor classes; this shared module only reads this narrow surface.
    const target = /** @type {SharedViewportApp & {viewport: Viewport}} */ (app);
    const options = /** @type {GridOption[]} */ (target.viewport.getGridOptions());
    const currentValue = target.viewport.gridSize;

    const ui = /** @type {ViewportUiControls|undefined} */ (target.ui);
    const select = ui?.gridSize;
    if (select) {
        select.innerHTML = '';
        for (const opt of options) {
            if (opt.separatorBefore) {
                const separator = document.createElement('option');
                separator.value = '';
                separator.textContent = '\u2500'.repeat(12);
                separator.disabled = true;
                select.appendChild(separator);
            }
            const option = document.createElement('option');
            option.value = String(opt.value);
            option.textContent = opt.label;
            select.appendChild(option);
        }
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
    const size = options[closestIdx].value;
    if (select) select.value = String(size);
    if (size !== currentValue) target.viewport.setGridSize(size);
}

/**
 * Computes the bounding box of all shapes and components and calls
 * `viewport.fitToBounds` to zoom/pan to fit them with padding.
 * @param {object} app - Application state.
 */
export function fitToContent(app) {
    // Public callers are editor classes; this shared module only reads this narrow surface.
    const target = /** @type {SharedViewportApp & {viewport: Viewport, shapes: BoundShape[], components: BoundComponent[]}} */ (app);
    // Always fit to content (shapes + components), paper is just a guide
    if (target.shapes.length === 0 && target.components.length === 0) {
        target.viewport.resetView();
        return;
    }

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const shape of target.shapes) {
        const b = shape.getBounds();
        minX = Math.min(minX, b.minX);
        minY = Math.min(minY, b.minY);
        maxX = Math.max(maxX, b.maxX);
        maxY = Math.max(maxY, b.maxY);
    }

    for (const comp of target.components) {
        const b = comp.getBounds();
        if (!b) continue;
        minX = Math.min(minX, b.minX);
        minY = Math.min(minY, b.minY);
        maxX = Math.max(maxX, b.maxX);
        maxY = Math.max(maxY, b.maxY);
    }

    target.viewport.fitToBounds(minX, minY, maxX, maxY, 10);
}
