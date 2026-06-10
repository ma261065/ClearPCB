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
    const textBtn = document.getElementById('pcbToolText');
    const zoomOutBtn = document.getElementById('pcbZoomOut');
    const zoomInBtn = document.getElementById('pcbZoomIn');
    const zoomFitBtn = document.getElementById('pcbZoomFit');
    const resetViewBtn = document.getElementById('pcbResetView');
    const showGridInput = document.getElementById('pcbShowGrid');
    const snapToGridInput = document.getElementById('pcbSnapToGrid');
    const gridSizeSelect = document.getElementById('pcbGridSize');
    const unitsSelect = document.getElementById('pcbUnits');
    const gridStyleSelect = document.getElementById('pcbGridStyle');

    const toolBtns = [selectBtn, trackBtn, padBtn, viaBtn, holeBtn, textBtn];
    const validTools = new Set(['select', 'track', 'pad', 'via', 'hole', 'text']);

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
        // Cancel any in-progress Track draw when switching away from the
        // track tool (or even just re-selecting it).
        if (app._trackDraw && nextTool !== 'track') {
            app._cancelTrackDraw?.();
        }
        app.currentTool = nextTool;
        setToolButtonActive(nextTool);
        app._updateCursorForTool?.();
        app._setPcbStatus?.();
        // Show per-tool options group (Home tab).
        if (nextTool === 'via') {
            app._showViaToolOptions?.();
        } else if (nextTool === 'track') {
            app._showTrackToolOptions?.();
        } else if (nextTool === 'text') {
            app._showTextToolOptions?.();
        } else {
            app._hideToolOptions?.();
        }
    };

    app._syncPcbHomeToolHighlight = syncHomeToolHighlight;

    selectBtn?.addEventListener('click', () => setTool('select'));
    trackBtn?.addEventListener('click', () => setTool('track'));
    padBtn?.addEventListener('click', () => setTool('pad'));
    viaBtn?.addEventListener('click', () => setTool('via'));
    holeBtn?.addEventListener('click', () => setTool('hole'));
    textBtn?.addEventListener('click', () => setTool('text'));

    // Auto Route button
    const autoRouteBtn = document.getElementById('pcbAutoRoute');
    autoRouteBtn?.addEventListener('click', () => app.runAutoRoute?.());

    // Clear Routes button
    const clearRoutesBtn = document.getElementById('pcbClearRoutes');
    clearRoutesBtn?.addEventListener('click', () => app.clearRoutes?.());

    // Test board buttons
    document.getElementById('pcbTestDense')?.addEventListener('click', () => app.loadTestBoard?.('test-board.json'));
    document.getElementById('pcbTestSpread')?.addEventListener('click', () => app.loadTestBoard?.('test-board-spread.json'));

    // Export DSN button
    const exportDsnBtn = document.getElementById('pcbExportDSN');
    exportDsnBtn?.addEventListener('click', () => app.exportDSN?.());

    // Export Gerber button
    const exportGerberBtn = document.getElementById('pcbExportGerber');
    exportGerberBtn?.addEventListener('click', () => app.exportGerber?.());

    // Export BOM button
    const exportBomBtn = document.getElementById('pcbExportBOM');
    exportBomBtn?.addEventListener('click', () => app.exportBOM?.());

    // Export Pick-and-place button
    const exportPnpBtn = document.getElementById('pcbExportPnP');
    exportPnpBtn?.addEventListener('click', () => app.exportPickAndPlace?.());

    // 3D View button
    const view3dBtn = document.getElementById('pcb3dView');
    view3dBtn?.addEventListener('click', () => app.open3DView?.());

    // 2D View button (shares the 3D panel; Top/Bottom toggle lives in the pane header)
    const view2dBtn = document.getElementById('pcb2dView');
    view2dBtn?.addEventListener('click', () => app.open2DView?.(app._last2DSide || 'top'));

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

    // Live-redraw clearance halos when any routing parameter changes (only
    // if the overlay is currently visible). Trace width and clearance both
    // affect halo radii; via diameter affects via halos.
    for (const id of routeParamIds) {
        const el = document.getElementById(id);
        el?.addEventListener('input', () => {
            if (app._clearancesVisible) app.showClearances?.(true);
        });
    }

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

    bindPcbFileMenu(app);
}

/**
 * Wire the PCB ribbon's File menu so it mirrors the schematic editor's
 * File menu exactly. There is only ONE document (schematic + PCB live in
 * a single file owned by the ProjectDocument), so every File operation
 * delegates to the project — New / Open / Save / Save As / Import all act
 * on the same document regardless of which editor the user triggered them
 * from. PDF / Print render the PCB itself (board-sized, in colour) and
 * are handled by the PCB view.
 * @param {object} app PCBApp instance.
 */
function bindPcbFileMenu(app) {
    const get = (id) => document.getElementById(id);
    /** The neutral document owner coordinates all file I/O. */
    const project = () => /** @type {any} */ (window).bootstrap?.project;
    /** The schematic view hosts the shared save-toast UI. */
    const host = () => /** @type {any} */ (window).app;

    get('pcbRibbonNew')?.addEventListener('click', () => {
        project()?.newDocument();
        app._setActiveRibbonTab?.('pcb-home');
    });
    get('pcbRibbonOpen')?.addEventListener('click', () => {
        project()?.open();
        app._setActiveRibbonTab?.('pcb-home');
    });

    // ── Import dropdown (mirrors the schematic File menu) ────────
    const importBtn = get('pcbRibbonImport');
    const importMenu = get('pcbRibbonImportMenu');
    if (importBtn && importMenu) {
        const closeImportMenu = () => importMenu.classList.remove('open');
        importBtn.addEventListener('click', () => {
            importMenu.classList.toggle('open');
        });
        document.addEventListener('click', (e) => {
            const t = /** @type {Node} */ (e.target);
            if (!importBtn.contains(t) && !importMenu.contains(t)) closeImportMenu();
        });
        importMenu.addEventListener('click', (e) => {
            const item = /** @type {HTMLElement} */ (e.target).closest('.dropdown-item');
            if (!item) return;
            closeImportMenu();
            if (/** @type {HTMLElement} */ (item).dataset.format === 'easyeda-sch') {
                project()?.importEasyEDA();
            }
        });
    }

    get('pcbRibbonSave')?.addEventListener('click', async () => {
        const result = await project()?.save();
        if (result?.success) host()?._showSaveToast?.('Saved');
    });
    get('pcbRibbonSaveAs')?.addEventListener('click', async () => {
        const result = await project()?.saveAs();
        if (result?.success) host()?._showSaveToast?.('Saved');
    });
    get('pcbRibbonExportPdf')?.addEventListener('click', () => app.savePdf());
    get('pcbRibbonPrint')?.addEventListener('click', () => app.print());
}
