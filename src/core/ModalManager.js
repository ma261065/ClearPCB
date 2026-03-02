// ModalManager - simple stack-based modal escape handler
// Components can push an onEscape handler when they become modal (e.g. component picker, dialogs)

export const ModalManager = (() => {
    /** @type {Array<{id: string, onEscape: Function}>} */
    const stack = [];

    /**
     * Register (or replace) a modal escape handler on the stack.
     * @param {string} id - Unique identifier for the modal
     * @param {Function} onEscape - Callback invoked when Escape is pressed while this modal is on top
     */
    function push(id, onEscape) {
        if (!id) throw new Error('ModalManager.push requires id');
        // Replace existing entry with same id
        const idx = stack.findIndex(x => x.id === id);
        if (idx !== -1) {
            stack[idx] = { id, onEscape };
        } else {
            stack.push({ id, onEscape });
        }
    }

    /**
     * Remove a modal's escape handler from the stack.
     * @param {string} id - Identifier of the modal to remove
     */
    function pop(id) {
        const idx = stack.findIndex(x => x.id === id);
        if (idx !== -1) stack.splice(idx, 1);
    }

    /**
     * Return the topmost modal entry, or null if the stack is empty.
     * @returns {{id: string, onEscape: Function}|null}
     */
    function top() {
        return stack.length ? stack[stack.length - 1] : null;
    }

    // Global key handler - capture phase so we see Escape early
    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const t = top();
        if (t && typeof t.onEscape === 'function') {
            e.preventDefault();
            e.stopPropagation();
            try { t.onEscape(); } catch (err) { console.error('ModalManager onEscape error', err); }
            return;
        }
        // Fallback global event for application-level handling
        window.dispatchEvent(new CustomEvent('global-escape'));
    }, true);

    return { push, pop, top };
})();
