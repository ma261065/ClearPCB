import { cancelSchematicPointerInteraction } from './drag.js';
import { ModifyPropertyCommand, MoveShapesCommand } from './commands.js';
import { rotateNetOrientation } from '../../shapes/net.js';
import { resolveWireSnapPosition, PIN_SNAP_TOL } from './wire.js';
import { updateToolGhost } from './tool.js';
import { ModalManager } from '../../core/ModalManager.js';
import { cancelSchematicPropertyPreview } from './properties.js';
import { cancelWireDrawing, finishWireDrawing } from './wire.js';
import { flipComponentH, flipComponentV, rotateComponentRight } from './components.js';
import { handleTextEditKey } from './text-edit.js';
import { beginPastePreview, cutSelection } from './clipboard.js';
import { finishDrawing, finishLine, finishPolygon } from './drawing.js';
import { deleteSelected } from './selection.js';

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
        app.endTextEdit(false);
        return;
    }

    // 2-3. Active pointer edits and pre-threshold midpoint splits.
    if (cancelSchematicPointerInteraction(app)) return;

    switch (app.interactionState) {
        case 'drawing':
            if (app.currentTool === 'wire') {
                cancelWireDrawing(app);
            } else {
                app.cancelDrawing();
            }
            app.selectTool('select');
            return;

        case 'placing':
            if (app.pastingClipboard) {
                app.cancelPaste();
            } else if (app.placingComponent) {
                app.cancelComponentPlacement();
            }
            return;

        case 'toolActive':
            app.selectTool('select');
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
        app.selectTool('select');
    }
}

/** Settle reversible edits before either keyboard or ribbon history advances. */
export function runSchematicHistoryAction(app, action) {
    if (app.isDrawing || app.interactionState === 'drawing') return false;
    if (app.textEdit) {
        app.endTextEdit(false);
        return true;
    }
    if (app.pastingClipboard) {
        app.cancelPaste();
        return true;
    }
    if (app.placingComponent) {
        app.cancelComponentPlacement();
        return true;
    }
    const cancelledProperty = cancelSchematicPropertyPreview(app);
    cancelSchematicPointerInteraction(app);
    const changed = app.history[action]();
    if (changed) app.renderShapes(true);
    if (changed || cancelledProperty) app.updatePropertiesPanel?.(app.selection.getSelection());
    return true;
}

/** Flip the placing component / selected components horizontally. */
function handleFlipHorizontal(app, e) {
    if (!app.textEdit && app.placingComponent) {
        flipComponentH(app);
        e.preventDefault();
        return true;
    }
    if (canActOnSelection(app) && app.selection.getSelection().some(s => s.definition)) {
        flipComponentH(app);
        e.preventDefault();
        return true;
    }
    return false;
}

/** Flip the placing component / selected components vertically. */
function handleFlipVertical(app, e) {
    if (!app.textEdit && app.placingComponent) {
        flipComponentV(app);
        e.preventDefault();
        return;
    }
    if (canActOnSelection(app) && app.selection.getSelection().some(s => s.definition)) {
        flipComponentV(app);
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
        rotateComponentRight(app);
        e.preventDefault();
        return;
    }
    // Rotate selected component(s).
    if (canActOnSelection(app) && app.selection.getSelection().some(s => s.definition)) {
        rotateComponentRight(app);
        e.preventDefault();
        return;
    }
    // Rotate Net orientation while the Net tool is active.
    if (!app.textEdit && app.currentTool === 'net') {
        const current = app.toolOptions?.netOrientation || 'E';
        app.updateToolOptions?.({ netOrientation: rotateNetOrientation(current) });
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
            app.updatePropertiesPanel(sel);
            e.preventDefault();
            return;
        }

        const textShapes = sel.filter(s => s.type === 'text' && !s.locked);
        if (textShapes.length > 0) {
            const newRot = textShapes.every(shape => shape.fieldKey === 'reference')
                ? (((textShapes[0].rotation || 0) + 90) % 360 + 360) % 360
                : textShapes[0].rotation === 270 ? 0 : 270;
            app.history.execute(new ModifyPropertyCommand(app, textShapes, 'rotation', newRot));
            app.renderShapes(true);
            app.updatePropertiesPanel(sel);
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

        // Text edit has absolute priority for Escape and Enter
        if (app.textEdit) {
            if (e.key === 'Escape' || e.key === 'Enter') {
                if (app.handleTextEditKey && handleTextEditKey(app, e)) {
                    return;
                }
            }
        }

        if (app.handleTextEditKey && handleTextEditKey(app, e)) {
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
                    runSchematicHistoryAction(app, e.shiftKey ? 'redo' : 'undo');
                    break;
                case 'y':
                    e.preventDefault();
                    runSchematicHistoryAction(app, 'redo');
                    break;
                case 'a':
                    e.preventDefault();
                    app.selection.selectAll();
                    app.renderShapes(true);
                    break;
                case 'c':
                    e.preventDefault();
                    app.copySelection();
                    break;
                case 'x':
                    e.preventDefault();
                    cutSelection(app);
                    break;
                case 'v':
                    e.preventDefault();
                    beginPastePreview(app);
                    break;
            }
        } else {
            switch (e.key) {
                case 'Escape': {
                    // All cancellation precedence lives in handleEscape.
                    // Escape is always consumed in schematic mode.
                    handleEscape(app);
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    break;
                }
                case 'Enter':
                    if (app.isDrawing) {
                        if (app.currentTool === 'wire' && app.wirePoints.length >= 1) {
                            finishWireDrawing(app, app.drawCurrent);
                        } else if (app.currentTool === 'line') {
                            finishLine(app);
                        } else if (app.currentTool === 'polygon') {
                            finishPolygon(app);
                        } else if (app.drawCurrent) {
                            finishDrawing(app, app.drawCurrent);
                        }
                        e.preventDefault();
                    }
                    break;
                case 'Delete':
                case 'Backspace':
                    deleteSelected(app);
                    break;
                case 'x':
                case 'X':
                    // X: flip horizontally (placing/selected component) else
                    // select the no-connect tool.
                    if (handleFlipHorizontal(app, e)) break;
                    app.selectTool('noconnect');
                    break;
                case 'y':
                case 'Y':
                    // Y: flip vertically (placing/selected component). No tool.
                    handleFlipVertical(app, e);
                    break;
                case ' ':
                    if (e.target?.isContentEditable) break;
                    handleSpaceRotate(app, e);
                    if (!e.defaultPrevented && !e.altKey && !app.textEdit && !app.placingComponent
                        && !app.isDrawing && !app.pastingClipboard && !app.selection.getSelection().length
                        && !['INPUT', 'BUTTON'].includes(e.target?.tagName)) {
                        e.preventDefault();
                        app.fitToContent();
                    }
                    break;
                case 'f':
                case 'F':
                    app.fitToContent();
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
                    const step = app.viewport.snapToGrid ? app.viewport.gridSize / 4 : 1;
                    let dx = 0, dy = 0;
                    if (e.key === 'ArrowUp') dy = -step;
                    else if (e.key === 'ArrowDown') dy = step;
                    else if (e.key === 'ArrowLeft') dx = -step;
                    else if (e.key === 'ArrowRight') dx = step;

                    const sel = app.selection.getSelection();
                    if (sel.length > 0) {
                        const cmd = new MoveShapesCommand(app, sel, dx, dy);
                        app.history.execute(cmd);
                        app.updatePropertiesPanel(sel);
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
                        app.selectTool(tool);
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
