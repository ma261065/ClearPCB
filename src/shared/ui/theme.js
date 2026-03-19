const THEME_STORAGE_KEY = 'clearpcb-theme';

/**
 * Returns a normalized theme string.
 * @returns {'dark' | 'light'}
 */
export function getSavedTheme() {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
}

/**
 * Applies a theme to the document root.
 * @param {'dark' | 'light'} theme
 */
export function applyTheme(theme) {
    const html = document.documentElement;
    if (theme === 'light') {
        html.setAttribute('data-theme', 'light');
    } else {
        html.removeAttribute('data-theme');
    }
}

/**
 * Persists and applies a theme.
 * @param {'dark' | 'light'} theme
 */
export function setTheme(theme) {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    applyTheme(theme);
}

/**
 * Loads the stored theme and applies it.
 * @returns {'dark' | 'light'}
 */
export function loadAndApplyTheme() {
    const theme = getSavedTheme();
    applyTheme(theme);
    return theme;
}

/**
 * Toggles between dark and light themes.
 * @returns {'dark' | 'light'}
 */
export function toggleTheme() {
    const current = getSavedTheme();
    const next = current === 'light' ? 'dark' : 'light';
    setTheme(next);
    return next;
}

/**
 * @param {'dark' | 'light'} theme
 * @returns {string}
 */
export function getThemeIcon(theme) {
    return theme === 'light' ? '☀️' : '🌙';
}

/**
 * Syncs one or more theme toggle button labels.
 * @param {(string | HTMLElement | null | undefined)[]} targets
 * @param {'dark' | 'light'} [theme]
 */
export function syncThemeToggleButtons(targets, theme = getSavedTheme()) {
    const icon = getThemeIcon(theme);
    for (const target of targets) {
        const el = typeof target === 'string'
            ? document.getElementById(target)
            : target;
        if (el instanceof HTMLElement) {
            el.textContent = icon;
        }
    }
}
