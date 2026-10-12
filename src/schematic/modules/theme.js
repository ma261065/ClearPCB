import { storageManager } from '../../core/StorageManager.js';
import { rebuildComponentSymbol } from './schematic-view.js';
import { loadAndApplyTheme, toggleTheme as toggleSharedTheme } from '../../shared/ui/theme.js';
import { createComponentPreview, getPlacingComponent } from './components.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */

/**
 * Binds the theme toggle button click to `toggleTheme` and loads
 * the saved theme on startup.
 * @param {SchematicEditor} app
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
 * @param {SchematicEditor} app
 */
export function toggleTheme(app) {
    toggleSharedTheme();
    app.refreshRibbon?.();
}

/**
 * Reads the saved theme from storage, applies the `data-theme` attribute
 * and toggle icon, and updates the viewport theme.
 * @param {SchematicEditor} app
 */
export function loadTheme(app) {
    loadAndApplyTheme();
    app.refreshRibbon?.();

    app.viewport?.updateTheme?.();
}

/**
 * Recreates all component SVG symbols to pick up new theme colors;
 * also refreshes the placement preview if active.
 * @param {SchematicEditor} app
 */
export function updateComponentColors(app) {
    for (const comp of app.components) rebuildComponentSymbol(app, comp);

    const placing = getPlacingComponent(app);
    if (placing && app.componentPreview) {
        createComponentPreview(app, placing);
    }
}
