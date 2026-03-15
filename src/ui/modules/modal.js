import { ModalManager } from '../../core/ModalManager.js';

let modalCounter = 0;

/**
 * @param {{ title?: string, message?: string, contentEl?: HTMLElement|null, okText?: string, cancelText?: string, showCancel?: boolean }} options
 */
function buildModal({ title, message, contentEl = null, okText, cancelText, showCancel = false }) {
    const overlay = document.createElement('div');
    overlay.className = 'app-modal-overlay';
    overlay.tabIndex = 0;

    const modal = document.createElement('div');
    modal.className = 'app-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    if (title) {
        const titleEl = document.createElement('div');
        titleEl.className = 'app-modal-title';
        titleEl.textContent = title;
        modal.appendChild(titleEl);
    }

    if (message) {
        const msgEl = document.createElement('div');
        msgEl.className = 'app-modal-message';
        msgEl.textContent = message;
        modal.appendChild(msgEl);
    }

    if (contentEl) {
        modal.appendChild(contentEl);
    }

    const actions = document.createElement('div');
    actions.className = 'app-modal-actions';

    if (showCancel) {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'app-modal-btn app-modal-cancel';
        cancelBtn.textContent = cancelText || 'Cancel';
        actions.appendChild(cancelBtn);
        cancelBtn.addEventListener('click', () => close(false));
    }

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'app-modal-btn app-modal-ok';
    okBtn.textContent = okText || 'OK';
    actions.appendChild(okBtn);
    okBtn.addEventListener('click', () => close(true));

    modal.appendChild(actions);
    overlay.appendChild(modal);

    let resolvePromise = null;
    const modalId = `modal_${++modalCounter}`;

    /** @returns {HTMLElement[]} */
    const focusables = () => {
        return Array.from(modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
            .filter(el => el instanceof HTMLElement);
    };

    const close = (result) => {
        ModalManager.pop(modalId);
        document.removeEventListener('keydown', handleKeyDown, true);
        document.removeEventListener('keypress', swallowKeyEvent, true);
        document.removeEventListener('keyup', swallowKeyEvent, true);
        overlay.remove();
        if (resolvePromise) resolvePromise(result);
    };

    overlay.addEventListener('contextmenu', (e) => e.preventDefault());
    overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) e.preventDefault();
    });
    const handleKeyDown = (e) => {
        e.stopImmediatePropagation();
        const target = e.target;
        const isTypingTarget = target instanceof HTMLInputElement
            || target instanceof HTMLTextAreaElement
            || target instanceof HTMLSelectElement;
        const hasInput = !!modal.querySelector('input, textarea, select');
        const key = e.key.toLowerCase();

        if (e.key === 'Tab') {
            const items = focusables();
            if (!items.length) return;
            const first = items[0];
            const last = items[items.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
            return;
        }

        if (!isTypingTarget) {
            e.preventDefault();
        }

        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            const buttons = Array.from(modal.querySelectorAll('.app-modal-btn'))
                .filter(el => el instanceof HTMLElement);
            if (buttons.length > 0) {
                const list = buttons;
                const current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                const idx = Math.max(0, list.indexOf(current || list[0]));
                const dir = e.key === 'ArrowRight' ? 1 : -1;
                const next = (idx + dir + list.length) % list.length;
                list[next].focus();
            }
            return;
        }

        if (e.key === 'Escape') {
            close(false);
            return;
        }

        if (showCancel && (key === 'y' || key === 'n')) {
            close(key === 'y');
            return;
        }

        if (e.key === 'Enter') {
            close(true);
            return;
        }

        if (e.key === ' ') {
            if (!hasInput) {
                close(true);
            }
        }
    };

    const swallowKeyEvent = (e) => {
        e.stopImmediatePropagation();
        const target = e.target;
        const isTypingTarget = target instanceof HTMLInputElement
            || target instanceof HTMLTextAreaElement
            || target instanceof HTMLSelectElement;
        if (!isTypingTarget) e.preventDefault();
    };

    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('keypress', swallowKeyEvent, true);
    document.addEventListener('keyup', swallowKeyEvent, true);
    overlay.addEventListener('keydown', handleKeyDown);
    overlay.addEventListener('focusin', (e) => {
        if (e.target instanceof Node && !modal.contains(e.target)) {
            const items = focusables();
            if (items.length) items[0].focus();
        }
    });

    return {
        overlay,
        modal,
        okBtn,
        close,
        setResolver(resolver) { resolvePromise = resolver; },
        modalId
    };
}

export function showAlert(message, options = {}) {
    const { title = 'Notice', okText = 'OK' } = options;
    return new Promise((resolve) => {
        const modal = buildModal({ title, message, okText, showCancel: false });
        modal.setResolver(() => resolve());
        document.body.appendChild(modal.overlay);
        ModalManager.push(modal.modalId, () => modal.close(false));
        setTimeout(() => modal.okBtn.focus(), 0);
    });
}

export function showConfirm(message, options = {}) {
    const { title = 'Confirm', okText = 'OK', cancelText = 'Cancel' } = options;
    return new Promise((resolve) => {
        const modal = buildModal({ title, message, okText, cancelText, showCancel: true });
        modal.setResolver(resolve);
        document.body.appendChild(modal.overlay);
        ModalManager.push(modal.modalId, () => modal.close(false));
        setTimeout(() => modal.okBtn.focus(), 0);
    });
}

export function showPrompt(message, options = {}) {
    const {
        title = 'Input',
        okText = 'OK',
        cancelText = 'Cancel',
        placeholder = '',
        defaultValue = ''
    } = options;

    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'app-modal-input';
        input.placeholder = placeholder;
        input.value = defaultValue;

        const modal = buildModal({ title, message, okText, cancelText, showCancel: true, contentEl: input });
        modal.setResolver((result) => {
            resolve(result ? input.value : null);
        });

        document.body.appendChild(modal.overlay);
        ModalManager.push(modal.modalId, () => modal.close(false));
        setTimeout(() => input.focus(), 0);
    });
}
