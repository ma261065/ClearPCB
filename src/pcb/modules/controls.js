/**
 * Binds PCB-specific UI controls for tools and layers.
 * @param {object} app
 */
export function bindPcbControls(app) {
    const selectBtn = document.getElementById('pcbToolSelect');
    const panBtn = document.getElementById('pcbToolPan');
    const layerTopBtn = document.getElementById('pcbLayerTop');
    const layerBottomBtn = document.getElementById('pcbLayerBottom');
    const zoomOutBtn = document.getElementById('pcbZoomOut');
    const zoomInBtn = document.getElementById('pcbZoomIn');
    const zoomFitBtn = document.getElementById('pcbZoomFit');
    const resetViewBtn = document.getElementById('pcbResetView');
    const showGridInput = document.getElementById('pcbShowGrid');
    const snapToGridInput = document.getElementById('pcbSnapToGrid');
    const showRulersInput = document.getElementById('pcbShowRulers');

    const setTool = (tool) => {
        app.currentTool = tool;
        if (selectBtn) selectBtn.classList.toggle('active', tool === 'select');
        if (panBtn) panBtn.classList.toggle('active', tool === 'pan');
        app._updateCursorForTool?.();
        app._setPcbStatus?.();
    };

    const setLayer = (layer) => {
        app.activeLayer = layer;
        if (layerTopBtn) layerTopBtn.classList.toggle('active', layer === 'top');
        if (layerBottomBtn) layerBottomBtn.classList.toggle('active', layer === 'bottom');
        app._setPcbStatus?.();
    };

    selectBtn?.addEventListener('click', () => setTool('select'));
    panBtn?.addEventListener('click', () => setTool('pan'));
    layerTopBtn?.addEventListener('click', () => setLayer('top'));
    layerBottomBtn?.addEventListener('click', () => setLayer('bottom'));

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
    setLayer(app.activeLayer || 'top');
    syncViewToggles();

    app.syncPcbViewToggles = syncViewToggles;
}
