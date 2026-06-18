/**
 * Shared "Recent files" dropdown wiring for the Open split-button.
 *
 * Both the schematic ribbon and the PCB ribbon use this: they share a single
 * FileManager (via ProjectDocument), so the recents list is identical in both
 * editors. The menu is rebuilt each time it opens so it always reflects the
 * latest list (entries are added on every open/save).
 */

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

    const build = async () => {
        const fm = getFileManager?.();
        const recents = (await fm?.getRecentFiles?.()) || [];
        menu.textContent = '';

        if (!recents.length) {
            const empty = document.createElement('div');
            empty.className = 'dropdown-item recent-empty';
            empty.textContent = 'No recent files';
            menu.appendChild(empty);
            return;
        }

        for (const entry of recents) {
            const row = document.createElement('div');
            row.className = 'recent-row';

            const open = document.createElement('button');
            open.className = 'dropdown-item recent-open';
            open.textContent = entry.name;
            open.title = entry.path || entry.name;
            open.addEventListener('click', () => {
                close();
                openRecent?.(entry.name);
            });

            const remove = document.createElement('button');
            remove.className = 'recent-remove';
            remove.textContent = '×';
            remove.title = 'Remove from recents';
            remove.addEventListener('click', (e) => {
                // Keep the menu open and just drop this one entry.
                e.stopPropagation();
                getFileManager?.()?.removeRecent?.(entry.name);
                build();
            });

            row.appendChild(open);
            row.appendChild(remove);
            menu.appendChild(row);
        }
    };

    caretBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = !menu.classList.contains('open');
        if (willOpen) build();
        menu.classList.toggle('open');
    });

    // Close when clicking anywhere outside the caret or the menu.
    document.addEventListener('click', (e) => {
        const t = /** @type {Node} */ (e.target);
        if (!caretBtn.contains(t) && !menu.contains(t)) close();
    });
}
