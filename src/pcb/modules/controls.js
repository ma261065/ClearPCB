/**
 * Binds PCB-specific UI controls for tools and layers.
 * @param {object} app
 */
export function bindPcbControls(app) {
    const selectBtn = document.getElementById('pcbToolSelect');
    const panBtn = document.getElementById('pcbToolPan');
    const layerTopBtn = document.getElementById('pcbLayerTop');
    const layerBottomBtn = document.getElementById('pcbLayerBottom');

    const setTool = (tool) => {
        app.currentTool = tool;
        if (selectBtn) selectBtn.classList.toggle('active', tool === 'select');
        if (panBtn) panBtn.classList.toggle('active', tool === 'pan');
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

    setTool(app.currentTool || 'select');
    setLayer(app.activeLayer || 'top');
}
