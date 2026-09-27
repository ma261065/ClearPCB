/**
 * Shared "Recent files" dropdown wiring for the Open split-button.
 *
 * Both the schematic ribbon and the PCB ribbon use this: they share a single
 * FileManager (via ProjectDocument), so the recents list is identical in both
 * editors. The menu is rebuilt each time it opens so it always reflects the
 * latest list (entries are added on every open/save).
 */

/**
 * Render the shared recent-file list used by the ribbon and startup screen.
 * @param {object} opts
 * @param {HTMLElement|null} opts.container
 * @param {() => any} opts.getFileManager
 * @param {(name: string) => void|Promise<void>} opts.openRecent
 * @param {() => void} [opts.beforeOpen]
 */
export async function renderRecentFiles({ container, getFileManager, openRecent, beforeOpen }) {
    if (!container) return;
    const fm = getFileManager?.();
    const recents = (await fm?.getRecentFiles?.()) || [];
    container.textContent = '';

    if (!recents.length) {
        const empty = document.createElement('div');
        empty.className = 'dropdown-item recent-empty';
        empty.textContent = 'No recent files';
        container.appendChild(empty);
        return;
    }

    for (const entry of recents) {
        const row = document.createElement('div');
        row.className = 'recent-row';

        const open = document.createElement('button');
        open.className = 'dropdown-item recent-open';
        open.title = entry.path || entry.name;

        const name = document.createElement('span');
        name.className = 'recent-name';
        name.textContent = entry.name;
        open.appendChild(name);

        if (entry.path && entry.path !== entry.name) {
            const path = document.createElement('span');
            path.className = 'recent-path';
            path.textContent = entry.path;
            open.appendChild(path);
        }

        open.addEventListener('click', () => {
            beforeOpen?.();
            void openRecent?.(entry.name);
        });

        const remove = document.createElement('button');
        remove.className = 'recent-remove';
        remove.textContent = '×';
        remove.title = 'Remove from recents';
        remove.setAttribute('aria-label', `Remove ${entry.name} from recent files`);
        remove.addEventListener('click', async (e) => {
            e.stopPropagation();
            await getFileManager?.()?.removeRecent?.(entry.name);
            await renderRecentFiles({ container, getFileManager, openRecent, beforeOpen });
        });

        row.appendChild(open);
        row.appendChild(remove);
        container.appendChild(row);
    }
}

/**
 * @param {object} opts
 * @param {HTMLElement|null} opts.caretBtn        The ▾ button beside Open.
 * @param {HTMLElement|null} opts.menu            The `.dropdown-menu` container.
 * @param {() => any} opts.getFileManager         Returns the active FileManager.
 * @param {(name: string) => void} opts.openRecent Opens the named recent file.
 */
export function bindRecentsDropdown({ caretBtn, menu, getFileManager, openRecent }) {
    if (!caretBtn || !menu) return;

    const close = () => menu.classList.remove('open');
    const build = () => renderRecentFiles({
        container: menu,
        getFileManager,
        openRecent,
        beforeOpen: close,
    });

    caretBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = !menu.classList.contains('open');
        if (willOpen) void build();
        menu.classList.toggle('open');
    });

    // Close when clicking anywhere outside the caret or the menu.
    document.addEventListener('click', (e) => {
        const t = /** @type {Node} */ (e.target);
        if (!caretBtn.contains(t) && !menu.contains(t)) close();
    });
}
