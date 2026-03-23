import { updateGridDropdown } from '../../ui/modules/viewport.js';
import { PCB_LAYERS, buildLayerPanel } from './layers.js';

/**
 * Binds PCB-specific UI controls for tools and layers.
 * @param {object} app
 */
export function bindPcbControls(app) {
    const selectBtn = document.getElementById('pcbToolSelect');
    const panBtn = document.getElementById('pcbToolPan');
    const zoomOutBtn = document.getElementById('pcbZoomOut');
    const zoomInBtn = document.getElementById('pcbZoomIn');
    const zoomFitBtn = document.getElementById('pcbZoomFit');
    const resetViewBtn = document.getElementById('pcbResetView');
    const showGridInput = document.getElementById('pcbShowGrid');
    const snapToGridInput = document.getElementById('pcbSnapToGrid');
    const showRulersInput = document.getElementById('pcbShowRulers');
    const gridSizeSelect = document.getElementById('pcbGridSize');
    const unitsSelect = document.getElementById('pcbUnits');
    const gridStyleSelect = document.getElementById('pcbGridStyle');

    const setTool = (tool) => {
        app.currentTool = tool;
        if (selectBtn) selectBtn.classList.toggle('active', tool === 'select');
        if (panBtn) panBtn.classList.toggle('active', tool === 'pan');
        app._updateCursorForTool?.();
        app._setPcbStatus?.();
    };

    selectBtn?.addEventListener('click', () => setTool('select'));
    panBtn?.addEventListener('click', () => setTool('pan'));

    // Layer panel
    buildLayerPanel(app);

    const syncViewToggles = () => {
        if (!app.viewport) return;
        if (showGridInput) {
            showGridInput.checked = !!app.viewport.gridVisible;
        }
        if (showRulersInput) {
            showRulersInput.checked = !!app.viewport.showRulers;
        }
        if (snapToGridInput) {
            snapToGridInput.checked = !!app.viewport.snapToGrid && !!app.viewport.gridVisible;
            snapToGridInput.disabled = !app.viewport.gridVisible;
        }
    };

    const ensureViewport = () => {
        app._ensureViewport?.();
        return app.viewport;
    };

    zoomOutBtn?.addEventListener('click', () => {
        const vp = ensureViewport();
        if (!vp) return;
        vp.zoomOut();
    });

    zoomInBtn?.addEventListener('click', () => {
        const vp = ensureViewport();
        if (!vp) return;
        vp.zoomIn();
    });

    zoomFitBtn?.addEventListener('click', () => {
        app._fitToContent?.();
    });

    resetViewBtn?.addEventListener('click', () => {
        const vp = ensureViewport();
        if (!vp) return;
        vp.resetView();
    });

    showGridInput?.addEventListener('change', (e) => {
        const vp = ensureViewport();
        if (!vp) return;
        const gridOn = !!e.target.checked;
        vp.setGridVisible(gridOn);
        if (!gridOn) {
            if (snapToGridInput) snapToGridInput.checked = false;
            vp.snapToGrid = false;
        }
        syncViewToggles();
    });

    snapToGridInput?.addEventListener('change', (e) => {
        const vp = ensureViewport();
        if (!vp || !vp.gridVisible) return;
        vp.snapToGrid = !!e.target.checked;
        syncViewToggles();
    });

    showRulersInput?.addEventListener('change', (e) => {
        const vp = ensureViewport();
        if (!vp) return;
        vp.showRulers = !!e.target.checked;
        vp._createRulers();
        syncViewToggles();
    });

    setTool(app.currentTool || 'select');
    syncViewToggles();

    // Grid size, style, units dropdowns — reuse shared updateGridDropdown
    app.ui = {
        gridSize: gridSizeSelect,
        gridStyle: gridStyleSelect,
        units: unitsSelect,
        showGrid: showGridInput,
        snapToGrid: snapToGridInput,
    };

    gridSizeSelect?.addEventListener('change', (e) => {
        const vp = ensureViewport();
        if (!vp) return;
        vp.setGridSize(parseFloat(/** @type {HTMLSelectElement} */ (e.target).value));
    });

    gridStyleSelect?.addEventListener('change', (e) => {
        const vp = ensureViewport();
        if (!vp) return;
        vp.setGridStyle(/** @type {HTMLSelectElement} */ (e.target).value);
    });

    unitsSelect?.addEventListener('change', (e) => {
        const vp = ensureViewport();
        if (!vp) return;
        vp.setUnits(/** @type {HTMLSelectElement} */ (e.target).value);
        app._updateGridDropdown?.();
    });

    app.syncPcbViewToggles = syncViewToggles;
}
