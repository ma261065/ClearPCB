import { syncGridSettings } from '../../shared/ui/viewport.js';
import { PCB_LAYERS, buildLayerPanel } from './layers.js';
import { bindRecentsDropdown } from '../../shared/ui/recents.js';
import { showPictureImport } from './picture-import.js';
import { bindDesignSettings } from './design-settings.js';
import { runPcbHistoryAction, savePcbProject } from './editor-actions.js';
import { PCB_SHAPE_TOOLS as SHAPE_TOOLS, normalizePcbTool, selectPcbTool } from './tool-lifecycle.js';

/**
 * Binds PCB-specific UI controls for tools and layers.
 * @param {object} app
 */
export function bindPcbControls(app) {
    const selectBtn = document.getElementById('pcbToolSelect');
    const trackBtn = document.getElementById('pcbToolTrack');
    const imageBtn = document.getElementById('pcbImportImage');
    const viaBtn = document.getElementById('pcbToolVia');
    const padBtn = document.getElementById('pcbToolPad');
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
    const showGridInput = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbShowGrid'));
    const snapToGridInput = /** @type {HTMLInputElement|null} */ (document.getElementById('pcbSnapToGrid'));
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

    const toolBtns = [selectBtn, trackBtn, viaBtn, padBtn, holeBtn, shapesBtn, textBtn, fillBtn];
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
        const tool = normalizePcbTool(app.currentTool);
        if (shapesBtn && SHAPE_TOOLS.has(tool)) shapesBtn.textContent = `${SHAPE_ICONS[tool]} Shapes`;
        setToolButtonActive(tool);
    };

    const setTool = tool => selectPcbTool(app, tool);

    app._syncPcbHomeToolHighlight = syncHomeToolHighlight;

    selectBtn?.addEventListener('click', () => setTool('select'));
    trackBtn?.addEventListener('click', () => setTool('track'));
    imageBtn?.addEventListener('click', () => showPictureImport(app));
    viaBtn?.addEventListener('click', () => setTool('via'));
    padBtn?.addEventListener('click', () => setTool('pad'));
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
    app.syncClipboardButtons?.();

    bindPcbHistoryButtons(app, undoBtn, redoBtn);

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
    document.getElementById('pcbPanelize')?.addEventListener('click', () => app.openPanelize?.());

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

    bindDesignSettings(app);

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
            !specctraFlyout.contains(/** @type {Node} */ (e.target)) &&
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
        const gridOn = !!/** @type {HTMLInputElement} */ (e.target).checked;
        const vp = ensureViewport();
        if (!vp) return;
        vp.setGridVisible(gridOn);
        if (!gridOn) {
            if (snapToGridInput) snapToGridInput.checked = false;
            vp.snapToGrid = false;
        }
        syncViewToggles();
        app._markDirty?.();
    });

    snapToGridInput?.addEventListener('change', (e) => {
        const enabled = !!/** @type {HTMLInputElement} */ (e.target).checked;
        const vp = ensureViewport();
        if (!vp || !vp.gridVisible) return;
        vp.snapToGrid = enabled;
        syncViewToggles();
        app._markDirty?.();
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
        const size = parseFloat(/** @type {HTMLSelectElement} */ (e.target).value);
        const vp = ensureViewport();
        if (!vp) return;
        vp.setGridSize(size);
        syncGridSettings(app);
        app._markDirty?.();
    });

    gridStyleSelect?.addEventListener('change', (e) => {
        const style = /** @type {HTMLSelectElement} */ (e.target).value;
        const vp = ensureViewport();
        if (!vp) return;
        vp.setGridStyle(style);
        syncGridSettings(app);
        app._markDirty?.();
    });

    unitsSelect?.addEventListener('change', (e) => {
        const units = /** @type {HTMLSelectElement} */ (e.target).value;
        const vp = ensureViewport();
        if (!vp) return;
        vp.setUnits(units);
        app._updateGridDropdown?.();
        syncGridSettings(app);
        app._markDirty?.();
    });

    app.syncPcbViewToggles = syncViewToggles;
    syncGridSettings(app);

    bindPcbFileMenu(app);
}

/**
 * Undo/Redo buttons route through the same history action as the keyboard
 * shortcuts, so a floating paste or drag is cancelled before history moves.
 * @param {object} app
 * @param {HTMLElement | null} undoBtn
 * @param {HTMLElement | null} redoBtn
 */
export function bindPcbHistoryButtons(app, undoBtn, redoBtn) {
    undoBtn?.addEventListener('click', () => runPcbHistoryAction(app, 'undo'));
    redoBtn?.addEventListener('click', () => runPcbHistoryAction(app, 'redo'));
    app._syncHistoryButtons?.();
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
    const project = () => app.project;

    get('pcbRibbonNew')?.addEventListener('click', () => {
        project()?.newDocument();
    });
    get('pcbRibbonOpen')?.addEventListener('click', () => {
        project()?.open();
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

    get('pcbRibbonSave')?.addEventListener('click', () => savePcbProject(app));
    get('pcbRibbonSaveAs')?.addEventListener('click', () => savePcbProject(app, true));
    get('pcbRibbonExportPdf')?.addEventListener('click', () => app.savePdf());
    get('pcbRibbonPrint')?.addEventListener('click', () => app.print());
}
