// ModalManager - simple stack-based modal escape handler
// Components can push an onEscape handler when they become modal (e.g. component picker, dialogs)

export const ModalManager = (() => {
    /** @type {Array<{id: string, onEscape: Function, previousFocus: Element|null}>} */
    const stack = [];

    /**
     * Register (or replace) a modal escape handler on the stack.
     * Remembers the currently-focused element so it can be restored on pop().
     * @param {string} id - Unique identifier for the modal
     * @param {Function} onEscape - Callback invoked when Escape is pressed while this modal is on top
     */
    function push(id, onEscape) {
        if (!id) throw new Error('ModalManager.push requires id');
        const previousFocus = (document.activeElement && document.activeElement !== document.body)
            ? document.activeElement : null;
        const idx = stack.findIndex(x => x.id === id);
        if (idx !== -1) {
            // Keep the original previousFocus on replace.
            stack[idx] = { id, onEscape, previousFocus: stack[idx].previousFocus };
        } else {
            stack.push({ id, onEscape, previousFocus });
        }
    }

    /**
     * Remove a modal's escape handler from the stack and restore focus to the
     * element that was focused when push() was called.
     * @param {string} id - Identifier of the modal to remove
     */
    function pop(id) {
        const idx = stack.findIndex(x => x.id === id);
        if (idx === -1) return;
        const entry = stack[idx];
        stack.splice(idx, 1);
        // Restore focus only when popping the top of the stack (the active modal).
        if (idx === stack.length && entry.previousFocus
            && document.body.contains(entry.previousFocus)
            && typeof /** @type {HTMLElement} */ (entry.previousFocus).focus === 'function') {
            try { /** @type {HTMLElement} */ (entry.previousFocus).focus(); }
            catch { /* element may have been removed */ }
        }
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
