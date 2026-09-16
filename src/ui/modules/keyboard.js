import { clearDragState } from './mouse.js';
import { ModifyPropertyCommand, MoveShapesCommand } from '../../core/CommandHistory.js';
import { rotateNetOrientation } from '../../shapes/net.js';
import { resolveWireSnapPosition, PIN_SNAP_TOL } from './wire.js';
import { updateToolGhost } from './tool.js';
import { updateLabelDragGuide } from './draw-states.js';
import { ModalManager } from '../../core/ModalManager.js';

/**
 * Single-letter shortcuts that simply select a tool. Overloaded keys
 * (x/y/space — flip/rotate vs tool) are handled explicitly below.
 * @type {Record<string, string>}
 */
const TOOL_KEYS = {
    v: 'select',
    l: 'text',
    w: 'wire',
    c: 'circle',
    a: 'arc',
    p: 'polygon',
    i: 'line',
    n: 'net',
    o: 'component',
    r: 'rect',
};

/**
 * True when keyboard actions that operate on the current selection
 * (flip, rotate, etc.) are allowed: select tool active and no
 * text-edit / drawing / paste in progress.
 * @param {object} app
 */
function canActOnSelection(app) {
    return !app.textEdit && !app.isDrawing && !app.pastingClipboard && app.currentTool === 'select';
}

/**
 * Tear down an active anchor/segment drag and return to idle, keeping
 * the dragged shape selected. Shared by the segmentDrag/anchorDrag
 * Escape branches (callers revert geometry first).
 * @param {object} app
 */
function cancelDragToIdle(app) {
    const shape = app.drag?.shape;
    clearDragState(app);
    app.pendingAnchorDrag = null;
    app.didDrag = false;
    app.viewport.svg.style.cursor = '';
    app._hideCrosshair();
    app.interactionState = 'idle';
    if (shape) shape.selected = true;
    app.renderShapes(true);
}

/**
 * Central Escape handler. Encodes the full cancellation precedence in
 * one place so a single Escape always cancels the most specific active
 * thing first. Each step returns once it consumes the key:
 *   1. inline text edit
 *   2. an in-progress drag (interactionState-driven)
 *   3. a pending (pre-threshold) midpoint split
 *   4. the component picker
 *   5. an active selection (deselect)
 *   6. the open Net-style dropdown
 *   7. a non-Home ribbon tab (back to Home)
 *   8. a non-select tool (back to select)
 * @param {object} app - Application state.
 */
export function handleEscape(app) {
    // 1. Inline text edit.
    if (app.textEdit) {
        app._endTextEdit(false);
        return;
    }

    // 2. Cancel an in-progress drag.
    switch (app.interactionState) {
        case 'segmentDrag':
            // Revert bridge insertions from segment drag start.
            if (app.drag?.shape?.type === 'polyline' && app.drag.beforeState) {
                app._applyShapeState(app.drag.shape, app.drag.beforeState);
            }
            if (app.drag?.wireStates) {
                for (const [wire, beforeState] of app.drag.wireStates) {
                    app._applyShapeState(wire, beforeState);
                }
            }
            cancelDragToIdle(app);
            return;

        case 'anchorDrag':
            // Revert shape and linked wires to pre-drag state.
            if (app.drag?.beforeState) {
                app._applyShapeState(app.drag.shape, app.drag.beforeState);
            }
            if (app.drag?.wireStates) {
                for (const [wire, beforeState] of app.drag.wireStates) {
                    app._applyShapeState(wire, beforeState);
                }
            }
            cancelDragToIdle(app);
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
    }

    // 3. Pending (pre-threshold) midpoint split.
    if (app.pendingAnchorDrag) {
        const { shape, preInsertState } = app.pendingAnchorDrag;
        if (preInsertState) app._applyShapeState(shape, preInsertState);
        if (shape) shape.selected = true;
        app.pendingAnchorDrag = null;
        app.viewport.svg.style.cursor = '';
        app.renderShapes(true);
        return;
    }

    // 4. Component picker.
    if (app.componentPicker?.isOpen) {
        app.componentPicker.close();
        return;
    }

    // 5. Active selection — deselect. (Selecting a shape auto-activates the
    // Properties ribbon tab, so this must run BEFORE the ribbon-tab step
    // below, otherwise the first Escape would only reset the ribbon.)
    if (app.selection?.getSelection?.().length > 0) {
        app.selection.clearSelection();
        app.renderShapes(true);
        return;
    }

    // 6. Open Net-style dropdown.
    const netMenu = document.getElementById('ribbonNetStyleMenu');
    if (netMenu && netMenu.classList.contains('open')) {
        netMenu.classList.remove('open');
        return;
    }

    // 7. Non-Home ribbon tab → Home.
    const activeTab = (document.getElementById('ribbonSchematic') || document)
        .querySelector('.ribbon-tab.active');
    if (activeTab instanceof HTMLElement && activeTab.dataset.tab !== 'home') {
        app._setActiveRibbonTab?.('home');
        return;
    }

    // 8. Non-select tool → select (safety net for stale state).
    if (app.currentTool !== 'select') {
        app._onToolSelected('select');
    }
}

/** Flip the placing component / selected components horizontally. */
function handleFlipHorizontal(app, e) {
    if (!app.textEdit && app.placingComponent) {
        app._flipComponentH();
        e.preventDefault();
        return true;
    }
    if (canActOnSelection(app) && app.selection.getSelection().some(s => s.definition)) {
        app._flipComponentH();
        e.preventDefault();
        return true;
    }
    return false;
}

/** Flip the placing component / selected components vertically. */
function handleFlipVertical(app, e) {
    if (!app.textEdit && app.placingComponent) {
        app._flipComponentV();
        e.preventDefault();
        return;
    }
    if (canActOnSelection(app) && app.selection.getSelection().some(s => s.definition)) {
        app._flipComponentV();
        e.preventDefault();
    }
}

/**
 * Spacebar: rotate the placing component, the selected components, the
 * active Net tool's orientation, or selected Net/Text shapes.
 */
function handleSpaceRotate(app, e) {
    // Rotate component while placing.
    if (!app.textEdit && app.placingComponent) {
        app._rotateComponentRight();
        e.preventDefault();
        return;
    }
    // Rotate selected component(s).
    if (canActOnSelection(app) && app.selection.getSelection().some(s => s.definition)) {
        app._rotateComponentRight();
        e.preventDefault();
        return;
    }
    // Rotate Net orientation while the Net tool is active.
    if (!app.textEdit && app.currentTool === 'net') {
        const current = app.toolOptions?.netOrientation || 'E';
        app._onOptionsChanged?.({ netOrientation: rotateNetOrientation(current) });
        const world = app.viewport.currentMouseWorld;
        if (world) {
            const resolved = resolveWireSnapPosition(app, world, { pinTolerance: PIN_SNAP_TOL });
            updateToolGhost(app, { x: resolved.x, y: resolved.y });
        }
        e.preventDefault();
        return;
    }
    // Rotate selected Net / Text shapes.
    if (!app.textEdit && !app.isDrawing && app.currentTool === 'select') {
        const sel = app.selection.getSelection();

        const netShapes = sel.filter(s => s.type === 'net' && !s.locked);
        if (netShapes.length > 0) {
            const newOrientation = rotateNetOrientation(netShapes[0].orientation || 'E');
            app.history.execute(new ModifyPropertyCommand(app, netShapes, 'orientation', newOrientation));
            app.renderShapes(true);
            app._updatePropertiesPanel(sel);
            e.preventDefault();
            return;
        }

        const textShapes = sel.filter(s => s.type === 'text' && !s.locked);
        if (textShapes.length > 0) {
            const newRot = textShapes[0].rotation === 270 ? 0 : 270;
            app.history.execute(new ModifyPropertyCommand(app, textShapes, 'rotation', newRot));
            app.renderShapes(true);
            app._updatePropertiesPanel(sel);
            if (sel.length === 1 && sel[0].parentComponent) {
                updateLabelDragGuide(app, sel[0]);
            }
            e.preventDefault();
        }
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
        // PCB mode owns the keyboard. AppBootstrap's window-capture
        // dispatcher runs first; if it consumed the key it already
        // called stopImmediatePropagation and we never see it. If PCB
        // is active and the key wasn't consumed, we still bail so we
        // don't accidentally fire schematic-scoped tool shortcuts
        // (e.g. 'V' switching to the select tool) while the user is
        // in PCB mode.
        const pcbApp = /** @type {any} */ (globalThis).bootstrap?.pcbApp;
        if (pcbApp?._active) return;

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

        // Ctrl+Tab: toggle Schematic / PCB mode (works even during text edit)
        if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') {
            e.preventDefault();
            e.stopPropagation();
            const tabs = document.querySelectorAll('.mode-tab');
            if (tabs.length >= 2) {
                const active = document.querySelector('.mode-tab.active');
                const target = active?.dataset.mode === 'pcb' ? tabs[0] : tabs[1];
                target.click();
            }
            return;
        }

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
                    // All cancellation precedence lives in handleEscape.
                    // Escape is always consumed in schematic mode.
                    app._handleEscape();
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
                case 'x':
                case 'X':
                    // X: flip horizontally (placing/selected component) else
                    // select the no-connect tool.
                    if (handleFlipHorizontal(app, e)) break;
                    app._onToolSelected('noconnect');
                    break;
                case 'y':
                case 'Y':
                    // Y: flip vertically (placing/selected component). No tool.
                    handleFlipVertical(app, e);
                    break;
                case ' ':
                    handleSpaceRotate(app, e);
                    break;
                case 'f':
                case 'F':
                    app._fitToContent();
                    break;
                case 'Home':
                    e.preventDefault();
                    app.viewport.resetView();
                    break;
                case '+':
                case '=':
                    e.preventDefault();
                    app.viewport.zoomIn();
                    break;
                case '-':
                case '_':
                    e.preventDefault();
                    app.viewport.zoomOut();
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
                default: {
                    // Single-letter tool shortcuts (v/w/c/a/p/i/n/o/r/l).
                    const tool = TOOL_KEYS[e.key.toLowerCase()];
                    if (tool) {
                        e.preventDefault();
                        app._onToolSelected(tool);
                    }
                    break;
                }
            }
        }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });

    // Return cleanup function
    return function destroyKeyboardShortcuts() {
        window.removeEventListener('keydown', onKeyDown, { capture: true });
    };
}
