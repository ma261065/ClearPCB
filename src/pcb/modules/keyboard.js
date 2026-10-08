import { isEditorActive } from './pcb-editor-api.js';
import { runPcbDeleteAction, runPcbEscapeAction, runPcbHistoryAction, runPcbNudgeAction, savePcbProject } from './editor-actions.js';
import { getPcbSelection } from './selection-registry.js';
import { hasPcbGesture } from './pcb-interactions.js';
import { handleTrackDrawKey } from './track-draw.js';
import { handleFillDrawKey } from './copper-fill-draw.js';
import { handleShapeDrawKey } from './board-shape-draw.js';
/** @typedef {import('./pcb-editor-api.js').PcbEditor} PcbEditor */

/*
 * The PCB editor's keyboard shortcuts ? the counterpart of
 * schematic/modules/keyboard.js. AppBootstrap's window-capture dispatcher calls
 * PCBApp.handleKeyDown while the PCB tab is active; drawing tools handle their
 * own keys, and actions go through editor-actions.js.
 */

/**
 * Central keyboard handler for PCB mode. Invoked by
 * AppBootstrap's window-capture dispatcher when this app is the
 * active mode. Returns `true` if the key was consumed (caller
 * should stop propagation), `false` to let other listeners run.
 *
 * Modes (highest priority first):
 *   - In-flight Track draw: Escape cancels, Enter finishes, Space inserts a via.
 *   - Selection / drag:     Ctrl+Z/Y undo/redo, Delete removes, Escape cancels.
 *
 * @param {PcbEditor} app
 * @param {KeyboardEvent} e
 * @returns {boolean} true if consumed
 */
export function handlePcbKeyDown(app, e) {
    if (!isEditorActive(app)) return false;

    // Don't hijack keys when the user is typing in an input/textarea
    // (e.g. the Properties panel text fields). Otherwise Backspace
    // would delete the selected text instead of a character.
    const tgt = /** @type {HTMLElement} */ (e.target);
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT' || tgt.isContentEditable)) {
        return false;
    }
    // The window-capture dispatcher must let panel navigation reach its handler.
    if (tgt?.closest?.('#pcbDrcSlidePanel')
        && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return false;

    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === '+' || e.key === '=') {
            app.viewport?.zoomIn();
            return true;
        }
        if (e.key === '-' || e.key === '_') {
            app.viewport?.zoomOut();
            return true;
        }
        if (e.key === 'Home') {
            app.viewport?.resetView();
            return true;
        }
    }

    // File save shortcuts (Ctrl+S / Ctrl+Alt+S). While PCB is active it owns
    // the keyboard, and the schematic keyboard handler bails out when PCB is
    // active — so Ctrl+S must be handled here. Otherwise it isn't consumed by
    // the app and falls through to the browser's native "Save page as…"
    // dialog instead of saving the project (matching the PCB ribbon Save
    // button, which calls project.save()/saveAs()).
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        void savePcbProject(app, e.altKey);
        return true;
    }

    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'c' || e.key === 'C')) {
        if (app.copySelection()) return true;
        return false;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'x' || e.key === 'X')) {
        if (app.cutSelection()) return true;
        return false;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'v' || e.key === 'V')) {
        if (app.pasteSelection()) return true;
        return false;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'a' || e.key === 'A')) {
        app.selectAll();
        return true;
    }

    // A drawing session owns its keys (Escape, Enter, and Space for tracks).
    for (const handleDrawKey of [handleTrackDrawKey, handleFillDrawKey, handleShapeDrawKey]) {
        const consumed = handleDrawKey(app, e);
        if (consumed !== null) return consumed;
    }

    // Otherwise: history, delete, selection-cancel.
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl && !e.altKey && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        return runPcbNudgeAction(app, /** @type {'ArrowUp'|'ArrowDown'|'ArrowLeft'|'ArrowRight'} */ (e.key));
    }
    if (ctrl && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
        return runPcbHistoryAction(app, 'undo');
    }
    if (ctrl && ((e.key === 'y' || e.key === 'Y') || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))) {
        return runPcbHistoryAction(app, 'redo');
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
        return runPcbDeleteAction(app);
    }
    if (e.key === 'Escape') return runPcbEscapeAction(app);
    // Component transform shortcuts (match the schematic editor):
    //   Space = rotate right, X = flip horizontal, Y = flip vertical.
    const selectedRef = getPcbSelection(app, 'reftext')[0] || null;
    const selectedComponent = getPcbSelection(app, 'component')[0] || null;
    if (selectedRef && app.placements.has(selectedRef)) {
        // A selected reference designator rotates with Space; the
        // component body shortcuts don't apply while the label is selected.
        if (e.code === 'Space' || e.key === ' ') {
            app.rotateRefText(selectedRef);
            e.preventDefault();
            return true;
        }
    }
    if (selectedComponent && app.placements.has(selectedComponent)) {
        if (e.code === 'Space' || e.key === ' ') {
            app.rotateComponent(selectedComponent, 'R');
            app.showComponentProperties(selectedComponent);
            e.preventDefault();
            return true;
        }
        if (e.key === 'x' || e.key === 'X') {
            app.flipComponent(selectedComponent, 'H');
            app.showComponentProperties(selectedComponent);
            e.preventDefault();
            return true;
        }
        if (e.key === 'y' || e.key === 'Y') {
            app.flipComponent(selectedComponent, 'V');
            app.showComponentProperties(selectedComponent);
            e.preventDefault();
            return true;
        }
    }
    if ((e.code === 'Space' || e.key === ' ') && !ctrl && !e.altKey
        && !getPcbSelection(app).length && !hasPcbGesture(app) && tgt?.tagName !== 'BUTTON') {
        app.fitToContent();
        return true;
    }
    return false;
}
