import { SCHEMATIC_TOOL_KEYS, finishSchematicDrawInPlace } from './schematic-tools.js';
import { ModifyPropertyCommand, MoveShapesCommand } from './commands.js';
import { rotateNetOrientation } from '../../shapes/net.js';
import { resolveWireSnapPosition, PIN_SNAP_TOL } from './wire-snap.js';
import { updateToolGhost } from './tool.js';
import { ModalManager } from '../../core/ModalManager.js';
import { flipComponentH, flipComponentV, isPlacingComponent, rotateComponentRight } from './components.js';
import { handleTextEditKey, hasSchematicTextEdit } from './text-edit.js';
import { beginPastePreview, cutSelection, isPastingClipboard } from './clipboard.js';
import {
    canRunSchematicSelectionAction, runSchematicDeleteAction, runSchematicEscapeAction, runSchematicHistoryAction,
} from './editor-actions.js';
import { isSchematicLocked } from '../../shapes/lock-owner.js';
import { isSchematicDrawingActive } from './drawing.js';
import { isComponentItem, isNetItem, isTextItem } from '../../core/schematic-items.js';
/** @typedef {import('./schematic-editor-api.js').SchematicEditor} SchematicEditor */
/** @typedef {import('../../core/SchematicDocument.js').SchematicItem} SchematicItem */
/** @typedef {import('../../components/Component.js').Component} Component */
/** @typedef {import('../../shapes/net.js').Net} Net */
/** @typedef {import('../../shapes/net.js').NetOrientation} NetOrientation */
/** @typedef {import('../../shapes/text.js').Text} Text */
/** @typedef {import('../../ui/SchematicApp.js').SchematicToolOptions} KeyboardToolOptions */


/**
 * True when keyboard actions that operate on the current selection
 * (flip, rotate, etc.) are allowed: select tool active and nothing in progress.
 * @param {SchematicEditor} app
 */
function canActOnSelection(app) {
    return canRunSchematicSelectionAction(app) && app.currentTool === 'select';
}

/**
 * Flip the placing component / selected components horizontally.
 * @param {SchematicEditor} app
 * @param {KeyboardEvent} e
 */
function handleFlipHorizontal(app, e) {
    if (!hasSchematicTextEdit(app) && isPlacingComponent(app)) {
        flipComponentH(app);
        e.preventDefault();
        return true;
    }
    if (canActOnSelection(app) && app.selection.getSelection().some(isComponentItem)) {
        flipComponentH(app);
        e.preventDefault();
        return true;
    }
    return false;
}

/**
 * Flip the placing component / selected components vertically.
 * @param {SchematicEditor} app
 * @param {KeyboardEvent} e
 */
function handleFlipVertical(app, e) {
    if (!hasSchematicTextEdit(app) && isPlacingComponent(app)) {
        flipComponentV(app);
        e.preventDefault();
        return;
    }
    if (canActOnSelection(app) && app.selection.getSelection().some(isComponentItem)) {
        flipComponentV(app);
        e.preventDefault();
    }
}

/**
 * Spacebar: rotate the placing component, the selected components, the
 * active Net tool's orientation, or selected Net/Text shapes.
 * @param {SchematicEditor} app
 * @param {KeyboardEvent} e
 */
function handleSpaceRotate(app, e) {
    // Rotate component while placing.
    if (!hasSchematicTextEdit(app) && isPlacingComponent(app)) {
        rotateComponentRight(app);
        e.preventDefault();
        return;
    }
    // Rotate selected component(s).
    if (canActOnSelection(app) && app.selection.getSelection().some(isComponentItem)) {
        rotateComponentRight(app);
        e.preventDefault();
        return;
    }
    // Rotate Net orientation while the Net tool is active.
    if (!hasSchematicTextEdit(app) && app.currentTool === 'net') {
        const current = /** @type {NetOrientation} */ (/** @type {KeyboardToolOptions} */ (app.toolOptions)?.netOrientation || 'E');
        app.updateToolOptions({ netOrientation: rotateNetOrientation(current) });
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

        const netShapes = sel.filter(/** @param {SchematicItem} s @returns {s is Net} */ s => isNetItem(s) && !isSchematicLocked(s));
        if (netShapes.length > 0) {
            const newOrientation = rotateNetOrientation(netShapes[0].orientation || 'E');
            app.history.execute(new ModifyPropertyCommand(app, netShapes, 'orientation', newOrientation));
            app.renderShapes(true);
            app.updatePropertiesPanel(sel);
            e.preventDefault();
            return;
        }

        const textShapes = sel.filter(/** @param {SchematicItem} s @returns {s is Text} */ s => isTextItem(s) && !isSchematicLocked(s));
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
 * @param {SchematicEditor} app
 * @returns {Function} Cleanup function that removes the keyboard listeners.
 */
export function bindKeyboardShortcuts(app) {
    /** @type {(e: KeyboardEvent) => void} */
    const onKeyDown = (e) => {
        // PCB mode owns the keyboard. AppBootstrap's window-capture
        // dispatcher runs first; if it consumed the key it already
        // called stopImmediatePropagation and we never see it. If PCB
        // is active and the key wasn't consumed, we still bail so we
        // don't accidentally fire schematic-scoped tool shortcuts
        // (e.g. 'V' switching to the select tool) while the user is
        // in PCB mode.
        const pcbApp = /** @type {{bootstrap?: {pcbApp?: {isActive?: () => boolean}}}} */ (globalThis).bootstrap?.pcbApp;
        if (pcbApp?.isActive?.()) return;

        const topModal = ModalManager.top();
        if (topModal && topModal.id !== 'text-edit' && topModal.id !== 'componentPicker') {
            return;
        }
        const target = /** @type {(EventTarget & {tagName?: string, type?: string, isContentEditable?: boolean})|null} */ (e.target);
        const targetElement = e.target instanceof Element ? e.target : null;
        // Enter and Escape belong to a focused Properties control. Let its own
        // handler commit/cancel before the canvas can finish a draw or deselect.
        if ((e.key === 'Enter' || e.key === 'Escape')
            && targetElement?.closest('#propertiesPanel')) return;
        // Allow shortcuts through for non-text inputs (checkboxes, buttons, etc.)
        // Only block when user is actively typing in a text field
        if (target) {
            const tag = target.tagName;
            if ((tag === 'TEXTAREA' || tag === 'SELECT') && e.key !== 'Escape' && e.key !== 'Enter') return;
            if (tag === 'INPUT') {
                const inputType = (target.type || 'text').toLowerCase();
                // Block shortcuts only for text-entry inputs
                if (inputType !== 'checkbox' && inputType !== 'radio' && inputType !== 'button' && e.key !== 'Escape' && e.key !== 'Enter') return;
            }
        }
        if (e.defaultPrevented && e.key !== 'Escape' && e.key !== 'Enter') return;

        // Text edit has absolute priority for Escape and Enter
        if (hasSchematicTextEdit(app)) {
            if (e.key === 'Escape' || e.key === 'Enter') {
                if (/** @type {{handleTextEditKey?: Function}} */ (app).handleTextEditKey && handleTextEditKey(app, e)) {
                    return;
                }
            }
        }

        if (/** @type {{handleTextEditKey?: Function}} */ (app).handleTextEditKey && handleTextEditKey(app, e)) {
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
                    if (isSchematicDrawingActive(app)) {
                        finishSchematicDrawInPlace(app);
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
                    if (target?.isContentEditable) break;
                    handleSpaceRotate(app, e);
                    if (!e.defaultPrevented && !e.altKey && !hasSchematicTextEdit(app) && !isPlacingComponent(app)
                        && !isSchematicDrawingActive(app) && !isPastingClipboard(app) && !app.selection.getSelection().length
                        && !['INPUT', 'BUTTON'].includes(target?.tagName || '')) {
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
                    if (hasSchematicTextEdit(app)) break;
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
                    // Single-letter tool shortcuts, from each tool's entry in schematic-tools.js
                    // (X, which also flips, and Y and Space are handled above).
                    const tool = Object.hasOwn(SCHEMATIC_TOOL_KEYS, e.key.toLowerCase()) ? SCHEMATIC_TOOL_KEYS[e.key.toLowerCase()] : null;
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
