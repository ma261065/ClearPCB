import { DeleteShapesCommand, DeleteComponentsCommand, ModifyPropertyCommand, BatchCommand } from '../../core/CommandHistory.js';
import { updateRibbonState } from './ribbon.js';

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

export function deleteSelected(app) {
    const toDelete = app.selection.getSelection().filter(item => !item.locked);
    if (toDelete.length === 0) return;

    app.selection.clearSelection();

    const shapesToDelete = [];
    const componentsToDelete = [];

    for (const item of toDelete) {
        if (app.shapes.includes(item)) {
            // Field texts: toggle visibility instead of deleting
            if (item.parentComponent && item.fieldKey) {
                const showKey = item.fieldKey === 'reference' ? 'showReference' : 'showValue';
                if (item.parentComponent[showKey]) {
                    const command = new ModifyPropertyCommand(
                        app, [item.parentComponent], showKey, false);
                    app.history.execute(command);
                }
                continue;
            }
            shapesToDelete.push(item);
        } else if (app.components.includes(item)) {
            componentsToDelete.push(item);
        }
    }

    if (shapesToDelete.length > 0 && componentsToDelete.length > 0) {
        // Mixed selection: wrap both deletes in a single undo entry
        const batch = new BatchCommand('Delete selection');
        batch.add(new DeleteShapesCommand(app, shapesToDelete));
        batch.add(new DeleteComponentsCommand(app, componentsToDelete));
        app.history.execute(batch);
    } else if (shapesToDelete.length > 0) {
        const command = new DeleteShapesCommand(app, shapesToDelete);
        app.history.execute(command);
    } else if (componentsToDelete.length > 0) {
        const command = new DeleteComponentsCommand(app, componentsToDelete);
        app.history.execute(command);
    }

    app.renderShapes(true);
}

export function captureShapeState(app, shape) {
    return shape.captureState();
}

export function applyShapeState(app, shape, state) {
    shape.applyState(state);
    app.renderShapes(true);
}
