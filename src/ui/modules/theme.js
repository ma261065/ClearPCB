import { storageManager } from '../../core/StorageManager.js';
import { loadAndApplyTheme, toggleTheme as toggleSharedTheme, syncThemeToggleButtons } from '../../shared/ui/theme.js';

/**
 * Binds the theme toggle button click to `toggleTheme` and loads
 * the saved theme on startup.
 * @param {object} app - Application state.
 */
export function bindThemeToggle(app) {
    const themeToggle = document.getElementById('themeToggle');
    if (!themeToggle) return;

    themeToggle.addEventListener('click', () => {
        app._toggleTheme();
    });

    app._loadTheme();
}

/**
 * Switches between light and dark themes, persists the choice,
 * updates the toggle icon, and refreshes viewport and component colors.
 * @param {object} app - Application state.
 */
export function toggleTheme(app) {
    const newTheme = toggleSharedTheme();
    syncThemeToggleButtons(['themeToggle', 'pcbThemeToggle'], newTheme);

    app.viewport.updateTheme();

    updateComponentColors(app);
}

/**
 * Reads the saved theme from storage, applies the `data-theme` attribute
 * and toggle icon, and updates the viewport theme.
 * @param {object} app - Application state.
 */
export function loadTheme(app) {
    loadAndApplyTheme();
    syncThemeToggleButtons(['themeToggle', 'pcbThemeToggle']);

    if (app.viewport) {
        app.viewport.updateTheme();
    }
}

/**
 * Recreates all component SVG symbols to pick up new theme colors;
 * also refreshes the placement preview if active.
 * @param {object} app - Application state.
 */
export function updateComponentColors(app) {
    for (const comp of app.components) {
        if (comp.element) {
            comp.element.remove();
        }
        const element = comp.createSymbolElement();
        app.viewport.addComponentContent(element);
    }

    if (app.placingComponent && app.componentPreview) {
        app._createComponentPreview(app.placingComponent);
    }
}
