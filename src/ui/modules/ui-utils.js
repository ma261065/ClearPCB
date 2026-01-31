export function updateUndoRedoButtons(app) {
    if (app.ui.undoBtn) {
        app.ui.undoBtn.disabled = !app.history.canUndo();
        app.ui.undoBtn.style.opacity = app.history.canUndo() ? '1' : '0.4';
    }
    if (app.ui.redoBtn) {
        app.ui.redoBtn.disabled = !app.history.canRedo();
        app.ui.redoBtn.style.opacity = app.history.canRedo() ? '1' : '0.4';
    }
}

export function makeHelpPanelDraggable() {
    const panel = document.querySelector('.help-panel');
    if (!panel) return;
    const header = panel.querySelector('h3') || panel;

    let isDragging = false;
    let offsetX = 0;
    let offsetY = 0;

    header.addEventListener('mousedown', (e) => {
        isDragging = true;
        const rect = panel.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
        header.style.cursor = 'grabbing';
        e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const x = e.clientX - offsetX;
        const y = e.clientY - offsetY;

        const maxX = window.innerWidth - panel.offsetWidth;
        const maxY = window.innerHeight - panel.offsetHeight;

        panel.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
        panel.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    });

    window.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            header.style.cursor = 'grab';
        }
    });
}
