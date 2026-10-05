import { bindRibbonHeight } from '../../shared/ui/ribbon-height.js';
import { renderRibbon } from '../../shared/ui/ribbon.js';
import { createSchematicRibbonDescription } from './ribbon-description.js';

/**
 * Binds all ribbon tab buttons, tool buttons, file commands, edit commands,
 * and event listeners; sets up the save toast, active tab tracking, and
 * shape panel options.
 * @param {object} app - Application state.
 */
export function bindRibbon(app) {
    const ribbonEl = document.getElementById('ribbonSchematic');
    if (!ribbonEl) return;

    const ribbon = renderRibbon(ribbonEl, createSchematicRibbonDescription(app));
    app.ui.propertiesPanel = ribbon.controls.get('propertiesPanel') || app.ui.propertiesPanel;
    const retainRibbonHeight = bindRibbonHeight(ribbonEl);
    app._retainRibbonHeight = retainRibbonHeight;
    app.refreshRibbon = () => {
        ribbon.refresh();
        retainRibbonHeight();
    };
    app._setActiveToolButton = () => app.refreshRibbon?.();
    app._activateRibbonTab = (tabId) => {
        retainRibbonHeight();
        app.activeRibbonTab = tabId;
        ribbon.activateTab(tabId);
    };

    ribbonEl.addEventListener('change', (e) => {
        if (e.target instanceof HTMLSelectElement) e.target.blur();
    });

    app._showSaveToast = (text = 'Saved') => {
        const anchor = document.getElementById('docTitle');
        if (!anchor) return;
        const rect = anchor.getBoundingClientRect();
        const existing = document.getElementById('ribbon-save-toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = 'ribbon-save-toast';
        toast.className = 'ribbon-save-toast';
        toast.textContent = text;
        toast.style.left = `${rect.left + rect.width / 2}px`;
        toast.style.top = `${rect.top - 28}px`;
        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('show'));
        window.setTimeout(() => {
            toast.classList.remove('show');
            window.setTimeout(() => toast.remove(), 200);
        }, 900);
    };

    const ribbonEscHandler = (e) => {
        if (e.key === 'Escape') app.setActiveRibbonTab('home');
    };
    document.addEventListener('keydown', ribbonEscHandler);
    app._cleanupRibbonEsc = () => document.removeEventListener('keydown', ribbonEscHandler);

    app._activateRibbonTab('home');
    updateRibbonState(app, app.selection.getSelection());

    app.eventBus.on('selectionChanged', (shapes) => {
        updateRibbonState(app, shapes);
        app._activateRibbonTab(shapes.length > 0 ? 'properties' : 'home');
    });

    app.eventBus.on('toolChanged', () => {
        app.updatePropertiesPanel?.(app.selection.getSelection());
        app.refreshRibbon?.();
    });
}

/**
 * Populates or clears the shape-options panel (line width, fill checkbox,
 * font size) based on the active tool when nothing is selected.
 * @param {object} app - Application state.
 * @param {Array} selection - Currently selected items.
 * @param {string} [toolIdArg] - Active tool identifier override.
 */
export function updateShapePanelOptions(app, selection, toolIdArg) {
    const container = document.getElementById('ribbonShapeOptions');
    if (!container) return;
    // Drawing defaults are rendered in the Properties tab so Home remains
    // focused on commands and tools rather than object-specific settings.
    container.innerHTML = '';
}

/**
 * Enables/disables ribbon buttons (delete, lock, cut, copy, paste, rotate)
 * based on the current selection count and clipboard state.
 * @param {object} app - Application state.
 * @param {Array} selection - Currently selected items.
 */
export function updateRibbonState(app, selection) {
    app.refreshRibbon?.();
}
