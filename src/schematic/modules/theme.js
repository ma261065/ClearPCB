import { storageManager } from '../../core/StorageManager.js';
import { rebuildComponentSymbol } from './schematic-view.js';
import { loadAndApplyTheme, toggleTheme as toggleSharedTheme } from '../../shared/ui/theme.js';
import { createComponentPreview } from './components.js';

/**
 * Binds the theme toggle button click to `toggleTheme` and loads
 * the saved theme on startup.
 * @param {object} app - Application state.
 */
export function bindThemeToggle(app) {
    window.addEventListener('clearpcb-theme-changed', () => {
        app.viewport?.updateTheme();
        updateComponentColors(app);
        app.refreshRibbon?.();
    });

    loadTheme(app);
}

/**
 * Switches between light and dark themes, persists the choice,
 * updates the toggle icon, and refreshes viewport and component colors.
 * @param {object} app - Application state.
 */
export function toggleTheme(app) {
    toggleSharedTheme();
    app.refreshRibbon?.();
}

/**
 * Reads the saved theme from storage, applies the `data-theme` attribute
 * and toggle icon, and updates the viewport theme.
 * @param {object} app - Application state.
 */
export function loadTheme(app) {
    loadAndApplyTheme();
    app.refreshRibbon?.();

    app.viewport?.updateTheme?.();
}

/**
 * Recreates all component SVG symbols to pick up new theme colors;
 * also refreshes the placement preview if active.
 * @param {object} app - Application state.
 */
export function updateComponentColors(app) {
    for (const comp of app.components) rebuildComponentSymbol(app, comp);

    if (app.placingComponent && app.componentPreview) {
        createComponentPreview(app, app.placingComponent);
    }
}
