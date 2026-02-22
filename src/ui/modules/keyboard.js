export function handleEscape(app) {
    if (app._suppressNextEscape) {
        app._suppressNextEscape = false;
        return;
    }
    if (app.textEdit) {
        app._endTextEdit(false);
        return;
    }
    if (app.isDrawing) {
        if (app.currentTool === 'wire') {
            app._cancelWireDrawing();
        } else {
            app._cancelDrawing();
        }
        return;
    }
    if (app.pastingClipboard) {
        app._cancelPaste();
        return;
    }
    if (app.placingComponent) {
        app._cancelComponentPlacement();
        return;
    }
    if (app.componentPicker.isOpen) {
        app.componentPicker.close();
        return;
    }
    if (app.dragMode === 'box') {
        app._removeBoxSelectElement();
        app.isDragging = false;
        app.dragMode = null;
        app.boxSelectStart = null;
        return;
    }
    if (app.currentTool !== 'select') {
        app._onToolSelected('select');
    } else {
        app.selection.clearSelection();
        app.renderShapes(true);
    }
}

export function bindKeyboardShortcuts(app) {
    const onKeyDown = (e) => {
        // Allow shortcuts through for non-text inputs (checkboxes, buttons, etc.)
        // Only block when user is actively typing in a text field
        if (e.target) {
            const tag = e.target.tagName;
            if (tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (tag === 'INPUT') {
                const inputType = (e.target.type || 'text').toLowerCase();
                // Block shortcuts only for text-entry inputs
                if (inputType !== 'checkbox' && inputType !== 'radio' && inputType !== 'button') return;
            }
        }
        if (e.defaultPrevented) return;

        // Text edit has absolute priority for Escape and Enter
        if (app.textEdit) {
            if (e.key === 'Escape' || e.key === 'Enter') {
                if (app._handleTextEditKey && app._handleTextEditKey(e)) {
                    return;
                }
            }
        }

        if (app._handleTextEditKey && app._handleTextEditKey(e)) {
            return;
        }

        if (e.ctrlKey || e.metaKey) {
            switch (e.key.toLowerCase()) {
                case 's':
                    e.preventDefault();
                    if (e.altKey) {
                        app.saveFileAs();
                    } else {
                        app.saveFile();
                    }
                    break;
                case 'p':
                    if (e.shiftKey) {
                        e.preventDefault();
                        app.savePdf();
                    } else {
                        e.preventDefault();
                        app.print();
                    }
                    break;
                case 'o':
                    e.preventDefault();
                    app.openFile();
                    break;
                case 'n':
                    e.preventDefault();
                    app.newFile();
                    break;
                case 'z':
                    e.preventDefault();
                    if (e.shiftKey) {
                        if (app.history.redo()) app.renderShapes(true);
                    } else {
                        if (app.history.undo()) app.renderShapes(true);
                    }
                    break;
                case 'y':
                    e.preventDefault();
                    if (app.history.redo()) app.renderShapes(true);
                    break;
                case 'a':
                    e.preventDefault();
                    app.selection.selectAll();
                    app.renderShapes(true);
                    break;
                case 'c':
                    e.preventDefault();
                    app._copySelection();
                    break;
                case 'x':
                    e.preventDefault();
                    app._cutSelection();
                    break;
                case 'v':
                    e.preventDefault();
                    app._pasteClipboard();
                    break;
            }
        } else {
            switch (e.key) {
                case 'Escape':
                    if (app._suppressNextEscape) {
                        app._suppressNextEscape = false;
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        break;
                    }
                    app._handleEscape();
                    break;
                case 'Enter':
                    if (app.currentTool === 'wire' && app.isDrawing && app.wirePoints.length >= 2) {
                        app._finishWireDrawing(app.drawCurrent);
                        e.preventDefault();
                    }
                    break;
                case 'Delete':
                case 'Backspace':
                    app._deleteSelected();
                    break;
                case 'v':
                case 'V':
                    app._onToolSelected('select');
                    break;
                case 'l':
                case 'L':
                    app._onToolSelected('line');
                    break;
                case 'w':
                case 'W':
                    app._onToolSelected('wire');
                    break;
                case 'c':
                case 'C':
                    app._onToolSelected('circle');
                    break;
                case 'a':
                case 'A':
                    app._onToolSelected('arc');
                    break;
                case 'p':
                case 'P':
                    app._onToolSelected('polygon');
                    break;
                case 't':
                case 'T':
                    app._onToolSelected('text');
                    break;
                case 'i':
                case 'I':
                    app._onToolSelected('component');
                    break;
                case 'f':
                case 'F':
                    app._fitToContent();
                    break;
                case 'r':
                case 'R':
                    if (app.placingComponent) {
                        app._rotateComponentRight();
                        e.preventDefault();
                    } else {
                        app._onToolSelected('rect');
                    }
                    break;
                case 'm':
                case 'M':
                    if (app.placingComponent) {
                        app._flipComponentH();
                        e.preventDefault();
                    }
                    break;
            }
        }
    };

    const onGlobalEscape = () => {
        if (app._suppressNextEscape) {
            app._suppressNextEscape = false;
            return;
        }
        // Don't handle global escape if we just exited text edit or still in text edit
        if (app.textEdit) return;
        app._handleEscape();
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('global-escape', onGlobalEscape);

    // Return cleanup function
    return function destroyKeyboardShortcuts() {
        window.removeEventListener('keydown', onKeyDown, { capture: true });
        window.removeEventListener('global-escape', onGlobalEscape);
    };
}
