export function bindKeyboardShortcuts(app) {
    window.addEventListener('keydown', (e) => {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;

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
            }
        } else {
            switch (e.key) {
                case 'Escape':
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
                case 'r':
                case 'R':
                    if (app.placingComponent) {
                        app._rotateComponent();
                        e.preventDefault();
                    } else {
                        app._onToolSelected('rect');
                    }
                    break;
                case 'm':
                case 'M':
                    if (app.placingComponent) {
                        app._mirrorComponent();
                        e.preventDefault();
                    }
                    break;
            }
        }
    }, { capture: true });

    window.addEventListener('global-escape', () => app._handleEscape());
}
