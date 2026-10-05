/**
 * The editors' small pop-up menu (context menus, the lock icon's unlock menu): one
 * per id, opened at the pointer, closed by choosing an item, a press outside it, or
 * Escape. Both editors use it, so menus look and behave the same everywhere.
 */

const MENU_STYLE = 'position:fixed;z-index:10000;background:#2b2b2b;border:1px solid #555;border-radius:4px;'
    + 'padding:2px 0;box-shadow:0 2px 8px rgba(0,0,0,0.4);min-width:120px;';
const ITEM_STYLE = 'padding:6px 16px;color:#eee;cursor:pointer;font:13px/1.4 system-ui,sans-serif;white-space:nowrap;';

/** @typedef {{text: string, onClick: (event?: MouseEvent) => void}} MenuItem */

/** Close the menu with this id, and its global listeners, if it is open. */
export function dismissContextMenu(id) {
    const menu = document.getElementById(id);
    if (!menu) return;
    const handlers = /** @type {any} */ (menu)._dismiss;
    if (handlers) {
        // The listeners attach a tick after opening; a menu closed sooner must not attach them.
        clearTimeout(handlers.timer);
        document.removeEventListener('mousedown', handlers.dismiss, { capture: true });
        document.removeEventListener('keydown', handlers.onKey, { capture: true });
    }
    menu.remove();
}

/**
 * Open a menu (replacing any open one with the same id). Nothing opens for no items.
 * @param {string} id
 * @param {MenuItem[]} items
 * @param {number} clientX
 * @param {number} clientY
 * @param {{className?: string, onChosen?: () => void}} [options] `onChosen` runs after an item's action
 * @returns {HTMLDivElement|undefined}
 */
export function showContextMenu(id, items, clientX, clientY, { className = '', onChosen = () => {} } = {}) {
    dismissContextMenu(id);
    if (!items.length) return undefined;
    const menu = document.createElement('div');
    menu.id = id;
    if (className) menu.className = className;
    menu.style.cssText = `${MENU_STYLE}left:${clientX}px;top:${clientY}px;`;
    for (const item of items) {
        const element = document.createElement('div');
        element.textContent = item.text;
        element.style.cssText = ITEM_STYLE;
        element.addEventListener('mouseenter', () => { element.style.background = '#3a3a3a'; });
        element.addEventListener('mouseleave', () => { element.style.background = ''; });
        element.addEventListener('click', event => {
            dismissContextMenu(id);
            item.onClick(event);
            onChosen();
        });
        menu.appendChild(element);
    }
    menu.addEventListener('contextmenu', event => event.preventDefault());
    document.body.appendChild(menu);
    const dismiss = event => { if (!menu.contains(event.target)) dismissContextMenu(id); };
    const onKey = event => { if (event.key === 'Escape') dismissContextMenu(id); };
    // Attach after this tick, so the press that opened the menu does not close it.
    const timer = setTimeout(() => {
        if (document.getElementById(id) !== menu) return;
        document.addEventListener('mousedown', dismiss, { capture: true });
        document.addEventListener('keydown', onKey, { capture: true });
    }, 0);
    /** @type {any} */ (menu)._dismiss = { dismiss, onKey, timer };
    return menu;
}
