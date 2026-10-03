import { cancelSchematicPointerInteraction } from './drag.js';
import { BatchCommand, DeleteComponentsCommand, DeleteShapesCommand, ModifyPropertyCommand } from './commands.js';
import { cancelSchematicPropertyPreview } from './properties.js';
import { cancelWireDrawing } from './wire.js';
import { deleteFocusedSchematicShape } from './context-menu.js';

/**
 * Keyboard, ribbon and Properties entry points for the schematic editor's Escape,
 * Undo/Redo and Delete actions — the counterpart of pcb/modules/editor-actions.js.
 * Every input route calls these, so each action has one precedence and one
 * cleanup boundary however it is invoked.
 */

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
export function runSchematicEscapeAction(app) {
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
        app.setActiveRibbonTab?.('home');
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

/**
 * Deletes all unlocked selected items (shapes and components), handling
 * component field-text show-flag toggling and batching delete commands for undo.
 * @param {object} app - Application state.
 */
export function runSchematicDeleteAction(app) {
    if (deleteFocusedSchematicShape(app)) return;
    const toDelete = app.selection.getSelection().filter(item => !item.locked);
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
