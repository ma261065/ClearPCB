/**
 * Platform-aware keyboard shortcut labels.
 *
 * On macOS / iOS the modifier names are replaced with standard symbols:
 *   Ctrl  → ⌘   (Command)
 *   Alt   → ⌥   (Option)
 *   Shift → ⇧
 *   Del   → ⌫   (Backspace / Delete)
 *
 * The keyboard handler already uses `e.ctrlKey || e.metaKey`, so the
 * actual shortcuts work on both platforms — this module only adapts the
 * **displayed text** (tooltips, help panel, dynamically-created labels).
 */

/** True when running on macOS or iOS. */
export const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);

/**
 * Rewrite a shortcut string for the current platform.
 *
 * On Windows/Linux the string is returned unchanged.
 * On macOS the modifier words are replaced with their symbols.
 *
 * @param {string} text - e.g. `"Ctrl+Alt+S"` or `"Cut (Ctrl+X)"`
 * @returns {string}
 */
export function adaptShortcutText(text) {
    if (!isMac) return text;
    return text
        .replace(/Ctrl\+/g, '⌘')
        .replace(/Alt\+/g, '⌥')
        .replace(/Shift\+/g, '⇧')
        .replace(/\bDel\b/g, '⌫');
}

/**
 * One-time DOM pass: rewrite every `title` attribute and `<kbd>` element
 * that contains modifier-key text so Mac users see the correct symbols.
 *
 * Safe to call on non-Mac — it returns immediately.
 */
export function adaptShortcutsInDOM() {
    if (!isMac) return;

    // Rewrite title attributes on every element with one
    for (const el of document.querySelectorAll('[title]')) {
        const t = el.getAttribute('title');
        const adapted = adaptShortcutText(t);
        if (adapted !== t) el.setAttribute('title', adapted);
    }

    // Rewrite <kbd> elements (help panel)
    for (const kbd of document.querySelectorAll('kbd')) {
        const t = kbd.textContent;
        const adapted = adaptShortcutText(t);
        if (adapted !== t) kbd.textContent = adapted;
    }
}
