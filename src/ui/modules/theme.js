import { storageManager } from '../../core/StorageManager.js';

export function bindThemeToggle(app) {
    const themeToggle = document.getElementById('themeToggle');
    if (!themeToggle) return;

    themeToggle.addEventListener('click', () => {
        app._toggleTheme();
    });

    app._loadTheme();
}

export function toggleTheme(app) {
    const html = document.documentElement;
    const currentTheme = html.getAttribute('data-theme');
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';

    html.setAttribute('data-theme', newTheme);
    storageManager.set('clearpcb-theme', newTheme);

    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.textContent = newTheme === 'light' ? '☀️' : '🌙';
    }

    app.viewport.updateTheme();

    updateComponentColors(app);
}

export function loadTheme(app) {
    const savedTheme = storageManager.get('clearpcb-theme') || 'dark';
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

export function updateComponentColors(app) {
    for (const comp of app.components) {
        if (comp.element) {
            comp.element.remove();
        }
        const element = comp.createSymbolElement();
        app.viewport.addContent(element);
    }

    if (app.placingComponent && app.componentPreview) {
        app._createComponentPreview(app.placingComponent);
    }
}
