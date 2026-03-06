/**
 * Enables/disables and adjusts opacity of the undo and redo toolbar buttons
 * based on `app.history` state.
 * @param {object} app - Application state.
 */
export function updateUndoRedoButtons(app) {
    const canUndo = app.history.canUndo();
    const canRedo = app.history.canRedo();

    if (app.ui.undoBtn) {
        app.ui.undoBtn.disabled = !canUndo;
        app.ui.undoBtn.style.opacity = canUndo ? '1' : '0.4';
    }
    if (app.ui.redoBtn) {
        app.ui.redoBtn.disabled = !canRedo;
        app.ui.redoBtn.style.opacity = canRedo ? '1' : '0.4';
    }
}

/**
 * Set a checkbox to checked, unchecked, or indeterminate based on an array of boolean values.
 */
export function setCheckboxState(el, values) {
    el.indeterminate = false;
    if (values.length === 0) {
        el.checked = false;
        el.disabled = true;
        return;
    }
    const allTrue = values.every(v => v === true);
    const allFalse = values.every(v => v === false);
    el.disabled = false;
    if (allTrue) {
        el.checked = true;
    } else if (allFalse) {
        el.checked = false;
    } else {
        el.checked = false;
        el.indeterminate = true;
    }
}

/**
 * Makes the `.help-panel` element draggable by its `<h3>` header,
 * clamped to the window bounds.
 */
export function makeHelpPanelDraggable() {
    const panel = /** @type {HTMLElement|null} */ (document.querySelector('.help-panel'));
    if (!panel) return;
    const header = /** @type {HTMLElement} */ (panel.querySelector('h3') || panel);

    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    /** @param {MouseEvent} e */
    const onMouseMove = (e) => {
        if (!isDragging) return;
        const x = e.clientX - offsetX;
        const y = e.clientY - offsetY;

        const maxX = window.innerWidth - panel.offsetWidth;
        const maxY = window.innerHeight - panel.offsetHeight;

        panel.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
        panel.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    };

    const onMouseUp = () => {
        if (isDragging) {
            isDragging = false;
            header.style.cursor = 'grab';
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        }
    };

    /** @param {MouseEvent} e */
    const onMouseDown = (e) => {
        isDragging = true;
        const rect = panel.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        header.style.cursor = 'grabbing';
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
    };

    header.addEventListener('mousedown', onMouseDown);
}
