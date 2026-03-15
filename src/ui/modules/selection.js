import { DeleteShapesCommand, DeleteComponentsCommand, ModifyPropertyCommand, ModifyShapeCommand, BatchCommand } from '../../core/CommandHistory.js';
import { updateRibbonState } from './ribbon.js';

/**
 * Toggles the `locked` property on all selected items via `ModifyPropertyCommand`
 * and refreshes the properties panel and ribbon.
 * @param {object} app - Application state.
 */
export function toggleSelectionLock(app) {
    const selection = app.selection.getSelection();
    if (selection.length === 0) return;
    const allLocked = selection.every(item => item.locked === true);
    const nextValue = !allLocked;
    const affected = selection.filter(item => typeof item.locked === 'boolean' && item.locked !== nextValue);
    if (affected.length === 0) return;

    const command = new ModifyPropertyCommand(app, affected, 'locked', nextValue);
    app.history.execute(command);

    app.fileManager.setDirty(true);
    app._updatePropertiesPanel(selection);
    updateRibbonState(app, selection);
}

/**
 * Deletes all unlocked selected items (shapes and components), handling
 * component field-text show-flag toggling and batching delete commands for undo.
 * @param {object} app - Application state.
 */
export function deleteSelected(app) {
    const toDelete = app.selection.getSelection().filter(item => !item.locked);
    if (toDelete.length === 0) return;

    app.selection._clearSelection();

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

    app.selection._notifySelectionChanged();
}

/**
 * Snapshots a shape's current state for undo purposes.
 * @param {object} app - Application state.
 * @param {import('../../shapes/shape.js').Shape} shape - Shape to capture.
 * @returns {object} The captured state object.
 */
export function captureShapeState(app, shape) {
    return shape.captureState();
}

/**
 * Restores a shape to a previously captured state and triggers a full re-render.
 * @param {object} app - Application state.
 * @param {import('../../shapes/shape.js').Shape} shape - Shape to restore.
 * @param {object} state - Previously captured state.
 */
export function applyShapeState(app, shape, state) {
    shape.applyState(state);
    app.renderShapes(true);
}
