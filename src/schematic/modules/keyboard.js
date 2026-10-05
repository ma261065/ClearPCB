import { ModifyPropertyCommand, MoveShapesCommand } from './commands.js';
import { rotateNetOrientation } from '../../shapes/net.js';
import { resolveWireSnapPosition, PIN_SNAP_TOL } from './wire.js';
import { updateToolGhost } from './tool.js';
import { ModalManager } from '../../core/ModalManager.js';
import { finishWireDrawing } from './wire.js';
import { flipComponentH, flipComponentV, rotateComponentRight } from './components.js';
import { handleTextEditKey } from './text-edit.js';
import { beginPastePreview, cutSelection } from './clipboard.js';
import { finishDrawing, finishLine, finishPolygon } from './drawing.js';
import {
    canRunSchematicSelectionAction, runSchematicDeleteAction, runSchematicEscapeAction, runSchematicHistoryAction,
} from './editor-actions.js';
import { isSchematicLocked } from '../../shapes/lock-owner.js';

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
 * (flip, rotate, etc.) are allowed: select tool active and nothing in progress.
 * @param {object} app
 */
function canActOnSelection(app) {
    return canRunSchematicSelectionAction(app) && app.currentTool === 'select';
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
    if (canActOnSelection(app)) {
        const sel = app.selection.getSelection();

        const netShapes = sel.filter(s => s.type === 'net' && !isSchematicLocked(s));
        if (netShapes.length > 0) {
            const newOrientation = rotateNetOrientation(netShapes[0].orientation || 'E');
            app.history.execute(new ModifyPropertyCommand(app, netShapes, 'orientation', newOrientation));
            app.renderShapes(true);
            app.updatePropertiesPanel(sel);
            e.preventDefault();
            return;
        }

        const textShapes = sel.filter(s => s.type === 'text' && !isSchematicLocked(s));
        if (textShapes.length > 0) {
            // Every schematic text, a reference included, toggles horizontal / vertical.
            const newRot = textShapes[0].rotation === 270 ? 0 : 270;
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
                    if (!canRunSchematicSelectionAction(app)) break;
                    app.selection.selectAll();
                    app.renderShapes(true);
                    break;
                case 'c':
                    e.preventDefault();
                    app.copySelection();
                    break;
                case 'x':
                    e.preventDefault();
                    if (canRunSchematicSelectionAction(app)) cutSelection(app);
                    break;
                case 'v':
                    e.preventDefault();
                    if (canRunSchematicSelectionAction(app)) beginPastePreview(app);
                    break;
            }
        } else {
            switch (e.key) {
                case 'Escape': {
                    // All cancellation precedence lives in runSchematicEscapeAction.
                    // Escape is always consumed in schematic mode.
                    runSchematicEscapeAction(app);
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
                    runSchematicDeleteAction(app);
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
                        if (!canRunSchematicSelectionAction(app)) break;
                        // Locked objects stay put; the rest of the selection moves.
                        const movable = sel.filter(item => !isSchematicLocked(item));
                        if (!movable.length) break;
                        const cmd = new MoveShapesCommand(app, movable, dx, dy);
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
