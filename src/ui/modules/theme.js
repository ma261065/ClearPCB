import { storageManager } from '../../core/StorageManager.js';

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
    const html = document.documentElement;
    const currentTheme = html.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';

    html.setAttribute('data-theme', newTheme);
    localStorage.setItem('clearpcb-theme', newTheme);

    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.textContent = newTheme === 'light' ? '☀️' : '🌙';
    }

    app.viewport.updateTheme();

    updateComponentColors(app);
}

/**
 * Reads the saved theme from storage, applies the `data-theme` attribute
 * and toggle icon, and updates the viewport theme.
 * @param {object} app - Application state.
 */
export function loadTheme(app) {
    const savedTheme = localStorage.getItem('clearpcb-theme') || 'dark';
    const html = document.documentElement;

    if (savedTheme === 'light') {
        html.setAttribute('data-theme', 'light');
    }

    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.textContent = savedTheme === 'light' ? '☀️' : '🌙';
    }

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
