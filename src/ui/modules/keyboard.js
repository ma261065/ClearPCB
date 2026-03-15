import { clearDragState } from './mouse.js';
import { ModifyPropertyCommand, MoveShapesCommand } from '../../core/CommandHistory.js';
import { rotateNetOrientation } from '../../shapes/net.js';
import { resolveWireSnapPosition, PIN_SNAP_TOL } from './wire.js';
import { updateToolGhost } from './tool.js';
import { updateLabelDragGuide } from './draw-states.js';
import { ModalManager } from '../../core/ModalManager.js';

/**
 * Central Escape key handler. Uses app.interactionState to determine
 * what to cancel, then transitions back to idle.
 * @param {object} app - Application state.
 */
export function handleEscape(app) {
    if (app.textEdit) {
        app._endTextEdit(false);
        return;
    }

    switch (app.interactionState) {
        case 'segmentDrag':
            // Revert bridge insertions from segment drag start
            if (app.drag?.wireStates) {
                for (const [wire, beforeState] of app.drag.wireStates) {
                    app._applyShapeState(wire, beforeState);
                }
            }
            { const shape = app.drag?.shape;
              clearDragState(app);
              app.didDrag = false;
              app.viewport.svg.style.cursor = '';
              app.interactionState = 'idle';
              if (shape) shape.selected = true;
              app.renderShapes(true); }
            return;

        case 'anchorDrag':
            // Revert shape and linked wires to pre-drag state
            if (app.drag?.beforeState) {
                app._applyShapeState(app.drag.shape, app.drag.beforeState);
            }
            if (app.drag?.wireStates) {
                for (const [wire, beforeState] of app.drag.wireStates) {
                    app._applyShapeState(wire, beforeState);
                }
            }
            { const shape = app.drag?.shape;
              clearDragState(app);
              app.didDrag = false;
              app.viewport.svg.style.cursor = '';
              app.interactionState = 'idle';
              if (shape) shape.selected = true;
              app.renderShapes(true); }
            return;

        case 'moveDrag':
        case 'boxSelect':
            clearDragState(app);
            app.didDrag = false;
            app._removeBoxSelectElement();
            app.viewport.svg.style.cursor = '';
            app.interactionState = 'idle';
            app.renderShapes(true);
            return;

        case 'drawing':
            if (app.currentTool === 'wire') {
                app._cancelWireDrawing();
            } else {
                app._cancelDrawing();
            }
            app._onToolSelected('select');
            return;

        case 'placing':
            if (app.pastingClipboard) {
                app._cancelPaste();
            } else if (app.placingComponent) {
                app._cancelComponentPlacement();
            }
            return;

        case 'toolActive':
            app._onToolSelected('select');
            return;

        case 'idle':
        default:
            // Cancel pending anchor drag if present
            if (app.pendingAnchorDrag) {
                const { shape, preInsertState } = app.pendingAnchorDrag;
                if (preInsertState) {
                    app._applyShapeState(shape, preInsertState);
                }
                if (shape) shape.selected = true;
                app.pendingAnchorDrag = null;
                app.viewport.svg.style.cursor = '';
                app.renderShapes(true);
                return;
            }
            // Close component picker if open
            if (app.componentPicker.isOpen) {
                app.componentPicker.close();
                return;
            }
            // Clear selection
            app.selection.clearSelection();
            app.renderShapes(true);
            return;
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
        const topModal = ModalManager.top();
        if (topModal && topModal.id !== 'text-edit' && topModal.id !== 'componentPicker') {
            return;
        }
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
                case 'Escape': {
                    // If a non-Home ribbon tab is showing, switch back to Home
                    const activeTab = document.querySelector('.ribbon-tab.active');
                    if (activeTab && activeTab.dataset.tab !== 'home') {
                        app._setActiveRibbonTab('home');
                        e.preventDefault();
                        break;
                    }
                    app._handleEscape();
                    if (!app.textEdit && !app.isDrawing && !app.pastingClipboard && !app.placingComponent && !app.componentPicker?.isOpen && app.currentTool !== 'select') {
                        app._onToolSelected('select');
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    break;
                }
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
                    app._onToolSelected('text');
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
                case 'i':
                case 'I':
                    app._onToolSelected('line');
                    break;
                case 'n':
                case 'N':
                    app._onToolSelected('net');
                    break;
                case 'x':
                case 'X':
                    // X: flip component horizontally while placing or selected
                    if (!app.textEdit && app.placingComponent) {
                        app._flipComponentH();
                        e.preventDefault();
                        break;
                    }
                    if (!app.textEdit && !app.isDrawing && !app.pastingClipboard && app.currentTool === 'select') {
                        const sel = app.selection.getSelection();
                        const components = sel.filter(s => s.definition);
                        if (components.length > 0) {
                            app._flipComponentH();
                            e.preventDefault();
                            break;
                        }
                    }
                    app._onToolSelected('noconnect');
                    break;
                case 'y':
                case 'Y':
                    // Y: flip component vertically while placing or selected
                    if (!app.textEdit && app.placingComponent) {
                        app._flipComponentV();
                        e.preventDefault();
                        break;
                    }
                    if (!app.textEdit && !app.isDrawing && !app.pastingClipboard && app.currentTool === 'select') {
                        const sel = app.selection.getSelection();
                        const components = sel.filter(s => s.definition);
                        if (components.length > 0) {
                            app._flipComponentV();
                            e.preventDefault();
                            break;
                        }
                    }
                    break;
                case ' ':
                    // Spacebar: rotate component while placing or selected
                    if (!app.textEdit && app.placingComponent) {
                        app._rotateComponentRight();
                        e.preventDefault();
                        break;
                    }
                    if (!app.textEdit && !app.isDrawing && !app.pastingClipboard && app.currentTool === 'select') {
                        const sel = app.selection.getSelection();
                        const components = sel.filter(s => s.definition);
                        if (components.length > 0) {
                            app._rotateComponentRight();
                            e.preventDefault();
                            break;
                        }
                    }

                    // Spacebar: rotate Net orientation while placing
                    if (!app.textEdit && app.currentTool === 'net') {
                        const current = app.toolOptions?.netOrientation || 'E';
                        const next = rotateNetOrientation(current);
                        app._onOptionsChanged?.({ netOrientation: next });

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
                        const textShapes = sel.filter(s => s.type === 'text' && !s.locked);
                        if (textShapes.length > 0) {
                            const newRot = textShapes[0].rotation === 270 ? 0 : 270;
                            const cmd = new ModifyPropertyCommand(app, textShapes, 'rotation', newRot);
                            app.history.execute(cmd);
                            app.renderShapes(true);
                            app._updatePropertiesPanel(sel);
                            if (sel.length === 1 && sel[0].parentComponent) {
                                updateLabelDragGuide(app, sel[0]);
                            }
                            e.preventDefault();
                        }
                    }
                    break;
                case 'o':
                case 'O':
                    e.preventDefault();
                    app._onToolSelected('component');
                    break;
                case 'f':
                case 'F':
                    app._fitToContent();
                    break;
                case 'r':
                case 'R':
                    app._onToolSelected('rect');
                    break;
                case 'm':
                case 'M':
                    break;
                case 'ArrowUp':
                case 'ArrowDown':
                case 'ArrowLeft':
                case 'ArrowRight': {
                    if (app.textEdit) break;
                    e.preventDefault();
                    const step = app.viewport.snapToGrid ? app.viewport.gridSize : 1;
                    let dx = 0, dy = 0;
                    if (e.key === 'ArrowUp') dy = -step;
                    else if (e.key === 'ArrowDown') dy = step;
                    else if (e.key === 'ArrowLeft') dx = -step;
                    else if (e.key === 'ArrowRight') dx = step;

                    const sel = app.selection.getSelection();
                    if (sel.length > 0) {
                        const cmd = new MoveShapesCommand(app, sel, dx, dy);
                        app.history.execute(cmd);
                        app._updatePropertiesPanel(sel);
                    } else {
                        const panAmount = 20 / app.viewport.scale;
                        app.viewport.viewBox.x += dx > 0 ? panAmount : dx < 0 ? -panAmount : 0;
                        app.viewport.viewBox.y += dy > 0 ? panAmount : dy < 0 ? -panAmount : 0;
                        app.viewport._updateViewBox();
                        app.viewport._notifyViewChanged();
                    }
                    break;
                }
            }
        }
    };

    const onGlobalEscape = () => {
        const topModal = ModalManager.top();
        if (topModal && topModal.id !== 'text-edit') return;
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
