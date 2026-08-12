import { updateGridDropdown } from '../../ui/modules/viewport.js';
import { PCB_LAYERS, buildLayerPanel } from './layers.js';
import { bindRecentsDropdown } from '../../ui/modules/recents.js';

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
    const shapesBtn = document.getElementById('pcbToolShapes');
    const shapesArrowBtn = document.getElementById('pcbToolShapesArrow');
    const shapesWrap = document.getElementById('pcbToolShapesWrap');
    const shapesMenu = document.getElementById('pcbToolShapesMenu');
    const textBtn = document.getElementById('pcbToolText');
    const fillBtn = document.getElementById('pcbToolFill');
    const zoomOutBtn = document.getElementById('pcbZoomOut');
    const zoomInBtn = document.getElementById('pcbZoomIn');
    const zoomFitBtn = document.getElementById('pcbZoomFit');
    const resetViewBtn = document.getElementById('pcbResetView');
    const showGridInput = document.getElementById('pcbShowGrid');
    const snapToGridInput = document.getElementById('pcbSnapToGrid');
    const gridSizeSelect = document.getElementById('pcbGridSize');
    const unitsSelect = document.getElementById('pcbUnits');
    const gridStyleSelect = document.getElementById('pcbGridStyle');
    const copyHomeBtn = document.getElementById('pcbCopyHome');
    const cutHomeBtn = document.getElementById('pcbCutHome');
    const pasteHomeBtn = document.getElementById('pcbPasteHome');
    const copyPropsBtn = document.getElementById('pcbCopyProps');
    const cutPropsBtn = document.getElementById('pcbCutProps');
    const pastePropsBtn = document.getElementById('pcbPasteProps');
    const undoBtn = document.getElementById('pcbUndoBtn');
    const redoBtn = document.getElementById('pcbRedoBtn');

    const toolBtns = [selectBtn, trackBtn, padBtn, viaBtn, holeBtn, shapesBtn, textBtn, fillBtn];
    const validTools = new Set(['select', 'track', 'pad', 'via', 'line', 'circle', 'arc', 'rect', 'polygon', 'text', 'fill']);
    // Tools grouped under the "Shapes" dropdown button.
    const SHAPE_TOOLS = new Set(['line', 'circle', 'arc', 'rect', 'polygon']);
    // Icon shown beside the stable Shapes dropdown label.
    const SHAPE_ICONS = {
        line: '/',
        circle: '◯',
        arc: '◠',
        rect: '▢',
        polygon: '⬠',
    };

    const setToolButtonActive = (tool) => {
        for (const btn of toolBtns) {
            if (!btn) continue;
            if (btn === shapesBtn) {
                btn.classList.toggle('active', SHAPE_TOOLS.has(tool));
                shapesWrap?.classList.toggle('active', SHAPE_TOOLS.has(tool));
            } else {
                btn.classList.toggle('active', btn.id === `pcbTool${tool.charAt(0).toUpperCase() + tool.slice(1)}`);
            }
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
        // Cancel any in-progress Track draw (and drop the pre-draw hover snap
        // marker) when switching away from the track tool.
        if (nextTool !== 'track') {
            app._cancelTrackDraw?.();
        }
        // Cancel any in-progress copper-fill outline when leaving the fill tool.
        if (app._fillDraw && nextTool !== 'fill') {
            app._cancelFillDraw?.();
        }
        // Cancel any in-progress shape draw when switching to another tool.
        if (app._shapeDraw && app._shapeDraw.kind !== nextTool) {
            app._cancelShapeDraw?.();
        }
        app.currentTool = nextTool;
        // Reflect the active shape through its icon while retaining the
        // consistent Shapes button label.
        if (shapesBtn && SHAPE_TOOLS.has(nextTool)) {
            shapesBtn.textContent = `${SHAPE_ICONS[nextTool]} Shapes`;
        }
        // Clear any component hover outline when leaving the select tool.
        if (nextTool !== 'select') app._hoverComponent?.(null);
        // Clear a selected reference designator when leaving the select tool.
        if (nextTool !== 'select') app._selectRefText?.(null);
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
        } else if (nextTool === 'fill') {
            app._showFillToolOptions?.();
        } else if (nextTool === 'circle') {
            app._hideToolOptions?.();
            app._showBoardShapeToolProperties?.('circle');
        } else if (SHAPE_TOOLS.has(nextTool)) {
            app._hideToolOptions?.();
            app._showBoardShapeToolProperties?.(nextTool);
        } else {
            app._hideToolOptions?.();
        }
    };

    app._syncPcbHomeToolHighlight = syncHomeToolHighlight;

    selectBtn?.addEventListener('click', () => setTool('select'));
    trackBtn?.addEventListener('click', () => setTool('track'));
    padBtn?.addEventListener('click', () => setTool('pad'));
    viaBtn?.addEventListener('click', () => setTool('via'));
    holeBtn?.addEventListener('click', () => {
        app.activeLayer = 'hole';
        setTool('circle');
    });
    textBtn?.addEventListener('click', () => setTool('text'));
    fillBtn?.addEventListener('click', () => setTool('fill'));

    // Shapes dropdown: the button toggles a small menu of shape tools, and
    // also re-activates whichever shape was last chosen so a single click
    // picks up the current shape (matching the other tool buttons).
    const hideShapesMenu = () => {
        if (shapesMenu) shapesMenu.hidden = true;
        shapesArrowBtn?.setAttribute('aria-expanded', 'false');
    };
    const toggleShapesMenu = () => {
        if (!shapesMenu) return;
        shapesMenu.hidden = !shapesMenu.hidden;
        shapesArrowBtn?.setAttribute('aria-expanded', String(!shapesMenu.hidden));
    };
    if (shapesBtn && shapesArrowBtn && shapesMenu) {
        let lastShape = 'circle';
        const selectShape = (shape) => {
            lastShape = shape;
            hideShapesMenu();
            setTool(shape);
        };
        shapesBtn.addEventListener('click', () => {
            selectShape(SHAPE_TOOLS.has(app.currentTool) ? app.currentTool : lastShape);
        });
        shapesArrowBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleShapesMenu();
        });
        for (const item of shapesMenu.querySelectorAll('[data-shape]')) {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const shape = item.getAttribute('data-shape') || 'circle';
                selectShape(shape);
            });
        }
        // Dismiss the menu on any outside click.
        document.addEventListener('click', (e) => {
            if (shapesMenu.hidden) return;
            if (shapesWrap?.contains(/** @type {Node} */(e.target))) return;
            if (shapesMenu.contains(/** @type {Node} */(e.target))) return;
            hideShapesMenu();
        });
    }

    const doCopy = () => app.copySelection?.();
    const doCut = () => app.cutSelection?.();
    const doPaste = () => app.pasteSelection?.();
    copyHomeBtn?.addEventListener('click', doCopy);
    copyPropsBtn?.addEventListener('click', doCopy);
    cutHomeBtn?.addEventListener('click', doCut);
    cutPropsBtn?.addEventListener('click', doCut);
    pasteHomeBtn?.addEventListener('click', doPaste);
    pastePropsBtn?.addEventListener('click', doPaste);
    app._syncClipboardButtons?.();

    undoBtn?.addEventListener('click', () => app.history?.undo?.());
    redoBtn?.addEventListener('click', () => app.history?.redo?.());
    app._syncHistoryButtons?.();

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
    const routerModeSelect = document.getElementById('pcbRouterMode');
    const routeParamIds = ['pcbTrackWidth', 'pcbClearance', 'pcbViaDiameter', 'pcbViaDrill'];

    // Design parameters (track width, clearance, via sizes, units, router) are
    // UI preferences kept out of the saved document but persisted across
    // reloads in localStorage.
    const DESIGN_PARAMS_KEY = 'clearpcb_pcb_design_params';
    const saveDesignParams = () => {
        try {
            const data = {
                units: routeUnitsSelect?.value || 'mm',
                router: routerModeSelect?.value || 'maze',
            };
            for (const id of routeParamIds) {
                const el = document.getElementById(id);
                if (el) data[id] = el.value;
            }
            localStorage.setItem(DESIGN_PARAMS_KEY, JSON.stringify(data));
        } catch { /* storage unavailable — ignore */ }
    };

    // Restore previously-saved design parameters onto the ribbon inputs.
    let storedDesign = null;
    try { storedDesign = JSON.parse(localStorage.getItem(DESIGN_PARAMS_KEY) || 'null'); }
    catch { storedDesign = null; }
    if (storedDesign) {
        if (routeUnitsSelect && storedDesign.units) routeUnitsSelect.value = storedDesign.units;
        if (routerModeSelect && storedDesign.router) routerModeSelect.value = storedDesign.router;
        const inch = storedDesign.units === 'inch';
        for (const id of routeParamIds) {
            const el = document.getElementById(id);
            if (el && storedDesign[id] != null && storedDesign[id] !== '') {
                el.value = storedDesign[id];
                el.step = inch ? '0.001' : '0.01';
            }
        }
    }

    let routeParamUnit = storedDesign?.units || 'mm';
    // Share the unit-toggle baseline with PCBApp so loading a project's design
    // params can keep it in sync (a stale baseline makes the unit switch
    // early-return and leave mismatched values).
    app._routeParamUnit = routeParamUnit;
    routerModeSelect?.addEventListener('change', saveDesignParams);
    routeUnitsSelect?.addEventListener('change', () => {
        const newUnit = routeUnitsSelect.value;
        routeParamUnit = app._routeParamUnit || routeParamUnit;
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
        app._routeParamUnit = newUnit;
        saveDesignParams();
    });

    // Live-redraw clearance halos when any routing parameter changes (only
    // if the overlay is currently visible). Trace width and clearance both
    // affect halo radii; via diameter affects via halos.
    for (const id of routeParamIds) {
        const el = document.getElementById(id);
        el?.addEventListener('input', () => {
            if (app._clearancesVisible) app.showClearances?.(true);
            // Pour clearances follow the routing parameters, so reflow. The
            // reflow is rAF-deferred; the 2D/3D panel rebuild is debounced, so
            // by the time it runs the pour geometry (_computed) is up to date.
            app._refreshFills?.();
            app._board3d?.refresh?.();
            saveDesignParams();
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

    get('pcbRibbonNew')?.addEventListener('click', () => {
        project()?.newDocument();
        app._setActiveRibbonTab?.('pcb-home');
    });
    get('pcbRibbonOpen')?.addEventListener('click', () => {
        project()?.open();
        app._setActiveRibbonTab?.('pcb-home');
    });

    // ── Recent files (Open ▾ dropdown) ───────────────────────────
    bindRecentsDropdown({
        caretBtn: get('pcbRibbonOpenRecent'),
        menu: get('pcbRibbonRecentMenu'),
        getFileManager: () => project()?.fileManager,
        openRecent: (name) => project()?.openRecent(name),
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
        if (result?.success) app._showSaveToast?.('Saved');
    });
    get('pcbRibbonSaveAs')?.addEventListener('click', async () => {
        const result = await project()?.saveAs();
        if (result?.success) app._showSaveToast?.('Saved');
    });
    get('pcbRibbonExportPdf')?.addEventListener('click', () => app.savePdf());
    get('pcbRibbonPrint')?.addEventListener('click', () => app.print());
}
