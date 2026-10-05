import { BatchCommand, DeleteComponentsCommand, DeleteShapesCommand, ModifyPropertyCommand } from './commands.js';
import { cancelSchematicPropertyPreview } from './properties.js';
import { deleteFocusedSchematicShape } from './context-menu.js';
import { hasSchematicInteraction, isSchematicDrawing } from './schematic-interactions.js';
import {
    cancelSchematicInteraction, cancelSchematicPointerInteraction, SCHEMATIC_MODAL_GESTURES,
} from './schematic-interaction-routing.js';
import { isSchematicLocked } from '../../shapes/lock-owner.js';
import { flushSettledChanges } from '../../shared/ui/settled-input.js';

/**
 * Keyboard, ribbon and Properties entry points for the schematic editor's Escape,
 * Undo/Redo and Delete actions — the counterpart of pcb/modules/editor-actions.js.
 * Every input route calls these, so each action has one precedence and one
 * cleanup boundary however it is invoked. In-progress interactions and their
 * cancel handlers come from schematic-interactions.js and its routing module.
 */

/**
 * Central Escape handler. A single Escape always cancels the most specific
 * active thing first. Each step returns once it consumes the key:
 *   1. the highest-priority in-progress interaction, in the order of
 *      schematic-interactions.js: inline text edit, overlap-cycle press, drag,
 *      pending midpoint split, drawing (which also returns to Select), paste,
 *      component placement
 *   2. an armed drawing tool with nothing in progress (back to Select)
 *   3. the component picker
 *   4. an active selection (deselect)
 *   5. the open Net-style dropdown
 *   6. a non-Home ribbon tab (back to Home)
 *   7. a non-select tool (back to select)
 * @param {object} app - Application state.
 */
export function runSchematicEscapeAction(app) {
    // 1. In-progress interactions, highest priority first.
    const cancelled = cancelSchematicInteraction(app);
    if (cancelled === 'isDrawing') app.selectTool('select');
    if (cancelled) return;

    // 2. An armed tool with nothing in progress.
    if (app.interactionState === 'toolActive') {
        app.selectTool('select');
        return;
    }

    // 3. Component picker.
    if (app.componentPicker?.isOpen) {
        app.componentPicker.close();
        return;
    }

    // 4. Active selection — deselect. (Selecting a shape auto-activates the
    // Properties ribbon tab, so this must run BEFORE the ribbon-tab step
    // below, otherwise the first Escape would only reset the ribbon.)
    if (app.selection?.getSelection?.().length > 0) {
        app.selection.clearSelection();
        app.renderShapes(true);
        return;
    }

    // 5. Open Net-style dropdown.
    const netMenu = document.getElementById('ribbonNetStyleMenu');
    if (netMenu && netMenu.classList.contains('open')) {
        netMenu.classList.remove('open');
        return;
    }

    // 6. Non-Home ribbon tab → Home.
    const activeTab = (document.getElementById('ribbonSchematic') || document)
        .querySelector('.ribbon-tab.active');
    if (activeTab instanceof HTMLElement && activeTab.dataset.tab !== 'home') {
        app.setActiveRibbonTab?.('home');
        return;
    }

    // 7. Non-select tool → select (safety net for stale state).
    if (app.currentTool !== 'select') {
        app.selectTool('select');
    }
}

/** Settle reversible edits before either keyboard or ribbon history advances. */
export function runSchematicHistoryAction(app, action) {
    // Like the PCB editor: drawing blocks history, modal edits (inline text, paste,
    // placement) are only cancelled, and pointer previews are cancelled first.
    if (isSchematicDrawing(app)) return false;
    if (cancelSchematicInteraction(app, SCHEMATIC_MODAL_GESTURES)) return true;
    // A spinner run still settling becomes its own undo step first.
    flushSettledChanges();
    const cancelledProperty = cancelSchematicPropertyPreview(app);
    cancelSchematicPointerInteraction(app);
    const changed = app.history[action]();
    if (changed) app.renderShapes(true);
    if (changed || cancelledProperty) app.updatePropertiesPanel?.(app.selection.getSelection());
    return true;
}

/**
 * Deletes all unlocked selected items (shapes and components), handling
 * component field-text show-flag toggling and batching delete commands for undo.
 * @param {object} app - Application state.
 */
export function runSchematicDeleteAction(app) {
    // A focused node or segment delete settles its own drag on that shape first.
    if (deleteFocusedSchematicShape(app)) return;
    if (!canRunSchematicSelectionAction(app)) return;
    const toDelete = app.selection.getSelection().filter(item => !isSchematicLocked(item));
    if (toDelete.length === 0) return;

    app.selection.clearSelection({ notify: false });

    const shapeSet = new Set(app.shapes);
    const compSet = new Set(app.components);
    const deleteSet = new Set(toDelete);
    const shapesToDelete = [];
    const componentsToDelete = [];
    const showFlagCommands = [];

    for (const item of toDelete) {
        if (shapeSet.has(item)) {
            if (item.parentComponent && item.fieldKey && item.fieldKey !== 'label') {
                // Skip show-flag toggle if parent is also being deleted
                if (!deleteSet.has(item.parentComponent)) {
                    if (item.fieldKey === 'wireLabel' && item.parentComponent.type === 'wire') {
                        // Wire label: hide by setting visible = false on the text shape
                        if (item.visible) {
                            showFlagCommands.push(new ModifyPropertyCommand(
                                app, [item], 'visible', false));
                        }
                    } else {
                        const showKey = item.fieldKey === 'reference' ? 'showReference' : 'showValue';
                        if (item.parentComponent[showKey]) {
                            showFlagCommands.push(new ModifyPropertyCommand(
                                app, [item.parentComponent], showKey, false));
                        }
                    }
                }
                continue;
            }
            shapesToDelete.push(item);
        } else if (compSet.has(item)) {
            componentsToDelete.push(item);
        }
    }

    const cmdCount = (shapesToDelete.length > 0 ? 1 : 0) + (componentsToDelete.length > 0 ? 1 : 0)
        + showFlagCommands.length;
    const needsBatch = cmdCount > 1;

    if (needsBatch) {
        const batch = new BatchCommand('Delete selection');
        for (const cmd of showFlagCommands) batch.add(cmd);
        if (shapesToDelete.length > 0) batch.add(new DeleteShapesCommand(app, shapesToDelete));
        if (componentsToDelete.length > 0) batch.add(new DeleteComponentsCommand(app, componentsToDelete));
        app.history.execute(batch);
    } else if (showFlagCommands.length > 0) {
        app.history.execute(showFlagCommands[0]);
    } else if (shapesToDelete.length > 0) {
        app.history.execute(new DeleteShapesCommand(app, shapesToDelete));
    } else if (componentsToDelete.length > 0) {
        app.history.execute(new DeleteComponentsCommand(app, componentsToDelete));
    }

    app.selection.notifyChanged();
}

/**
 * Whether an action on the current selection (delete, cut, paste, nudge, flip,
 * rotate, select all) may run: nothing may be in progress, as in the PCB editor.
 * Placement keys that act on the component being placed check that first.
 * @param {object} app
 */
export function canRunSchematicSelectionAction(app) {
    return !hasSchematicInteraction(app);
}
