/**
 * Model3DPopout — a floating, draggable in-app window that hosts an
 * interactive {@link Model3DViewer} for a single component's 3D model.
 *
 * Opened from the schematic component right-click menu ("Show 3D"). Reuses the
 * same THREE.js viewer as the component-picker preview (drag to spin, wheel to
 * zoom), so the look and interaction match. Only one pop-out exists at a time;
 * opening a second replaces the first. Escape (via ModalManager) or the close
 * button dismisses it and frees the WebGL context.
 */

import { Model3DViewer } from './Model3DViewer.js';
import { ModalManager } from '../core/ModalManager.js';

const MODAL_ID = 'model3d-popout';

/** @type {{ panel: HTMLElement, viewer: Model3DViewer } | null} */
let _current = null;

/**
 * Open (or replace) the 3D model pop-out.
 * @param {Object} opts
 * @param {string} opts.objText raw Wavefront OBJ text
 * @param {string} [opts.title] window title (e.g. the component reference)
 * @returns {boolean} true if a model was rendered
 */
export function openModel3DPopout({ objText, title = '3D Model' }) {
    closeModel3DPopout();

    const panel = document.createElement('div');
    panel.className = 'model3d-popout';

    const header = document.createElement('div');
    header.className = 'model3d-popout-header';

    const titleEl = document.createElement('span');
    titleEl.className = 'model3d-popout-title';
    titleEl.textContent = title;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'model3d-popout-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '\u00D7';

    header.appendChild(titleEl);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'model3d-popout-body';

    const hint = document.createElement('div');
    hint.className = 'model3d-popout-hint';
    hint.textContent = 'drag to rotate \u00B7 scroll to zoom';

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(hint);
    document.body.appendChild(panel);

    // Centre the panel on first open (its size is set by CSS).
    const rect = panel.getBoundingClientRect();
    const left = Math.max(8, (window.innerWidth - rect.width) / 2);
    const top = Math.max(8, (window.innerHeight - rect.height) / 3);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;

    // The viewer reads the body's size in its constructor, so the panel must
    // already be in the DOM (it is) before we create it.
    const viewer = new Model3DViewer(body);
    const ok = viewer.setModel(objText);
    if (!ok) {
        viewer.dispose();
        body.classList.add('model3d-popout-body-error');
        body.textContent = 'Unable to display 3D model';
    }

    enableHeaderDrag(panel, header);

    closeBtn.addEventListener('click', closeModel3DPopout);
    ModalManager.push(MODAL_ID, closeModel3DPopout);

    _current = { panel, viewer };
    return ok;
}

/** Close the pop-out (if open) and release its WebGL context. Idempotent. */
export function closeModel3DPopout() {
    if (!_current) return;
    ModalManager.pop(MODAL_ID);
    try { _current.viewer?.dispose(); } catch { /* already gone */ }
    _current.panel?.remove();
    _current = null;
}

/**
 * Let the user drag the panel around by its header. Pointer capture keeps the
 * drag alive even if the cursor outruns the header.
 * @param {HTMLElement} panel
 * @param {HTMLElement} handle
 */
function enableHeaderDrag(panel, handle) {
    let startX = 0, startY = 0, baseLeft = 0, baseTop = 0;

    const onMove = (e) => {
        const left = baseLeft + (e.clientX - startX);
        const top = baseTop + (e.clientY - startY);
        const maxLeft = window.innerWidth - panel.offsetWidth;
        const maxTop = window.innerHeight - panel.offsetHeight;
        panel.style.left = `${Math.min(Math.max(0, left), Math.max(0, maxLeft))}px`;
        panel.style.top = `${Math.min(Math.max(0, top), Math.max(0, maxTop))}px`;
    };

    const onUp = (e) => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        try { handle.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    };

    handle.addEventListener('pointerdown', (e) => {
        // Ignore drags that start on the close button.
        if (/** @type {HTMLElement} */ (e.target).closest('.model3d-popout-close')) return;
        startX = e.clientX;
        startY = e.clientY;
        const r = panel.getBoundingClientRect();
        baseLeft = r.left;
        baseTop = r.top;
        try { handle.setPointerCapture(e.pointerId); } catch { /* noop */ }
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        e.preventDefault();
    });
}
