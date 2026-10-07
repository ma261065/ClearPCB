import { syncGridSettings } from '../../shared/ui/viewport.js';
import { buildLayerPanel } from './layers.js';
import { bindRibbonHeight } from '../../shared/ui/ribbon-height.js';
import { renderRibbon } from '../../shared/ui/ribbon.js';
import { bindDesignSettings } from './design-settings.js';
import { runPcbHistoryAction } from './editor-actions.js';
import { selectPcbTool } from './tool-lifecycle.js';
import { createPcbRibbonDescription } from './ribbon-description.js';

/**
 * Binds PCB-specific UI controls for tools and layers.
 * @param {object} app
 */
export function bindPcbControls(app) {
    const ribbonEl = document.getElementById('ribbonPCB');
    if (ribbonEl) {
        const ribbon = renderRibbon(ribbonEl, createPcbRibbonDescription(app));
        app.retainPcbRibbonHeight = bindRibbonHeight(ribbonEl);
        app.refreshPcbRibbon = () => {
            ribbon.refresh();
            app.retainPcbRibbonHeight?.();
        };
        app.activatePcbRibbonTab = (tabId, userInitiated = false) => ribbon.activateTab(tabId, userInitiated);
        app.syncPcbViewToggles = () => app.refreshPcbRibbon?.();
        app.ui = {
            ...(app.ui || {}),
            gridSize: ribbon.controls.get('pcbGridSize'),
            gridStyle: ribbon.controls.get('pcbGridStyle'),
            units: ribbon.controls.get('pcbUnits'),
            showGrid: ribbon.controls.get('pcbShowGrid'),
            snapToGrid: ribbon.controls.get('pcbSnapToGrid'),
        };
    }

    bindDesignSettings(app);
    buildLayerPanel(app);
    app.retainPcbRibbonHeight?.();
    selectPcbTool(app, app.currentTool || 'select');
    syncGridSettings(app);
}

export function bindPcbHistoryButtons(app, undoBtn, redoBtn) {
    undoBtn?.addEventListener('click', () => runPcbHistoryAction(app, 'undo'));
    redoBtn?.addEventListener('click', () => runPcbHistoryAction(app, 'redo'));
    app.syncPcbHistoryButtons?.();
}
