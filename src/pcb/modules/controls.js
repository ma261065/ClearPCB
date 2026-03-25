import { updateGridDropdown } from '../../ui/modules/viewport.js';
import { PCB_LAYERS, buildLayerPanel } from './layers.js';

/**
 * Binds PCB-specific UI controls for tools and layers.
 * @param {object} app
 */
export function bindPcbControls(app) {
    const selectBtn = document.getElementById('pcbToolSelect');
    const trackBtn = document.getElementById('pcbToolTrack');
    const padBtn = document.getElementById('pcbToolPad');
    const viaBtn = document.getElementById('pcbToolVia');
    const holeBtn = document.getElementById('pcbToolHole');
    const zoomOutBtn = document.getElementById('pcbZoomOut');
    const zoomInBtn = document.getElementById('pcbZoomIn');
    const zoomFitBtn = document.getElementById('pcbZoomFit');
    const resetViewBtn = document.getElementById('pcbResetView');
    const showGridInput = document.getElementById('pcbShowGrid');
    const snapToGridInput = document.getElementById('pcbSnapToGrid');
    const gridSizeSelect = document.getElementById('pcbGridSize');
    const unitsSelect = document.getElementById('pcbUnits');
    const gridStyleSelect = document.getElementById('pcbGridStyle');

    const toolBtns = [selectBtn, trackBtn, padBtn, viaBtn, holeBtn];
    const validTools = new Set(['select', 'track', 'pad', 'via', 'hole']);

    const setToolButtonActive = (tool) => {
        for (const btn of toolBtns) {
            if (btn) btn.classList.toggle('active', btn.id === `pcbTool${tool.charAt(0).toUpperCase() + tool.slice(1)}`);
        }
    };

    const syncHomeToolHighlight = () => {
        const tool = typeof app.currentTool === 'string' && validTools.has(app.currentTool)
            ? app.currentTool
            : 'select';
        setToolButtonActive(tool);
    };

    const setTool = (tool) => {
        const nextTool = validTools.has(tool) ? tool : 'select';
        app.currentTool = nextTool;
        setToolButtonActive(nextTool);
        app._updateCursorForTool?.();
        app._setPcbStatus?.();
    };

    app._syncPcbHomeToolHighlight = syncHomeToolHighlight;

    selectBtn?.addEventListener('click', () => setTool('select'));
    trackBtn?.addEventListener('click', () => setTool('track'));
    padBtn?.addEventListener('click', () => setTool('pad'));
    viaBtn?.addEventListener('click', () => setTool('via'));
    holeBtn?.addEventListener('click', () => setTool('hole'));

    // Auto Route button
    const autoRouteBtn = document.getElementById('pcbAutoRoute');
    autoRouteBtn?.addEventListener('click', () => app.runAutoRoute?.());

    // Clear Routes button
    const clearRoutesBtn = document.getElementById('pcbClearRoutes');
    clearRoutesBtn?.addEventListener('click', () => app.clearRoutes?.());

    // Export DSN button
    const exportDsnBtn = document.getElementById('pcbExportDSN');
    exportDsnBtn?.addEventListener('click', () => app.exportDSN?.());

    // Import SES button
    const importSesBtn = document.getElementById('pcbImportSES');
    importSesBtn?.addEventListener('click', () => app.importSES?.());

    // Routing parameter units conversion
    const routeUnitsSelect = document.getElementById('pcbRouteUnits');
    const routeParamIds = ['pcbTrackWidth', 'pcbClearance', 'pcbViaDiameter', 'pcbViaDrill'];
    let routeParamUnit = 'mm';
    routeUnitsSelect?.addEventListener('change', () => {
        const newUnit = routeUnitsSelect.value;
        if (newUnit === routeParamUnit) return;
        const factor = (routeParamUnit === 'mm' && newUnit === 'inch') ? 1 / 25.4
                     : (routeParamUnit === 'inch' && newUnit === 'mm') ? 25.4 : 1;
        for (const id of routeParamIds) {
            const el = document.getElementById(id);
            if (el) {
                const v = parseFloat(el.value);
                if (!isNaN(v)) el.value = (v * factor).toFixed(newUnit === 'inch' ? 4 : 3);
                el.step = newUnit === 'inch' ? '0.001' : '0.01';
            }
        }
        routeParamUnit = newUnit;
    });

    // Specctra help flyout
    const specctraHelpBtn = document.getElementById('pcbSpecctraHelp');
    const specctraFlyout = document.getElementById('specctraHelpFlyout');
    const specctraClose = document.getElementById('specctraHelpClose');
    specctraHelpBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        specctraFlyout?.classList.toggle('open');
    });
    specctraClose?.addEventListener('click', (e) => {
        e.stopPropagation();
        specctraFlyout?.classList.remove('open');
    });
    document.addEventListener('click', (e) => {
        if (specctraFlyout?.classList.contains('open') &&
            !specctraFlyout.contains(e.target) &&
            e.target !== specctraHelpBtn) {
            specctraFlyout.classList.remove('open');
        }
    });

    // Layer panel
    buildLayerPanel(app);

    const syncViewToggles = () => {
        if (!app.viewport) return;
        if (showGridInput) {
            showGridInput.checked = !!app.viewport.gridVisible;
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
