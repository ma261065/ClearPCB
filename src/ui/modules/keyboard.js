import { clearDragState } from './mouse.js';
import { ModifyPropertyCommand } from '../../core/CommandHistory.js';
import { rotateNetLabelOrientation } from '../../shapes/netlabel.js';
import { resolveWireSnapPosition, PIN_SNAP_TOL } from './wire.js';
import { updateToolGhost } from './tool.js';

/**
 * Central Escape key handler. Cascades through text edit, active/pending
 * anchor drag, active drawing, paste, component placement, component picker,
 * box select, tool reset, or clears selection.
 * @param {object} app - Application state.
 */
export function handleEscape(app) {
    if (app.textEdit) {
        app._endTextEdit(false);
        return;
    }
    // Cancel active segment drag — revert bridge insertions
    if (app.isDragging && app.dragMode === 'wire-segment' && app.dragWireStates) {
        for (const [wire, beforeState] of app.dragWireStates) {
            app._applyShapeState(wire, beforeState);
        }
        const shape = app.dragShape;
        clearDragState(app);
        app.didDrag = false;
        app.viewport.svg.style.cursor = '';
        app.interactionState = 'idle';
        if (shape) shape.selected = true;
        app.renderShapes(true);
        return;
    }
    // Cancel active anchor drag — revert shape to pre-drag state
    if (app.isDragging && app.dragMode === 'anchor' && app.dragShape) {
        if (app.dragShapesBefore) {
            app._applyShapeState(app.dragShape, app.dragShapesBefore);
        }
        // Also revert any linked wire states (e.g. junction removal)
        if (app.dragAnchorWireStates) {
            for (const [wire, beforeState] of app.dragAnchorWireStates) {
                app._applyShapeState(wire, beforeState);
            }
        }
        const shape = app.dragShape;
        clearDragState(app);
        app.didDrag = false;
        app.viewport.svg.style.cursor = '';
        app.interactionState = 'idle';
        shape.selected = true;
        app.renderShapes(true);
        return;
    }
    // Cancel pending anchor drag (click-and-release, waiting for movement threshold)
    if (app.pendingAnchorDrag) {
        const { shape, preInsertState } = app.pendingAnchorDrag;
        if (preInsertState) {
            app._applyShapeState(shape, preInsertState);
        }
        shape.selected = true;
        app.pendingAnchorDrag = null;
        app.viewport.svg.style.cursor = '';
        app.interactionState = 'idle';
        app.renderShapes(true);
        return;
    }
    if (app.isDrawing) {
        if (app.currentTool === 'wire') {
            app._cancelWireDrawing();
        } else {
            app._cancelDrawing();
        }
        app._onToolSelected('select');
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
        clearDragState(app);
        app.didDrag = false;
        app._removeBoxSelectElement();
        app.interactionState = 'idle';
        return;
    }
    if (app.currentTool !== 'select') {
        app._onToolSelected('select');
    } else {
        app.selection.clearSelection();
        app.renderShapes(true);
    }
}

/**
 * Registers global keyboard event listeners for all shortcuts
 * (Ctrl+S/O/N/Z/Y/A/C/X/V/P, tool keys, Enter, Delete, Escape, etc.).
 * @param {object} app - Application state.
 * @returns {Function} Cleanup function that removes the keyboard listeners.
 */
export function bindKeyboardShortcuts(app) {
    const onKeyDown = (e) => {
        // Allow shortcuts through for non-text inputs (checkboxes, buttons, etc.)
        // Only block when user is actively typing in a text field
        if (e.target) {
            const tag = e.target.tagName;
            if ((tag === 'TEXTAREA' || tag === 'SELECT') && e.key !== 'Escape' && e.key !== 'Enter') return;
            if (tag === 'INPUT') {
                const inputType = (e.target.type || 'text').toLowerCase();
                // Block shortcuts only for text-entry inputs
                if (inputType !== 'checkbox' && inputType !== 'radio' && inputType !== 'button' && e.key !== 'Escape' && e.key !== 'Enter') return;
            }
        }
        if (e.defaultPrevented && e.key !== 'Escape' && e.key !== 'Enter') return;

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
                    app._handleEscape();
                    if (!app.textEdit && !app.isDrawing && !app.pastingClipboard && !app.placingComponent && !app.componentPicker?.isOpen && app.currentTool !== 'select') {
                        app._onToolSelected('select');
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    break;
                case 'Enter':
                    if (app.isDrawing) {
                        if (app.currentTool === 'wire' && app.wirePoints.length >= 1) {
                            app._finishWireDrawing(app.drawCurrent);
                        } else if (app.currentTool === 'line') {
                            app._finishLine();
                        } else if (app.currentTool === 'polygon') {
                            app._finishPolygon();
                        } else if (app.drawCurrent) {
                            app._finishDrawing(app.drawCurrent);
                        }
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
                case 'n':
                case 'N':
                    app._onToolSelected('netlabel');
                    break;
                case 'x':
                case 'X':
                    app._onToolSelected('noconnect');
                    break;
                case ' ':
                    // Spacebar: rotate netlabel orientation while placing
                    if (!app.textEdit && app.currentTool === 'netlabel') {
                        const current = app.toolOptions?.netLabelOrientation || 'E';
                        const next = rotateNetLabelOrientation(current);
                        app._onOptionsChanged?.({ netLabelOrientation: next });

                        const world = app.viewport.currentMouseWorld;
                        if (world) {
                            const resolved = resolveWireSnapPosition(app, world, { pinTolerance: PIN_SNAP_TOL });
                            updateToolGhost(app, { x: resolved.x, y: resolved.y });
                        }

                        e.preventDefault();
                        break;
                    }

                    // Spacebar: toggle H/V rotation on any selected text shape
                    if (!app.textEdit && !app.isDrawing && app.currentTool === 'select') {
                        const sel = app.selection.getSelection();
                        const textShapes = sel.filter(s => s.type === 'text');
                        if (textShapes.length > 0) {
                            const newRot = textShapes[0].rotation === 270 ? 0 : 270;
                            const cmd = new ModifyPropertyCommand(app, textShapes, 'rotation', newRot);
                            app.history.execute(cmd);
                            app.renderShapes(true);
                            app._updatePropertiesPanel(sel);
                            e.preventDefault();
                        }
                    }
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
